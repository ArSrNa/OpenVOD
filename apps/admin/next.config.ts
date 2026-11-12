import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // monorepo 内 TS 源码包交给 Next 转译（ADR-0001 包边界）
  transpilePackages: [
    "@openvod/db",
    "@openvod/shared",
    "@openvod/crypto",
    "@openvod/storage",
    "@openvod/transcode",
    "@openvod/contracts",
    "openvod-jssdk",
  ],
  // 侧栏 logo 为远程图片，需显式放行域名（ADR-0013 单容器形态，运行时需能访问该域名）
  images: {
    remotePatterns: [{ protocol: "https", hostname: "www.arsrna.cn", pathname: "/logo.png" }],
  },
  // Prisma 客户端保持外部化（引擎二进制不走打包器）
  serverExternalPackages: ["@prisma/client"],
  // Next 16 起 Turbopack 为默认打包器（无自定义 webpack 配置，直接生效）
  allowedDevOrigins: ["127.0.0.1", "*.cnb.run"],
  // API 一律不缓存（与 lib/envelope.ts 的逐响应 no-store 构成双保险）：
  // 覆盖 /api/admin/*、/api/setup、/api/auth/*（better-auth 的响应头不归我们控制）与 /healthz。
  // 只圈 API 与探活，不动页面与 /_next/static —— 静态资源需要正常的强缓存。
  async headers() {
    const noStore = [{ key: "Cache-Control", value: "no-store" }];
    return [
      { source: "/api/:path*", headers: noStore },
      { source: "/healthz", headers: noStore },
    ];
  },
};

export default nextConfig;
