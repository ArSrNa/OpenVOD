"use client";

import { Alert, App as AntApp, Button, Card, Form, Input, Typography } from "antd";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

interface PasswordValues {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
}

// better-auth 常见错误 → 控制台文案（未命中时展示原始信息）
const ERROR_MESSAGES: Record<string, string> = {
    "Invalid password": "当前密码不正确",
};

/**
 * 管理员自助重置登录密码（/settings/login）。
 * 走 better-auth 内建 POST /api/auth/change-password：服务端校验当前密码与最短长度，
 * 新口令经服务端哈希写入 admin_accounts（不经过任何自定义 /api/admin 端点）。
 * revokeOtherSessions 对齐播放端用户重置口令语义：旧凭据会话全部吊销，仅保留当前会话。
 */
export function AdminPasswordCard() {
    const { message } = AntApp.useApp();
    const [form] = Form.useForm<PasswordValues>();
    // null = 探测中；true = 本地密码账号（显示表单）；false = 纯 SSO 账号（无本地密码可改）
    const [hasCredential, setHasCredential] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        // 只有本地邮箱密码登录的账号才有可修改的密码；SSO 账号的口令由身份提供方管理。
        // 探测失败时保守按「有本地密码」展示表单，由服务端兜底校验。
        let cancelled = false;
        void authClient
            .listAccounts()
            .then(({ data }) => {
                if (!cancelled) setHasCredential(Boolean(data?.some((account) => account.providerId === "credential")));
            })
            .catch(() => {
                if (!cancelled) setHasCredential(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const submit = async (values: PasswordValues) => {
        setSaving(true);
        try {
            const result = await authClient.changePassword({
                currentPassword: values.currentPassword,
                newPassword: values.newPassword,
                revokeOtherSessions: true,
            });
            if (result.error) {
                const raw = result.error.message ?? "";
                message.error(ERROR_MESSAGES[raw] ?? raw ?? "密码修改失败");
                return;
            }
            form.resetFields();
            message.success("登录密码已更新；其他设备的登录会话已吊销");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card title="重置登录密码" className="w-full" loading={hasCredential === null}>
            {hasCredential === false ? (
                <Alert
                    type="info"
                    showIcon
                    message="当前账号通过 SSO 登录"
                    description="SSO 账号没有本地密码，口令由身份提供方（IdP）管理。"
                />
            ) : (
                <>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                        修改成功后当前会话保持登录，其他设备的登录会话将被吊销，需用新密码重新登录。
                    </Typography.Paragraph>
                    <Form<PasswordValues> form={form} layout="vertical" requiredMark={false} onFinish={submit} style={{ maxWidth: 420 }}>
                        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
                            <Input.Password autoComplete="current-password" />
                        </Form.Item>
                        <Form.Item
                            name="newPassword"
                            label="新密码"
                            rules={[
                                { required: true, message: "请输入新密码" },
                                { min: 8, message: "密码至少 8 位" },
                                { max: 72, message: "密码最多 72 个字符" },
                            ]}
                        >
                            <Input.Password placeholder="至少 8 位" maxLength={72} autoComplete="new-password" />
                        </Form.Item>
                        <Form.Item
                            name="confirmPassword"
                            label="确认新密码"
                            dependencies={["newPassword"]}
                            rules={[
                                { required: true, message: "请再次输入新密码" },
                                ({ getFieldValue }) => ({
                                    validator: (_rule, value: string) =>
                                        !value || getFieldValue("newPassword") === value
                                            ? Promise.resolve()
                                            : Promise.reject(new Error("两次输入的密码不一致")),
                                }),
                            ]}
                        >
                            <Input.Password placeholder="再次输入" maxLength={72} autoComplete="new-password" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" loading={saving}>
                            更新密码
                        </Button>
                    </Form>
                </>
            )}
        </Card>
    );
}
