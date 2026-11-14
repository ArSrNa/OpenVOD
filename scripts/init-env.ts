#!/usr/bin/env bun
/**
 * scripts/init-env.ts — 交互式向导生成根 .env（scripts/gen-env.sh 的 TUI 互补，ADR-0015）
 *
 * 场景差异：
 *   sh scripts/gen-env.sh    从「CNB 密钥仓库注入的环境变量」落盘 .env（CI / 云开发容器，非交互）
 *   bun scripts/init-env.ts  逐项问答引导生成 .env（无密钥仓库的本地开发 / 自托管初始化）
 *
 * 生成范围（ADR-0015 最小集 + 进程装配期参数）：
 *   必需：DATABASE_URL / DB_PROVIDER / MASTER_KEYS（三端共用 DATABASE_URL）
 *   装配：ADMIN_PORT / DELIVERY_LISTEN（默认 8787 / :9000，可整体跳过）
 *   兜底：推荐留空——管理台 /setup 首次启动向导写入 system_settings（DB 值优先，env 兜底），
 *         密钥类设置由向导自动生成并以 MK 封装入库（ADR-0006 分层）。
 *
 * 纪律：MASTER_KEYS 永不完整回显（汇总掩码，ADR-0006 红线）；落盘权限 600；
 *       校验规则与 sh scripts/gen-env.sh --check 及管理台自检（apps/admin/src/lib/master-keys.ts）对齐。
 *
 * 用法：
 *   bun scripts/init-env.ts            交互式向导（.env 已存在时确认覆盖）
 *   bun scripts/init-env.ts --force    覆盖已存在的 .env，不再确认
 *   bun scripts/init-env.ts --stdout   只打印渲染结果，不落盘（管道 / 排查用）
 *   bun scripts/init-env.ts -o <path>  输出到指定文件（默认 <root>/.env）
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  confirm,
  intro,
  log,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
  unwrap,
} from "./lib/tui";

// ---------------------------------------------------------------------------
// 基础常量
// ---------------------------------------------------------------------------
const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ENV = resolve(ROOT, ".env");
const TEMPLATE = resolve(ROOT, ".env.example");

/** ADR-0015：必需键收敛为最小集（DB 引导 + MK 根密钥），与 gen-env.sh --check 一致；
 *  三端共用 DATABASE_URL（ADR-0011 2026-10-17 修订） */
const REQUIRED_KEYS = ["DATABASE_URL", "DB_PROVIDER", "MASTER_KEYS"] as const;

const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p);

// ---------------------------------------------------------------------------
// 纯函数（scripts/init-env.test.ts 直接覆盖）
// ---------------------------------------------------------------------------

/** 与 gen-env.sh quote_val 一致：双引号包裹前的转义（\ " $ `），防 .env / source 解析破坏 */
export function quoteEnvValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/** 解析 .env.example：键默认值 + 被注释掉的可选键（`# KEY=""`，赋值时取消注释） */
export function parseTemplate(text: string): { defaults: Record<string, string>; commented: Set<string> } {
  const defaults: Record<string, string> = {};
  const commented = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(?:#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    let value = rest;
    if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) value = rest.slice(1, -1);
    else if (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) value = rest.slice(1, -1);
    else value = rest.replace(/\s#.*$/, "").trim();
    defaults[key] = value;
    if (line.startsWith("#")) commented.add(key);
  }
  return { defaults, commented };
}

/**
 * 模板 + 覆盖渲染（gen-env.sh render_template 的 TS 对应）：
 *   - 模板已有键且 values 提供 → 写 `KEY="value"`（注释行赋值即取消注释）
 *   - 注释行可选键未赋值 / 空值 → 保持注释（推荐走 /setup 向导）
 *   - values 有而模板没有的非空键 → 追加「额外键」区块
 *   - 其余行（注释 / 空行 / 结构）原样保留
 */
export function renderEnvFile(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const lines = template.split(/\r?\n/).map((raw) => {
    const m = /^(#[ \t]*)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(raw);
    if (!m) return raw;
    const key = m[2];
    if (!(key in values)) return raw;
    used.add(key);
    const value = values[key] ?? "";
    if (m[1] && value === "") return raw; // 注释行且无值 → 保持注释
    return `${key}="${quoteEnvValue(value)}"`;
  });
  const extra = Object.keys(values).filter((k) => !used.has(k) && values[k] !== "");
  if (extra.length > 0) {
    lines.push("", "# ---- 向导追加（模板中不存在的键）----");
    for (const k of extra) lines.push(`${k}="${quoteEnvValue(values[k])}"`);
  }
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * MASTER_KEYS 解析校验（规则对齐 packages/crypto/src/wrap.ts parseMasterKeys）。
 * scripts/ 目录不在 workspace 包内（bun 不链接 @openvod/*），故本地复刻；
 * 解析规则若变更需两端同步（文案不回显任何密钥值，ADR-0006 红线）。
 */
export function masterKeysParseError(raw: string): string | undefined {
  for (const part of raw.split(",")) {
    const seg = part.trim();
    const idx = seg.indexOf(":");
    const verRaw = idx < 0 ? seg : seg.slice(0, idx);
    const hex = idx < 0 ? "" : seg.slice(idx + 1);
    const verText = /^[0-9]{1,3}$/.test(verRaw) ? `版本=${verRaw}` : "版本段不是 1–3 位正整数";
    if (!/^[0-9]+$/.test(verRaw) || Number(verRaw) <= 0) {
      return `MASTER_KEYS 片段非法（应为 "版本:64位hex"，32 字节密钥）：${verText}，${hex === "" ? "缺少「版本:」分隔符" : `密钥段长度 ${hex.length}（应为 64 位 hex）`}`;
    }
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      return `MASTER_KEYS 片段非法（应为 "版本:64位hex"，32 字节密钥）：${verText}，hex 段含非 0-9a-f 字符（是否误用了 base64 / 口令？）`;
    }
    if (hex.length !== 64) {
      return `MASTER_KEYS 片段非法（应为 "版本:64位hex"，32 字节密钥）：${verText}，密钥段长度 ${hex.length}（应为 64 位 hex）`;
    }
  }
  return undefined;
}

/** MASTER_KEYS 校验：形态提示（引号/空白/全角冒号）+ 版本:64位hex 逐段解析（多版本逗号分隔） */
export function validateMasterKeys(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "MASTER_KEYS 不能为空";
  if (/^[ \t]*["']|["'][ \t]*$/.test(v)) return "值不需要引号（平台配置框常见误粘贴），请去掉引号";
  if (/\s/.test(v)) return "值中间含空白/换行（粘贴带入），必须删除";
  if (v.includes("：")) return "分隔符必须是半角冒号「:」，不能是全角「：」";
  return masterKeysParseError(v);
}

/** 64 位 hex（32 字节）校验：URL_SIGN_KEY_HEX（对齐 admin settings 的 SECRET_META 规则） */
export function validateHex64(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return "不能为空";
  if (!/^[0-9a-f]{64}$/.test(v)) {
    return `必须是 64 位 hex（32 字节，openssl rand -hex 32），当前 ${v.length} 个字符`;
  }
  return undefined;
}

/** MySQL 连接串校验（对齐 apps/delivery ParseDatabaseURL：仅 mysql://、必含库名） */
export function validateMysqlURL(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "连接串不能为空";
  if (!v.startsWith("mysql://")) return "仅支持 mysql:// 连接串（分发端 Go 驱动约束）";
  try {
    const u = new URL(v);
    if (!u.hostname) return "缺少主机名";
    const db = u.pathname.replace(/^\//, "");
    if (!db) return "缺少库名（形如 mysql://user:pass@host:3306/openvod）";
  } catch {
    return "URL 格式非法";
  }
  return undefined;
}

/** 密钥掩码：只露首尾各 4 字符 + 长度（长度不构成攻击面，肉眼可核对是否重新生成） */
export function maskSecret(s: string): string {
  if (!s) return "（空）";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}（${s.length} 字符）`;
}

/** 连接串掩码：仅抹掉密码段，保留 host / 库名便于核对；非 mysql:// 一律返回掩码 */
export function maskURL(u: string): string {
  const v = u.trim();
  if (!v.startsWith("mysql://")) return "****";
  try {
    const url = new URL(v);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return "****";
  }
}

/** 占位值检测：与 gen-env.sh --check 同款规则（密钥全零 / changeit / please-generate） */
export function placeholderWarnings(values: Record<string, string>): string[] {
  const warnings: string[] = [];
  if ((values.MASTER_KEYS ?? "").includes("0".repeat(64))) {
    warnings.push("MASTER_KEYS 仍是全零占位值（三端无法互通，切勿用于真实环境）");
  }
  const sign = (values.URL_SIGN_KEY_HEX ?? "").trim().toLowerCase();
  if (sign === "1".repeat(64) || sign === "0".repeat(64)) {
    warnings.push("URL_SIGN_KEY_HEX 仍是 .env.example 占位值");
  }
  if ((values.BETTER_AUTH_SECRET ?? "").includes("please-generate")) {
    warnings.push("BETTER_AUTH_SECRET 仍是 .env.example 占位值");
  }
  if ((values.DATABASE_URL ?? "").includes("changeit")) {
    warnings.push("DATABASE_URL 仍是 .env.example 占位密码（changeit）");
  }
  return warnings;
}

/** 显示值：连接串掩码密码、密钥掩码，其余原样 */
function displayValue(key: string, value: string): string {
  if (key === "MASTER_KEYS" || key === "URL_SIGN_KEY_HEX" || key === "BETTER_AUTH_SECRET") {
    return maskSecret(value);
  }
  if (key === "DATABASE_URL" && value.startsWith("mysql://")) return maskURL(value);
  if (key === "DELIVERY_PREVIEW_PASSWORD") return "****";
  return value;
}

// ---------------------------------------------------------------------------
// 输入辅助（validate 兼容「直接回车取默认值」：clack 可能不把默认值传入 validate）
// ---------------------------------------------------------------------------
type TextValidator = (value: string | undefined) => string | undefined;

function withDefault(validator: (v: string) => string | undefined, fallback: string): TextValidator {
  return (value) => validator((value ?? "").trim() || fallback);
}

const validatePort: TextValidator = (v) => {
  const s = (v ?? "").trim();
  if (!/^[0-9]{1,5}$/.test(s) || Number(s) < 1 || Number(s) > 65535) return "必须是 1–65535 的端口号";
  return undefined;
};

const validateListen: TextValidator = (v) => {
  const s = (v ?? "").trim();
  // :9000 / host:9000 / [::]:9000
  if (!/^:\d{1,5}$|^\[\S+\]:\d{1,5}$|^[A-Za-z0-9._-]+:\d{1,5}$/.test(s)) {
    return "格式应为 :9000 / host:9000 / [::]:9000";
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// 向导主流程
// ---------------------------------------------------------------------------
function usage(): void {
  process.stdout.write(
    [
      "用法：",
      "  bun scripts/init-env.ts            交互式向导（.env 已存在时确认覆盖）",
      "  bun scripts/init-env.ts --force    覆盖已存在的 .env，不再确认",
      "  bun scripts/init-env.ts --stdout   只打印渲染结果，不落盘",
      "  bun scripts/init-env.ts -o <path>  输出到指定文件（默认 <root>/.env）",
      "",
      "非交互场景请改用 sh scripts/gen-env.sh（从注入环境变量生成）。",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): { force: boolean; stdout: boolean; out: string } {
  let force = false;
  let stdout = false;
  let out = DEFAULT_ENV;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--stdout") stdout = true;
    else if (a === "-o" || a === "--out") {
      const v = argv[++i];
      if (!v) {
        log.error(`${a} 需要一个路径参数`);
        process.exit(2);
      }
      out = resolve(v);
    } else {
      log.error(`未知参数：${a}`);
      usage();
      process.exit(2);
    }
  }
  return { force, stdout, out };
}

/** 步骤 ①：数据库（DB_PROVIDER 决定 DATABASE_URL 形态与建表命令） */
async function askDatabase(values: Record<string, string>, defaults: Record<string, string>): Promise<void> {
  log.step("① 数据库（引导依赖：无法从 DB 读 DB 地址）");
  const provider = unwrap(
    await select({
      message: "数据库方言（DB_PROVIDER）",
      initialValue: "sqlite",
      options: [
        { value: "sqlite", label: "sqlite", hint: "本地开发推荐：packages/db/prisma/dev.db，task db:push 建表" },
        { value: "mysql", label: "mysql", hint: "生产 / 自托管共享：TDSQL-C 或自建 MySQL，task db:migrate" },
      ],
    }),
  );
  values.DB_PROVIDER = provider;

  if (provider === "sqlite") {
    values.DATABASE_URL = "file:./dev.db";
    log.info('DATABASE_URL 固定为 "file:./dev.db"（三端共用；相对 packages/db/prisma/），建表用 task db:push');
  } else {
    values.DATABASE_URL = unwrap(
      await text({
        message: "DATABASE_URL（三端共用：admin / worker / delivery）",
        defaultValue: defaults.DATABASE_URL,
        placeholder: "mysql://用户:密码@主机:3306/openvod",
        validate: withDefault((v) => {
          if (!v.startsWith("mysql://")) return "MySQL 连接串应以 mysql:// 开头";
          return validateMysqlURL(v);
        }, defaults.DATABASE_URL ?? ""),
      }),
    ).trim();
  }
}

/** 步骤 ②：主密钥 MK（自动生成 / 手动输入；ADR-0006 分层根，三端必须一致） */
async function askMasterKeys(values: Record<string, string>): Promise<void> {
  log.step("② 主密钥 MK（ADR-0006 分层根：唯一不可入库的密钥，admin / worker / delivery 三端一致）");
  const mode = unwrap(
    await select({
      message: "MASTER_KEYS 生成方式（格式 版本:64位hex）",
      options: [
        { value: "auto", label: "自动生成（推荐）", hint: "本机 crypto 随机 32 字节 hex，等价 openssl rand -hex 32" },
        { value: "manual", label: "手动输入", hint: "支持逗号分隔多版本（MK 轮换重封装免重转码）" },
      ],
    }),
  );
  if (mode === "auto") {
    const ver = unwrap(
      await text({
        message: "MK 版本号",
        defaultValue: "1",
        validate: withDefault(
          (v) => (/^[0-9]{1,3}$/.test(v) && Number(v) > 0 ? undefined : "1–3 位正整数"),
          "1",
        ),
      }),
    ).trim() || "1";
    values.MASTER_KEYS = `${ver}:${randomBytes(32).toString("hex")}`;
    log.success(`MK v${values.MASTER_KEYS.split(":")[0]} 已生成（值不回显，写入 .env 后三端共享）`);
  } else {
    values.MASTER_KEYS = unwrap(
      await password({
        message: "MASTER_KEYS（输入回显为掩码；多版本逗号分隔）",
        validate: (v) => validateMasterKeys(v ?? ""),
      }),
    ).trim();
  }
}

/** 步骤 ③：进程装配期参数（鸡生蛋，先于任何 DB 访问；默认可整体跳过） */
async function askAssembly(values: Record<string, string>, defaults: Record<string, string>): Promise<void> {
  log.step("③ 进程装配期参数（先于任何 DB 访问）");
  const keep = unwrap(
    await confirm({
      message: "端口保持默认（ADMIN_PORT=8787，DELIVERY_LISTEN=:9000）？",
      initialValue: true,
    }),
  );
  if (keep) return;
  values.ADMIN_PORT = unwrap(
    await text({ message: "ADMIN_PORT", defaultValue: defaults.ADMIN_PORT || "8787", validate: validatePort }),
  ).trim();
  values.DELIVERY_LISTEN = unwrap(
    await text({
      message: "DELIVERY_LISTEN",
      defaultValue: defaults.DELIVERY_LISTEN || ":9000",
      validate: validateListen,
    }),
  ).trim();
}

/** 步骤 ④：可选兜底（推荐全走 /setup 向导；显式勾选才写入） */
async function askOptional(values: Record<string, string>, defaults: Record<string, string>): Promise<void> {
  log.step("④ 可选兜底（DB 未配置同名设置时生效；推荐全部留空走管理台 /setup 向导）");
  const skip = unwrap(
    await confirm({
      message: "跳过可选兜底，全部交给 /setup 首次启动向导（推荐）？",
      initialValue: true,
    }),
  );
  if (skip) return;

  const picked = unwrap(
    await multiselect({
      message: "勾选要显式写进 .env 的键",
      required: false,
      options: [
        { value: "APP_ENV", label: "APP_ENV", hint: "运行环境：dev | prod" },
        { value: "ADMIN_BASE_URL", label: "ADMIN_BASE_URL", hint: "管理端对外基址（better-auth baseURL）" },
        { value: "DELIVERY_BASE_URL", label: "DELIVERY_BASE_URL", hint: "admin → delivery 调用地址兜底（系统设置优先）" },
        { value: "DELIVERY_PUBLIC_BASE_URL", label: "DELIVERY_PUBLIC_BASE_URL", hint: "播放 URL 基址兜底" },
        { value: "URL_SIGN_KEY_HEX", label: "URL_SIGN_KEY_HEX", hint: "播放签名密钥（64 位 hex）" },
        { value: "BETTER_AUTH_SECRET", label: "BETTER_AUTH_SECRET", hint: "管理端会话密钥（≥32 字符）" },
        { value: "DELIVERY_PREVIEW_USERNAME", label: "DELIVERY_PREVIEW_USERNAME", hint: "预览账号（bootstrap-playback.ts）" },
        { value: "DELIVERY_PREVIEW_PASSWORD", label: "DELIVERY_PREVIEW_PASSWORD", hint: "预览口令" },
      ],
    }),
  );

  for (const key of picked) {
    if (key === "APP_ENV") {
      values.APP_ENV = unwrap(
        await select({
          message: "APP_ENV",
          initialValue: defaults.APP_ENV || "dev",
          options: [
            { value: "dev", label: "dev", hint: "本地开发" },
            { value: "prod", label: "prod", hint: "生产部署" },
          ],
        }),
      );
    } else if (key === "URL_SIGN_KEY_HEX" || key === "BETTER_AUTH_SECRET") {
      const gen = unwrap(
        await select({
          message: `${key} 生成方式`,
          options: [
            { value: "auto", label: "自动生成（推荐）", hint: "本机 crypto 随机（48 字节 → base64url / 32 字节 → hex）" },
            { value: "manual", label: "手动输入", hint: "输入回显为掩码" },
          ],
        }),
      );
      if (gen === "auto") {
        values[key] =
          key === "URL_SIGN_KEY_HEX" ? randomBytes(32).toString("hex") : randomBytes(48).toString("base64url");
      } else if (key === "URL_SIGN_KEY_HEX") {
        values[key] = unwrap(
          await password({
            message: "URL_SIGN_KEY_HEX",
            validate: (v) => validateHex64(v ?? ""),
          }),
        ).trim().toLowerCase();
      } else {
        values[key] = unwrap(
          await password({
            message: "BETTER_AUTH_SECRET（≥32 字符）",
            validate: (v) => ((v ?? "").trim().length >= 32 ? undefined : "至少 32 字符"),
          }),
        ).trim();
      }
    } else if (key === "DELIVERY_PREVIEW_PASSWORD") {
      values[key] = unwrap(
        await password({ message: "DELIVERY_PREVIEW_PASSWORD" }),
      ).trim();
    } else {
      values[key] = unwrap(
        await text({
          message: `${key}`,
          defaultValue: defaults[key] || "",
          placeholder: defaults[key] ? `默认 ${defaults[key]}` : undefined,
        }),
      ).trim();
    }
  }
}

/** 步骤 ⑤：终检 + 汇总确认 */
async function review(values: Record<string, string>, stdout: boolean, out: string): Promise<boolean> {
  log.step("⑤ 校验与汇总");
  for (const k of REQUIRED_KEYS) {
    if (!(values[k] ?? "").trim()) {
      log.error(`必需变量 ${k} 缺失，向导中止`);
      process.exit(1);
    }
  }
  for (const w of placeholderWarnings(values)) log.warn(w);

  const keys = [
    ...REQUIRED_KEYS,
    ...["ADMIN_PORT", "DELIVERY_LISTEN", "APP_ENV", "ADMIN_BASE_URL", "DELIVERY_BASE_URL", "DELIVERY_PUBLIC_BASE_URL", "URL_SIGN_KEY_HEX", "BETTER_AUTH_SECRET", "DELIVERY_PREVIEW_USERNAME", "DELIVERY_PREVIEW_PASSWORD"].filter((k) => k in values),
  ];
  const width = Math.max(...keys.map((k) => k.length));
  const summary = keys.map((k) => `  ${k.padEnd(width)}  =  ${displayValue(k, values[k] ?? "")}`).join("\n");
  note(summary, `待写入 ${stdout ? "stdout" : rel(out)}（密钥已掩码）`);

  if (stdout) return true;
  return unwrap(await confirm({ message: "确认写入？", initialValue: true }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return;
  }
  const { force, stdout, out } = parseArgs(argv);

  if (!existsSync(TEMPLATE)) {
    log.error(`模板不存在：${rel(TEMPLATE)}`);
    process.exit(1);
  }
  const templateText = readFileSync(TEMPLATE, "utf8");
  const { defaults } = parseTemplate(templateText);

  if (!process.stdin.isTTY) {
    log.error("当前会话不是交互 TTY，无法问答；非交互场景请改用 sh scripts/gen-env.sh");
    process.exit(2);
  }
  if (!stdout && !process.stdout.isTTY) {
    log.error("stdout 不是 TTY，交互 UI 无法渲染；要捕获生成内容请加 --stdout");
    process.exit(2);
  }
  if (!stdout && existsSync(out) && !force) {
    const overwrite = unwrap(await confirm({ message: `${rel(out)} 已存在，覆盖写入？`, initialValue: false }));
    if (!overwrite) {
      log.info("已取消，未做任何修改");
      return;
    }
  }

  intro("OpenVOD 环境变量向导");
  log.info("生成范围遵循 ADR-0015 最小集：必需 3 键 + 进程装配期参数；其余配置推荐留空，由管理台 /setup 首次启动向导写入 system_settings。");

  const values: Record<string, string> = {};
  await askDatabase(values, defaults);
  await askMasterKeys(values);
  await askAssembly(values, defaults);
  await askOptional(values, defaults);

  const ok = await review(values, stdout, out);
  if (!ok) {
    log.info("已取消，未做任何修改");
    outro("随时重新运行 bun scripts/init-env.ts");
    return;
  }

  const content = renderEnvFile(templateText, values);
  if (stdout) {
    process.stdout.write(content);
    return;
  }
  writeFileSync(out, content, { mode: 0o600 });
  chmodSync(out, 0o600);
  const lines = content.split("\n").filter((l) => l.trim()).length;
  log.success(`已生成 ${out}（${lines} 行，权限 600）`);

  const dbHint = values.DB_PROVIDER === "sqlite" ? "task db:push" : "task db:migrate";
  outro(
    [
      "下一步：",
      `  task db:generate            生成两份 Prisma 客户端（mysql + sqlite，缺一 Next 打包失败）`,
      `  ${dbHint.padEnd(27)} ${values.DB_PROVIDER === "sqlite" ? "SQLite 开发库建表" : "MySQL 迁移"}`,
      "  bun scripts/dev.ts          启动开发环境（admin 自动带起 worker）",
      "  sh scripts/gen-env.sh --check   复核必需变量与占位值",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main().catch((e: Error) => {
    log.error(e.message);
    process.exit(1);
  });
}
