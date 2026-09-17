"use client";

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
