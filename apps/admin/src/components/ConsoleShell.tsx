"use client";

import { Button, Empty, Layout, Menu, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Providers } from "@/app/providers";

const { Sider, Content, Header } = Layout;

// 模块骨架（ADR-0004 功能清单；页面随 specification 实现）
const MODULES = [
  { key: "media", label: "媒资管理" },
  { key: "subtitles", label: "字幕管理" },
  { key: "users", label: "用户管理" },
  { key: "keys", label: "密钥管理" },
  { key: "jobs", label: "转码任务" },
  { key: "settings", label: "系统设置" },
] as const;

export function ConsoleShell({ userName }: { userName: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState<string>("media");

  const logout = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <Providers>
      <Layout style={{ minHeight: "100vh" }}>
        <Header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingRight: 24,
          }}
        >
          <Typography.Title level={4} style={{ color: "#fff", margin: 0 }}>
            OpenVOD 管理端
          </Typography.Title>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ color: "#fff", fontSize: 13 }}>{userName}</span>
            <Button size="small" onClick={logout}>
              退出
            </Button>
          </div>
        </Header>
        <Layout>
          <Sider theme="light" width={200}>
            <Menu
              mode="inline"
              selectedKeys={[current]}
              items={MODULES.map((m) => ({ key: m.key, label: m.label }))}
              onClick={(e) => setCurrent(e.key)}
              style={{ height: "100%", borderInlineEnd: "none" }}
            />
          </Sider>
          <Content style={{ padding: 24 }}>
            <Empty
              description={`${MODULES.find((m) => m.key === current)?.label} — scaffold（路由随 specification 实现）`}
            />
          </Content>
        </Layout>
      </Layout>
    </Providers>
  );
}
