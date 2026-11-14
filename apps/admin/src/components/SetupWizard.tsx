"use client";

import { Alert, Button, Card, Form, Input, Steps, Switch, Typography, App as AntApp, theme } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// 首次启动向导（/setup，ADR-0015）：
// Step 1 对象存储（必填）——写 system_settings（SecretAccessKey 经 MK 封装入库）；
// Step 2 可选项 —— 播放域名 / 首个管理员账号 / OIDC；密钥未提供时服务端自动生成。
// 提交后 setup_completed 落库，业务链路（分发端 / Worker 读同一设置）即可启动。
interface SetupForm {
    s3_endpoint: string;
    s3_region?: string;
    s3_bucket: string;
    s3_access_key_id: string;
    s3_secret_access_key: string;
    s3_force_path_style?: boolean;
    storage_root_prefix?: string;
    storage_cdn_base_url?: string;
    playback_base_url?: string;
    admin_email?: string;
    admin_password?: string;
    admin_name?: string;
    oidc_issuer?: string;
    oidc_client_id?: string;
    oidc_client_secret?: string;
}

/** 环境自检状态：ok（含 MK 是否可用 + 具体原因）/ completed（已初始化）/ unknown（接口不可用）/ pending */
type EnvCheck =
    | { kind: "pending" }
    | { kind: "ok"; masterKeysOk: boolean; error: string | null; hint: string | null }
    | { kind: "completed" }
    | { kind: "unknown"; message: string };

export function SetupWizard() {
    const { message } = AntApp.useApp();
    // 底色跟 antd 主题走（深色模式下不再是一块固定的浅灰）
    const { token } = theme.useToken();
    const router = useRouter();
    const [form] = Form.useForm<SetupForm>();
    const [step, setStep] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [envCheck, setEnvCheck] = useState<EnvCheck>({ kind: "pending" });

    useEffect(() => {
        let cancelled = false;
        fetch("/api/setup", { cache: "no-store" })
            .then(async (r) => {
                // 403 = 该实例已完成初始化（本页只是历史标签页 / 手工访问）→ 回登录页，
                // 不能按“MK 未配置”渲染（旧实现把任何非 2xx 都当成 MK 缺失，误导排查方向）
                if (r.status === 403) return { kind: "completed" } as EnvCheck;
                if (!r.ok) return { kind: "unknown", message: `自检接口返回 HTTP ${r.status}` } as EnvCheck;
                const b = (await r.json().catch(() => null)) as
                    | { master_keys_ok?: boolean; master_keys_error?: string | null; master_keys_hint?: string | null }
                    | null;
                if (!b) return { kind: "unknown", message: "自检接口响应无法解析" } as EnvCheck;
                return {
                    kind: "ok",
                    masterKeysOk: Boolean(b.master_keys_ok),
                    error: b.master_keys_error ?? null,
                    hint: b.master_keys_hint ?? null,
                } as EnvCheck;
            })
            .catch((e: Error) => ({ kind: "unknown", message: `无法访问自检接口：${e.message}` }) as EnvCheck)
            .then((state) => {
                if (cancelled) return;
                if (state.kind === "completed") {
                    message.info("系统已完成初始化，正在跳转登录页");
                    router.replace("/login");
                    return;
                }
                setEnvCheck(state);
            });
        return () => {
            cancelled = true;
        };
    }, [message, router]);

    const onFinish = async (v: SetupForm) => {
        setSubmitting(true);
        try {
            const res = await fetch("/api/setup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    s3_endpoint: v.s3_endpoint,
                    s3_region: v.s3_region ?? "",
                    s3_bucket: v.s3_bucket,
                    s3_access_key_id: v.s3_access_key_id,
                    s3_secret_access_key: v.s3_secret_access_key,
                    s3_force_path_style: v.s3_force_path_style === false ? "false" : "true",
                    storage_root_prefix: v.storage_root_prefix ?? "",
                    storage_cdn_base_url: v.storage_cdn_base_url ?? "",
                    playback_base_url: v.playback_base_url ?? "",
                    admin_email: v.admin_email ?? "",
                    admin_password: v.admin_password ?? "",
                    admin_name: v.admin_name ?? "",
                    oidc_issuer: v.oidc_issuer ?? "",
                    oidc_client_id: v.oidc_client_id ?? "",
                    oidc_client_secret: v.oidc_client_secret ?? "",
                }),
            });
            const body = (await res.json().catch(() => null)) as
                | { admin_error?: string | null; error?: { message?: string } }
                | null;
            if (res.ok && body) {
                if (body.admin_error) {
                    message.warning(`初始化完成，但首个管理员创建失败：${body.admin_error}`);
                } else {
                    message.success("初始化完成，请使用管理员账号登录");
                }
                router.push("/login");
                router.refresh();
            } else {
                message.error(body?.error?.message ?? `初始化失败（HTTP ${res.status}）`);
            }
        } catch {
            message.error("初始化失败（网络错误）");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: token.colorBgLayout }}>
            <Card style={{ width: 640 }}>
                <Typography.Title level={4} style={{ textAlign: "center", marginTop: 4 }}>
                    OpenVOD 首次启动配置
                </Typography.Title>
                <Typography.Paragraph type="secondary" style={{ textAlign: "center", fontSize: 13 }}>
                    配置对象存储即可开箱使用；播放域名、SSO、管理员账号可稍后配置
                </Typography.Paragraph>
                {envCheck.kind === "unknown" && (
                    <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="环境自检失败"
                        description={`${envCheck.message}。请确认管理端进程可访问数据库后刷新本页。`}
                    />
                )}
                {envCheck.kind === "ok" && !envCheck.masterKeysOk && (
                    <Alert
                        type="error"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="环境变量 MASTER_KEYS 缺失或格式非法"
                        description={
                            <span>
                                {envCheck.error ?? "未在运行进程的环境变量中找到 MASTER_KEYS。"}
                                {envCheck.hint ? `　${envCheck.hint}` : ""}
                                <br />
                                主密钥 MK 无法进数据库（ADR-0006 分层根）。请在**部署环境**为 admin / worker / delivery
                                三个进程配置同一份 MASTER_KEYS（格式 版本:64位hex，生成 openssl rand -hex 32），
                                重启进程后刷新本页。
                            </span>
                        }
                    />
                )}
                {envCheck.kind === "ok" && envCheck.masterKeysOk && (
                    <Typography.Paragraph type="secondary" style={{ textAlign: "center", fontSize: 12 }}>
                        MASTER_KEYS 自检通过，可继续初始化
                    </Typography.Paragraph>
                )}
                <Steps
                    size="small"
                    current={step}
                    items={[{ title: "对象存储" }, { title: "可选项" }, { title: "完成" }]}
                    style={{ marginBottom: 24 }}
                />
                <Form<SetupForm> form={form} layout="vertical" requiredMark={false} onFinish={onFinish}>
                    <div style={{ display: step === 0 ? "block" : "none" }}>
                        <Form.Item
                            name="s3_endpoint"
                            label="S3 端点"
                            rules={[{ required: true, message: "请输入 S3 兼容端点" }]}
                            extra="如 https://cos.ap-guangzhou.myqcloud.com（COS）或 MinIO 地址"
                        >
                            <Input placeholder="https://..." />
                        </Form.Item>
                        <Form.Item name="s3_region" label="区域" extra="如 ap-guangzhou（COS 必填）">
                            <Input placeholder="ap-guangzhou" />
                        </Form.Item>
                        <Form.Item name="s3_bucket" label="桶名" rules={[{ required: true, message: "请输入桶名" }]}>
                            <Input placeholder="openvod" />
                        </Form.Item>
                        <Form.Item
                            name="s3_access_key_id"
                            label="AccessKeyID"
                            rules={[{ required: true, message: "请输入 AccessKeyID" }]}
                        >
                            <Input />
                        </Form.Item>
                        <Form.Item
                            name="s3_secret_access_key"
                            label="SecretAccessKey"
                            rules={[{ required: true, message: "请输入 SecretAccessKey" }]}
                        >
                            <Input.Password />
                        </Form.Item>
                        <Form.Item
                            name="s3_force_path_style"
                            label="path-style"
                            valuePropName="checked"
                            extra="MinIO请开启；腾讯云COS必须关闭"
                            initialValue={true}
                        >
                            <Switch />
                        </Form.Item>
                        <Form.Item name="storage_root_prefix" label="存储目录（可选）" extra="所有资产均在该目录下，如prod/vod，可与其它业务共享桶">
                            <Input placeholder="如不填，则为存储桶根目录" />
                        </Form.Item>
                        <Form.Item name="storage_cdn_base_url" label="加速域名（可选）" extra="视频加速地址，留空则直接使用S3端点访问">
                            <Input placeholder="https://cdn.example.com" />
                        </Form.Item>
                        <Button type="primary" onClick={() => form.validateFields().then(() => setStep(1))}>
                            下一步
                        </Button>
                    </div>

                    <div style={{ display: step === 1 ? "block" : "none" }}>
                        <Form.Item name="playback_base_url" label="播放域名（分发端地址）" extra="分发端部署后的访问地址；留空则无法播放">
                            <Input placeholder="https://delivery.example.com" />
                        </Form.Item>
                        <Typography.Title level={5}>首个管理员账号（强烈建议现在创建）</Typography.Title>
                        <Form.Item
                            name="admin_email"
                            label="邮箱"
                            rules={[{ type: "email", message: "邮箱格式不正确" }]}
                        >
                            <Input autoComplete="username" />
                        </Form.Item>
                        <Form.Item
                            name="admin_password"
                            label="密码"
                            extra="至少 8 位"
                            rules={[{ min: 8, message: "密码至少 8 位" }]}
                        >
                            <Input.Password autoComplete="new-password" />
                        </Form.Item>
                        <Form.Item name="admin_name" label="显示名（可选）">
                            <Input />
                        </Form.Item>
                        <Typography.Title level={5}>OIDC / SSO（可选，默认本地账号密码登录）</Typography.Title>
                        <Form.Item name="oidc_issuer" label="Issuer" extra="discovery: {issuer}/.well-known/openid-configuration；留空不启用">
                            <Input placeholder="https://sso.example.com" />
                        </Form.Item>
                        <Form.Item name="oidc_client_id" label="Client ID">
                            <Input />
                        </Form.Item>
                        <Form.Item name="oidc_client_secret" label="Client Secret" extra="将以 MK 加密后入库">
                            <Input.Password />
                        </Form.Item>
                        <div style={{ display: "flex", gap: 8 }}>
                            <Button onClick={() => setStep(0)}>上一步</Button>
                            <Button type="primary" htmlType="submit" loading={submitting}>
                                完成初始化
                            </Button>
                        </div>
                    </div>
                </Form>
            </Card>
        </div>
    );
}
