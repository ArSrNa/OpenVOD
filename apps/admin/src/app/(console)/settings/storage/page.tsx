import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";

export const metadata: Metadata = { title: "存储设置 - OpenVOD 管理端" };

export default function StorageSettingsPage() {
  return (
    <SettingsManager group="storage" />
  );
}
