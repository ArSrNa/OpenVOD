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
};

export default nextConfig;
