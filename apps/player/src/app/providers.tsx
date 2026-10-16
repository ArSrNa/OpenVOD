"use client";

// antd v5 × React 19 官方补丁：必须在**客户端组件**里引入才会在浏览器执行（与 admin 同约定）
import "@ant-design/v5-patch-for-react-19";
import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#1a56db" } }}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
