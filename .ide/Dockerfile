# ============================================================================
# CNB 云开发环境镜像（.cnb.yml: .devenv.docker.build）
#
# 基础镜像已提供：Ubuntu 24.04 / Node 25 / npm / Bun 1.4 / pnpm / git / curl / unzip
# 本文件按 docs/vod-deploy-edgeone-scf.html 的技术栈选型补齐其余开发环境：
#
#   管理端 Control Plane  Bun + Hono / React + Vite / Drizzle ORM（Bun/Node 基础镜像已覆盖）
#   转码 Worker           ffmpeg + Shaka Packager + Bento4（常驻容器专用，禁止上函数）
#                         + fonts-noto-cjk（文字水印 drawtext 的 fontfile，与 worker 镜像同源）
#   分发端 Data Plane     Go 1.26（EdgeOne Cloud Functions 原生运行时，配 Chi/Echo/Gin/Fiber）
#   双语言契约            quicktype（zod -> JSON Schema -> Go struct，防模型漂移）
#   数据库                MySQL 8 客户端（TDSQL-C）+ sqlite3（Drizzle 方言切换余地）
#   对象存储              MinIO Client mc（本地 MinIO / COS S3 兼容接口调试）
#   部署编排              Task（Taskfile）+ edgeone CLI（Pages 全栈部署）+ docker CLI/buildx
#   连通性排查            nc / dig / ping（验证 Cloud Functions 与 TDSQL-C 内网连通）
#
# 注意：SCF 为 x86，构建部署镜像必须 docker buildx build --platform linux/amd64
# ============================================================================

FROM docker.cnb.cool/arsrna/dev-image/nodejs

# BuildKit 自动注入 TARGETARCH；无 BuildKit 时由各步骤 ${TARGETARCH:-amd64} 兜底为 amd64
ARG TARGETARCH

# ---- 可锁定的版本（升级时只改这里） ----
ARG GO_VERSION=1.26.0
ARG SHAKA_PACKAGER_VERSION=v3.9.2
ARG DOCKER_CLI_VERSION=29.6.2
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z

ENV TZ=Asia/Shanghai \
    GOPATH=/go \
    GOPROXY=https://goproxy.cn,direct \
    PATH=/usr/local/go/bin:/go/bin:${PATH}

# ---------------------------------------------------------------------------
# 1) 系统工具 + 数据库客户端 + 转码链路
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates tzdata \
        openssh-client procps less vim iputils-ping netcat-openbsd bind9-dnsutils \
        ffmpeg \
        fonts-noto-cjk \
        mysql-client \
        sqlite3 \
        jq \
    ; \
    ln -snf /usr/share/zoneinfo/"$TZ" /etc/localtime; \
    echo "$TZ" > /etc/timezone; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# 2) Go 1.26 —— 分发端语言（EdgeOne Cloud Functions 原生支持）
#    主源 golang.google.cn（国内可达），失败回退 go.dev
# ---------------------------------------------------------------------------
RUN set -eux; \
    ARCH="${TARGETARCH:-amd64}"; \
    curl -fsSL "https://golang.google.cn/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz \
      || curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm -f /tmp/go.tgz; \
    mkdir -p "$GOPATH"; \
    go version

# ---------------------------------------------------------------------------
# 3) Go 生态工具（走 goproxy.cn 国内加速）
#    task           : Taskfile 编排 —— task deploy 一条命令触发全链路部署
#    golangci-lint  : Go 静态检查
# ---------------------------------------------------------------------------
RUN set -eux; \
    go install github.com/go-task/task/v3/cmd/task@latest; \
    go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest; \
    task --version; \
    golangci-lint version

# ---------------------------------------------------------------------------
# 4) Shaka Packager —— HLS/DASH 打包 + AES-128 加密（与 ffmpeg 组成转码 Worker 工具链）
# ---------------------------------------------------------------------------
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) PKG_ARCH=arm64;; \
      *)     PKG_ARCH=x64;; \
    esac; \
    curl -fsSL -o /usr/local/bin/packager \
      "https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_PACKAGER_VERSION}/packager-linux-${PKG_ARCH}"; \
    chmod +x /usr/local/bin/packager; \
    packager -version

# ---------------------------------------------------------------------------
# 5) Docker CLI + buildx —— 构建 linux/amd64 镜像并推送 TCR（SCF 仅接受同地域 TCR）
#    daemon 由 CNB `services: docker` 提供，这里只装客户端
# ---------------------------------------------------------------------------
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) DK_ARCH=aarch64;; \
      *)     DK_ARCH=x86_64;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DK_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    if [ -f /tmp/docker/docker-buildx ]; then \
      mv /tmp/docker/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx; \
    else \
      BXV="$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+' | head -1)"; \
      curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx \
        "https://github.com/docker/buildx/releases/download/v${BXV}/buildx-v${BXV}.linux-amd64"; \
    fi; \
    chmod +x /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-buildx; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version; \
    docker buildx version

# ---------------------------------------------------------------------------
# 6) MinIO Client (mc) —— 本地 MinIO / COS（S3 兼容）调试，代码不变
# ---------------------------------------------------------------------------
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) MC_ARCH=linux-arm64;; \
      *)     MC_ARCH=linux-amd64;; \
    esac; \
    curl -fsSL -o /usr/local/bin/mc \
      "https://github.com/minio/mc/releases/download/${MC_VERSION}/mc.${MC_ARCH}.${MC_VERSION}"; \
    chmod +x /usr/local/bin/mc; \
    mc --version

# ---------------------------------------------------------------------------
# 7) npm 全局工具
#    edgeone   : EdgeOne Pages CLI —— edgeone pages deploy 一次发布前端+边缘函数+云函数
#    quicktype : 契约生成 —— zod -> JSON Schema -> Go struct，生成物入库 + CI git diff 门禁
# ---------------------------------------------------------------------------
RUN set -eux; \
    npm install -g --silent edgeone quicktype; \
    npm ls -g --depth=0; \
    edgeone --version; \
    quicktype --version

# ---------------------------------------------------------------------------
# 8) ffmpeg/ffprobe wrapper —— 隔离 CodeBuddy 终端注入的 LD_LIBRARY_PATH
#    CodeBuddy 终端会在运行时把 LD_LIBRARY_PATH 指向 /root/.codebuddy-server-cn/
#    .../lib，其自带旧版 libstdc++.so.6（缺 GLIBCXX_3.4.29~3.4.32）会遮蔽系统库，
#    导致系统 ffmpeg/ffprobe 报 "GLIBCXX_3.4.32 not found" 无法启动。
#    在 /usr/local/bin（PATH 优先于 /usr/bin）放置 wrapper，运行时清空该变量；
#    仅影响 ffmpeg/ffprobe 自身，不影响 CodeBuddy 工具链。
# ---------------------------------------------------------------------------
RUN set -eux; \
    printf '#!/bin/sh\nLD_LIBRARY_PATH= exec /usr/bin/ffmpeg "$@"\n'  > /usr/local/bin/ffmpeg; \
    printf '#!/bin/sh\nLD_LIBRARY_PATH= exec /usr/bin/ffprobe "$@"\n' > /usr/local/bin/ffprobe; \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe; \
    LD_LIBRARY_PATH=/nonexistent ffmpeg -version | head -1; \
    LD_LIBRARY_PATH=/nonexistent ffprobe -version | head -1

WORKDIR /workspace
