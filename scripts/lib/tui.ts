/**
 * scripts/lib/tui.ts — 交互式终端 UI 的薄封装（基于 @clack/prompts）
 *
 * 为什么单列一层：
 *   1) 交互式脚本共用同一套取消语义与 TTY 判定：`scripts/dev.ts` 的服务选择，
 *      以及后续「初始化变量」向导（/setup → system_settings：文本 / 密码 / 确认）；
 *   2) 手写 ANSI 重绘在窄终端 + CJK 宽字符下会因为折行导致行数统计失准、旧行不断堆积
 *      （2026-09-22 实测），宽度截断与多行重绘交给 @clack/prompts 处理；
 *   3) 依赖极轻（@clack/prompts + @clack/core + fast-string-width + fast-wrap-ansi + sisteransi），
 *      ESM-only，Bun 直接 import 即可，无需构建步骤。
 *
 * 用法：
 *   const key = unwrap(await text({ message: "变量名" }));            // Ctrl-C → 提示后 exit 130
 *   const secret = unwrap(await password({ message: "MASTER_KEYS" })); // 输入回显为掩码
 *   const ok = unwrap(await confirm({ message: "写入 .env？" }));
 */
import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, password, select, text } from "@clack/prompts";

/** Ctrl-C / Esc 取消时的退出码（与 shell 惯例一致：128 + SIGINT） */
export const CANCEL_EXIT_CODE = 130;

/** 交互式可用（stdin/stdout 均为 TTY）；非 TTY（CI / 管道）时调用方应走默认值，避免挂起等输入 */
export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** 用户取消 → 统一提示并退出，不抛异常（避免调用点各写一套 try/catch） */
export function cancelled(message = "已取消"): never {
  cancel(message);
  process.exit(CANCEL_EXIT_CODE);
}

/**
 * 收敛 `T | symbol`：取消即退出，省掉每个调用点的 isCancel 分支。
 * 返回 `Exclude<T, symbol>`——clack 的返回类型是 `Value | CANCEL_SYMBOL`，
 * 用 Exclude 才能把 cancel symbol 从联合里摘掉（写成 `unwrap<T>(v: T | symbol): T`
 * 会让 TS 把 symbol 一并推断进 T）。
 */
export function unwrap<T>(value: T): Exclude<T, symbol> {
  return isCancel(value) ? cancelled() : (value as Exclude<T, symbol>);
}

export { confirm, intro, log, multiselect, note, outro, password, select, text };
