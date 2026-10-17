// Package config 环境变量配置（12-factor，ADR-0002）
package config

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// StorageConfig 对象存储配置（env 命名与 packages/storage 的 from-env 对齐，spec.md §1.5）
// 2026-09-22 修订（ADR-0005）：仅 S3 兼容存储，local 驱动已移除。
type StorageConfig struct {
	RootPrefix      string // STORAGE_ROOT_PREFIX（空 = 桶顶层）
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// 加速域名（STORAGE_CDN_BASE_URL，ADR-0005 / ADR-0019）：语义随 SignMode——
	// s3_presign 下只替换预签名 GET 的 origin（CDN 回源 COS 且 Host 透传桶端点才可验签）；
	// cdn_url_auth 下为签名 URL 的 host（加速域名）
	CDNBaseURL     string
	ForcePathStyle bool

	// ---- GET 签名方式（ADR-0019，spec.md §6.7） ----
	// SignMode：s3_presign（默认，现状）| cdn_url_auth（EO Token 鉴权方式 A）| custom
	SignMode string // STORAGE_SIGN_MODE
	// CDNAuthKey CDN 边缘鉴权密钥（STORAGE_CDN_AUTH_KEY / system_settings，cdn_url_auth 必填；
	// 与 CDN 控制台同款密钥，双侧一致）
	CDNAuthKey string
	// CDNAuthTTLSec 鉴权窗口秒（STORAGE_CDN_AUTH_TTL_SEC，默认 3600；与 CDN 控制台「有效时长」一致）
	CDNAuthTTLSec int
	// CDNAuthType EO Token 鉴权方式（STORAGE_CDN_AUTH_TYPE / storage_cdn_auth_type：
	// a | b | c | d | v，默认 a；与 CDN 控制台 Token 鉴权所选方式一致）
	CDNAuthType string
	// CDNAuthParam 方式 A 的鉴权 query 参数名（STORAGE_CDN_AUTH_PARAM / storage_cdn_auth_param，
	// 默认 sign；1–100 位字母/数字/下划线；与 CDN 控制台「鉴权加密串参数名称」一致）
	CDNAuthParam string
	// CDNAuthTokenParam 方式 D 的签名参数名（STORAGE_CDN_AUTH_TOKEN_PARAM / storage_cdn_auth_token_param，默认 token）
	CDNAuthTokenParam string
	// CDNAuthTimeParam 方式 D 的时间戳参数名（STORAGE_CDN_AUTH_TIME_PARAM / storage_cdn_auth_time_param，默认 t）
	CDNAuthTimeParam string
	// CustomSigner custom 模式的提供者名（STORAGE_CUSTOM_SIGNER，默认 "custom"）
	CustomSigner string
}

type Config struct {
	Env         string
	Listen      string
	DatabaseURL string // go-sql-driver DSN（由 DELIVERY_DATABASE_URL 归一，见 ParseDatabaseURL）

	// 资源 URL 基址：拼清单 / 密钥 / 字幕 URL（ADR-0006 §3）。
	// 运行时由 system_settings 覆盖（与其余设置一起 60s 刷新，env 兜底）。
	PublicBaseURL string

	// 允许跨域访问的源（管理端产物预览用 hls.js 需要；`*` = 全部）。
	// 播放鉴权全走 URL token、不带 Cookie，故 `*` 不引入凭证泄露面。
	CORSOrigins []string

	URLSignKey    []byte // 播放 token 的 HMAC 密钥（URL_SIGN_KEY_HEX）
	URLSignKeyKid string
	MasterKeys    map[int][]byte // ver -> 32B（解封 CEK / JWT 私钥，ADR-0006 §1）

	Storage StorageConfig

	JWTIssuer      string
	JWTTTLSec      int
	SessionTTLSec  int
	ManifestTTLSec int
	// 字幕 token 有效期上限（spec.md §7.5）：实际 exp 取与会话 exp 的较小值
	SubtitleTTLSec int
}

// Load 读取环境变量；部署形态见 ADR-0003（EdgeOne CF 环境注入 / SCF 容器 env）。
func Load() (*Config, error) {
	cfg := &Config{
		Env:            getEnv("APP_ENV", "dev"),
		Listen:         getEnv("DELIVERY_LISTEN", ":9000"), // SCF Web 函数固定监听 9000
		URLSignKeyKid:  getEnv("URL_SIGN_KEY_KID", "urlsign-v1"),
		MasterKeys:     map[int][]byte{},
		JWTIssuer:      getEnv("DELIVERY_JWT_ISSUER", "openvod-delivery"),
		JWTTTLSec:      getEnvInt("DELIVERY_JWT_TTL_SEC", 24*3600),
		SessionTTLSec:  getEnvInt("PLAYBACK_SESSION_TTL_SEC", 4*3600),
		ManifestTTLSec: getEnvInt("PLAYBACK_MANIFEST_TTL_SEC", 4*3600),
		SubtitleTTLSec: getEnvInt("PLAYBACK_SUBTITLE_TTL_SEC", 24*3600),
	}

	db, err := ParseDatabaseURL(os.Getenv("DELIVERY_DATABASE_URL"))
	if err != nil {
		return nil, err
	}
	cfg.DatabaseURL = db

	cfg.PublicBaseURL = strings.TrimRight(getEnv("DELIVERY_PUBLIC_BASE_URL", ""), "/")
	if cfg.PublicBaseURL == "" {
		// 本地 dev 便利：默认指向本机监听端口；生产必须显式配置（CDN / 分发域名）
		cfg.PublicBaseURL = "http://127.0.0.1" + portSuffix(cfg.Listen)
	}

	if key, err := hexKey("URL_SIGN_KEY_HEX"); err != nil {
		// ADR-0015：签名密钥不再强制 env——缺失时由装配层从 system_settings 解封（url_sign_key_hex），
		// 两处都没有才在启动时报错（安全失败，拒绝签发 token）
		cfg.URLSignKey = nil
	} else {
		cfg.URLSignKey = key
	}

	for _, o := range strings.Split(getEnv("DELIVERY_CORS_ORIGINS", "*"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.CORSOrigins = append(cfg.CORSOrigins, o)
		}
	}

	mkEnv := os.Getenv("MASTER_KEYS")
	for _, part := range strings.Split(mkEnv, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		// 只报「形态」不报内容：这些错误会进启动日志，密钥值绝不能出现（ADR-0006 红线）
		seg := strings.SplitN(part, ":", 2)
		if len(seg) != 2 {
			return nil, fmt.Errorf("MASTER_KEYS 片段非法（应为 版本:64位hex）：缺少「版本:」分隔符")
		}
		var ver int
		if _, err := fmt.Sscanf(seg[0], "%d", &ver); err != nil {
			return nil, fmt.Errorf("MASTER_KEYS 片段非法（应为 版本:64位hex）：版本段不是正整数")
		}
		key, err := hex.DecodeString(seg[1])
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("MASTER_KEYS 片段非法（应为 版本:64位hex）：密钥段长度 %d 字符（应为 64 位 hex）", len(seg[1]))
		}
		cfg.MasterKeys[ver] = key
	}
	if len(cfg.MasterKeys) == 0 {
		return nil, fmt.Errorf("MASTER_KEYS 未配置")
	}

	// ADR-0015：存储配置 env 只作兜底——缺失不再启动失败，装配层会先读
	// system_settings（首次启动向导写入），两处都不完整才报"请先完成管理台首次启动向导"。
	cfg.Storage = StorageConfig{
		RootPrefix:      os.Getenv("STORAGE_ROOT_PREFIX"),
		Endpoint:        os.Getenv("S3_ENDPOINT"),
		Region:          os.Getenv("S3_REGION"),
		Bucket:          os.Getenv("S3_BUCKET"),
		AccessKeyID:     os.Getenv("S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
		// COS 只接受 virtual-hosted-style，必须显式 S3_FORCE_PATH_STYLE="false"；MinIO 默认 true
		ForcePathStyle: strings.ToLower(getEnv("S3_FORCE_PATH_STYLE", "true")) != "false",
		CDNBaseURL:     strings.TrimRight(strings.TrimSpace(os.Getenv("STORAGE_CDN_BASE_URL")), "/"),
		// GET 签名方式（ADR-0019）：env 兜底，system_settings 优先（settings.ApplyTo 覆盖）
		SignMode:      strings.TrimSpace(os.Getenv("STORAGE_SIGN_MODE")),
		CDNAuthKey:    os.Getenv("STORAGE_CDN_AUTH_KEY"),
		CDNAuthTTLSec: getEnvInt("STORAGE_CDN_AUTH_TTL_SEC", 3600),
		CDNAuthType:   strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TYPE")),
		CDNAuthParam:  strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_PARAM")),
		CDNAuthTokenParam: strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TOKEN_PARAM")),
		CDNAuthTimeParam:  strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TIME_PARAM")),
		CustomSigner:      strings.TrimSpace(os.Getenv("STORAGE_CUSTOM_SIGNER")),
	}

	return cfg, nil
}

// ParseDatabaseURL 把 `mysql://user:pw@host:port/db?k=v` 归一为 go-sql-driver DSN；
// 已是 DSN（形如 `user:pw@tcp(host:port)/db`）时原样返回。
func ParseDatabaseURL(raw string) (string, error) {
	raw = strings.Trim(strings.TrimSpace(raw), `"`)
	if raw == "" {
		return "", fmt.Errorf("DELIVERY_DATABASE_URL 未配置")
	}
	if !strings.Contains(raw, "://") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("DELIVERY_DATABASE_URL 非法: %w", err)
	}
	if u.Scheme != "mysql" {
		return "", fmt.Errorf("DELIVERY_DATABASE_URL 仅支持 mysql://（v1 云形态传 mysql 公网地址）: %s", u.Scheme)
	}
	user := u.User.Username()
	pass, _ := u.User.Password()
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":3306"
	}
	db := strings.TrimPrefix(u.Path, "/")
	if db == "" {
		return "", fmt.Errorf("DELIVERY_DATABASE_URL 缺少库名")
	}
	// parseTime=true 让 DATETIME 直接扫进 time.Time；loc=UTC 与 Prisma 的 UTC 存储对齐
	q := url.Values{"parseTime": {"true"}, "loc": {"UTC"}, "charset": {"utf8mb4"}}
	for k, vs := range u.Query() {
		if _, fixed := q[k]; fixed {
			continue
		}
		for _, v := range vs {
			q.Add(k, v)
		}
	}
	return fmt.Sprintf("%s:%s@tcp(%s)/%s?%s", user, pass, host, db, q.Encode()), nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func portSuffix(listen string) string {
	if i := strings.LastIndex(listen, ":"); i >= 0 {
		return listen[i:]
	}
	return ":9000"
}

func hexKey(env string) ([]byte, error) {
	v := os.Getenv(env)
	if v == "" {
		return nil, fmt.Errorf("%s 未配置", env)
	}
	b, err := hex.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("%s 非法 hex: %w", env, err)
	}
	return b, nil
}
