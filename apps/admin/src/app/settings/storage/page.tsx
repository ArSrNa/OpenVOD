import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { ConsoleShell } from "@/components/ConsoleShell";
import { SettingsManager } from "@/components/SettingsManager";
import pkg from "../../../../package.json";

export const metadata: Metadata = { title: "存储设置 - OpenVOD 管理端" };

export default async function StorageSettingsPage() {
  const session = await requireConsoleSession();
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version}>
      <SettingsManager group="storage" />
    </ConsoleShell>
  );
}
