import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/SetupWizard";
import { isSetupCompleted } from "@/lib/settings";

export const metadata: Metadata = {
  title: "首次启动配置 - OpenVOD 管理端",
};

// 首次启动向导页（/setup，ADR-0015）：未完成初始化时开放；已完成 → /login。
// 本页不要求会话（首次启动还没有管理员），POST /api/setup 完成后路由自动失效。
export default async function SetupPage() {
  if (await isSetupCompleted().catch(() => true)) redirect("/login");
  return <SetupWizard />;
}
