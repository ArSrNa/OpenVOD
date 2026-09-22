import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { DashboardOverview } from "@/components/DashboardOverview";
import { ConsoleShell } from "@/components/ConsoleShell";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../package.json";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "总览 - OpenVOD 管理端",
};

export default async function ConsolePage() {
  const session = await requireConsoleSession();
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version}>
      <div className="flex flex-col gap-5">
        <Header />
        <DashboardOverview />
      </div>
    </ConsoleShell>
  );
}
