// 自定义 URL 签名提供者注册入口（ADR-0019，spec.md §6.7）
// ---------------------------------------------------------------------
// 把 storage_sign_mode 配置为 "custom" 时，GET 签名 URL 由这里注册的提供者生成，
// 面向非 EO 的 CDN / 存储组合（如 Nginx secure_link、CloudFront 签名 URL、
// path-style 回源的 TypeA 变体等）。管理端「分发设置」页提供可交给 AI Agent 的
// 实现提示词（含本契约的完整说明），生成代码后落到本文件并重新构建。
//
// 契约：
//   - 实现 packages/storage 的 UrlSigner：sign(key, ttlSec) -> Promise<绝对 URL>；
//     key 为不含 root 前缀的业务相对键，需要完整对象键时自行拼 rootPrefix（见下）；
//   - 调用 registerUrlSigner(名字, 工厂) 注册；settings 的 storage_custom_signer
//     （默认 "custom"）即为这里的「名字」；
//   - 必须同时实现 Go 侧同名提供者（apps/delivery/internal/blob/custom_signer.go），
//     分发端（播放热路径）与 TS 侧（管理端 / Worker）才有一致的 URL 形态；
//   - 桶恒为私有（ADR-0005 不变量）：签名 URL 必须带鉴权材料，禁止返回免签 URL；
//   - 运行时动态插件明确不做（ADR-0019）：修改本文件后需重新构建部署。
//
// 注意：本文件经 packages/storage/src/index.ts 导入，构建期即执行注册；
// 未注册提供者被 settings 引用时报错（含本文件路径指引），不会静默回退。

import { registerUrlSigner, type UrlSigner } from "./signer";

// ---- 在下方实现并注册你的提供者（示例已注释，按需展开 / 让你的 Agent 生成） ----
//
// import { withRootPrefix } from "./prefix";
//
// const mySigner: UrlSigner = {
//   async sign(key: string, ttlSec: number): Promise<string> {
//     const fullPath = "/" + withRootPrefix(process.env.STORAGE_ROOT_PREFIX ?? "", key);
//     // …按你的 CDN 鉴权算法计算 query（密钥建议走 system_settings 的
//     // storage_cdn_auth_key 或独立 env，绝不能硬编码进仓库）…
//     return `https://cdn.example.com${fullPath}?…`;
//   },
// };
//
// registerUrlSigner("custom", () => mySigner);

export {};
