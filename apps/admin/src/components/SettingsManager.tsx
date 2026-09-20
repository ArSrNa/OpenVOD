"use client";

import { InfoCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, Typography, message } from "antd";
import { useEffect, useState } from "react";

// 播放设置页（系统设置 → 播放设置，/settings/playback；system_settings key-value）。
// 首项：播放域名 —— 覆盖 DELIVERY_PUBLIC_BASE_URL，清单 / 密钥 / 分片 / 字幕全量播放 URL 基址；
// 由分发端 60s 缓存读取（spec §2.1.2），留空回退 env。
interface SettingsForm {
    playback_base_url?: string;
}

export function SettingsManager() {
    const [form] = Form.useForm<SettingsForm>();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [envBase, setEnvBase] = useState("");

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch("/api/admin/settings", { cache: "no-store" });
                const body = await res.json().catch(() => null);
                if (res.ok && body) {
                    form.setFieldsValue({ playback_base_url: body.playback_base_url ?? "" });
                    setEnvBase(body.env_public_base_url ?? "");
                } else {
                    message.error(body?.error?.message ?? "加载系统设置失败");
                }
            } catch {
                message.error("加载系统设置失败（网络错误）");
            } finally {
                setLoading(false);
            }
        })();
    }, [form]);

    const onFinish = async (values: SettingsForm) => {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ playback_base_url: values.playback_base_url ?? "" }),
            });
            const body = await res.json().catch(() => null);
            if (res.ok && body) {
                form.setFieldsValue({ playback_base_url: body.playback_base_url ?? "" });
                message.success("已保存，分发端 60s 缓存刷新后全量生效（约 1 分钟）");
            } else {
                message.error(body?.error?.message ?? "保存失败");
            }
        } catch {
            message.error("保存失败（网络错误）");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card title="控制台播放" loading={loading}>
            <Form<SettingsForm> form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 560 }}>
                <Form.Item
                    label="播放域名"
                    name="playback_base_url"
                    extra={`清单 / 密钥 / 字幕 / local 分片 URL 的基址，覆盖环境变量 DELIVERY_PUBLIC_BASE_URL${envBase ? `（当前：${envBase}）` : ""}；分发端 60s 缓存读取，保存后约 1 分钟内生效（s3 分片为预签名直出，走存储端点 / 加速域名）`}
                    rules={[
                        {
                            validator: (_, value: string) =>
                                !value?.trim() || /^https?:\/\//i.test(value.trim())
                                    ? Promise.resolve()
                                    : Promise.reject(new Error("域名必须以 http:// 或 https:// 开头")),
                        },
                    ]}
                >
                    <Input placeholder="如 https://delivery.example.com（留空使用环境变量）" allowClear />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>
                    保存
                </Button>
            </Form>
            <Alert
                style={{ maxWidth: 560, marginTop: 24 }}
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
                message="播放链路说明"
                description={
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                        s3 形态分片由分发端按对象存储端点直接预签名（可配 STORAGE_CDN_BASE_URL 换加速域名），浏览器直连拉取、字节不经过分发端（ADR-0005 修订）；本域名作用于清单（typ=m）、密钥（typ=k）、字幕与 local 分片。播放鉴权全走 URL 签名 token，改域名不影响令牌有效性。
                    </Typography.Text>
                }
            />
        </Card>
    );
}
