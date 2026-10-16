import type { Metadata } from "next";
import { SettingsManager } from "@/components/SettingsManager";
import { AdminPasswordCard } from "@/components/AdminPasswordCard";
import { Space } from "antd";

export const metadata: Metadata = { title: "登录设置 - OpenVOD 管理端" };

export default function LoginSettingsPage() {
    return (
        <Space className="w-full" direction="vertical">
            <AdminPasswordCard />
            <SettingsManager group="login" />
        </Space>
    );
}
