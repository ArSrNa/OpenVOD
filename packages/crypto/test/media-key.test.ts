// 每媒资密钥材料单测（ADR-0006 §1/§2 + spec.md §4）：生成 / 解封 / 轮换重封装。
// 不依赖 fixtures（纯自洽往返），因此无需先跑 `task vectors`。
import { describe, expect, it } from "bun:test";
import {
  createMediaKey,
  findMasterKey,
  genKid,
  openMediaKey,
  parseMasterKeys,
  pickWrappingMasterKey,
  resealMediaKey,
  type MasterKey,
} from "../src/index";

const MK1: MasterKey = { ver: 1, key: Buffer.from("a".repeat(64), "hex") };
const MK2: MasterKey = { ver: 2, key: Buffer.from("b".repeat(64), "hex") };

describe("MK 选择", () => {
  it("pickWrappingMasterKey 取版本号最大者（轮换后新封装走新版本）", () => {
    expect(pickWrappingMasterKey([MK1, MK2]).ver).toBe(2);
    expect(pickWrappingMasterKey([MK2, MK1]).ver).toBe(2);
  });

  it("pickWrappingMasterKey 空列表抛错（MASTER_KEYS 未配置）", () => {
    expect(() => pickWrappingMasterKey([])).toThrow(/MASTER_KEYS/);
  });

  it("findMasterKey 按版本取；缺失抛错（轮换必须保留旧版本才能解封）", () => {
    expect(findMasterKey([MK1, MK2], 1).ver).toBe(1);
    expect(() => findMasterKey([MK2], 1)).toThrow(/版本 1/);
  });

  it("与 parseMasterKeys 的 env 格式衔接（'版本:64位hex' 逗号分隔）", () => {
    const mks = parseMasterKeys("1:" + "a".repeat(64) + ", 2:" + "b".repeat(64));
    expect(pickWrappingMasterKey(mks).ver).toBe(2);
    expect(findMasterKey(mks, 1).key.length).toBe(32);
  });
});

describe("每媒资密钥材料", () => {
  it("createMediaKey：CEK 16B / IV 16B / kid 32 hex / 落库形态为封装串", () => {
    const m = createMediaKey(MK1);
    expect(m.cek.length).toBe(16);
    expect(m.ivHex).toMatch(/^[0-9a-f]{32}$/);
    expect(m.kid).toMatch(/^[0-9a-f]{32}$/);
    expect(m.method).toBe("AES-128");
    expect(m.mkVer).toBe(1);
    // 明文绝不出现在落库字段里
    expect(m.wrappedCekHex).not.toContain(m.cek.toString("hex"));
    expect(m.wrappedCekHex.length).toBeGreaterThan(32);
  });

  it("openMediaKey 往返一致（分发端 /key 响应与重封装都用它）", () => {
    const m = createMediaKey(MK1);
    expect(openMediaKey(MK1, m.wrappedCekHex).toString("hex")).toBe(m.cek.toString("hex"));
  });

  it("错误 MK 解封抛错（GCM 认证失败，不返回垃圾明文）", () => {
    const m = createMediaKey(MK1);
    expect(() => openMediaKey(MK2, m.wrappedCekHex)).toThrow();
  });

  it("封装串被篡改时解封抛错", () => {
    const m = createMediaKey(MK1);
    const tampered = "00" + m.wrappedCekHex.slice(2);
    expect(() => openMediaKey(MK1, tampered)).toThrow();
  });

  it("kid 随机：批量生成不重复", () => {
    const kids = new Set(Array.from({ length: 128 }, () => genKid()));
    expect(kids.size).toBe(128);
  });

  it("同一媒资重转码 = 新 kid 换新 CEK（不复用旧密钥）", () => {
    const first = createMediaKey(MK1);
    const second = createMediaKey(MK1);
    expect(second.kid).not.toBe(first.kid);
    expect(second.cek.toString("hex")).not.toBe(first.cek.toString("hex"));
    expect(second.ivHex).not.toBe(first.ivHex);
  });
});

describe("MK 轮换重封装（ADR-0006 §6：不重转码）", () => {
  it("1 → 2：CEK 明文不变，封装串与版本更新", () => {
    const before = createMediaKey(MK1);
    const after = resealMediaKey([MK1, MK2], { wrappedCekHex: before.wrappedCekHex, mkVer: before.mkVer });
    expect(after.mkVer).toBe(2);
    expect(after.wrappedCekHex).not.toBe(before.wrappedCekHex);
    // 同一个 CEK：媒体字节无需重转码即可继续解密
    expect(openMediaKey(MK2, after.wrappedCekHex).toString("hex")).toBe(before.cek.toString("hex"));
    // 旧版本已不能再解封新封装串
    expect(() => openMediaKey(MK1, after.wrappedCekHex)).toThrow();
  });

  it("已是 active 版本时幂等（全表重复扫描安全）", () => {
    const m = createMediaKey(MK2);
    const again = resealMediaKey([MK1, MK2], { wrappedCekHex: m.wrappedCekHex, mkVer: m.mkVer });
    expect(again).toEqual({ wrappedCekHex: m.wrappedCekHex, mkVer: 2 });
  });

  it("封装所用 MK 版本不在 MASTER_KEYS 中时抛错（提示保留旧版本）", () => {
    const m = createMediaKey(MK1);
    expect(() => resealMediaKey([MK2], { wrappedCekHex: m.wrappedCekHex, mkVer: m.mkVer })).toThrow(
      /版本 1/,
    );
  });
});
