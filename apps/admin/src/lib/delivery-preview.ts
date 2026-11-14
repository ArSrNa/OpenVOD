// 管理端「产物解密播放」预览客户端（服务端专用；spec.md §6）
//
// 关键纪律：明文 CEK 的唯一出口是分发端 key 接口（P0，spec.md §4.3）——
// 管理端只做「以预览账号向分发端换一个签名主清单 URL」，**绝不自行解封 / 转发密钥**；
// 浏览器按标准 HLS 播放（hls.js / Safari 原生），清单、密钥、分片全部由分发端 / 对象存储直达浏览器。
//
// 接入方式（2026-10-16）：改用**播放器 SDK（openvod-jssdk）**的服务端形态——login、
// JWT 缓存 / 401 重登、play 请求组装（templateId → template_id 单点映射）、错误保真全部由 SDK 治理；
// 本文件只保留管理端特有的三件事：预览账号配置读取、`encrypted` 提示（本地 hls_keys 行）、对象桶 CORS 诊断。
// 签名 URL **原样透出**（SDK 不变量 N2）：播放域名由分发端按系统设置 `playback_base_url` 生成（spec §2.1.2），
// 管理端不再兜底改写 URL。
//
// 配置（ADR-0015）：分发端地址取系统设置 `playback_base_url`（控制台「播放设置 → 分发端公开地址」），
// env DELIVERY_BASE_URL 仅作兜底；两者皆空直接报错，不再静默回退 127.0.0.1（容器 / 端口预览下必然连不上）。
// 预览账号 delivery_preview_username（明文设置）+ delivery_preview_password（MK 封装设置），
// env 同名键兜底（预览账号用 apps/admin/scripts/bootstrap-playback.ts 创建，建议专用）。
import { createPlayerSdk, DeliveryError, PlayerSdkError, type PlaybackHandle, type PlayerSdk } from "openvod-jssdk";
import { getDb } from "@openvod/db";

import { getSettingsSnapshot } from "./settings";

const db = getDb<any>();

export class DeliveryPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * 分发端地址解析：系统设置优先，env 兜底。
 * 两者皆空时报 501 而不是回退 127.0.0.1——回环地址在容器 / 端口预览下必然连不上，
 * 只会把「没配地址」伪装成网络故障（`fetch failed`）。
 */
export function resolveBaseUrl(
  settingBaseUrl: string,
  envBaseUrl: string | undefined = process.env.DELIVERY_BASE_URL,
): string {
  const base = (settingBaseUrl.trim() || (envBaseUrl ?? "").trim()).replace(/\/+$/, "");
  if (!base) {
    throw new DeliveryPreviewError(
      "not_implemented",
      "未配置分发端地址：到「播放设置 → 分发端公开地址」填写（或设置环境变量 DELIVERY_BASE_URL）",
      501,
    );
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new DeliveryPreviewError("bad_request", `分发端地址必须是 http(s) 开头的完整地址：${base}`, 400);
  }
  return base;
}

/**
 * SDK 实例缓存：key = [分发端地址, 预览账号, 口令]——三者任一变化即换实例（旧实例 dispose，
 * JWT 缓存与定时器随之失效），等价原先手写 token 缓存的「凭据变化即失效」语义（spec.md §2.1.2）。
 */
let cached: { key: string; sdk: PlayerSdk } | null = null;

/**
 * 取预览账号的 SDK 实例（password 模式：SDK 自己 login + 缓存 JWT + 到期前重登 + 401 重登一次）。
 * `autoRefresh: false`——服务端一次性交付签名 URL、浏览器自行播放，不需要后台续签（避免为已关掉的
 * 预览弹窗长期保活会话）；URL 过期后用户重新点「播放」即换新 token。
 */
async function previewSdk(): Promise<PlayerSdk> {
  const snap = await getSettingsSnapshot();
  const username = snap.admin.previewUsername || process.env.DELIVERY_PREVIEW_USERNAME?.trim() || "";
  const password = snap.admin.previewPassword || process.env.DELIVERY_PREVIEW_PASSWORD || "";
  if (!username || !password) {
    throw new DeliveryPreviewError(
      "not_implemented",
      "未配置播放预览账号（DELIVERY_PREVIEW_USERNAME / DELIVERY_PREVIEW_PASSWORD），见 dev-workflow §5.3",
      501,
    );
  }
  const base = resolveBaseUrl(snap.playbackBaseUrl);
  const key = JSON.stringify([base, username, password]);
  if (cached?.key !== key) {
    cached?.sdk.dispose();
    cached = {
      key,
      sdk: createPlayerSdk({
        baseUrl: base,
        credential: { mode: "password", username, password },
        autoRefresh: false,
      }),
    };
  }
  return cached.sdk;
}

export interface PreviewPlayResult {
  sid: string;
  /** 签名主清单 URL（浏览器直接交给播放器；token 已在 URL 上） */
  manifest_url: string;
  expires_at: string;
  template_id: string;
  /** 该媒资是否加密（hls_keys 有行）——仅用于 UI 提示，密钥仍只由分发端下发 */
  encrypted: boolean;
  /** 浏览器能否直连分片（s3 形态探测对象桶 CORS；null = 未探测 / 探测失败） */
  browser_cors_ok: boolean | null;
}

/**
 * 浏览器 CORS 前置探测（只做诊断，不参与播放；SDK 明确不做诊断探测，见 player-sdk-spec §9）：
 * 以管理端源站为 Origin 试取一个分片，看对象桶是否回 `Access-Control-Allow-Origin`。
 * 未配置桶 CORS 时浏览器的表现就是「有总时长但一直转圈」——这里提前给出结论。
 * 本地形态（分片走分发端自带 CORS）直接返回 true。
 */
async function probeSegmentCors(manifestUrl: string, origin: string): Promise<boolean | null> {
  try {
    const master = await (await fetch(manifestUrl, { cache: "no-store" })).text();
    const variantUrl = master
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("http"));
    if (!variantUrl) return null;
    const variant = await (await fetch(variantUrl, { cache: "no-store" })).text();
    const segUrl = variant
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("http") && !l.includes("/key?"));
    if (!segUrl) return null;
    if (new URL(segUrl).host === new URL(manifestUrl).host) return true; // 分片走分发端（自带 CORS）
    const res = await fetch(segUrl, {
      headers: { Origin: origin, Range: "bytes=0-0" },
      cache: "no-store",
    });
    return Boolean(res.headers.get("access-control-allow-origin"));
  } catch {
    return null;
  }
}

/**
 * SDK 错误 → 管理端错误（错误保真：分发端 code / 文案原样透出）：
 * - 上游 401 必须换状态码——管理端浏览器的 fetchJson 把**任何** 401 都当成自己的会话失效并跳登录页，
 *   预览账号被禁 / 口令过期不能把用户踢出控制台；
 * - status 0 = 网络层失败 / 超时（SDK 文案已含分发端地址与 CORS 提示）→ 502（上游不可达）。
 */
function toPreviewError(error: unknown): DeliveryPreviewError {
  if (error instanceof DeliveryError) {
    if (error.status === 401) {
      return new DeliveryPreviewError(
        error.code,
        `播放预览账号登录失败：${error.message}（检查预览账号与口令，见 dev-workflow §5.3）`,
        502,
      );
    }
    return new DeliveryPreviewError(error.code, error.message, error.status > 0 ? error.status : 502);
  }
  if (error instanceof PlayerSdkError) {
    return new DeliveryPreviewError("internal", `播放预览 SDK 错误（${error.code}）：${error.message}`, 502);
  }
  return new DeliveryPreviewError("internal", (error as Error)?.message ?? "播放预览失败", 502);
}

/**
 * 以预览账号调分发端 play：多套模板产物时由 templateId 指定（空串 = 旧布局产物，null = 自动选择）。
 * probeOrigin 传浏览器请求的 Origin 时，会顺便探测对象桶 CORS（诊断用）。
 */
export async function previewPlay(
  mediaId: string,
  templateId: string | null,
  probeOrigin?: string | null,
): Promise<PreviewPlayResult> {
  const sdk = await previewSdk();

  let handle: PlaybackHandle;
  try {
    // 空串是**显式请求旧布局产物**，不能当作未指定丢弃（null 才是未指定，由分发端自动选择）；
    // 同媒资 + 同模板且未进入 leeway 时 SDK 直接返回缓存 handle（零请求）
    handle = await sdk.play(mediaId, { templateId });
  } catch (e) {
    throw toPreviewError(e);
  }

  const keyRow = await db.hlsKey
    .findUnique({ where: { mediaId }, select: { kid: true } })
    .catch(() => null);

  const corsOk = probeOrigin ? await probeSegmentCors(handle.manifest_url, probeOrigin) : null;

  return {
    sid: handle.sid,
    manifest_url: handle.manifest_url,
    expires_at: handle.expires_at,
    template_id: handle.template_id,
    encrypted: Boolean(keyRow),
    browser_cors_ok: corsOk,
  };
}
