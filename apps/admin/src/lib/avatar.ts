// 管理端头像：Cravatar（Gravatar 兼容的国内镜像）按邮箱 MD5 取图 ——
// https://cravatar.cn/avatar/{md5(邮箱)}?s=400&d=404
//
// 为什么在服务端算 MD5：浏览器端没有现成实现（Web Crypto 不支持 md5，仓库也不引第三方
// md5 依赖），而 `node:crypto` 只在服务端可用。因此与 lib/version.ts 同纪律：
// 本模块只允许**服务端**（页面 / API route）引用，结果以 prop 下传给客户端组件。
import { createHash } from "node:crypto";

const CRAVATAR_BASE = "https://cravatar.cn/avatar";

/**
 * 邮箱 → Cravatar 头像 URL。
 *
 * 哈希口径遵循 Gravatar 规范：邮箱先去首尾空格、再转小写，取 MD5 十六进制。
 * 邮箱缺失（空串 / null）时返回 undefined，由客户端回退到占位图标。
 *
 * `d=404`：邮箱未注册 Cravatar 时返回 404，让客户端回退到 `UserOutlined` 占位图标；
 * 不加该参数时服务端会返回默认剪影图，占位图标永远看不到（头像加载失败也看不出区别）。
 *
 * @param email 管理员邮箱
 * @param size 头像边长像素（默认 400，兼顾高清屏）
 */
export function cravatarAvatarUrl(
  email: string | null | undefined,
  size = 400,
): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return undefined;
  const hash = createHash("md5").update(normalized).digest("hex");
  return `${CRAVATAR_BASE}/${hash}?s=${size}&d=404`;
}
