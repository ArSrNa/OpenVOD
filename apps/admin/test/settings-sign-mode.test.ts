// 签名方式设置键的纯函数校验（ADR-0019）：白名单 / 枚举 / 密钥标记 / 默认值。
// 不依赖 DB（normalizeSettingValue / settingFallback / isSecretSetting 均为纯函数）。
import { describe, expect, test } from "bun:test";

import {
  SETTING_DEFAULTS,
  SETTING_SECRET_KEYS,
  SETTING_TTL_LIMITS,
} from "@openvod/shared";
import { isSecretSetting, normalizeSettingValue, settingFallback, SettingsError } from "@/lib/settings";

describe("storage_sign_mode（ADR-0019）", () => {
  test("枚举白名单：三种模式合法，空串回退默认", () => {
    for (const mode of ["s3_presign", "cdn_url_auth", "custom"]) {
      expect(normalizeSettingValue("storage_sign_mode", mode)).toBe(mode);
    }
    expect(normalizeSettingValue("storage_sign_mode", "")).toBe("");
  });

  test("枚举外取值拒绝", () => {
    expect(() => normalizeSettingValue("storage_sign_mode", "presign3")).toThrow(SettingsError);
    expect(() => normalizeSettingValue("storage_sign_mode", "cdn_url_auth ")).not.toThrow(); // trim 后合法
  });

  test("密钥键 storage_cdn_auth_key 走白名单（任意值可写，明文入库被上层封装拦截）", () => {
    expect(isSecretSetting("storage_cdn_auth_key")).toBe(true);
    expect((SETTING_SECRET_KEYS as readonly string[]).includes("storage_cdn_auth_key")).toBe(true);
    expect(normalizeSettingValue("storage_cdn_auth_key", "  cdn-key-1  ")).toBe("cdn-key-1");
  });

  test("ttl 范围防呆（60s–7d）", () => {
    const limits = SETTING_TTL_LIMITS["storage_cdn_auth_ttl_sec"];
    expect(limits).toEqual({ min: 60, max: 604800 });
    expect(normalizeSettingValue("storage_cdn_auth_ttl_sec", "3600")).toBe("3600");
    expect(() => normalizeSettingValue("storage_cdn_auth_ttl_sec", "10")).toThrow();
    expect(() => normalizeSettingValue("storage_cdn_auth_ttl_sec", "9999999")).toThrow();
  });

  test("自定义提供者名：1–64 位字母数字下划线短横线", () => {
    expect(normalizeSettingValue("storage_custom_signer", " my-provider_2 ")).toBe("my-provider_2");
    expect(() => normalizeSettingValue("storage_custom_signer", "bad name!")).toThrow();
  });

  test("默认值与 env 兜底键名（STORAGE_SIGN_MODE 等）", () => {
    expect(SETTING_DEFAULTS["storage_sign_mode"]).toBe("s3_presign");
    expect(SETTING_DEFAULTS["storage_cdn_auth_ttl_sec"]).toBe("3600");
    expect(SETTING_DEFAULTS["storage_custom_signer"]).toBe("custom");
    expect(settingFallback("storage_sign_mode", { STORAGE_SIGN_MODE: "cdn_url_auth" })).toEqual({
      value: "cdn_url_auth",
      source: "env",
    });
  });
});

describe("storage_cdn_auth_type（ADR-0019：EO Token 鉴权方式 A/B/C/D/V）", () => {
  test("枚举白名单：五种方式合法（大小写归一化为小写），枚举外拒绝", () => {
    for (const t of ["a", "b", "c", "d", "v"]) {
      expect(normalizeSettingValue("storage_cdn_auth_type", t)).toBe(t);
    }
    expect(normalizeSettingValue("storage_cdn_auth_type", " B ")).toBe("b");
    expect(normalizeSettingValue("storage_cdn_auth_type", "")).toBe("");
    expect(() => normalizeSettingValue("storage_cdn_auth_type", "e")).toThrow(SettingsError);
    expect(() => normalizeSettingValue("storage_cdn_auth_type", "typea")).toThrow(SettingsError);
  });

  test("默认值与 env 兜底（STORAGE_CDN_AUTH_TYPE）", () => {
    expect(SETTING_DEFAULTS["storage_cdn_auth_type"]).toBe("a");
    expect(settingFallback("storage_cdn_auth_type", { STORAGE_CDN_AUTH_TYPE: "v" })).toEqual({
      value: "v",
      source: "env",
    });
    expect(settingFallback("storage_cdn_auth_type", {})).toEqual({ value: "a", source: "default" });
  });
});
