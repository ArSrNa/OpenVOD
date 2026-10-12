// 自定义签名提供者的 AI Agent 提示词生成（ADR-0019 扩展，spec.md §6.7）：
// 用户在「存储设置」选择 sign_mode=custom 后，把本提示词交给自己的编码 Agent，
// 由 Agent 在两个注册点（TS / Go）生成实现代码并补测试——仍是编译期注入，
// 不做运行时动态插件（安全边界同 ADR-0019）。
// 纪律：提示词绝不携带任何密钥材料（cdn_auth_key 等只出现键名），算法细节由用户补充。

export interface CustomSignerPromptInput {
  /** settings 的 storage_custom_signer（注册名，默认 custom） */
  providerName: string;
  /** 用户对自己 CDN / 鉴权算法的自由描述（拼进提示词，可空） */
  algorithmNotes?: string;
  /** 当前加速域名（storage_cdn_base_url，仅用于上下文，可为空） */
  cdnBaseUrl?: string;
}

export function buildCustomSignerPrompt(input: CustomSignerPromptInput): string {
  const providerName = input.providerName.trim() || "custom";
  const notes = input.algorithmNotes?.trim()
    ? `\n## 本部署的鉴权算法（用户提供，以此为准）\n\n${input.algorithmNotes.trim()}\n`
    : "";
  const cdn = input.cdnBaseUrl?.trim() ? `\n- 加速域名（storage_cdn_base_url）：${input.cdnBaseUrl.trim()}` : "";

  return `# 任务：为 OpenVOD 实现自定义资产 URL 签名提供者「${providerName}」

## 背景

OpenVOD 是自建云点播系统：HLS 分片等资产存放在**私有** S3 兼容对象存储桶中，播放端通过带签名的 GET URL 直出访问（视频字节不经过后端函数，P0 纪律）。签名方式由系统设置 \`storage_sign_mode\` 控制（决策文档 ADR-0019，设计契约 docs/vod/spec.md §6.7）：

- \`s3_presign\`（默认）：S3 SigV4 预签名；
- \`cdn_url_auth\`：EdgeOne Token 鉴权方式 A（内置实现，不要改动）；
- \`custom\`：**本任务**——本部署的 CDN / 存储组合不属于以上两种，需要注册自定义签名提供者。

**硬性不变量**：
1. 桶恒为私有——生成的 URL 必须携带鉴权材料（签名 query / path token 等），**绝不允许返回免签 URL**；
2. 同一签名 URL 在有效窗口内必须**字节级稳定**（同样的输入参数得到完全相同的 URL），这是 CDN 缓存命中的前提；
3. 运行时动态插件明确不做：实现是**编译期注册**，改代码后需重新构建部署。

## 你的工作

在以下**两个注册点**实现同名提供者（双语言 URL 形态必须一致，管理端/Worker 走 TS，播放分发端走 Go）：

### 1. TypeScript（管理端 + Worker）\`packages/storage/src/custom-signer.ts\`

- 实现 \`UrlSigner\` 接口：\`sign(key: string, ttlSec: number): Promise<string>\`；
- \`key\` 是**不含 root 前缀**的业务相对键（如 \`proceed/{媒资id}/{模板id}/seg-000.ts\`）；
  需要完整对象键时用 \`withRootPrefix(rootPrefix, key)\`（从 \`./prefix\` 导入）；
- 返回**绝对 URL**（含协议与域名）；
- 调用 \`registerUrlSigner("${providerName}", factory)\` 注册（同文件已有 import 与注释示例，展开即可）；
- 密钥等敏感参数**不要硬编码**：从 \`@openvod/shared\` 的设置键语义出发，用环境变量
  （如 \`STORAGE_CDN_AUTH_KEY\`）或在工厂入参（config）中读取。

### 2. Go（分发端播放热路径）\`apps/delivery/internal/blob/custom_signer.go\`

- 实现 \`blob.URLSigner\` 接口：\`Sign(ctx context.Context, key string, ttl time.Duration) (string, error)\`；
- 在该文件 \`init()\` 中调用 \`RegisterURLSigner("${providerName}", factory)\`；
- 工厂签名：\`func(cfg config.StorageConfig) (URLSigner, error)\`——\`cfg.CDNBaseURL\` /
  \`cfg.CDNAuthKey\` / \`cfg.CDNAuthTTLSec\` / \`cfg.RootPrefix\` 可直接使用（密钥已由装配层解封）；
- 完整对象键用同包的 \`fullKey(cfg.RootPrefix, key)\`。

### 两侧可用的配置

- \`storage_cdn_base_url\` → \`cfg.CDNBaseURL\`（签名 URL 的 host）；
- \`storage_cdn_auth_key\` → \`cfg.CDNAuthKey\`（边缘鉴权密钥，MK 封装存储，运行时明文）；
- \`storage_cdn_auth_ttl_sec\` → \`cfg.CDNAuthTTLSec\`（建议作为签名窗口）；
- \`storage_custom_signer\` → 注册名（当前 "${providerName}"）。
${cdn}
${notes}
## 参考实现（内置，风格与结构照此对齐）

- TS：\`packages/storage/src/signer.ts\` 的 \`createEdgeOneTypeASigner\`（窗口对齐函数 \`typeAWindowTimestamp\`）；
- Go：\`apps/delivery/internal/blob/signer.go\` 的 \`edgeOneTypeASigner\`（公式与 TS 一致）。

## 质量要求

1. **双语言互通测试**：签名结果必须一致。共享测试向量 fixtures 在
   \`packages/crypto/fixtures/url-sign-v1.json\`（TS 测试参考 \`packages/storage/test/signer.test.ts\`，
   Go 测试参考 \`apps/delivery/internal/blob/signer_test.go\`）——为你的算法补一组向量进该文件或独立 fixtures，
   两侧测试都读同一份数据；
2. 边界处理：key 前导 \`/\` 归一、ttl 非法值、缺配置时的报错信息要**指明设置键名**（不要泄露密钥值）；
3. 运行验证：
   - \`bun test packages/storage/test/\`（TS 侧）；
   - \`go -C apps/delivery test ./internal/blob/\`（Go 侧）；
   - \`bun run check\` / \`go -C apps/delivery vet ./...\` 无新告警；
4. 不要改动内置 \`s3_presign\` / \`cdn_url_auth\` 实现与其它业务代码；改动范围仅限上述两个注册点、
   fixtures 与对应测试文件；
5. 完成后输出：改动文件清单、签名 URL 示例（用测试向量）、部署提示（需重新构建 admin / worker 镜像
   与 \`task build:delivery\`，并在 CDN 控制台完成对应鉴权配置）。`;
}
