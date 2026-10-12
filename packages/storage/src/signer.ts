// 资产 GET URL 签名提供者（ADR-0019）：统一语义 sign(key, ttlSec) -> 绝对 URL。
// 桶恒为私有（ADR-0005 不变量）——可变的只是「签名发生在 S3 还是 CDN（或自定义提供者）」：
//   - s3_presign（默认，现状）：S3 SigV4 预签名，CDN 透传回源由 S3 验签；缓存键必须含完整 query
//     或对带 query 请求不缓存（2026-10-05 踩坑口径，spec.md §6.5）；
//   - cdn_url_auth：CDN URL 鉴权（v1 实现 EO Token 鉴权方式 A）——URL 无 S3 签名，CDN 以控制台
//     配置的私有回源凭证直读私有对象；URL 在 ttl 窗口内稳定，跨会话可命中缓存；
//   - custom：编译期注册的自定义提供者（registerUrlSigner，见 custom-signer.ts；
//     运行时动态插件明确不做，ADR-0019）。
// 消费范围（spec.md §6.7）：所有 GET 形态签名 URL——分发端分片直出、管理端 original / 封面 /
// 水印图 302、Worker 取源片与水印图。写入路径（presignPut / put）不在此列，仍走 S3 SDK。
import { typeAUrl } from "@openvod/crypto";

export type SignMode = "s3_presign" | "cdn_url_auth" | "custom";

/** 统一签名语义：key 为不含 root 前缀的业务相对键（与 StorageAdapter 其余方法一致） */
export interface UrlSigner {
  sign(key: string, ttlSec: number): Promise<string>;
}

/** EO Token 鉴权方式 A 的 URL 内 rand / uid 固定常量（不做随机，保窗口内 URL 稳定 = 缓存友好） */
export const TYPEA_FIXED_RAND = "openvod";
export const TYPEA_FIXED_UID = "0";

/** EO TypeA 窗口对齐（ADR-0019 / spec.md §6.7）：
 *  timestamp = ⌊(now + ttl) / ttl⌋ · ttl，恒有 now < timestamp ≤ now + ttl。
 *  同一 ttl 窗口内 timestamp 不变 → URL（含缓存键）稳定；CDN 侧过期 = timestamp + 控制台有效时长，
 *  实际有效期 ∈ (控制台时长, 控制台时长 + ttl]，不会在签发瞬间已过期。 */
export function typeAWindowTimestamp(nowSec: number, ttlSec: number): number {
  return Math.floor((nowSec + ttlSec) / ttlSec) * ttlSec;
}

export interface EdgeOneTypeASignerOptions {
  /** 签名 URL 的 host（加速域名，storage_cdn_base_url 在 cdn_url_auth 模式下的语义） */
  baseUrl: string;
  /** CDN 边缘鉴权密钥（storage_cdn_auth_key，与 CDN 控制台同款密钥双侧一致） */
  key: string;
  /** 鉴权窗口（秒，storage_cdn_auth_ttl_sec；应与 EO 控制台「有效时长」一致，为实际有效期下限） */
  windowTtlSec?: number;
  /** 鉴权 query 参数名（EO 控制台自定义，默认 sign；部署文档要求两侧一致） */
  authParam?: string;
  /** 显式注入当前时间（测试用；缺省取系统时钟） */
  nowSec?: number;
}

/** EO Token 鉴权方式 A 签名器：{base}/{fullKey}?sign={ts}-{rand}-{uid}-{md5}（md5(path-ts-rand-uid-key)）。
 *  注意与 s3_presign 的语义差异：窗口取 storage_cdn_auth_ttl_sec（调用方 ttlSec 仅作下限参考被忽略），
 *  这是「窗口内 URL 稳定 = 缓存键稳定」的前提；需要更长的有效期就调大该设置（控制台同步调大）。 */
export function createEdgeOneTypeASigner(opts: EdgeOneTypeASignerOptions): UrlSigner {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("cdn_url_auth 需要 storage_cdn_base_url（签名 URL 的加速域名）");
  if (!opts.key) throw new Error("cdn_url_auth 需要 storage_cdn_auth_key（CDN 边缘鉴权密钥）");
  const windowTtlSec = opts.windowTtlSec ?? 3600;
  if (!Number.isInteger(windowTtlSec) || windowTtlSec < 60) {
    throw new Error("storage_cdn_auth_ttl_sec 必须为 ≥60 的整数（秒）");
  }
  const authParam = opts.authParam ?? "sign";
  return {
    sign(key: string, _ttlSec: number): Promise<string> {
      // 注意：签名 path 含 root 前缀（CDN 回源桶时 URL path 即完整对象键）；
      // path-style 回源（path 带桶名）等非 EO 标准拓扑请改用 custom 提供者
      const path = `/${key.replace(/^\/+/, "")}`;
      const timestamp = typeAWindowTimestamp(opts.nowSec ?? Math.floor(Date.now() / 1000), windowTtlSec);
      const url = typeAUrl(base, path, opts.key, {
        timestamp,
        rand: TYPEA_FIXED_RAND,
        uid: TYPEA_FIXED_UID,
      });
      // EO 控制台的鉴权参数名可自定义（默认 sign）；两侧必须一致（deploy 文档前置清单）
      return Promise.resolve(authParam === "sign" ? url : url.replace("?sign=", `?${authParam}=`));
    },
  };
}

/**
 * 自定义签名提供者注册表（编译期注入，ADR-0019）：
 * 自托管自编译用户实现 UrlSigner 后调用 registerUrlSigner(name, factory) 注册，
 * settings 的 storage_sign_mode="custom" + storage_custom_signer=name 即路由到该实现。
 * 注册入口统一收口在 ./custom-signer.ts（用户 / 其 Agent 编辑该文件后重新构建）。
 */
const registry = new Map<string, () => UrlSigner | Promise<UrlSigner>>();

export function registerUrlSigner(name: string, factory: () => UrlSigner | Promise<UrlSigner>): void {
  const normalized = name.trim();
  if (!normalized) throw new Error("registerUrlSigner：提供者名不能为空");
  registry.set(normalized, factory);
}

export function getRegisteredUrlSignerFactory(name: string): (() => UrlSigner | Promise<UrlSigner>) | undefined {
  return registry.get(name.trim());
}

export interface UrlSignerFactoryDeps {
  signMode: SignMode;
  /** s3_presign 后端：raw SigV4 预签名（含 cdn origin 替换，即现有 presignGet 行为） */
  s3Presign?: (key: string, ttlSec: number) => Promise<string>;
  /** cdn_base_url（s3_presign 模式由 s3Presign 内部消费；cdn_url_auth 模式为签名 host） */
  cdnBaseUrl?: string;
  cdnAuthKey?: string;
  /** cdn_url_auth 的对齐窗口（storage_cdn_auth_ttl_sec，默认 3600） */
  cdnAuthTtlSec?: number;
  customSignerName?: string;
}

/** 按 sign mode 装配 UrlSigner（createStorage 的 GET 签名入口，spec.md §6.7 提供者契约） */
export function createUrlSigner(deps: UrlSignerFactoryDeps): UrlSigner {
  switch (deps.signMode) {
    case "cdn_url_auth":
      return createEdgeOneTypeASigner({
        baseUrl: deps.cdnBaseUrl ?? "",
        key: deps.cdnAuthKey ?? "",
        windowTtlSec: deps.cdnAuthTtlSec,
      });
    case "custom": {
      const name = (deps.customSignerName ?? "custom").trim() || "custom";
      const factory = getRegisteredUrlSignerFactory(name);
      if (!factory) {
        throw new Error(
          `自定义签名提供者「${name}」未注册：请在 packages/storage/src/custom-signer.ts 实现并 registerUrlSigner 后重新构建（ADR-0019）`,
        );
      }
      // 工厂可能异步（含远程配置拉取的自定义实现）；统一抹平为 Promise
      const signer = factory();
      const resolved = signer instanceof Promise ? signer : Promise.resolve(signer);
      return { sign: (key, ttlSec) => resolved.then((s) => s.sign(key, ttlSec)) };
    }
    case "s3_presign":
    default: {
      const s3Presign = deps.s3Presign;
      if (!s3Presign) throw new Error("s3_presign 模式缺少 SigV4 预签名后端");
      return { sign: (key, ttlSec) => s3Presign(key, ttlSec) };
    }
  }
}
