// 管理端「产物解密播放」预览客户端（服务端专用；spec.md §6）
//
// 关键纪律：明文 CEK 的唯一出口是分发端 key 接口（P0，spec.md §4.3）——
// 管理端只做「以预览账号向分发端换一个签名主清单 URL」，**绝不自行解封 / 转发密钥**；
// 浏览器按标准 HLS 播放（hls.js / Safari 原生），清单、密钥、分片全部由分发端 / 对象存储直达浏览器。
//
// 配置（.env）：DELIVERY_BASE_URL、DELIVERY_PREVIEW_USERNAME、DELIVERY_PREVIEW_PASSWORD
// （预览账号用 apps/admin/scripts/bootstrap-playback.ts 创建，建议专用、只配本机/内网可达地址）。
import { getDb } from "@openvod/db";

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

function baseUrl(): string {
  return (process.env.DELIVERY_BASE_URL?.trim() || "http://127.0.0.1:9000").replace(/\/+$/, "");
}

type TokenCache = { value: string; expiresAtSec: number };
let cached: TokenCache | null = null;

/** 取预览账号 JWT（进程内缓存到过期前 60s，避免每次点击都 login，ADR-0007 无 refresh） */
async function previewToken(): Promise<string> {
  const username = process.env.DELIVERY_PREVIEW_USERNAME?.trim();
  const password = process.env.DELIVERY_PREVIEW_PASSWORD ?? "";
  if (!username || !password) {
    throw new DeliveryPreviewError(
      "not_implemented",
      "未配置播放预览账号（DELIVERY_PREVIEW_USERNAME / DELIVERY_PREVIEW_PASSWORD），见 dev-workflow §5.3",
      501,
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAtSec - 60 > nowSec) return cached.value;

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
    });
  } catch (e) {
    throw new DeliveryPreviewError("internal", `无法连接分发端（${baseUrl()}）：${(e as Error).message}`, 502);
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: { message?: string } }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new DeliveryPreviewError(
      "internal",
      `播放预览账号登录失败（HTTP ${res.status}）：${body?.error?.message ?? "请检查账号与分发端日志"}`,
      502,
    );
  }
  cached = { value: body.access_token, expiresAtSec: nowSec + (body.expires_in ?? 3600) };
  return cached.value;
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
 * 浏览器 CORS 前置探测（只做诊断，不参与播放）：
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
 * 以预览账号调分发端 play：多套模板产物时由 templateId 指定（空串 = 旧布局产物，null = 自动选择）。
 * probeOrigin 传浏览器请求的 Origin 时，会顺便探测对象桶 CORS（诊断用）。
 */
export async function previewPlay(
  mediaId: string,
  templateId: string | null,
  probeOrigin?: string | null,
): Promise<PreviewPlayResult> {
  const token = await previewToken();
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/media/${mediaId}/play`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // 注意：空串是**显式请求旧布局产物**，不能当作未指定丢弃（null 才是未指定，由分发端自动选择）
      body: JSON.stringify(templateId !== null ? { template_id: templateId } : {}),
      cache: "no-store",
    });
  } catch (e) {
    throw new DeliveryPreviewError("internal", `无法连接分发端（${baseUrl()}）：${(e as Error).message}`, 502);
  }
  const body = (await res.json().catch(() => null)) as
    | ({ sid?: string; manifest_url?: string; expires_at?: string; template_id?: string } & {
        error?: { code?: string; message?: string };
      })
    | null;
  if (!res.ok || !body?.manifest_url) {
    const status = res.status === 404 ? 404 : 409;
    throw new DeliveryPreviewError(body?.error?.code ?? "internal", body?.error?.message ?? `分发端返回 HTTP ${res.status}`, status);
  }

  const keyRow = await db.hlsKey
    .findUnique({ where: { mediaId }, select: { kid: true } })
    .catch(() => null);

  const corsOk = probeOrigin ? await probeSegmentCors(body.manifest_url, probeOrigin) : null;

  return {
    sid: body.sid ?? "",
    manifest_url: body.manifest_url,
    expires_at: body.expires_at ?? "",
    template_id: body.template_id ?? "",
    encrypted: Boolean(keyRow),
    browser_cors_ok: corsOk,
  };
}
