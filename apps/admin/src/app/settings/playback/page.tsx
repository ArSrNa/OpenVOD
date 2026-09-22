import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { ConsoleShell } from "@/components/ConsoleShell";
import { SettingsManager } from "@/components/SettingsManager";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../../../package.json";

export const metadata: Metadata = {
  title: "播放设置 - OpenVOD 管理端",
};

// 播放设置页（/settings/playback，系统设置 → 播放设置；system_settings key-value）。
// 服务端只做会话守卫；数据由客户端从 /api/admin/settings 拉取（同 /users、/templates）。
export default async function PlaybackSettingsPage() {
  const session = await requireConsoleSession();
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version}>
      <SettingsManager group="playback" />
    </ConsoleShell>
  );
}
