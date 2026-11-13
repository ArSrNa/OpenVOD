"use client";

import { Card, Segmented, Space, Typography } from "antd";
import { setThemeMode, useThemeMode, type ThemeMode } from "@/lib/theme";

const THEME_OPTIONS: Array<{ label: string; value: ThemeMode }> = [
  { label: "跟随系统", value: "system" },
  { label: "浅色", value: "light" },
  { label: "深色", value: "dark" },
];

/**
 * 外观设置（/settings/appearance）：只管管理端自己的配色，纯浏览器偏好。
 * 不接 /api/admin/settings：每个管理员 / 每台浏览器各存各的。
 * 文案只保留一个预期差（换浏览器要重选），其余功能说明不写。
 */
export function AppearanceSettings() {
  const mode = useThemeMode();
  return (
    <Card title="外观设置">
      <Space align="center" size={12}>
        <span>主题颜色</span>
        <Segmented<ThemeMode> options={THEME_OPTIONS} value={mode} onChange={setThemeMode} />
      </Space>
    </Card>
  );
}
