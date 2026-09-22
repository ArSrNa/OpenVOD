import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { KeysManager } from "@/components/KeysManager";
import { ConsoleShell } from "@/components/ConsoleShell";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../../package.json";

export const metadata: Metadata = {
  title: "密钥管理 - OpenVOD 管理端",
};

export default async function KeysPage() {
  const session = await requireConsoleSession();
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version} initialPath="/keys">
      <KeysManager />
    </ConsoleShell>
  );
}
