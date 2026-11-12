# 播放演示 App player 镜像（spec.md §11.8：Next.js 全栈单容器，UI + route handler 同源）
#
# 构建上下文必须是**仓库根**：player 经 `workspace:*` 依赖 `@openvod/contracts`（TS 源码直引），
# 且与其它 app 共用根 `bun.lock`；用 `-f` 指 Dockerfile：
#   docker build -f apps/player/Dockerfile -t <tag> .
#
# 与 admin 镜像的差异：
#   1) player **不依赖** packages/db / Prisma → 不跑两份客户端生成（构建更快，也不需 openssl）；
#   2) 分发端地址只在**服务端**（DELIVERY_BASE_URL）：浏览器请求一律经 `/api/delivery` 同源代理
#      （spec.md §11.9）——镜像一次构建可跨环境部署、不依赖构建期内联，改 env 重启即生效。
FROM node:22-bookworm-slim AS build

RUN npm i -g bun@1
WORKDIR /app
# 整仓入上下文（.dockerignore 已剔除 node_modules / .next / 生成物 / 密钥）：
# 逐个 COPY 各 workspace 的 package.json 会更省缓存层，但新增包时容易漏（与 admin 同一取舍，deploy-apps.md）
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/player build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build /app /app

# 端口由 PLAYER_PORT 控制（默认 :3100，与 dev-workflow §1 一致）
EXPOSE 3100

# /healthz 语义：进程存活即 200（与 admin 同口径，供 compose / 编排探活）；
# 端口先清洗成纯数字：`docker run --env-file` 不剥 .env 引号（compose 会剥），带引号会让 URL / -p 非法
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const p=String(process.env.PLAYER_PORT??3100).replace(/\\D/g,'')||'3100';fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# bun 把 next 装在 apps/player/node_modules（不 hoist 到根），故用包内路径；cwd 必须是 apps/player。
# 同上：`-p "3100"` 会被 next 以 `not a non-negative number` 拒绝，先 tr 只保留数字
CMD ["sh", "-c", "cd /app/apps/player && PORT=$(printf '%s' \"${PLAYER_PORT:-3100}\" | tr -cd 0-9); [ -n \"$PORT\" ] || PORT=3100; exec node ./node_modules/next/dist/bin/next start -p \"$PORT\""]
