// scripts/init-env.ts 纯函数单测（Bun test）。
// 覆盖：值转义 / 模板渲染 / MASTER_KEYS 与连接串校验 / 掩码 / 占位值检测。
// 校验规则对齐 gen-env.sh --check 与 apps/admin/src/lib/master-keys.ts（ADR-0006 / 0015）。
import { describe, expect, test } from "bun:test";
import {
  maskSecret,
  maskURL,
  parseTemplate,
  placeholderWarnings,
  quoteEnvValue,
  renderEnvFile,
  validateHex64,
  validateMasterKeys,
  validateMysqlURL,
} from "./init-env";

const HEX32 = "a".repeat(64);
const MK = `1:${HEX32}`;

describe("quoteEnvValue", () => {
  test("转义 \\ \" $ `（与 gen-env.sh quote_val 一致）", () => {
    expect(quoteEnvValue('a\\b"c$d`e')).toBe('a\\\\b\\"c\\$d\\`e');
  });
  test("普通值原样", () => {
    expect(quoteEnvValue("file:./dev.db")).toBe("file:./dev.db");
  });
});

describe("parseTemplate", () => {
  test("取默认值并识别注释掉的可选键", () => {
    const { defaults, commented } = parseTemplate(
      [
        'DATABASE_URL="mysql://openvod:changeit@127.0.0.1:3306/openvod"',
        'ADMIN_PORT="8787"',
        '# URL_SIGN_KEY_HEX=""',
        "纯注释行",
        "",
      ].join("\n"),
    );
    expect(defaults.DATABASE_URL).toBe("mysql://openvod:changeit@127.0.0.1:3306/openvod");
    expect(defaults.ADMIN_PORT).toBe("8787");
    expect(defaults.URL_SIGN_KEY_HEX).toBe("");
    expect(commented.has("URL_SIGN_KEY_HEX")).toBe(true);
    expect(commented.has("DATABASE_URL")).toBe(false);
  });
});

describe("renderEnvFile", () => {
  const template = [
    "# 头注释",
    'DATABASE_URL="mysql://openvod:changeit@127.0.0.1:3306/openvod"',
    '# URL_SIGN_KEY_HEX=""',
    'DELIVERY_PUBLIC_BASE_URL=""',
    "",
  ].join("\n");

  test("覆盖已有键，保留注释 / 空行", () => {
    const out = renderEnvFile(template, { DATABASE_URL: "file:./dev.db" });
    expect(out).toContain("# 头注释");
    expect(out).toContain('DATABASE_URL="file:./dev.db"');
    expect(out).toContain('# URL_SIGN_KEY_HEX=""');
    expect(out).toContain('DELIVERY_PUBLIC_BASE_URL=""');
    expect(out.endsWith("\n")).toBe(true);
  });

  test("注释行赋值即取消注释；空值保持注释", () => {
    const out = renderEnvFile(template, { URL_SIGN_KEY_HEX: HEX32 });
    expect(out).toContain(`URL_SIGN_KEY_HEX="${HEX32}"`);
    expect(out).not.toContain("# URL_SIGN_KEY_HEX");

    const untouched = renderEnvFile(template, {});
    expect(untouched).toContain('# URL_SIGN_KEY_HEX=""');
  });

  test("values 含模板没有的键 → 追加额外键区块", () => {
    const out = renderEnvFile(template, { EXTRA_KEY: "v1" });
    expect(out).toContain('EXTRA_KEY="v1"');
    expect(out).toContain("向导追加");
  });

  test("转义值中的特殊字符", () => {
    const out = renderEnvFile(template, { DATABASE_URL: 'mysql://u:p$a"ss@h/db' });
    expect(out).toContain('DATABASE_URL="mysql://u:p\\$a\\"ss@h/db"');
  });
});

describe("validateMasterKeys", () => {
  test("合法：单版本 / 多版本", () => {
    expect(validateMasterKeys(MK)).toBeUndefined();
    expect(validateMasterKeys(`1:${HEX32},2:${"b".repeat(64)}`)).toBeUndefined();
  });
  test("空值", () => {
    expect(validateMasterKeys("")).toContain("不能为空");
  });
  test("引号 / 空白 / 全角冒号形态提示", () => {
    expect(validateMasterKeys(`"${MK}"`)).toContain("引号");
    expect(validateMasterKeys(` 1:${HEX32} x`)).toContain("空白");
    expect(validateMasterKeys(`1：${HEX32}`)).toContain("全角");
  });
  test("hex 长度 / 内容非法（透传 parseMasterKeys 文案，不回显密钥值）", () => {
    const shortHex = HEX32.slice(0, 63);
    const short = validateMasterKeys(`1:${shortHex}`);
    expect(short).toContain("64 位 hex");
    expect(short).not.toContain(shortHex);
    expect(validateMasterKeys("1:zz")).toContain("非法");
    expect(validateMasterKeys("noversion")).toContain("非法");
  });
});

describe("validateHex64", () => {
  test("合法（小写归一由调用方处理）", () => {
    expect(validateHex64(HEX32)).toBeUndefined();
    expect(validateHex64("A".repeat(64).toLowerCase())).toBeUndefined();
  });
  test("长度与非 hex 字符", () => {
    expect(validateHex64("ab")).toContain("64 位 hex");
    expect(validateHex64("z".repeat(64))).toContain("64 位 hex");
  });
});

describe("validateMysqlURL", () => {
  test("合法连接串", () => {
    expect(validateMysqlURL("mysql://openvod_ro:pw@127.0.0.1:3306/openvod")).toBeUndefined();
  });
  test("缺 mysql:// / 缺主机名 / 缺库名", () => {
    expect(validateMysqlURL("postgres://u@h/db")).toContain("mysql://");
    expect(validateMysqlURL("mysql://u:p@127.0.0.1:3306")).toContain("库名");
    expect(validateMysqlURL("mysql://")).toContain("主机名");
    expect(validateMysqlURL("")).toContain("不能为空");
  });
});

describe("maskSecret / maskURL", () => {
  test("密钥只露首尾 4 字符 + 长度", () => {
    const masked = maskSecret(MK);
    expect(masked).toBe(`1:aa…aaaa（${MK.length} 字符）`);
    expect(masked).not.toContain(HEX32);
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret("")).toBe("（空）");
  });
  test("连接串抹掉密码段；非 URL 原样返回掩码", () => {
    expect(maskURL("mysql://openvod_ro:changeit@127.0.0.1:3306/openvod")).toContain("openvod_ro:****@");
    expect(maskURL("file:./dev.db")).toBe("****");
  });
});

describe("placeholderWarnings", () => {
  test("全零 MK / changeit / please-generate / 占位签名密钥", () => {
    const w = placeholderWarnings({
      MASTER_KEYS: `1:${"0".repeat(64)}`,
      DATABASE_URL: "mysql://openvod:changeit@h/openvod",
      BETTER_AUTH_SECRET: "please-generate-a-random-secret-min-32-chars",
      URL_SIGN_KEY_HEX: "1".repeat(64),
    });
    expect(w).toHaveLength(4);
    expect(w.some((x) => x.includes("MASTER_KEYS"))).toBe(true);
    expect(w.filter((x) => x.includes("changeit"))).toHaveLength(1);
    expect(w.some((x) => x.includes("BETTER_AUTH_SECRET"))).toBe(true);
    expect(w.some((x) => x.includes("URL_SIGN_KEY_HEX"))).toBe(true);
  });
  test("真实值无警告", () => {
    expect(
      placeholderWarnings({
        MASTER_KEYS: MK,
        DATABASE_URL: "file:./dev.db",
      }),
    ).toHaveLength(0);
  });
});
