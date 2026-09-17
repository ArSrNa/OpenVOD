"use client";

import { Button, Card, Form, Input, Tabs, Typography } from "antd";
import { App as AntApp } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GENERIC_OIDC_PROVIDER_ID, authClient } from "@/lib/auth-client";
import { Providers } from "../providers";

interface Values {
  email: string;
  password: string;
}

function LoginInner() {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const ssoLogin = async () => {
    try {
      await authClient.signIn.social({
        provider: GENERIC_OIDC_PROVIDER_ID,
        callbackURL: "/",
      });
    } catch {
      message.error("无法发起 SSO 登录：请确认服务端已配置 OIDC_ISSUER");
    }
  };

  const localLogin = async (v: Values) => {
    setLoading(true);
    try {
      const res = await authClient.signIn.email({ email: v.email, password: v.password });
      if (res.error) {
        message.error(res.error.message ?? "登录失败");
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  const ssoPanel = (
    <div style={{ textAlign: "center", padding: "16px 0" }}>
      <Typography.Paragraph type="secondary">通过企业 SSO（OIDC）登录管理端</Typography.Paragraph>
      <Button type="primary" size="large" onClick={ssoLogin}>
        使用 SSO 登录
      </Button>
    </div>
  );

  const localPanel = (
    <Form onFinish={localLogin} layout="vertical" requiredMark={false}>
      <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }]}>
        <Input autoComplete="username" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block>
        登录
      </Button>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        本地兜底账号（ADR-0012 双轨）：bun apps/admin/scripts/create-admin.ts &lt;email&gt; &lt;pass&gt;
      </Typography.Paragraph>
    </Form>
  );

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f5f6f8" }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: "center", marginTop: 4 }}>
          OpenVOD 管理端
        </Typography.Title>
        <Tabs
          centered
          items={[
            { key: "sso", label: "SSO 登录", children: ssoPanel },
            { key: "local", label: "本地账号", children: localPanel },
          ]}
        />
      </Card>
    </div>
  );
}

export default LoginInner;
