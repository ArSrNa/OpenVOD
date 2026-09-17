// 互通向量回归：fixtures 与实现不一致立即失败（防双端漂移，ADR-0001）
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { signToken, typeAHash, unwrap, verifyToken, wrap } from "../src/index";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "crypto-v1.json");

if (!existsSync(fixturePath)) {
  console.warn("fixtures 缺失：先执行 `task vectors` 生成（bun packages/crypto/scripts/gen-vectors.ts）");
}

describe("crypto 互通向量", () => {
  it.skipIf(!existsSync(fixturePath))("AES-256-GCM wrap/unwrap 与 fixtures 一致", () => {
    const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
    const mk = Buffer.from(fx.wrap.mk_hex, "hex");
    const pt = Buffer.from(fx.wrap.plaintext_hex, "hex");
    const iv = Buffer.from(fx.wrap.gcm_iv_hex, "hex");
    expect(wrap(mk, pt, { iv }).toString("hex")).toBe(fx.wrap.wrapped_hex);
    expect(unwrap(mk, Buffer.from(fx.wrap.wrapped_hex, "hex")).toString("hex")).toBe(fx.wrap.plaintext_hex);
  });

  it.skipIf(!existsSync(fixturePath))("token 签名与验签和 fixtures 一致", () => {
    const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
    const key = Buffer.from(fx.token.key_hex, "hex");
    expect(signToken(fx.token.payload, key)).toBe(fx.token.token);
    const got = verifyToken(fx.token.token, [{ kid: fx.token.payload.kid, key }], {
      typ: fx.token.payload.typ,
      mid: fx.token.payload.mid,
      nowSec: fx.token.payload.exp - 1,
    });
    expect(got.sid).toBe(fx.token.payload.sid);
  });

  it.skipIf(!existsSync(fixturePath))("TypeA hash 与 fixtures 一致", () => {
    const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(typeAHash(fx.typea.uri, fx.typea.timestamp, fx.typea.rand, fx.typea.uid, fx.typea.key)).toBe(
      fx.typea.sign,
    );
  });

  it("篡改 payload 验签必须失败", () => {
    const key = Buffer.from("c".repeat(64), "hex");
    const payload = {
      ver: 1 as const,
      typ: "k" as const,
      mid: "media_test_01",
      sid: "sess_test_01",
      exp: 1893456000,
      kid: "k_test_01",
    };
    const token = signToken(payload, key);
    const [p64] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, sid: "evil" }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      verifyToken(`${tamperedPayload}.${token.slice(p64.length + 1)}`, [{ kid: payload.kid, key }], {
        nowSec: payload.exp - 1,
      }),
    ).toThrow();
  });
});
