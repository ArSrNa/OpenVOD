import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 播放器 SDK 以 workspace 源码直引（exports → src/index.ts）→ 需显式转译
  transpilePackages: ["@openvod/player-sdk"],
  // SDK 内部仅类型导入 @openvod/contracts（播放器不依赖 DB / 管理端代码）；CNB 预览域名放行 dev 源
  allowedDevOrigins: ["127.0.0.1", "*.cnb.run"],
};

export default nextConfig;
