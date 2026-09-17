import { Empty, Layout, Menu, Typography } from "antd";
import { useState } from "react";

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

export function App() {
  const [current, setCurrent] = useState<string>("media");

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", color: "#fff" }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0 }}>
          OpenVOD 管理端
        </Typography.Title>
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
          <Empty description={`${MODULES.find((m) => m.key === current)?.label} — scaffold（路由随 specification 实现）`} />
        </Content>
      </Layout>
    </Layout>
  );
}
