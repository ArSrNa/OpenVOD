import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { ConsoleShell } from "@/components/ConsoleShell";
import { SettingsManager } from "@/components/SettingsManager";
import { AdminPasswordCard } from "@/components/AdminPasswordCard";
import pkg from "../../../../package.json";
import { Space } from "antd";

export const metadata: Metadata = { title: "登录设置 - OpenVOD 管理端" };

export default async function LoginSettingsPage() {
    const session = await requireConsoleSession();
    return (
        <ConsoleShell userName={session.user.name} version={pkg.version}>
            <Space className="w-full" direction="vertical">
                <AdminPasswordCard />
                <SettingsManager group="login" />
            </Space>
        </ConsoleShell>
    );
}
