// 资产 GET URL 签名提供者（ADR-0019，与 packages/storage/src/signer.ts 同契约手工对齐）：
// 统一语义 Sign(key, ttl) -> 绝对 URL。桶恒为私有（ADR-0005 不变量）——可变的只是
// 「签名发生在 S3 还是 CDN（或自定义提供者）」。模式与设置键：
//   - s3_presign（默认，现状）：S3 SigV4 预签名（PresignGetDirect 后端），CDN 透传回源由 S3 验签；
//   - cdn_url_auth：EO Token 鉴权方式 A/B/C/D/V（storage_cdn_auth_type 选择）——URL 无 S3 签名，
//     CDN 私有回源直读；窗口按 storage_cdn_auth_ttl_sec 对齐（与 TS typeAWindowTimestamp 同公式），
//     窗口内 URL 稳定；
//   - custom：编译期注册的自定义提供者（RegisterURLSigner / custom_signer.go；
//     运行时动态插件明确不做，ADR-0019）。
package blob

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"openvod/apps/delivery/internal/config"
)

// URLSigner 统一签名语义：key 为不含 root 前缀的业务相对键（与 Store 其余方法一致）。
type URLSigner interface {
	Sign(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// ---- EO Token 鉴权公共算法（与 @openvod/crypto 的 typea.ts / edgeone.ts 同式；
//      fixtures 共享 url-sign-v1.json 与 url-sign-eo-methods-v1.json） ----

// TypeAFixedRand / TypeAFixedUID URL 内固定常量（不做随机，保窗口内 URL 稳定 = 缓存友好）
const (
	TypeAFixedRand = "openvod"
	TypeAFixedUID  = "0"
	// TypeAAuthParam EO 控制台的鉴权参数名（可自定义，默认 sign；部署文档要求两侧一致）
	TypeAAuthParam = "sign"
	// TypeAMinWindowSec 对齐窗口下限（与 SETTING_TTL_LIMITS.storage_cdn_auth_ttl_sec 对齐）
	TypeAMinWindowSec = 60
)

// edgeOneAuthParamPattern storage_cdn_auth_param 形状（EO 控制台「鉴权加密串参数名称」：1–100 位字母/数字/下划线）
var edgeOneAuthParamPattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,100}$`)

// TypeAHash 与 TS typeAHash 同式：md5("{uri}-{timestamp}-{rand}-{uid}-{key}")，uri 以 / 开头不含 query
func TypeAHash(uri string, timestamp int64, randStr, uid, key string) string {
	sum := md5.Sum([]byte(fmt.Sprintf("%s-%d-%s-%s-%s", uri, timestamp, randStr, uid, key)))
	return hex.EncodeToString(sum[:])
}

// TypeAWindowTimestamp 窗口对齐：timestamp = ⌊(now+ttl)/ttl⌋·ttl，恒有 now < ts ≤ now+ttl；
// 同一 ttl 窗口内 ts 不变 → URL（含缓存键）稳定；实际有效期 ∈ (控制台有效时长, +ttl]。
func TypeAWindowTimestamp(nowSec, ttlSec int64) int64 {
	return (nowSec + ttlSec) / ttlSec * ttlSec
}

// UTC8MinuteString Unix 秒 → UTC+8 "YYYYMMDDHHMM"（方式 B；纯算术，不依赖进程时区）
func UTC8MinuteString(tsSec int64) string {
	return time.Unix(tsSec, 0).UTC().Add(8 * time.Hour).Format("20060102150405")[:12]
}

// TypeBHash 方式 B：md5("{key}{timestamp}{path}")（timestamp 为 UTC+8 分钟串）
func TypeBHash(path, timestampUTC8, key string) string {
	sum := md5.Sum([]byte(key + timestampUTC8 + path))
	return hex.EncodeToString(sum[:])
}

// TypeCHash 方式 C：md5("{key}{path}{timestamp}")（timestamp 为十六进制 Unix 秒，无 0x）
func TypeCHash(path, timestampHex, key string) string {
	sum := md5.Sum([]byte(key + path + timestampHex))
	return hex.EncodeToString(sum[:])
}

// TypeDHash 方式 D：md5("{key}{path}{timestamp}")（timestamp 为十进制 Unix 秒）
func TypeDHash(path, timestampDec, key string) string {
	sum := md5.Sum([]byte(key + path + timestampDec))
	return hex.EncodeToString(sum[:])
}

// TypeVParams 方式 V 的签名参数：T 必填（过期时刻，十六进制 Unix 秒）；其余选填，缺省空串参与拼接。
type TypeVParams struct {
	T, Plive, Exper, Us, Whref, Bkref, Whip, Bkip string
}

// TypeVHash 方式 V：sha1(key + path + t + plive + exper + us + whref + bkref + whip + bkip)（顺序固定）
func TypeVHash(path, key string, p TypeVParams) string {
	sum := sha1.Sum([]byte(key + path + p.T + p.Plive + p.Exper + p.Us + p.Whref + p.Bkref + p.Whip + p.Bkip))
	return hex.EncodeToString(sum[:])
}

func isEdgeOneAuthType(v string) bool {
	switch v {
	case "a", "b", "c", "d", "v":
		return true
	default:
		return false
	}
}

// buildEdgeOneURL 按方式组装鉴权 URL（与 TS 侧组装函数同式；测试由 fixtures 直接驱动）：
//   - A：{base}{path}?{authParam}={ts}-{rand}-{uid}-{md5}（rand/uid 固定常量；authParam 默认 sign）
//   - B：{base}/{ts(UTC+8 分钟)}/{md5}/{path}
//   - C：{base}/{md5}/{ts(hex)}/{path}
//   - D：{base}{path}?token={md5}&t={ts}
//   - V：{base}{path}?t={t(hex)}&sign={sha1}（tsSec 即过期时刻）
func buildEdgeOneURL(authType, base, path, key string, tsSec int64, authParam string) string {
	switch authType {
	case "b":
		tsStr := UTC8MinuteString(tsSec)
		return fmt.Sprintf("%s/%s/%s%s", base, tsStr, TypeBHash(path, tsStr, key), path)
	case "c":
		tsHex := strconv.FormatInt(tsSec, 16)
		return fmt.Sprintf("%s/%s/%s%s", base, TypeCHash(path, tsHex, key), tsHex, path)
	case "d":
		tsDec := strconv.FormatInt(tsSec, 10)
		return fmt.Sprintf("%s%s?token=%s&t=%s", base, path, TypeDHash(path, tsDec, key), tsDec)
	case "v":
		tHex := strconv.FormatInt(tsSec, 16)
		return fmt.Sprintf("%s%s?t=%s&sign=%s", base, path, tHex, TypeVHash(path, key, TypeVParams{T: tHex}))
	default: // a
		return fmt.Sprintf("%s%s?%s=%d-%s-%s-%s", base, path, authParam, tsSec,
			TypeAFixedRand, TypeAFixedUID, TypeAHash(path, tsSec, TypeAFixedRand, TypeAFixedUID, key))
	}
}

// ---- EdgeOne 签名器（方式 A/B/C/D/V；装配入口） ----

type edgeOneSigner struct {
	authType  string // a | b | c | d | v
	base      string // 加速域名（storage_cdn_base_url 在 cdn_url_auth 模式下的语义）
	key       string // 边缘鉴权密钥（storage_cdn_auth_key，与 CDN 控制台一致）
	authParam string // 方式 A 的 query 参数名（storage_cdn_auth_param，默认 sign）
	windowTtl int64  // 对齐窗口秒（storage_cdn_auth_ttl_sec）
	nowSecFn  func() int64 // 可注入测试时钟
}

func newEdgeOneSigner(cfg config.StorageConfig) (*edgeOneSigner, error) {
	if cfg.CDNBaseURL == "" {
		return nil, fmt.Errorf("cdn_url_auth 需要 storage_cdn_base_url（签名 URL 的加速域名）")
	}
	if cfg.CDNAuthKey == "" {
		return nil, fmt.Errorf("cdn_url_auth 需要 storage_cdn_auth_key（CDN 边缘鉴权密钥）")
	}
	if cfg.CDNAuthTTLSec < TypeAMinWindowSec {
		return nil, fmt.Errorf("storage_cdn_auth_ttl_sec 必须为 ≥%d 的整数（秒），当前 %d", TypeAMinWindowSec, cfg.CDNAuthTTLSec)
	}
	authType := strings.ToLower(strings.TrimSpace(cfg.CDNAuthType))
	if authType == "" {
		authType = "a"
	}
	if !isEdgeOneAuthType(authType) {
		return nil, fmt.Errorf("storage_cdn_auth_type 非法：%s（可选 a | b | c | d | v，ADR-0019）", cfg.CDNAuthType)
	}
	authParam := strings.TrimSpace(cfg.CDNAuthParam)
	if authParam == "" {
		authParam = TypeAAuthParam
	}
	if !edgeOneAuthParamPattern.MatchString(authParam) {
		return nil, fmt.Errorf("storage_cdn_auth_param 非法（1–100 位字母 / 数字 / 下划线，与 CDN 控制台「鉴权加密串参数名称」一致）")
	}
	return &edgeOneSigner{
		authType:  authType,
		base:      cfg.CDNBaseURL,
		key:       cfg.CDNAuthKey,
		authParam: authParam,
		windowTtl: int64(cfg.CDNAuthTTLSec),
		nowSecFn:  func() int64 { return time.Now().Unix() },
	}, nil
}

// Sign 生成鉴权 URL。时间窗语义（与 TS 侧一致）：
//   - 方式 A/B/C/D：时间戳为「签发时刻」（窗口对齐值；B 序列化为 UTC+8 分钟串、C 为 hex、D 为十进制）；
//   - 方式 V：t 为「过期时刻」（窗口对齐值 + 1 窗，保证任意签发时刻有效期 ≥ 窗口，另加 EO 300s 容差）。
//
// 调用方 ttl 不参与窗口（窗口恒取配置值）——需要更长有效期就调大 storage_cdn_auth_ttl_sec 并同步 CDN 控制台。
func (s *edgeOneSigner) Sign(_ context.Context, key string, _ time.Duration) (string, error) {
	path := "/" + strings.TrimLeft(key, "/")
	ts := TypeAWindowTimestamp(s.nowSecFn(), s.windowTtl)
	if s.authType == "v" {
		ts += s.windowTtl
	}
	authParam := s.authParam
	if authParam == "" { // 直接构造（测试）或旧配置：回退默认参数名
		authParam = TypeAAuthParam
	}
	return buildEdgeOneURL(s.authType, s.base, path, s.key, ts, authParam), nil
}

// ---- custom（编译期注册，ADR-0019） ----

// SignerFactory 自定义签名提供者工厂。在 custom_signer.go 的 init() 中调用
// RegisterURLSigner(名字, 工厂) 注册；settings 的 storage_custom_signer（默认 "custom"）
// 即路由到同名工厂。修改注册代码后需重新构建部署（不做运行时动态插件）。
type SignerFactory func(cfg config.StorageConfig) (URLSigner, error)

var signerRegistry = map[string]SignerFactory{}

// RegisterURLSigner 注册自定义提供者（重复注册同名直接 panic——装配期错误越早暴露越好）
func RegisterURLSigner(name string, factory SignerFactory) {
	normalized := strings.TrimSpace(name)
	if normalized == "" {
		panic("blob.RegisterURLSigner: 提供者名不能为空")
	}
	if _, exists := signerRegistry[normalized]; exists {
		panic(fmt.Sprintf("blob.RegisterURLSigner: 提供者「%s」重复注册", normalized))
	}
	signerRegistry[normalized] = factory
}

// ---- 装配 ----

// NewURLSigner 按 sign mode 装配 GET 签名提供者（blob.New 的签名入口，spec.md §6.7 契约）
func NewURLSigner(cfg config.StorageConfig, s3Presign URLSigner) (URLSigner, error) {
	switch cfg.SignMode {
	case "cdn_url_auth":
		return newEdgeOneSigner(cfg)
	case "custom":
		name := strings.TrimSpace(cfg.CustomSigner)
		if name == "" {
			name = "custom"
		}
		factory, ok := signerRegistry[name]
		if !ok {
			return nil, fmt.Errorf(
				"自定义签名提供者「%s」未注册：请在 apps/delivery/internal/blob/custom_signer.go 实现并 RegisterURLSigner 后重新构建（ADR-0019）", name)
		}
		return factory(cfg)
	case "s3_presign", "":
		if s3Presign == nil {
			return nil, fmt.Errorf("s3_presign 模式缺少 SigV4 预签名后端")
		}
		return s3Presign, nil
	default:
		return nil, fmt.Errorf("storage_sign_mode 非法：%s（可选 s3_presign | cdn_url_auth | custom，ADR-0019）", cfg.SignMode)
	}
}
