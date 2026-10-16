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
  createEdgeOneSigner,
  createEdgeOneTypeASigner,
  createUrlSigner,
  getRegisteredUrlSignerFactory,
  registerUrlSigner,
  typeAWindowTimestamp,
} from "../src/signer";
import {
  isEdgeOneAuthType,
  typeBHash,
  typeBUrl,
  typeCHash,
  typeCUrl,
  typeDHash,
  typeDUrl,
  typeVHash,
  typeVUrl,
  utc8MinuteString,
} from "@openvod/crypto";
import { CDN_AUTH_TYPES } from "@openvod/shared";

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

// ---- EO Token 鉴权方式 B/C/D/V（官方 5 种全覆盖；fixtures 与 Go 侧共享同一份向量） ----

type EoMethodsFixture = {
  methods: Record<
    string,
    {
      spec: string;
      vectors: Array<{
        name: string;
        base: string;
        path: string;
        timestampSec: number;
        timestamp?: string;
        key: string;
        md5hash?: string;
        t?: string;
        exper?: string;
        us?: string;
        sign?: string;
        url: string;
      }>;
    }
  >;
};

const METHODS_FIXTURE_PATH = resolve(import.meta.dir, "../../crypto/fixtures/url-sign-eo-methods-v1.json");
const hasMethodsFixture = existsSync(METHODS_FIXTURE_PATH);
const methodsFixture = hasMethodsFixture
  ? (JSON.parse(readFileSync(METHODS_FIXTURE_PATH, "utf8")) as EoMethodsFixture)
  : null;

test("EO B/C/D/V fixtures 存在（官方示例 + 本仓对齐向量）", () => {
  expect(hasMethodsFixture).toBe(true);
});

test("isEdgeOneAuthType 与 CDN_AUTH_TYPES 一致（crypto / shared 防漂移）", () => {
  for (const t of CDN_AUTH_TYPES) expect(isEdgeOneAuthType(t)).toBe(true);
  expect(isEdgeOneAuthType("x")).toBe(false);
  expect(isEdgeOneAuthType("")).toBe(false);
});

test("utc8MinuteString：UTC+8 分钟串（不依赖进程时区）", () => {
  expect(utc8MinuteString(1721028830)).toBe("202407151533");
  expect(utc8MinuteString(1721030400)).toBe("202407151600");
});

test("EO 方式 B/C/D/V：hash 与 URL 组装与 fixtures 逐字一致", () => {
  expect(methodsFixture).not.toBeNull();
  for (const [method, m] of Object.entries(methodsFixture!.methods)) {
    for (const v of m.vectors) {
      switch (method) {
        case "b":
          expect(typeBHash(v.path, v.timestamp!, v.key)).toBe(v.md5hash);
          expect(typeBUrl(v.base, v.path, v.key, { timestampSec: v.timestampSec })).toBe(v.url);
          break;
        case "c":
          expect(typeCHash(v.path, v.timestamp!, v.key)).toBe(v.md5hash);
          expect(typeCUrl(v.base, v.path, v.key, { timestampSec: v.timestampSec })).toBe(v.url);
          break;
        case "d":
          expect(typeDHash(v.path, v.timestamp!, v.key)).toBe(v.md5hash);
          expect(typeDUrl(v.base, v.path, v.key, { timestampSec: v.timestampSec })).toBe(v.url);
          break;
        case "v": {
          // hash 覆盖可选参数（官方示例含 us / exper）；本仓组装不生成它们（非 VOD 源站不支持 us / plive）
          expect(typeVHash(v.path, v.key, { t: v.t!, exper: v.exper, us: v.us })).toBe(v.sign);
          if (!v.us && !v.exper) {
            expect(typeVUrl(v.base, v.path, v.key, { timestampSec: v.timestampSec })).toBe(v.url);
          }
          break;
        }
      }
    }
  }
});

test("createEdgeOneSigner：五种方式窗口稳定性 + URL 形态", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const windowStart = 1721026800; // 窗口 [1721026800, 1721030400)
  const mk = (authType: string, nowSec: number) =>
    createEdgeOneSigner({ baseUrl: "https://cdn.example.com", key, authType, windowTtlSec: 3600, nowSec });

  for (const authType of CDN_AUTH_TYPES) {
    const a = await mk(authType, windowStart).sign("proceed/x/seg.ts", 60);
    const b = await mk(authType, windowStart + 3599).sign("proceed/x/seg.ts", 60);
    const c = await mk(authType, windowStart + 3600).sign("proceed/x/seg.ts", 60);
    expect(a).toBe(b); // 同窗口稳定（缓存友好）
    expect(a).not.toBe(c); // 跨窗口变化
  }

  const nowSec = windowStart;
  const sign = (authType: string) =>
    createEdgeOneSigner({
      baseUrl: "https://cdn.example.com",
      key,
      authType,
      windowTtlSec: 3600,
      nowSec,
    }).sign("proceed/x/seg.ts", 60);
  expect(await sign("a")).toMatch(/\?sign=\d+-openvod-0-[0-9a-f]{32}$/);
  expect(await sign("b")).toMatch(/^https:\/\/cdn\.example\.com\/\d{12}\/[0-9a-f]{32}\/proceed\/x\/seg\.ts$/);
  expect(await sign("c")).toMatch(/^https:\/\/cdn\.example\.com\/[0-9a-f]{32}\/[0-9a-f]+\/proceed\/x\/seg\.ts$/);
  expect(await sign("d")).toMatch(/\?token=[0-9a-f]{32}&t=\d+$/);
  expect(await sign("v")).toMatch(/\?t=[0-9a-f]+&sign=[0-9a-f]{40}$/);
});

test("createEdgeOneSigner：V 的 t 为过期时刻（签发即 ≥1 个窗口有效期，另加 EO 300s 容差）", async () => {
  const key = "0123456789abcdef0123456789abcdef";
  const nowSec = 1721026800;
  const url = await createEdgeOneSigner({
    baseUrl: "https://cdn.example.com",
    key,
    authType: "v",
    windowTtlSec: 3600,
    nowSec,
  }).sign("proceed/x/seg.ts", 60);
  const t = parseInt(url.split("?t=")[1]!.split("&")[0]!, 16);
  expect(t).toBe(1721034000); // ⌊(now+ttl)/ttl⌋·ttl + ttl
  expect(t - nowSec).toBeGreaterThanOrEqual(3600);
  expect(t - nowSec).toBeLessThanOrEqual(2 * 3600);
});

test("createEdgeOneSigner：非法 authType / 缺配置报错", () => {
  expect(() => createEdgeOneSigner({ baseUrl: "https://cdn.example.com", key: "k", authType: "x" })).toThrow(
    /storage_cdn_auth_type/,
  );
  expect(() => createEdgeOneSigner({ baseUrl: "", key: "k", authType: "d" })).toThrow(/storage_cdn_base_url/);
  expect(() => createEdgeOneSigner({ baseUrl: "https://cdn.example.com", key: "" })).toThrow(/storage_cdn_auth_key/);
});

test("工厂：cdn_url_auth 按 cdnAuthType 装配（B 方式形态）", async () => {
  const signer = createUrlSigner({
    signMode: "cdn_url_auth",
    cdnBaseUrl: "https://cdn.example.com",
    cdnAuthKey: "0123456789abcdef0123456789abcdef",
    cdnAuthTtlSec: 3600,
    cdnAuthType: "b",
  });
  const url = await signer.sign("proceed/med00001/tpl00001/seg-000.ts", 600);
  expect(url).toMatch(/^https:\/\/cdn\.example\.com\/\d{12}\/[0-9a-f]{32}\/proceed\/med00001\/tpl00001\/seg-000\.ts$/);
});
