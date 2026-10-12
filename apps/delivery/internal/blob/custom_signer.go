// 自定义 URL 签名提供者注册入口（ADR-0019，spec.md §6.7；Go 侧编译期注入）
// ---------------------------------------------------------------------
// 把 storage_sign_mode 配置为 "custom" 时，分发端的 GET 签名 URL（分片 / 海报直出）
// 由这里注册的提供者生成，面向非 EO 的 CDN / 存储组合（如 Nginx secure_link、
// CloudFront 签名 URL、path-style 回源的 TypeA 变体等）。管理端「存储设置」页提供
// 可交给 AI Agent 的实现提示词（含本契约的完整说明），生成代码后落到本文件并重新构建。
//
// 契约：
//   - 实现 blob.URLSigner：Sign(ctx, key, ttl) (string, error)；key 为不含 root 前缀的
//     业务相对键，需要完整对象键时用 blob.FullKey(rootPrefix, key)（见下方说明）；
//   - 调用 blob.RegisterURLSigner(名字, 工厂) 注册；settings 的 storage_custom_signer
//     （默认 "custom"）即为这里的「名字」；
//   - 必须同时实现 TS 侧同名提供者（packages/storage/src/custom-signer.ts），
//     管理端 / Worker 与分发端才有一致的 URL 形态；
//   - 算法互通测试：fixtures 在 packages/crypto/fixtures/url-sign-v1.json；
//   - 桶恒为私有（ADR-0005 不变量）：签名 URL 必须带鉴权材料，禁止返回免签 URL；
//   - 运行时动态插件明确不做（ADR-0019）：修改本文件后需重新构建（task build:delivery）。
//
//   - 未注册的提供者被 settings 引用时 blob.New 直接报错（含本文件路径指引），
//     分发端拒绝以错误签名形态启动，不会静默回退。

package blob

// ---- 在下方实现并注册你的提供者（示例已注释，按需展开 / 让你的 Agent 生成） ----
//
// import (
// 	"context"
// 	"time"
//
// 	"openvod/apps/delivery/internal/config"
// )
//
// type mySigner struct{ secret string }
//
// func (s *mySigner) Sign(_ context.Context, key string, ttl time.Duration) (string, error) {
// 	_ = ttl
// 	// fullKey 拼接全局 root 前缀（同包内可直接用，与 s3Store 内部同一规则）：
// 	// fullPath := "/" + fullKey(cfg.RootPrefix, key)
// 	// …按你的 CDN 鉴权算法计算 query（密钥建议走 system_settings 的
// 	// storage_cdn_auth_key 或独立 env，绝不能硬编码进仓库）…
// 	return "https://cdn.example.com/" + key + "?sig=…", nil
// }
//
// func init() {
// 	RegisterURLSigner("custom", func(cfg config.StorageConfig) (URLSigner, error) {
// 		return &mySigner{secret: cfg.CDNAuthKey}, nil
// 	})
// }
