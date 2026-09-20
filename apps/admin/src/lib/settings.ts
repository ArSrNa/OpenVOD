// 系统设置（system_settings key-value，控制台运行时可调项）。
// 首个键：控制台播放默认域名 —— 「产物 → 播放」清单 / 密钥请求基址；
// 留空 = 回退 env DELIVERY_BASE_URL（分发端返回的 manifest_url 原样使用）。
// S3 签名播放（ADR-0005 修订）：分片 URL 由分发端按对象存储端点预签名直出，
// 浏览器直连对象存储 / 透传 CDN，与该域名无关。
import { getDb } from "@openvod/db";

import { apiError } from "./envelope";

const db = getDb<any>();

/** 系统设置键（新增可调项在此登记） */
export const SETTING_KEYS = {
  /** 控制台播放默认域名（清单 / 密钥基址；空 = 回退 DELIVERY_BASE_URL） */
  playbackBaseUrl: "playback_base_url",
} as const;

export class SettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** 归一化播放域名：空串 = 清除（回退 env）；非法输入抛 SettingsError */
function normalizeBaseUrl(input: unknown): string {
  const raw = String(input ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SettingsError("bad_request", "播放域名必须是合法的 http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SettingsError("bad_request", "播放域名协议必须是 http / https");
  }
  return raw;
}

/** 读取控制台播放域名（未配置 / 读取失败返回空串，调用方回退 env） */
export async function getPlaybackBaseUrl(): Promise<string> {
  const row = await db.systemSetting.findUnique({
    where: { key: SETTING_KEYS.playbackBaseUrl },
    select: { value: true },
  });
  return row?.value?.trim().replace(/\/+$/, "") || "";
}

/** GET /api/admin/settings 响应体（env 回退值 = 分发端的 DELIVERY_PUBLIC_BASE_URL，UI 提示用） */
export async function getSettings(): Promise<{
  playback_base_url: string;
  env_public_base_url: string;
}> {
  return {
    playback_base_url: await getPlaybackBaseUrl(),
    env_public_base_url: process.env.DELIVERY_PUBLIC_BASE_URL?.trim() || "",
  };
}

/** PUT /api/admin/settings：归一化后 upsert（空串删除行 = 回退 env） */
export async function updateSettings(body: unknown): Promise<{ playback_base_url: string }> {
  const input = (body ?? {}) as { playback_base_url?: unknown };
  if (!("playback_base_url" in input)) {
    throw new SettingsError("bad_request", "缺少 playback_base_url 字段");
  }
  const value = normalizeBaseUrl(input.playback_base_url);
  if (value) {
    await db.systemSetting.upsert({
      where: { key: SETTING_KEYS.playbackBaseUrl },
      create: { key: SETTING_KEYS.playbackBaseUrl, value },
      update: { value },
    });
  } else {
    await db.systemSetting.deleteMany({ where: { key: SETTING_KEYS.playbackBaseUrl } });
  }
  return { playback_base_url: value };
}

/** 路由统一错误映射 */
export function settingsErrorResponse(e: unknown) {
  if (e instanceof SettingsError) {
    return apiError(e.code, e.message, e.status);
  }
  console.error("[settings] unexpected error:", e);
  return apiError("internal", "系统设置操作失败", 500);
}
