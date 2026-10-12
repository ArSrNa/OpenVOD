// 资产 GET URL 签名提供者（ADR-0019，与 packages/storage/src/signer.ts 同契约手工对齐）：
// 统一语义 Sign(key, ttl) -> 绝对 URL。桶恒为私有（ADR-0005 不变量）——可变的只是
// 「签名发生在 S3 还是 CDN（或自定义提供者）」。模式与设置键：
//   - s3_presign（默认，现状）：S3 SigV4 预签名（PresignGetDirect 后端），CDN 透传回源由 S3 验签；
//   - cdn_url_auth：EO Token 鉴权方式 A——URL 无 S3 签名，CDN 私有回源直读；窗口按
//     storage_cdn_auth_ttl_sec 对齐（与 TS typeAWindowTimestamp 同公式），窗口内 URL 稳定；
//   - custom：编译期注册的自定义提供者（RegisterURLSigner / custom_signer.go；
//     运行时动态插件明确不做，ADR-0019）。
package blob

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"openvod/apps/delivery/internal/config"
)

// URLSigner 统一签名语义：key 为不含 root 前缀的业务相对键（与 Store 其余方法一致）。
type URLSigner interface {
	Sign(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// ---- EO Token 鉴权方式 A（与 @openvod/crypto typea.ts 同算法，fixtures 共享 url-sign-v1.json） ----

// TypeAFixedRand / TypeAFixedUID URL 内固定常量（不做随机，保窗口内 URL 稳定 = 缓存友好）
const (
	TypeAFixedRand = "openvod"
	TypeAFixedUID  = "0"
	// TypeAAuthParam EO 控制台的鉴权参数名（可自定义，默认 sign；部署文档要求两侧一致）
	TypeAAuthParam = "sign"
	// TypeAMinWindowSec 对齐窗口下限（与 SETTING_TTL_LIMITS.storage_cdn_auth_ttl_sec 对齐）
	TypeAMinWindowSec = 60
)

// TypeAHash 与 TS typeAHash 同式：md5("{uri}-{timestamp}-{rand}-{uid}-{key}")，uri 以 / 开头不含 query
func TypeAHash(uri string, timestamp int64, randStr, uid, key string) string {
	raw := fmt.Sprintf("%s-%d-%s-%s-%s", uri, timestamp, randStr, uid, key)
	sum := md5.Sum([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// TypeAWindowTimestamp 窗口对齐：timestamp = ⌊(now+ttl)/ttl⌋·ttl，恒有 now < ts ≤ now+ttl；
// 同一 ttl 窗口内 ts 不变 → URL（含缓存键）稳定；实际有效期 ∈ (控制台有效时长, +ttl]。
func TypeAWindowTimestamp(nowSec, ttlSec int64) int64 {
	return (nowSec + ttlSec) / ttlSec * ttlSec
}

type edgeOneTypeASigner struct {
	base      string // 加速域名（storage_cdn_base_url 在 cdn_url_auth 模式下的语义）
	key       string // 边缘鉴权密钥（storage_cdn_auth_key，与 CDN 控制台一致）
	windowTtl int64  // 对齐窗口秒（storage_cdn_auth_ttl_sec）
	authParam string
	nowSecFn  func() int64 // 可注入测试时钟
}

func newEdgeOneTypeASigner(cfg config.StorageConfig) (*edgeOneTypeASigner, error) {
	if cfg.CDNBaseURL == "" {
		return nil, fmt.Errorf("cdn_url_auth 需要 storage_cdn_base_url（签名 URL 的加速域名）")
	}
	if cfg.CDNAuthKey == "" {
		return nil, fmt.Errorf("cdn_url_auth 需要 storage_cdn_auth_key（CDN 边缘鉴权密钥）")
	}
	if cfg.CDNAuthTTLSec < TypeAMinWindowSec {
		return nil, fmt.Errorf("storage_cdn_auth_ttl_sec 必须为 ≥%d 的整数（秒），当前 %d", TypeAMinWindowSec, cfg.CDNAuthTTLSec)
	}
	return &edgeOneTypeASigner{
		base:      cfg.CDNBaseURL,
		key:       cfg.CDNAuthKey,
		windowTtl: int64(cfg.CDNAuthTTLSec),
		authParam: TypeAAuthParam,
		nowSecFn:  func() int64 { return time.Now().Unix() },
	}, nil
}

// Sign 生成 TypeA URL：{base}/{fullKey}?sign={ts}-{rand}-{uid}-{md5}。
// 注意：签名 path 即完整对象键（含 root 前缀）；调用方 ttl 不参与窗口（窗口恒取配置值，
// 语义与 TS 侧一致）——需要更长有效期就调大 storage_cdn_auth_ttl_sec 并同步 CDN 控制台。
func (s *edgeOneTypeASigner) Sign(_ context.Context, key string, _ time.Duration) (string, error) {
	path := "/" + strings.TrimLeft(key, "/")
	ts := TypeAWindowTimestamp(s.nowSecFn(), s.windowTtl)
	hash := TypeAHash(path, ts, TypeAFixedRand, TypeAFixedUID, s.key)
	return fmt.Sprintf("%s%s?%s=%d-%s-%s-%s", s.base, path, s.authParam, ts, TypeAFixedRand, TypeAFixedUID, hash), nil
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
		return newEdgeOneTypeASigner(cfg)
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
