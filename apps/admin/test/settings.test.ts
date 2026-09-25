import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../../../packages/db/generated/sqlite";
import { wrap, unwrap } from "@openvod/crypto";
import { checkSettingsOrigin, readSettingsEditor, saveSettingsEditor, settingsRequestBody, type SettingsDatabase, type SettingsEditorDeps } from "../src/lib/settings-editor";
import { normalizeSettingValue, SettingsError } from "../src/lib/settings";
import { reloadable, snapshotCache } from "../src/lib/reloadable";

let directory: string;
let db: PrismaClient;
let invalidations = 0;
const mk = Buffer.alloc(32, 9);
const actor = { id: "settings-test-admin", ip: "127.0.0.1" };
const env = {
  S3_ENDPOINT: "https://s3.example.test", S3_BUCKET: "test-bucket", S3_ACCESS_KEY_ID: "test-id", S3_SECRET_ACCESS_KEY: "test-secret",
  BETTER_AUTH_SECRET: "temporary-test-auth-secret-32-characters", URL_SIGN_KEY_HEX: "b".repeat(64),
  DELIVERY_PUBLIC_BASE_URL: "https://delivery.example.test",
};
function deps(): SettingsEditorDeps {
  return { db: db as unknown as SettingsDatabase, env, wrapSecret: (value) => wrap(mk, Buffer.from(value)).toString("hex"), invalidate: () => { invalidations++; } };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openvod-settings-editor-"));
  const path = join(directory, "test.db");
  await writeFile(path, "");
  const url = `file:${path}`;
  const proc = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("../../../packages/db/node_modules/prisma/build/index.js", import.meta.url)), "db", "push", "--skip-generate", "--schema", fileURLToPath(new URL("../../../packages/db/prisma/schema.sqlite.prisma", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`SQLite setup failed: ${out}\n${err}`);
  db = new PrismaClient({ datasourceUrl: url });
});
beforeEach(async () => { await db.systemSetting.deleteMany(); await db.auditLog.deleteMany(); invalidations = 0; });
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

test("读取配置来源且不回显密钥或密文", async () => {
  const first = await readSettingsEditor("storage", deps());
  expect(first.fields.find((f) => f.key === "s3_endpoint")).toMatchObject({ value: env.S3_ENDPOINT, source: "env", overridden: false });
  expect(first.fields.find((f) => f.key === "s3_secret_access_key")).toMatchObject({ value: null, configured: true, secret: true });
  const saved = await saveSettingsEditor({ group: "storage", revision: first.revision, values: { s3_secret_access_key: "replacement-secret" } }, actor, deps());
  const row = await db.systemSetting.findUniqueOrThrow({ where: { key: "s3_secret_access_key" } });
  expect(row.value).not.toContain("replacement-secret");
  expect(unwrap(mk, Buffer.from(row.value, "hex")).toString()).toBe("replacement-secret");
  expect(JSON.stringify(saved)).not.toContain(row.value);
  expect(JSON.stringify(saved)).not.toContain("replacement-secret");
  expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("replacement-secret");
  expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(row.value);
});

test("保存并重新读取、清除覆盖回退env、保留未提交的密钥", async () => {
  const first = await readSettingsEditor("playback", deps());
  const saved = await saveSettingsEditor({ group: "playback", revision: first.revision, values: { playback_base_url: "https://new.example.test/", delivery_preview_password: "preview-secret" } }, actor, deps());
  expect(saved.fields.find((f) => f.key === "playback_base_url")?.value).toBe("https://new.example.test");
  const secret = await db.systemSetting.findUniqueOrThrow({ where: { key: "delivery_preview_password" } });
  const reset = await saveSettingsEditor({ group: "playback", revision: saved.revision, values: { playback_base_url: "" } }, actor, deps());
  expect(reset.fields.find((f) => f.key === "playback_base_url")).toMatchObject({ value: env.DELIVERY_PUBLIC_BASE_URL, source: "env", overridden: false });
  expect((await db.systemSetting.findUniqueOrThrow({ where: { key: "delivery_preview_password" } })).value).toBe(secret.value);
  expect(invalidations).toBe(2);
});

test("整批校验先于写入，拒绝非法键/类型/TTL组合", async () => {
  const initial = await readSettingsEditor("playback", deps());
  for (const values of [
    { playback_base_url: "https://new.example.test", jwt_ttl_sec: "oops" },
    { setup_completed: "" }, { MASTER_KEYS: "forbidden" }, { s3_bucket: "wrong-group" },
    { playback_base_url: null }, { playback_session_ttl_sec: "300" },
    { playback_manifest_ttl_sec: String(8 * 86400), playback_session_ttl_sec: String(8 * 86400) },
  ]) await expect(saveSettingsEditor({ group: "playback", revision: initial.revision, values }, actor, deps())).rejects.toBeInstanceOf(SettingsError);
  expect(await db.systemSetting.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
});

test("过期版本不能覆盖新配置", async () => {
  const initial = await readSettingsEditor("worker", deps());
  await saveSettingsEditor({ group: "worker", revision: initial.revision, values: { worker_max_attempts: "5" } }, actor, deps());
  try {
    await saveSettingsEditor({ group: "worker", revision: initial.revision, values: { worker_max_attempts: "2" } }, actor, deps());
    throw new Error("should conflict");
  } catch (error) { expect((error as SettingsError).status).toBe(409); }
  expect((await readSettingsEditor("worker", deps())).fields.find((f) => f.key === "worker_max_attempts")?.value).toBe("5");
  expect(await db.auditLog.count()).toBe(1);
});

test("审计失败回滚整批配置", async () => {
  const initial = await readSettingsEditor("worker", deps());
  await db.$executeRawUnsafe("CREATE TRIGGER fail_settings_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
  try {
    await expect(saveSettingsEditor({ group: "worker", revision: initial.revision, values: { worker_max_attempts: "5", worker_lease_ms: "10000" } }, actor, deps())).rejects.toThrow();
    expect(await db.systemSetting.count()).toBe(0);
    expect(invalidations).toBe(0);
  } finally { await db.$executeRawUnsafe("DROP TRIGGER fail_settings_audit"); }
});

test("拒绝凭据URL、无效CORS和前缀逃逸", () => {
  for (const [key, value] of [
    ["s3_endpoint", "https://user:secret@example.test"], ["playback_base_url", "https://example.test?token=secret"],
    ["cors_origins", "https://example.test/path"], ["cors_origins", "*,https://example.test"],
    ["storage_root_prefix", "../other"], ["storage_root_prefix", "x\\y"], ["constructor", "value"],
  ]) expect(() => normalizeSettingValue(key, value)).toThrow();
  expect(normalizeSettingValue("cors_origins", "https://example.test/, https://example.test")).toBe("https://example.test");
});

test("写请求同源校验与64KiB体积限制", async () => {
  const req = (origin: string) => new Request("https://admin.example.test/api/admin/settings", { headers: { Origin: origin } });
  expect(() => checkSettingsOrigin(req("https://evil.example.test"), "https://admin.example.test")).toThrow();
  expect(() => checkSettingsOrigin(req(""), "https://admin.example.test")).toThrow();
  expect(() => checkSettingsOrigin(req("https://admin.example.test"), "https://admin.example.test")).not.toThrow();
  await expect(settingsRequestBody(new Request("https://admin.example.test/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: " ".repeat(65537) }))).rejects.toMatchObject({ status: 413 });
});

test("配置实例刷新：并发合并、变更重建、失败可重试", async () => {
  let builds = 0;
  const load = reloadable(async (key) => { builds++; if (key === "bad") throw new Error("build failed"); return { key }; });
  const [a, b] = await Promise.all([load("a"), load("a")]);
  expect(a).toBe(b);
  expect(builds).toBe(1);
  expect((await load("b")).key).toBe("b");
  await expect(load("bad")).rejects.toThrow();
  await expect(load("bad")).rejects.toThrow();
  expect(builds).toBe(4);
});

test("login 分组启用 OIDC 需要 Issuer、Client ID 与 Client Secret 齐备", async () => {
  const initial = await readSettingsEditor("login", deps());
  for (const values of [
    { oidc_issuer: "https://idp.example.test" },
    { oidc_issuer: "https://idp.example.test", oidc_client_id: "client" },
    { oidc_issuer: "https://idp.example.test", oidc_client_secret: "shh" },
  ]) await expect(saveSettingsEditor({ group: "login", revision: initial.revision, values }, actor, deps())).rejects.toThrow("启用 OIDC 需要同时配置 Issuer、Client ID 和 Client Secret");
  const complete = await saveSettingsEditor({ group: "login", revision: initial.revision, values: { oidc_issuer: "https://idp.example.test", oidc_client_id: "client", oidc_client_secret: "shh" } }, actor, deps());
  expect(complete.fields.find((f) => f.key === "oidc_issuer")?.value).toBe("https://idp.example.test");
  expect(await db.systemSetting.findUniqueOrThrow({ where: { key: "oidc_client_secret" } })).toBeTruthy();
  expect(await db.systemSetting.count()).toBe(3);
});

test("清除覆盖前校验将启用的环境回退值", async () => {
  const first = await readSettingsEditor("security", deps());
  const saved = await saveSettingsEditor({ group: "security", revision: first.revision, values: { url_sign_key_hex: "a".repeat(64) } }, actor, deps());
  const invalidEnv = { ...deps(), env: { ...env, URL_SIGN_KEY_HEX: "invalid-fallback" } };
  await expect(saveSettingsEditor({ group: "security", revision: saved.revision, values: { url_sign_key_hex: "" } }, actor, invalidEnv)).rejects.toBeInstanceOf(SettingsError);
  expect(await db.systemSetting.count()).toBe(1);
});

test("快照刷新失败保留最近有效值，冷启动失败可重试", async () => {
  let time = 1;
  let fail = true;
  let value = "old";
  const cache = snapshotCache(async () => { if (fail) throw new Error("temporary failure"); return value; }, 30, () => time);
  await expect(cache.read()).rejects.toThrow();
  fail = false;
  expect(await cache.read()).toBe("old");
  time = 32; fail = true;
  expect(await cache.read()).toBe("old");
  fail = false; value = "new"; time = 63;
  expect(await cache.read()).toBe("new");
});

test("保存失效后不接受之前在途查询返回的旧配置", async () => {
  let release!: (value: string) => void;
  let calls = 0;
  const cache = snapshotCache(() => ++calls === 1 ? new Promise<string>((resolve) => { release = resolve; }) : Promise.resolve("new"), 30000);
  const oldRead = cache.read();
  await Promise.resolve();
  cache.invalidate();
  expect(await cache.read()).toBe("new");
  release("old");
  expect(await oldRead).toBe("new");
  expect(await cache.read()).toBe("new");
});
