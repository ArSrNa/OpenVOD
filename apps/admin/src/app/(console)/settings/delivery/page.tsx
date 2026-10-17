import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";

export const metadata: Metadata = { title: "分发设置 - OpenVOD 管理端" };

// 分发设置页（/settings/delivery，系统设置 → 分发设置；system_settings key-value）：
// CDN 加速（storage_cdn_base_url）与资产 URL 鉴权（storage_sign_mode / storage_cdn_auth_*，
// ADR-0019 / spec.md §6.7）。CDN 控制台的私有回源 / Token 鉴权为部署配置，见 deploy-delivery.md。
export default function DeliverySettingsPage() {
  return (
    <SettingsManager group="delivery" />
  );
}
