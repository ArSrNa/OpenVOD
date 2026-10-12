# 体验环境启动 Runbook（Agent 用）

用户对 Agent 说「**启动一个体验环境**」（同类说法：「快速试用」「起一个本地体验环境」「搭个试用环境」）时，
**按本 Runbook 执行**：用 `docker-compose.infra.yml` + `scripts/compose-infra.sh` 拉起本地底座
（MySQL + RustFS，S3 兼容），再把三端跑起来。

目标：用户最后拿到管理台 / 分发端 / RustFS 控制台地址，**只需在 `/setup` 向导里填一次 RustFS 参数**。

适合：CNB 云原生开发环境（推荐，Docker 已内置）或任意有 Docker 的宿主。
不适合：生产部署（见 `deploy-delivery.md` / `deploy-apps.md`）。

## 0. 前置检查（别跳过）

1. Docker 可用：`docker compose version`（CNB 开发环境自带 docker service）。
2. 依赖就绪：`bun i`（已装过秒回）。
3. 本流程**全程不修改根 `.env`**：试用配置写入独立的 `.env.trial`，`dev.ts` 用 `--env-file` 加载。
   看一眼根 `.env` 是否存在即可（决定 `init-env` 的取材来源），无需备份、无需改动。
4. 已有服务在跑时先停（避免同端口冲突 / 旧配置的实例继续挂着）：
   - 源码进程：`bun scripts/dev.ts status` → `bun scripts/dev.ts stop`；
   - 容器（根编排）：`docker compose stop admin worker`（注意 worker 必须单实例）。

## 1. 启动底座（MySQL + RustFS）

```bash
sh scripts/compose-infra.sh up
```

脚本自动完成：生成 `.run/infra.env`（随机口令 + RustFS AK/SK，600 权限，已 gitignore）→
起 `openvod-infra` 编排（与根编排 `openvod` 互不影响）→ 等 mysql 健康 →
幂等创建分发端受限账号 `openvod_ro`（ADR-0011：约定表只读 + `playback_sessions` 读写）。

验证：`sh scripts/compose-infra.sh ps` 两个容器均 Up；
`sh scripts/compose-infra.sh env` 能打印三条连接串。

## 2. 生成 `.env.trial`（全程不碰根 `.env`）

```bash
sh scripts/compose-infra.sh init-env
```

- 根 `.env` 存在 → 以它为底，仅覆盖 `DB_PROVIDER` / `DATABASE_URL` / `DELIVERY_DATABASE_URL` 三个键，其余键原样继承；
- 根 `.env` 不存在 → 生成必需最小集（ADR-0015），`MASTER_KEYS` 随机生成；
- 产出 `.env.trial`（权限 600，已被 `.gitignore` 的 `.env.*` 规则忽略）；**重复执行会整体重新生成，勿手改**。

连接串明细可用 `sh scripts/compose-infra.sh env` 查看（含口令，勿外传；也不要整段回显到聊天）。

## 3. 建表

```bash
task db:generate   # mysql + sqlite 两份 Prisma 客户端（缺任一 Next 打包报错）
# Prisma CLI 不认识 .env.trial：先显式导出再迁移（真实进程环境优先于 .env 文件，不会被根 .env 打回）
set -a && . ./.env.trial && set +a && task db:migrate
```

验证（能看到几十张表即成功）：

```bash
docker compose -f docker-compose.infra.yml --env-file .run/infra.env \
  exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW TABLES" openvod'
```

空库 + 仓库自带 migrations 正常一次通过；若报 `P3014`（影子库），用 `scripts/compose-infra.sh env`
打印的 root 连接串，或走 dev-workflow §4.3 的 baseline 流程。

## 4. 起三端（后台常驻）

```bash
bun scripts/dev.ts --env-file .env.trial all --background   # admin + delivery + worker 一起后台起
bun scripts/dev.ts --env-file .env.trial status             # 三行 running
```

**体验环境下所有 `dev.ts` 命令都必须带 `--env-file .env.trial`**：`dev.ts` 指定该文件后完全不读根 `.env`；
忘带时会加载根 `.env`——那里可能连着生产库（dev.ts 的语义是「文件覆盖环境变量」，shell 导出挡不住它）。
（想前台看日志就分开跑 `--env-file .env.trial admin` / `delivery`；起 admin 会自动一并带 worker。）

## 5. 交代给用户（回复必须包含）

| 项 | 值 |
|---|---|
| 管理台 | CNB 预览：`$CNB_VSCODE_PROXY_URI` 的 `{{port}}` 换 `ADMIN_PORT`（默认 8787）；本机则 `http://127.0.0.1:8787` |
| 首次初始化 | 打开管理台自动进 `/setup` 向导：S3 参数填 **RustFS**——端点 `http://127.0.0.1:9002`、桶（先在 RustFS 控制台创建同名桶）、AK/SK 见 `.run/infra.env`；向导里可顺便创建首个管理员（email + 密码 ≥8 位） |
| RustFS 控制台 | `sh scripts/compose-infra.sh url`（CNB 预览地址推导）；本机 `http://127.0.0.1:9003` |
| 分发端 | `http://127.0.0.1:9000`（`DELIVERY_LISTEN`）；CNB 上需在 WebIDE 的 PORTS 面板添加 |
| 凭据文件 | `.run/infra.env`（MySQL 口令 + RustFS AK/SK）、`.env.trial`（DB 连接串 + MASTER_KEYS）：均 600 且已 gitignore |
| 停止 / 清理 | 底座 `sh scripts/compose-infra.sh down`（保数据）/ `reset`（**删卷清数据**）；三端 `bun scripts/dev.ts stop` |

## 安全红线

- **密钥不进聊天**：`.run/infra.env` / `.env.trial` 的值不整段回显，用户要看就让他自己开文件。
- 全程不修改根 `.env`；`.env.trial` 由 `init-env` 生成（重复执行整体覆盖），`.run/infra.env` 由脚本管理——两者都**不要手改**。
- **所有 `dev.ts` 命令必须带 `--env-file .env.trial`**：忘带 = 读根 `.env`，可能连到生产库。
- `reset` 会删数据卷，执行前必须先跟用户确认。
- 底座默认只绑 `127.0.0.1`：确需暴露到局域网才设 `INFRA_BIND=0.0.0.0`，并提醒口令强度。

## 故障速查

统一先查 `dev-workflow.md §8`。本流程高频：

| 症状 | 处理 |
|---|---|
| `up` 卡在等 mysql 健康 | `sh scripts/compose-infra.sh logs mysql` 看初始化日志；首次拉镜像慢属正常 |
| 忘带 `--env-file .env.trial` 起了服务 | `bun scripts/dev.ts stop` 全停后带参重启；若根 `.env` 指向生产库，向用户说明连错过库 |
| admin 起不来：`Cannot find module '../generated/sqlite'` | 漏了 `task db:generate`，两份客户端都要 |
| 向导页报 MASTER_KEYS 未配置 / 非法 | `.env.trial` 的 `MASTER_KEYS` 格式问题（`init-env` 已自动处理占位值），dev-workflow §8 有逐条自查 |
| 登录 403 Invalid origin | CNB 预览网关会改写 Origin，见 dev-workflow §8 对应条目 |
| 分发端 login 返回 503 未配置 JWT 签名密钥 | 向导完成后跑 `bun apps/admin/scripts/bootstrap-playback.ts <用户> <密码≥8位>` 引导播放链路（含签名密钥 + 播放端用户） |
