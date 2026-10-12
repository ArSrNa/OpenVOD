# 转码 Worker 镜像（ADR-0003 / ADR-0008：Bun 常驻容器；ADR-0017：resident / http 双模式；P0 —— 转码禁止上任何函数）
#
# 构建上下文必须是**仓库根**：worker 依赖 workspace 包（@openvod/{db,shared,crypto,storage,transcode,contracts}），
# 且 packages/db 的两份 Prisma 客户端要在镜像内生成。
#   docker build -f apps/worker/Dockerfile -t <tag> .
#
# 运行形态（ADR-0017）：
#   WORKER_MODE=resident（默认）：无端口，轮询认领 transcode_jobs，存活看进程；
#   WORKER_MODE=http（serverless 门铃）：监听 WORKER_HTTP_PORT（默认 9001，EXPOSE 见下），
#     POST /wake 触发认领（Bearer WORKER_NOTIFY_SECRET），GET /healthz 供平台探活，空闲超时退出。
# 两种模式的转码临时目录都在 os.tmpdir()，必须给容器挂大磁盘（ADR-0003：Worker 挂大磁盘）。
FROM oven/bun:1.4-debian

ENV TZ=Asia/Shanghai
# ffmpeg / ffprobe 是启动自检的必需项（缺失 worker 直接 exit 1）；shaka-packager / bento4 属 CENC 演进项，镜像不装。
# fonts-noto-cjk 是文字水印的硬依赖（spec.md §10.6 / ADR-0018）：drawtext 的 fontfile 取
# /usr/share/fonts/opentype/noto/NotoSans{,Bold}-CJK-Regular.ttc 与 NotoSerifCJK-Regular.ttc
# （键 → fontfile 映射见 @openvod/transcode WATERMARK_FONT_FILES，枚举见 @openvod/shared）。
# 换字体需同步改映射与 WATERMARK_FONT_DIR，缺字体会让文字水印任务失败。
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates tzdata procps fonts-noto-cjk \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# 字体存在性自检：构建期就暴露「忘装字体」，而不是等到线上转码才失败
RUN test -f /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    && test -f /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc \
    && test -f /usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc

WORKDIR /app
COPY . .

# bun.lock 是 TS 侧唯一锁文件（v1 不用 npm lock，ADR-0001）
RUN bun install --frozen-lockfile

# packages/db/src/index.ts 静态导入 mysql + sqlite 两份客户端，缺任一份 Next / Bun 解析即失败
RUN bun run --cwd packages/db generate:mysql && bun run --cwd packages/db generate:sqlite

# http 模式监听端口（resident 模式不监听；仅为编排 / 平台的端口声明）
EXPOSE 9001

# 双模式健康检查（与 docker-compose.yml worker 服务一致）：
# http 模式探 /healthz；resident 模式无端口，进程（PID 1）在 = 健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["sh", "-c", "if [ \"${WORKER_MODE:-resident}\" = \"http\" ]; then bun -e \"const r = await fetch('http://127.0.0.1:'+(process.env.WORKER_HTTP_PORT||9001)+'/healthz'); process.exit(r.ok?0:1)\"; else kill -0 1; fi"]

# worker 直接跑 TS 源码（Bun 原生转译，无构建步骤）
CMD ["bun", "apps/worker/src/index.ts"]
