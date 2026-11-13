import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
// 只取无 hook 的脚本常量：lib/theme.ts 依赖 useSyncExternalStore，Server Component 不能导入
import { THEME_INIT_SCRIPT } from "@/lib/theme-config";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenVOD 管理端",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning：下面的内联脚本在水合前写了 <html data-theme> / style，
    // 这是有意的（防深色模式刷新时白闪），React 不必再比对这两个属性。
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
