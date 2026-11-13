// 生成 TS/Go 加密互通测试向量（ADR-0001：公共逻辑双实现，必须以共享 fixtures 保证互通）
// 全部使用测试专用材料（非生产密钥），可安全入库。
// 生成：bun packages/crypto/scripts/gen-vectors.ts → packages/crypto/fixtures/crypto-v1.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, typeAHash, wrap } from "../src/index";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
mkdirSync(outDir, { recursive: true });

const mk = Buffer.from("a".repeat(64), "hex"); // 32B 测试 MK
const plaintext = Buffer.from("0123456789abcdef0123456789abcdef", "hex"); // 16B（如 CEK）
const fixedGcmIv = Buffer.from("b".repeat(24), "hex"); // 12B，固定以获得确定性输出

const wrapped = wrap(mk, plaintext, { iv: fixedGcmIv });

const tokenKey = Buffer.from("c".repeat(64), "hex"); // 32B 测试 HMAC key
const payload = {
  ver: 1 as const,
  typ: "k" as const,
  mid: "media_test_01",
  sid: "sess_test_01",
  exp: 1893456000, // 2030-01-01
  kid: "k_test_01",
};

// 共享 token（ADR-0009 2026-11-13 修订）：sid 省略 = 不绑会话（字幕 CDN 缓存形态）。
// JSON.stringify 丢弃 undefined → 字段整体缺失，与 Go omitempty 序列化逐字一致。
const sharedPayload = {
  ver: 1 as const,
  typ: "v" as const,
  mid: "media_test_01",
  sid: undefined,
  exp: 1893456000, // 2030-01-01
  kid: "k_test_01",
} as const;

const typeA = {
  key: "typea_test_key",
  uri: "/hls/media_test_01/720p/seg-0.ts",
  timestamp: 1893456000,
  rand: "0", // 固定 rand 以获得确定性输出
  uid: "0",
};

const fixture = {
  // AES-256-GCM wrap（Go 侧 unwrap 对照）
  wrap: {
    mk_hex: mk.toString("hex"),
    plaintext_hex: plaintext.toString("hex"),
    gcm_iv_hex: fixedGcmIv.toString("hex"),
    wrapped_hex: wrapped.toString("hex"),
  },
  // 分发端签名 token（Go 侧 sign/verify 对照，ADR-0006 §4）
  token: {
    key_hex: tokenKey.toString("hex"),
    payload,
    token: signToken(payload, tokenKey),
  },
  // 共享 token（sid 省略；字幕 CDN 缓存形态，ADR-0009 2026-11-13 修订）
  token_shared: {
    key_hex: tokenKey.toString("hex"),
    payload: sharedPayload,
    token: signToken(sharedPayload, tokenKey),
  },
  // EdgeOne TypeA（Go 侧对照，ADR-0005）
  typea: {
    ...typeA,
    sign: typeAHash(typeA.uri, typeA.timestamp, typeA.rand, typeA.uid, typeA.key),
  },
};

const file = join(outDir, "crypto-v1.json");
writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote", file);
