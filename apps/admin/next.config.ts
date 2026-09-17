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
  ],
  // Prisma 客户端保持外部化（引擎二进制不走打包器）
  serverExternalPackages: ["@prisma/client"],
  eslint: { ignoreDuringBuilds: true },
  allowedDevOrigins: ['127.0.0.1']
};

export default nextConfig;
