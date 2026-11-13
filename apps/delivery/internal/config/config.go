// Package config 环境变量配置（12-factor，ADR-0002）
package config

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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
	Env    string
	Listen string

	// ---- 数据库（ADR-0011 2026-10-17 修订）----
	// 三端统一只读 DATABASE_URL，驱动由 scheme 推导（不读 DB_PROVIDER）；
	// 需要最小权限时给 delivery 进程单独传受限账号的连接串即可，不再有第二个变量名。
	DatabaseDriver string // mysql | sqlite
	DatabaseURL    string // mysql: go-sql-driver DSN；sqlite: modernc.org/sqlite 路径
	DatabasePath   string // 仅 sqlite：归一后的绝对路径（日志 / 排错，不含凭据）

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
	// 字幕 token 有效期窗口（spec.md §7.5）：共享 token 的 exp 取窗口对齐（当前窗口末端），
	// 同窗口内重复 play 产出逐字相同的 token → URL 跨会话稳定可缓存（ADR-0009 2026-11-13 修订）
	SubtitleTTLSec int
	// 字幕共享 URL 的缓存时长（Cache-Control: public, max-age=；ADR-0009 2026-11-13 修订）：
	// 0 = 关闭缓存（回退 no-store）；错误响应恒 no-store
	SubtitleCacheMaxAgeSec int
}

// Load 读取环境变量；部署形态见 ADR-0003（EdgeOne CF 环境注入 / SCF 容器 env）。
func Load() (*Config, error) {
	cfg := &Config{
		Env:                    getEnv("APP_ENV", "dev"),
		Listen:                 getEnv("DELIVERY_LISTEN", ":9000"), // SCF Web 函数固定监听 9000
		URLSignKeyKid:          getEnv("URL_SIGN_KEY_KID", "urlsign-v1"),
		MasterKeys:             map[int][]byte{},
		JWTIssuer:              getEnv("DELIVERY_JWT_ISSUER", "openvod-delivery"),
		JWTTTLSec:              getEnvInt("DELIVERY_JWT_TTL_SEC", 24*3600),
		SessionTTLSec:          getEnvInt("PLAYBACK_SESSION_TTL_SEC", 4*3600),
		ManifestTTLSec:         getEnvInt("PLAYBACK_MANIFEST_TTL_SEC", 4*3600),
		SubtitleTTLSec:         getEnvInt("PLAYBACK_SUBTITLE_TTL_SEC", 24*3600),
		SubtitleCacheMaxAgeSec: getEnvInt("PLAYBACK_SUBTITLE_CACHE_MAX_AGE_SEC", 600),
	}

	db, err := ParseDatabaseURL(os.Getenv("DATABASE_URL"))
	if err != nil {
		// ADR-0011 修订（2026-10-17）：旧名 DELIVERY_DATABASE_URL 已移除，只读 DATABASE_URL。
		// 旧部署还留着旧名时给出改名提示，避免把「env 没改名」误判成「代码没迁移」。
		if strings.TrimSpace(os.Getenv("DELIVERY_DATABASE_URL")) != "" {
			return nil, fmt.Errorf("%w（检测到已废弃的 DELIVERY_DATABASE_URL：请改名为 DATABASE_URL，值不变）", err)
		}
		return nil, err
	}
	cfg.DatabaseDriver = db.Driver
	cfg.DatabaseURL = db.DSN
	cfg.DatabasePath = db.Path

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
		SignMode:          strings.TrimSpace(os.Getenv("STORAGE_SIGN_MODE")),
		CDNAuthKey:        os.Getenv("STORAGE_CDN_AUTH_KEY"),
		CDNAuthTTLSec:     getEnvInt("STORAGE_CDN_AUTH_TTL_SEC", 3600),
		CDNAuthType:       strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TYPE")),
		CDNAuthParam:      strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_PARAM")),
		CDNAuthTokenParam: strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TOKEN_PARAM")),
		CDNAuthTimeParam:  strings.TrimSpace(os.Getenv("STORAGE_CDN_AUTH_TIME_PARAM")),
		CustomSigner:      strings.TrimSpace(os.Getenv("STORAGE_CUSTOM_SIGNER")),
	}

	return cfg, nil
}

// 数据库驱动名（与 database/sql 注册名一致）
const (
	DriverMySQL  = "mysql"
	DriverSQLite = "sqlite" // modernc.org/sqlite（纯 Go，CGO_ENABLED=0 可构建）
)

// DBConfig 归一后的数据库接入参数。
type DBConfig struct {
	Driver string // mysql | sqlite
	DSN    string // mysql: go-sql-driver DSN；sqlite: 文件路径 + pragma
	Path   string // 仅 sqlite：归一后的绝对路径（日志 / 排错用）
}

/**
 * ParseDatabaseURL 把统一连接串归一为 Go 驱动参数（ADR-0011 2026-10-17 修订）：
 *   - `mysql://user:pw@host:port/db?k=v` → go-sql-driver DSN（固定 parseTime/loc/charset）；
 *   - `file:./dev.db`（Prisma 约定）/ `sqlite:///abs.db` / 裸 `*.db` 路径 → sqlite 路径；
 *   - 已是 go-sql-driver DSN（形如 `user:pw@tcp(host:port)/db`）→ 原样。
 * 驱动由 scheme 推导，不依赖 DB_PROVIDER——三端共用同一个 DATABASE_URL。
 */
func ParseDatabaseURL(raw string) (DBConfig, error) {
	raw = strings.Trim(strings.TrimSpace(raw), `"`)
	if raw == "" {
		return DBConfig{}, fmt.Errorf("数据库连接串未配置（DATABASE_URL 为空）")
	}
	switch {
	case strings.HasPrefix(raw, "mysql://"):
		dsn, err := mysqlDSN(raw)
		if err != nil {
			return DBConfig{}, err
		}
		return DBConfig{Driver: DriverMySQL, DSN: dsn}, nil
	case strings.HasPrefix(raw, "file:"):
		return sqliteConfig(strings.TrimPrefix(raw, "file:"))
	case strings.HasPrefix(raw, "sqlite:"):
		// sqlite:///abs.db → /abs.db；sqlite://rel.db / sqlite:./dev.db → 相对路径
		p := strings.TrimPrefix(strings.TrimPrefix(raw, "sqlite:"), "//")
		return sqliteConfig(p)
	case !strings.Contains(raw, "://") && isSQLitePath(raw):
		return sqliteConfig(raw)
	case !strings.Contains(raw, "://"):
		return DBConfig{Driver: DriverMySQL, DSN: raw}, nil
	default:
		scheme := raw[:strings.Index(raw, "://")]
		return DBConfig{}, fmt.Errorf("不支持的数据库连接串 scheme=%s（支持 mysql:// / file: / sqlite:）", scheme)
	}
}

func mysqlDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL 非法: %w", err)
	}
	user := u.User.Username()
	pass, _ := u.User.Password()
	host := u.Host
	if !strings.Contains(host, ":") {
		host += ":3306"
	}
	db := strings.TrimPrefix(u.Path, "/")
	if db == "" {
		return "", fmt.Errorf("DATABASE_URL 缺少库名")
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

// sqliteConfig 归一 Prisma 风格的 sqlite 连接串：丢弃连接池参数（connection_limit 等），
// 只保留路径，并附加 busy_timeout / foreign_keys pragma（与 Prisma 连接语义对齐）。
func sqliteConfig(raw string) (DBConfig, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DBConfig{}, fmt.Errorf("sqlite 连接串缺少文件路径")
	}
	path, query := raw, ""
	if i := strings.Index(path, "?"); i >= 0 {
		path, query = path[:i], path[i+1:]
	}
	if path == "" {
		return DBConfig{}, fmt.Errorf("sqlite 连接串缺少文件路径")
	}
	abs := resolveSQLitePath(path)

	pragmas := []string{"busy_timeout(5000)", "foreign_keys(1)"}
	if q, err := url.ParseQuery(query); err == nil {
		for _, v := range q["_pragma"] {
			if v != "" {
				pragmas = append(pragmas, v)
			}
		}
	}
	// modernc.org/sqlite 以 `?_pragma=name(value)` 逐条应用；路径中的空格 / 括号无需转义。
	return DBConfig{
		Driver: DriverSQLite,
		DSN:    abs + "?_pragma=" + strings.Join(pragmas, "&_pragma="),
		Path:   abs,
	}, nil
}

/**
 * resolveSQLitePath 按 Prisma 约定归一路径：相对路径以 schema 所在目录
 * packages/db/prisma 为基准（Prisma 的 file:./dev.db 就落在那里）。
 * 从 CWD 向上查找该目录（repo checkout 内任意子目录启动都能命中）；
 * 独立部署找不到 schema 时按 CWD 解析——此时应显式使用绝对路径。
 */
func resolveSQLitePath(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if dir, ok := findPrismaSchemaDir(); ok {
		return filepath.Clean(filepath.Join(dir, p))
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

func findPrismaSchemaDir() (string, bool) {
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for {
		candidate := filepath.Join(dir, "packages", "db", "prisma")
		if _, err := os.Stat(filepath.Join(candidate, "schema.sqlite.prisma")); err == nil {
			return candidate, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func isSQLitePath(raw string) bool {
	lower := strings.ToLower(raw)
	for _, ext := range []string{".db", ".sqlite", ".sqlite3"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
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
