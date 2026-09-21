# 转码 Worker 镜像（ADR-0003 / ADR-0008：Bun 常驻容器；P0 —— 转码禁止上任何函数）
#
# 构建上下文必须是**仓库根**：worker 依赖 workspace 包（@openvod/{db,shared,crypto,storage,transcode,contracts}），
# 且 packages/db 的两份 Prisma 客户端要在镜像内生成。
#   docker build -f apps/worker/Dockerfile -t <tag> .
#
# 运行形态：无端口（轮询认领 transcode_jobs），存活看进程；转码临时目录在 os.tmpdir()，
# 必须给容器挂大磁盘（ADR-0003：Worker 挂大磁盘）。
FROM oven/bun:1.4-debian

ENV TZ=Asia/Shanghai
# ffmpeg / ffprobe 是启动自检的必需项（缺失 worker 直接 exit 1）；shaka-packager / bento4 属 CENC 演进项，镜像不装
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates tzdata procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# bun.lock 是 TS 侧唯一锁文件（v1 不用 npm lock，ADR-0001）
RUN bun install --frozen-lockfile

# packages/db/src/index.ts 静态导入 mysql + sqlite 两份客户端，缺任一份 Next / Bun 解析即失败
RUN bun run --cwd packages/db generate:mysql && bun run --cwd packages/db generate:sqlite

# worker 直接跑 TS 源码（Bun 原生转译，无构建步骤）
CMD ["bun", "apps/worker/src/index.ts"]
