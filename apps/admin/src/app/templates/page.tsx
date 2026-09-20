import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TemplatesManager } from "@/components/TemplatesManager";
import { ConsoleShell } from "@/components/ConsoleShell";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../../package.json";

export const metadata: Metadata = {
  title: "转码模板 - OpenVOD 管理端",
};

export default async function TemplatesPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version} initialPath="/templates">
      <TemplatesManager />
    </ConsoleShell>
  );
}
