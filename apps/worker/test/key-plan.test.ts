// CEK 轮换计划密钥（transcode_jobs.key_plan）解封单测（spec.md §4.4）
// 覆盖：createMediaKey → 计划快照 → materializeMediaKey 往返一致（kid/iv/wrapped/明文 CEK）、
// 快照非法 → MediaKeyError、MASTER_KEYS 缺版本 → 报错（任务失败可安全重启，hls_keys 未被触碰）。
// 关键不变量：解封结果视作「新生成」——调用方产物上传成功后必须落库（与 resolveMediaKey 的
// reused=false 分支一致）。
import { describe, expect, it } from "bun:test";
import { createMediaKey, openMediaKey, parseMasterKeys, pickWrappingMasterKey } from "@openvod/crypto";
import { materializeMediaKey, MediaKeyError } from "../src/media-keys";

const MKS = parseMasterKeys(`1:${"c".repeat(64)},2:${"d".repeat(64)}`);

describe("materializeMediaKey（轮换计划密钥解封）", () => {
  it("计划快照 → 解封：与生成材料逐字段一致（含明文 CEK 往返）", () => {
    const material = createMediaKey(pickWrappingMasterKey(MKS));
    const plan = {
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex,
      mk_ver: material.mkVer,
    };
    const key = materializeMediaKey(MKS, plan);
    expect(key.kid).toBe(material.kid);
    expect(key.method).toBe(material.method);
    expect(key.ivHex).toBe(material.ivHex);
    expect(key.wrappedCekHex).toBe(material.wrappedCekHex);
    expect(key.mkVer).toBe(material.mkVer);
    expect(key.cek.equals(material.cek)).toBe(true);
  });

  it("旧版本封装的计划密钥仍可解封（MASTER_KEYS 保留历史版本）", () => {
    const material = createMediaKey(MKS.find((m) => m.ver === 1)!);
    const plan = {
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex,
      mk_ver: 1,
    };
    const key = materializeMediaKey(MKS, plan);
    expect(key.cek.equals(material.cek)).toBe(true);
  });

  it("快照缺失 / 非对象 / 字段不齐 → MediaKeyError", () => {
    expect(() => materializeMediaKey(MKS, null)).toThrow(MediaKeyError);
    expect(() => materializeMediaKey(MKS, "junk")).toThrow(MediaKeyError);
    expect(() => materializeMediaKey(MKS, { kid: "k" })).toThrow(MediaKeyError);
  });

  it("wrapped_cek 被篡改（GCM 认证失败）→ 抛错", () => {
    const material = createMediaKey(pickWrappingMasterKey(MKS));
    const bad = {
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex.slice(0, -2) + "00",
      mk_ver: material.mkVer,
    };
    expect(() => materializeMediaKey(MKS, bad)).toThrow();
  });

  it("MASTER_KEYS 缺少计划密钥的封装版本 → 报错并提示保留旧版本", () => {
    const onlyV1 = parseMasterKeys(`1:${"c".repeat(64)}`);
    const material = createMediaKey(MKS.find((m) => m.ver === 2)!);
    const plan = {
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex,
      mk_ver: 2,
    };
    expect(() => materializeMediaKey(onlyV1, plan)).toThrow(/版本 2/);
  });

  it("解封结果可与 hls_keys 复用路径互通（openMediaKey 语义一致）", () => {
    const mk = pickWrappingMasterKey(MKS);
    const material = createMediaKey(mk);
    const key = materializeMediaKey(MKS, {
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex,
      mk_ver: material.mkVer,
    });
    expect(key.cek.equals(openMediaKey(mk, material.wrappedCekHex))).toBe(true);
  });
});
