# 管理端 admin 镜像（ADR-0003 / ADR-0013：Next.js 全栈单容器，UI + API 同源无 CORS）
#
# 构建上下文必须是**仓库根**：admin 经 transpilePackages 直接消费 workspace 的 TS 源码包
# （@openvod/{db,shared,crypto,storage,transcode,contracts}），且 packages/db 的两份
# Prisma 客户端要在镜像内生成。
#   docker build -f apps/admin/Dockerfile -t <tag> .
#
# 运行时为 **Node 22**（ADR-0013：next build + next start）；bun 只用于安装依赖与跑构建脚本。
FROM node:22-bookworm-slim AS build

# Prisma 7 已移除 Rust 查询引擎，不再需要装 openssl（ADR-0020）；ca-certificates 供 HTTPS 校验
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g bun@1
WORKDIR /app
# 整仓入上下文（.dockerignore 已剔除 node_modules / .next / 生成物 / 密钥）：
# 逐个 COPY 各 workspace 的 package.json 会更省缓存层，但新增包时容易漏，取舍见 docs/vod/deploy-apps.md
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/db generate:mysql && bun run --cwd packages/db generate:sqlite
RUN bun run --cwd apps/admin build

FROM node:22-bookworm-slim AS runtime

# ffmpeg（含 ffprobe）是**管理端运行时硬依赖**（spec.md §2.1 / §10.2）：
# 「生成元数据」与「水印图片宽高探测」都在 admin 进程内就地跑 ffprobe
# （源片走 S3 预签名 URL 流，字节不进函数/内存）。镜像缺它 → 两个接口直接 500
# 「运行环境无法执行 ffprobe」（2026-11-13 实报）。构建阶段不需要：next build 不探测。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffprobe -version > /dev/null

ENV NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build /app /app

EXPOSE 8787
# 端口由 ADMIN_PORT 控制（默认 :8787，与 dev-workflow §1 一致）；cwd 必须是 apps/admin
# bun 把 next 装在 apps/admin/node_modules（不hoist 到根），故用包内路径；cwd 必须是 apps/admin
CMD ["sh", "-c", "cd /app/apps/admin && exec node ./node_modules/next/dist/bin/next start -p ${ADMIN_PORT:-8787}"]
