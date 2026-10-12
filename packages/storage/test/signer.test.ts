// UrlSigner 提供者测试（ADR-0019）：
//   - EO TypeA 对齐官方文档示例向量（fixtures/url-sign-v1.json，source 标注来源）；
//   - 窗口对齐公式（timestamp 恒 > now，同窗口稳定）；
//   - 工厂按 sign mode 装配 + custom 注册表路由 + 未注册报错指引。
// fixtures 缺失时 skip（与 crypto interop 测试同一前置，task vectors / 提交物入库保证）。
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  TYPEA_FIXED_RAND,
  TYPEA_FIXED_UID,
  createEdgeOneTypeASigner,
  createUrlSigner,
  getRegisteredUrlSignerFactory,
  registerUrlSigner,
  typeAWindowTimestamp,
} from "../src/signer";

const FIXTURE_PATH = resolve(import.meta.dir, "../../crypto/fixtures/url-sign-v1.json");
const hasFixture = existsSync(FIXTURE_PATH);
const fixture = hasFixture
  ? (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      fixed_rand: string;
      fixed_uid: string;
      vectors: Array<{
        name: string;
        path: string;
        timestamp: number;
        rand: string;
        uid: string;
        key: string;
        md5hash: string;
        sign: string;
      }>;
      window_alignment: { formula: string; vectors: Array<{ name: string; now: number; ttl: number; timestamp: number }> };
    })
  : null;

test("fixtures 存在（ADR-0019 要求先产 fixtures 再接入）", () => {
  expect(hasFixture).toBe(true);
});

test("EO TypeA 官方向量：固定 rand/uid 约定与 fixtures 一致", () => {
  expect(fixture).not.toBeNull();
  expect(fixture!.fixed_rand).toBe(TYPEA_FIXED_RAND);
  expect(fixture!.fixed_uid).toBe(TYPEA_FIXED_UID);
});

test("窗口对齐公式：fixtures 全向量", () => {
  expect(fixture).not.toBeNull();
  for (const v of fixture!.window_alignment.vectors) {
    expect(typeAWindowTimestamp(v.now, v.ttl)).toBe(v.timestamp);
    // 不变量：timestamp 恒 > now 且 ≤ now + ttl（签发瞬间不会已过期）
    expect(typeAWindowTimestamp(v.now, v.ttl)).toBeGreaterThan(v.now);
    expect(typeAWindowTimestamp(v.now, v.ttl)).toBeLessThanOrEqual(v.now + v.ttl);
  }
});

test("窗口对齐：同窗口内 URL 稳定，跨窗口变化", () => {
  // 同一 3600 窗口内取多个时刻 → 同一 timestamp（缓存键稳定）
  const t0 = 1721030400; // 窗口边界
  const a = typeAWindowTimestamp(t0, 3600);
  const b = typeAWindowTimestamp(t0 + 1, 3600);
  const c = typeAWindowTimestamp(t0 + 3599, 3600);
  const d = typeAWindowTimestamp(t0 + 3600, 3600);
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(c).not.toBe(d); // 跨过窗口边界才变化
});

test("EO TypeA 签名器：URL 形态与官方向量一致", () => {
  expect(fixture).not.toBeNull();
  const v = fixture!.vectors[1]!; // openvod-fixed-rand-uid
  const signer = createEdgeOneTypeASigner({
    baseUrl: "https://cdn.example.com",
    key: v.key,
    windowTtlSec: 3600,
    // 注入窗口内任一时刻（timestamp-1），对齐结果即 fixtures 的 timestamp
    nowSec: v.timestamp - 1,
  });
  // 注意：signer 的 key 参数即 fixtures 的 key（不含 root 前缀，path 由 baseUrl+fullKey 构成）
  const path = v.path.replace(/^\/+/, "");
  return signer.sign(path, 3600).then((url) => {
    expect(url).toBe(`https://cdn.example.com${v.path}?sign=${v.sign}`);
  });
});

test("EO TypeA 签名器：缺 baseUrl / key / 窗口过小直接报错（懒校验移到构造期）", () => {
  expect(() => createEdgeOneTypeASigner({ baseUrl: "", key: "k" })).toThrow(/storage_cdn_base_url/);
  expect(() => createEdgeOneTypeASigner({ baseUrl: "https://cdn.example.com", key: "" })).toThrow(
    /storage_cdn_auth_key/,
  );
  expect(() =>
    createEdgeOneTypeASigner({ baseUrl: "https://cdn.example.com", key: "k", windowTtlSec: 10 }),
  ).toThrow(/storage_cdn_auth_ttl_sec/);
});

test("工厂：s3_presign 委托后端（ttl 透传）", async () => {
  const calls: Array<[string, number]> = [];
  const signer = createUrlSigner({
    signMode: "s3_presign",
    s3Presign: async (key, ttlSec) => {
      calls.push([key, ttlSec]);
      return `https://s3.example.com/${key}?X-Amz-Signature=demo&ttl=${ttlSec}`;
    },
  });
  const url = await signer.sign("proceed/x/seg.ts", 600);
  expect(url).toBe("https://s3.example.com/proceed/x/seg.ts?X-Amz-Signature=demo&ttl=600");
  expect(calls).toEqual([["proceed/x/seg.ts", 600]]);
});

test("工厂：cdn_url_auth 装配 TypeA（窗口取 cdnAuthTtlSec）", async () => {
  const signer = createUrlSigner({
    signMode: "cdn_url_auth",
    cdnBaseUrl: "https://cdn.example.com",
    cdnAuthKey: "0123456789abcdef0123456789abcdef",
    cdnAuthTtlSec: 3600,
  });
  const url = await signer.sign("proceed/med00001/tpl00001/seg-000.ts", 600);
  // 调用方 ttl（600）被忽略；timestamp 按 3600 窗口对齐
  const ts = typeAWindowTimestamp(Math.floor(Date.now() / 1000), 3600);
  expect(url).toContain("https://cdn.example.com/proceed/med00001/tpl00001/seg-000.ts?sign=");
  expect(url).toContain(`?sign=${ts}-openvod-0-`);
});

test("工厂：custom 路由到注册表；未注册时报错并指明注册文件", async () => {
  registerUrlSigner("test-prov", () => ({
    sign: async (key) => `https://custom.example.com/${key}?sig=x`,
  }));
  const signer = createUrlSigner({ signMode: "custom", customSignerName: "test-prov" });
  expect(getRegisteredUrlSignerFactory("test-prov")).toBeDefined();
  expect(await signer.sign("a/b.ts", 60)).toBe("https://custom.example.com/a/b.ts?sig=x");

  const missing = () => createUrlSigner({ signMode: "custom", customSignerName: "no-such" });
  expect(missing).toThrow(/custom-signer\.ts/);
});
