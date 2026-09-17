"use client";

// antd v5 × React 19 官方补丁（ADR-0013）：必须在**客户端组件**里引入才会在浏览器执行。
// 放在 root layout（Server Component）只有副作用导入的 client reference，浏览器里 patch 不生效，
// 点击 antd 组件（wave 效果）时会告警 "antd v5 support React is 16 ~ 18"。
import "@ant-design/v5-patch-for-react-19";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useState } from "react";

/**
 * 全局 Provider 层（在 root layout 挂载一次）：
 * ConfigProvider（antd 主题/中文）→ ProConfigProvider（pro-components 上下文）→ App → React Query。
 * hashed={false}：SSR 下关掉 pro 样式哈希，避免服务端/客户端类名不一致（hydration 警告）。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#1a56db" } }}>
      <ProConfigProvider hashed={false}>
        <AntApp>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </AntApp>
      </ProConfigProvider>
    </ConfigProvider>
  );
}
