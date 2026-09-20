import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ConsoleShell } from "@/components/ConsoleShell";
import { UsersManager } from "@/components/UsersManager";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../../package.json";

export const metadata: Metadata = {
  title: "用户管理 - OpenVOD 管理端",
};

// 播放端用户管理页（/users，ADR-0004 users 表；ADR-0007 账户域）。
// 服务端只做会话守卫；数据由客户端从 /api/admin/users 拉取（同 /templates、/media）。
export default async function UsersPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version} initialPath="/users">
      <UsersManager />
    </ConsoleShell>
  );
}
