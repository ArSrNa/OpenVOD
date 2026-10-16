import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";

export const metadata: Metadata = { title: "任务设置 - OpenVOD 管理端" };

export default function WorkerSettingsPage() {
  return (
    <SettingsManager group="worker" />
  );
}
