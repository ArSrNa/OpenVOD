import { createHash } from "node:crypto";
import { getDb } from "@openvod/db";
import { SETTINGS_GROUPS, type SettingsGroup, type SettingsEditorResponse } from "./settings-fields";
import { bustCache, isSecretSetting, normalizeSettingValue, settingFallback, SettingsError, wrapSecretValue } from "./settings";

export interface SettingRow { key: string; value: string; updatedAt: Date }
export interface SettingsTransaction {
  systemSetting: {
    findMany: () => Promise<SettingRow[]>;
    upsert: (args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => Promise<unknown>;
    deleteMany: (args: { where: { key: string } }) => Promise<unknown>;
  };
  auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
}
export interface SettingsDatabase extends SettingsTransaction {
  $transaction: <T>(run: (tx: SettingsTransaction) => Promise<T>, options: { isolationLevel: "Serializable" }) => Promise<T>;
}
export interface SettingsEditorDeps {
  db: SettingsDatabase;
  env: Record<string, string | undefined>;
  wrapSecret: (plain: string) => string;
  invalidate: () => void;
}
const dependencies = (): SettingsEditorDeps => ({ db: getDb<SettingsDatabase>(), env: process.env, wrapSecret: wrapSecretValue, invalidate: bustCache });

export function settingsGroup(raw: unknown): SettingsGroup {
  if (typeof raw !== "string" || !Object.hasOwn(SETTINGS_GROUPS, raw)) throw new SettingsError("bad_request", "未知的设置分组");
  return raw as SettingsGroup;
}

function revision(group: SettingsGroup, rows: SettingRow[]): string {
  const keys = new Set<string>(SETTINGS_GROUPS[group].fields.map((f) => f.key));
  const state = rows.filter((row) => keys.has(row.key)).sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => [row.key, row.value, row.updatedAt.toISOString()]);
  // 包含密钥时哈希的是随机 IV 的密文，绝不哈希/暴露明文口令。
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function view(group: SettingsGroup, rows: SettingRow[], env: SettingsEditorDeps["env"]): SettingsEditorResponse {
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return {
    group, revision: revision(group, rows), restart_required: [],
    fields: SETTINGS_GROUPS[group].fields.map((field) => {
      const fallback = settingFallback(field.key, env);
      const overridden = stored.has(field.key);
      const value = overridden ? stored.get(field.key)! : fallback.value;
      const secret = isSecretSetting(field.key);
      return { key: field.key, label: field.label, value: secret ? null : value, source: overridden ? "db" : fallback.source, secret, configured: Boolean(value), overridden };
    }),
  };
}

export async function readSettingsEditor(rawGroup: unknown, deps = dependencies()): Promise<SettingsEditorResponse> {
  const group = settingsGroup(rawGroup);
  // 编辑侧读取失败须明确报错，不能展示回退值后误覆盖真实配置。
  return view(group, await deps.db.systemSetting.findMany(), deps.env);
}

function checkEffective(group: SettingsGroup, values: Map<string, string>, env: SettingsEditorDeps["env"]) {
  const get = (key: string) => values.get(key) ?? settingFallback(key, env).value;
  if (group === "playback") {
    if (Number(get("playback_manifest_ttl_sec")) > Number(get("playback_session_ttl_sec"))) {
      throw new SettingsError("bad_request", "清单签名有效期不能超过播放会话有效期（含环境变量回退值）");
    }
  }
  if (group === "storage") {
    for (const key of ["s3_endpoint", "s3_bucket", "s3_access_key_id", "s3_secret_access_key"]) {
      if (!get(key)) throw new SettingsError("bad_request", "存储端点、桶、Access Key ID 和 Secret Access Key 不能为空；清除覆盖前请先配置环境变量兜底");
    }
    // 签名方式组合校验（ADR-0019）：cdn_url_auth 必须配齐加速域名 + 边缘密钥；
    // custom 提示需先注册提供者（分发端启动 / 刷新时会再校验一次，blob.New 报错保留旧配置）
    const signMode = get("storage_sign_mode") || "s3_presign";
    if (signMode === "cdn_url_auth") {
      if (!get("storage_cdn_base_url")) {
        throw new SettingsError("bad_request", "cdn_url_auth 模式必须配置存储加速域名（签名 URL 的 host）");
      }
      if (!get("storage_cdn_auth_key")) {
        throw new SettingsError("bad_request", "cdn_url_auth 模式必须配置 CDN 边缘鉴权密钥（与 CDN 控制台一致）");
      }
    }
  }
  if (group === "security") {
    for (const key of ["better_auth_secret", "url_sign_key_hex"]) {
      if (!get(key)) throw new SettingsError("bad_request", "管理端会话密钥和播放签名密钥不能清空；请先配置环境变量兜底");
    }
  }
  if (group === "login") {
    if (get("oidc_issuer") && (!get("oidc_client_id") || !get("oidc_client_secret"))) {
      throw new SettingsError("bad_request", "启用 OIDC 需要同时配置 Issuer、Client ID 和 Client Secret");
    }
  }
}

export async function saveSettingsEditor(
  body: unknown,
  actor: { id: string; ip: string | null },
  deps = dependencies(),
): Promise<SettingsEditorResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsError("bad_request", "请求体必须是 JSON 对象");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["group", "revision", "values"].includes(key))) throw new SettingsError("bad_request", "请求包含未定义字段");
  const group = settingsGroup(input.group);
  if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision)) throw new SettingsError("bad_request", "缺少有效配置版本，请重新加载页面");
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new SettingsError("bad_request", "values 必须是设置键值对象");
  const allowed = new Set<string>(SETTINGS_GROUPS[group].fields.map((f) => f.key));
  const entries = Object.entries(input.values).map(([key, raw]) => {
    if (!allowed.has(key)) throw new SettingsError("bad_request", "包含未登记或不属于当前分组的设置键");
    return [key, normalizeSettingValue(key, raw)] as const;
  });
  if (!entries.length) throw new SettingsError("bad_request", "没有需要保存的修改");
  try {
    const result = await deps.db.$transaction(async (tx) => {
      const before = await tx.systemSetting.findMany();
      if (revision(group, before) !== input.revision) throw new SettingsError("bad_request", "设置已被其他管理员修改，请重新加载后再保存", 409);
      const effective = new Map(before.map((row) => [row.key, row.value]));
      for (const [key, value] of entries) {
        if (!value) normalizeSettingValue(key, settingFallback(key, deps.env).value);
        if (value) effective.set(key, value); else effective.delete(key);
      }
      checkEffective(group, effective, deps.env);
      // 校验全部通过后再生成密文、写入，避免失败时留下半套配置。
      const changes: Array<{ key: string; action: string; value: string }> = [];
      for (const [key, plain] of entries) {
        if (plain) {
          const value = isSecretSetting(key) ? deps.wrapSecret(plain) : plain;
          await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        } else await tx.systemSetting.deleteMany({ where: { key } });
        changes.push({ key, action: plain ? "set" : "reset", value: isSecretSetting(key) ? "[redacted]" : plain });
      }
      await tx.auditLog.create({ data: {
        actorType: "admin_user", actorId: actor.id, action: "settings.update", target: group, ip: actor.ip,
        detail: { changes },
      } });
      return view(group, await tx.systemSetting.findMany(), deps.env);
    }, { isolationLevel: "Serializable" });
    deps.invalidate();
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["P2002", "P2034"].includes(String(error.code))) {
      throw new SettingsError("bad_request", "设置保存冲突，请重新加载后再试", 409);
    }
    throw error;
  }
}

/** 与 Cookie 会话配套的写请求防护；信任来源使用保存前的配置。 */
export function checkSettingsOrigin(req: Request, adminBaseUrl: string): void {
  if (req.headers.get("sec-fetch-site") === "cross-site") throw new SettingsError("forbidden", "请从管理端页面提交设置", 403);
  const origin = req.headers.get("origin");
  let expected: string;
  try { expected = new URL(adminBaseUrl || req.url).origin; } catch { throw new SettingsError("forbidden", "管理端地址配置不正确", 403); }
  const requestOrigin = new URL(req.url).origin;
  const forwardedSameSite = req.headers.get("sec-fetch-site") === "same-origin";
  // CNB 网关会重写 Origin 协议，允许同源请求的 http 等同体（与现有 auth 规则一致）。
  if (!origin || origin === "null") {
    if (forwardedSameSite) return;
  } else if (origin === expected || (forwardedSameSite && (origin === requestOrigin || origin === expected.replace(/^https:/, "http:")))) return;
  throw new SettingsError("forbidden", "请求来源与管理端地址不一致", 403);
}

export async function settingsRequestBody(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new SettingsError("bad_request", "请求必须使用 application/json", 415);
  if (!req.body) throw new SettingsError("bad_request", "请求体不能为空");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new SettingsError("bad_request", "设置请求不能超过 64 KiB", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new SettingsError("bad_request", "JSON 格式不正确"); }
}
