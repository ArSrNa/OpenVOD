import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 仅类型导入 @openvod/contracts（播放器不依赖 DB / 管理端代码）；CNB 预览域名放行 dev 源
  allowedDevOrigins: ["127.0.0.1", "*.cnb.run"],
};

export default nextConfig;
