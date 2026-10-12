import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";

export const metadata: Metadata = { title: "安全设置 - OpenVOD 管理端" };

export default function SecuritySettingsPage() {
  return (
    <SettingsManager group="security" />
  );
}
