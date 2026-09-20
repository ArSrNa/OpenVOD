// 统一响应信封（spec.md §2）：错误 { error: { code, message } }，成功直出数据，
// 一律 Cache-Control: no-store（管理端 API 不落浏览器缓存）。
//
// 独立成文件的理由：业务 lib（users / templates / media …）只需要信封语义，
// 若直接 import "./api"，会把 better-auth 栈（./api → ./auth → Prisma 单例）拖进 import 图 ——
// 纯单测 import 这些 lib 时，packages/db 的单例就被钉在首个调用者的 DB_PROVIDER 上，
// 同进程内再切 sqlite 的测试（worker key-landing ② 段）会失效。
// lib/api.ts 从这里再导出，既有 import 路径不变。
import { NextResponse } from "next/server";

/** 统一错误信封（错误码沿用 @openvod/shared ERROR_CODES） */
export function apiError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function unauthorized(): NextResponse {
  return apiError("unauthorized", "未登录", 401);
}

/** 成功 JSON（管理端 API 一律 no-store） */
export function apiJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
