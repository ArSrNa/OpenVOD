import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/SetupWizard";
import { isSetupCompleted } from "@/lib/settings";

export const metadata: Metadata = {
  title: "首次启动配置 - OpenVOD 管理端",
};

// 必须显式 dynamic：本页门禁读的是 DB（setup_completed）与环境变量，Next 无法自动识别为动态。
// 否则镜像构建期（无 DB / 无 env）可能把它预渲染成静态页——要么被固化成「永远跳 /login」，
// 要么固化成向导 HTML，运行时再配合 /api/setup 的 403 显示误导性的 MASTER_KEYS 报错。
export const dynamic = "force-dynamic";

// 首次启动向导页（/setup，ADR-0015）：未完成初始化时开放；已完成 → /login。
// 本页不要求会话（首次启动还没有管理员），POST /api/setup 完成后路由自动失效。
export default async function SetupPage() {
  if (await isSetupCompleted().catch(() => true)) redirect("/login");
  return <SetupWizard />;
}
