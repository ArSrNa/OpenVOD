import type { Metadata } from "next";
import Link from "next/link";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenVOD 播放演示",
};

/** 顶部导航（Server Component；纯 HTML + Link，不引 antd 客户端组件） */
function TopBar() {
  return (
    <header
      style={{
        height: 56,
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#fff",
        borderBottom: "1px solid #f0f0f0",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: 6,
            background: "#1a56db",
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          V
        </span>
        <span style={{ fontSize: 16, fontWeight: 600 }}>OpenVOD 播放演示</span>
      </Link>
      <span style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}>
        播放端 App 参考实现（免登录，只消费分发端 /v1 API）
      </span>
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <Providers>
            <TopBar />
            <main style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 24px 48px" }}>{children}</main>
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
