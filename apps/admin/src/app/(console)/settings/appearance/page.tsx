import type { Metadata } from "next";
import { AppearanceSettings } from "@/components/AppearanceSettings";

export const metadata: Metadata = {
  title: "外观设置 - OpenVOD 管理端",
};

// 外观设置页（/settings/appearance，系统设置 → 外观设置）。
// 与其它设置页不同：偏好存浏览器 localStorage（lib/theme.ts），不读 /api/admin/settings。
export default function AppearanceSettingsPage() {
  return <AppearanceSettings />;
}
