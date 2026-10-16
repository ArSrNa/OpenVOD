import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";

export const metadata: Metadata = {
  title: "播放设置 - OpenVOD 管理端",
};

// 播放设置页（/settings/playback，系统设置 → 播放设置；system_settings key-value）。
// 会话守卫与壳层统一在 (console)/layout.tsx；数据由客户端从 /api/admin/settings 拉取（同 /users、/templates）。
export default function PlaybackSettingsPage() {
  return (
    <SettingsManager group="playback" />
  );
}
