# 环境变量清单（按应用拆分）

> **ADR-0015（2026-09-22 起）**：环境变量已收敛为**最小集**，本文件的多数变量降级为
> **env 兜底**——真正的运行配置存 `system_settings`，由管理台**首次启动向导 `/setup`**
> 写入（存储凭据、播放域名、TTL、播放签名密钥等），管理台「系统设置」页可随时调整。
>
> 解析顺序统一：**DB 设置值 > env 同名键 > 出厂默认**。
>
> - **必需 env（仅 3 个）**：`DATABASE_URL`、`DB_PROVIDER`、`MASTER_KEYS`
>   （外加进程装配期的 `ADMIN_PORT` / `DELIVERY_LISTEN`）；三端共用 `DATABASE_URL`，
>   不再有 `DELIVERY_DATABASE_URL`（ADR-0011 2026-10-17 修订）；
> - **密钥类设置**（S3 SecretAccessKey、播放签名密钥等）以 **MK 封装 hex** 入库（ADR-0006 分层），
>   `MASTER_KEYS` 永远只存在于 env——它是唯一不可入库的密钥；
> - 下文表格保留作为「env 兜底清单」与旧部署迁移参考；三端对照速查表中的键凡与
>   `packages/shared` 的 `SETTING_KEYS` 同义者均已被设置覆盖。

本文件按 **delivery / worker / admin / player** 四个应用分别列出各自运行所需的环境变量。
它们**共享同一份 `.env`**（`scripts/gen-env.sh` 从密钥仓库 / 进程环境生成，模板见根目录 `.env.example`；
player 另有独立模板 `apps/player/.env.example`），
但**各应用实际读取的键不同**——本文件用于区分「谁真正需要哪个变量」，避免误以为某个键各端通用。

> 真源：`.env.example`（模板）+ 代码读取点（见每节「读取位置」）。
> `.env` 不入库；CI 校验的必需键见 `scripts/gen-env.sh` 的 `REQUIRED_KEYS`。

共用的**变量值**（不是每个应用都读，但值必须一致）：
`MASTER_KEYS` —— admin(TS) 与 delivery(Go) 必须完全一致，worker 也用；否则 CEK 无法解封（ADR-0006）。

---

## 1. delivery（分发端，Go，`apps/delivery`）

读取位置：`apps/delivery/internal/config/config.go`（`config.Load()`，12-factor，ADR-0002）。

### .env 格式（可直接复制）

```dotenv
# ==================== delivery（分发端） ====================
# 监听地址（SCF Web 函数固定 :9000）
DELIVERY_LISTEN=":9000"
# 运行环境标识：dev | prod
APP_ENV="dev"

# 数据库连接串三端共用（见顶部 DATABASE_URL）：delivery 不再单独配置
# 需要最小权限时，给 delivery 进程单独传受限账号的 DATABASE_URL

# 播放 URL 基址（清单 / 密钥 / 字幕）；生产填分发域名
# 留空 = 回退 http://127.0.0.1:{DELIVERY_LISTEN 端口}；可被 system_settings.playback_base_url 运行时覆盖
DELIVERY_PUBLIC_BASE_URL=""

# 播放 token 的 HMAC 密钥（32 字节 hex，共 64 位；生成：openssl rand -hex 32）
URL_SIGN_KEY_HEX="1111111111111111111111111111111111111111111111111111111111111111"
# 播放 token 的 kid
URL_SIGN_KEY_KID="urlsign-v1"

# 主密钥 MK（格式 "版本:64位hex"，逗号分隔多版本轮换；生成：openssl rand -hex 32）
# 必须与 admin / worker 完全一致，否则 CEK 无法解封（ADR-0006）
MASTER_KEYS="1:0000000000000000000000000000000000000000000000000000000000000000"

# 播放端 JWT（ES256）
DELIVERY_JWT_ISSUER="openvod-delivery"
DELIVERY_JWT_TTL_SEC="86400"          # JWT 有效期（秒），默认 24h
PLAYBACK_SESSION_TTL_SEC="14400"      # 播放会话有效期（秒）
PLAYBACK_MANIFEST_TTL_SEC="14400"     # 清单 token / 预签名有效期上限（token exp ≤ 会话 exp）
PLAYBACK_SUBTITLE_TTL_SEC="86400"     # 字幕 token 有效期上限
DELIVERY_CORS_ORIGINS="*"             # 允许跨域的源，逗号分隔；* = 全部

# ---- 对象存储（S3 兼容：COS / MinIO 等；ADR-0005 2026-09-22 修订：仅 S3，local 驱动已移除）----
STORAGE_ROOT_PREFIX=""                # 全局 root 前缀，空 = 桶顶层
S3_ENDPOINT=""                        # 必填（COS: https://cos.<region>.myqcloud.com）
S3_REGION=""                          # 必填
S3_BUCKET=""                          # 必填
S3_ACCESS_KEY_ID=""                   # 必填
S3_SECRET_ACCESS_KEY=""               # 必填
S3_FORCE_PATH_STYLE="true"            # MinIO 用 true；腾讯云 COS 必须显式 "false"
STORAGE_CDN_BASE_URL=""               # 加速域名（仅替换 GET 预签名 URL 的 origin，可选）
```

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | **是** | 无 | 三端共用连接串。支持 `mysql://`（归一为 go-sql-driver DSN，自动补 `parseTime=true&loc=UTC&charset=utf8mb4`）、go-sql-driver DSN、`file:./dev.db` / `sqlite:///abs.db`（SQLite 单机同卷；相对路径按 `packages/db/prisma` 解析）。MySQL 生产可给 delivery 进程单独传受限账号（约定表只读 + `playback_sessions` 读写，ADR-0011）；**EdgeOne 发布脚本只注入此键** |
| `URL_SIGN_KEY_HEX` | **是** | 无 | 播放 token 的 HMAC 密钥，64 位 hex（32B）。非法 / 缺失直接启动失败 |
| `MASTER_KEYS` | **是** | 无 | `"版本:64位hex"`，逗号分隔多版本。用于解封 CEK 与 JWT 私钥（ADR-0006） |
| `DELIVERY_LISTEN` | 否 | `:9000` | 监听地址（SCF Web 函数固定 9000） |
| `DELIVERY_PUBLIC_BASE_URL` | 否 | 空 → `http://127.0.0.1:{端口}` | 播放 URL 基址（清单 / 密钥 / 字幕）。生产填分发域名；运行时可被 `system_settings.playback_base_url` 覆盖（60s 缓存） |
| `URL_SIGN_KEY_KID` | 否 | `urlsign-v1` | 播放 token 的 `kid` |
| `DELIVERY_JWT_ISSUER` | 否 | `openvod-delivery` | 播放端 JWT 的 `iss` |
| `DELIVERY_JWT_TTL_SEC` | 否 | `86400` | JWT 有效期（ADR-0007：默认 24h，无 refresh） |
| `PLAYBACK_SESSION_TTL_SEC` | 否 | `14400` | 播放会话有效期 |
| `PLAYBACK_MANIFEST_TTL_SEC` | 否 | `14400` | 清单 token / 预签名有效期上限（token exp ≤ 会话 exp） |
| `PLAYBACK_SUBTITLE_TTL_SEC` | 否 | `86400` | 字幕 token 有效期上限（实际 exp 取与会话 exp 较小值） |
| `DELIVERY_CORS_ORIGINS` | 否 | `*` | 允许跨域的源（管理端预览用；逗号分隔） |
| `APP_ENV` | 否 | `dev` | 运行环境标识 |
| `STORAGE_ROOT_PREFIX` | 否 | 空 | 全局 root 前缀（spec.md §1.1），空 = 桶顶层 |
| `S3_ENDPOINT` | **是** | 空 | S3 兼容端点（COS / MinIO） |
| `S3_REGION` | **是** | 空 | 区域 |
| `S3_BUCKET` | **是** | 空 | 桶名 |
| `S3_ACCESS_KEY_ID` | **是** | 空 | 访问密钥 ID |
| `S3_SECRET_ACCESS_KEY` | **是** | 空 | 访问密钥 |
| `S3_FORCE_PATH_STYLE` | 否 | `true` | 寻址风格。**腾讯云 COS 必须显式 `false`**（virtual-hosted-style）；MinIO 保持 `true` |
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 对象存储加速域名（ADR-0005 / ADR-0019）：`s3_presign` 模式仅替换 GET 预签名 URL 的 origin；`cdn_url_auth` 模式为签名 URL 的 host |
| `STORAGE_SIGN_MODE` | 否 | `s3_presign` | GET 签名方式：`s3_presign`（S3 SigV4 预签名）\| `cdn_url_auth`（EO Token 鉴权方式 A，CDN 私有回源）\| `custom`（编译期注册的自定义提供者）。✅ **已实现（ADR-0019 / spec §6.7）** |
| `STORAGE_CDN_AUTH_KEY` | 否 | 空 | CDN 边缘鉴权密钥（`cdn_url_auth` 必填；与 CDN 控制台同款密钥双侧一致；system_settings 中 MK 封装，env 兜底） |
| `STORAGE_CDN_AUTH_TYPE` | 否 | `a` | `cdn_url_auth` 的 EO Token 鉴权方式：`a` \| `b` \| `c` \| `d` \| `v`（与 CDN 控制台 Token 鉴权所选方式一致；A 为 query sign、B/C 为路径前缀、D 为 token/t、V 为过期时刻 t + sha1，§6.7） |
| `STORAGE_CDN_AUTH_PARAM` | 否 | `sign` | 方式 A 的鉴权 query 参数名（与 CDN 控制台「鉴权加密串参数名称」一致，1–100 位字母 / 数字 / 下划线） |
| `STORAGE_CDN_AUTH_TOKEN_PARAM` | 否 | `token` | 方式 D 的签名参数名（与 CDN 控制台一致；与时间戳参数名不可相同） |
| `STORAGE_CDN_AUTH_TIME_PARAM` | 否 | `t` | 方式 D 的时间戳参数名（与 CDN 控制台一致） |
| `STORAGE_CDN_AUTH_TTL_SEC` | 否 | `3600` | CDN 鉴权窗口（timestamp 按窗口对齐 = 窗口内 URL 稳定缓存友好；与 CDN 控制台「有效时长」一致） |
| `STORAGE_CUSTOM_SIGNER` | 否 | `custom` | `custom` 模式的提供者注册名（TS `registerUrlSigner` / Go `RegisterURLSigner`；实现入口 `packages/storage/src/custom-signer.ts` 与 `apps/delivery/internal/blob/custom_signer.go`） |

> delivery **不读** `DB_PROVIDER` / `BETTER_AUTH_SECRET`；只读 `DATABASE_URL`（驱动由 scheme 推导）。
> 部署环境变量清单另见 `docs/vod/deploy-delivery.md`。

---

## 2. worker（转码 Worker，Bun，`apps/worker`）

读取位置：`apps/worker/src/index.ts`（轮询参数）、`apps/worker/src/media-keys.ts`（`MASTER_KEYS`）、
`apps/worker/src/key-files.ts`（`DELIVERY_PUBLIC_BASE_URL`），DB 经 `@openvod/db`（`DATABASE_URL` / `DB_PROVIDER`），
存储经 `@openvod/storage` 的 `createStorageFromEnv()`。

### .env 格式（可直接复制）

```dotenv
# ==================== worker（转码 Worker） ====================
# 数据库（Prisma）：生产 MySQL；开发 SQLite 写 "file:./dev.db"
DATABASE_URL="mysql://openvod:changeit@127.0.0.1:3306/openvod"
# Prisma 客户端方言：mysql | sqlite
DB_PROVIDER="mysql"

# 主密钥 MK（"版本:64位hex"，逗号分隔多版本）；加密任务前提，必须与 admin / delivery 一致
MASTER_KEYS="1:0000000000000000000000000000000000000000000000000000000000000000"

# 转码期写 key_info 的密钥 URI 占位基址（应与 delivery 同值；留空用内建占位）
DELIVERY_PUBLIC_BASE_URL=""

# ---- 运行模式与队列认领（ADR-0008 / ADR-0017）----
WORKER_MODE="resident"           # resident = 常驻轮询；http = HTTP 门铃（serverless，/wake 触发认领）
WORKER_HTTP_PORT="9001"          # http 模式监听端口（仅 http 模式）
WORKER_IDLE_EXIT_MINUTES="0"     # http 模式空闲退出分钟数；0 = 不退出
WORKER_POLL_INTERVAL_MS="2000"   # 轮询间隔（毫秒，仅 resident 模式）
WORKER_LEASE_MS="60000"          # 任务 lease 时长（执行期按 1/3 续期，崩溃后过期重派）
WORKER_MAX_ATTEMPTS="3"          # 单任务最大尝试次数，超过判 FAILED

# ---- HTTP 门铃（ADR-0017；http 模式必填，admin 的 worker_notify_url / worker_notify_secret 须同值）----
WORKER_NOTIFY_URL="https://worker.example.com"   # admin 侧配置：发起转码/重启后 POST {URL}/wake
WORKER_NOTIFY_SECRET=""                          # /wake Bearer 密钥；http 模式缺失则拒绝启动

# ---- 对象存储（S3 兼容：COS / MinIO 等；仅 S3，local 驱动已移除）----
STORAGE_ROOT_PREFIX=""                # 全局 root 前缀，空 = 桶顶层
S3_ENDPOINT=""                        # 必填
S3_REGION=""                          # 必填
S3_BUCKET=""                          # 必填
S3_ACCESS_KEY_ID=""                   # 必填
S3_SECRET_ACCESS_KEY=""               # 必填
S3_FORCE_PATH_STYLE="true"            # MinIO 用 true；COS 必须显式 "false"
STORAGE_CDN_BASE_URL=""               # 加速域名（可选）

# 运行环境依赖（非环境变量）：必须安装 ffmpeg / ffprobe，缺失则 worker 启动即退出
```

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | **是** | 无 | Prisma 连接串（`packages/db/prisma` 的 `datasource.url = env("DATABASE_URL")`）。生产 MySQL，开发可 SQLite `file:./dev.db` |
| `DB_PROVIDER` | 否 | `mysql` | `mysql` \| `sqlite`，决定实例化哪份 Prisma 客户端（`@openvod/db`） |
| `MASTER_KEYS` | **加密任务必填** | 无 | 加密封装 CEK 的 MK。缺失时启动自检告警，**加密模板任务将失败**（未加密模板不受影响） |
| `DELIVERY_PUBLIC_BASE_URL` | 否 | 内建占位 | 转码期写 `key_info` 的密钥 URI 占位基址（ADR-0006 §2/§3）；应与 delivery 同值 |
| `WORKER_MODE` | 否 | `resident` | `resident`（常驻轮询，自托管）\| `http`（门铃模式：暴露 `POST /wake`，唤醒后 claim-drain，空闲可退出；ADR-0017）。DB `worker_mode` > env |
| `WORKER_HTTP_PORT` | 否 | `9001` | http 模式监听端口（含 `GET /healthz` 供平台探活） |
| `WORKER_IDLE_EXIT_MINUTES` | 否 | `0`（不退出） | http 模式空闲退出阈值：最后一次认领后连续 N 分钟无任务即 graceful 退出，加速平台缩零 |
| `WORKER_NOTIFY_SECRET` | http 模式**是** | 空 | `/wake` Bearer 共享密钥（常量时间比较）；admin 侧 `worker_notify_secret` 须同值，**http 模式未配置则拒绝启动**（防计费攻击） |
| `WORKER_POLL_INTERVAL_MS` | 否 | `2000` | 轮询认领间隔（毫秒，仅 resident 模式） |
| `WORKER_LEASE_MS` | 否 | `60000` | 任务 lease 时长；执行期按 1/3 续期，崩溃后 lease 过期即重派（ADR-0008） |
| `WORKER_MAX_ATTEMPTS` | 否 | `3` | 单任务最大尝试次数，超过判 `FAILED`，防崩溃循环 |
| `STORAGE_ROOT_PREFIX` | 否 | 空 | 全局 root 前缀（spec.md §1.1） |
| `S3_ENDPOINT` | **是** | 空 | S3 兼容端点 |
| `S3_REGION` | **是** | 空 | 区域 |
| `S3_BUCKET` | **是** | 空 | 桶名 |
| `S3_ACCESS_KEY_ID` | **是** | 空 | 访问密钥 ID |
| `S3_SECRET_ACCESS_KEY` | **是** | 空 | 访问密钥 |
| `S3_FORCE_PATH_STYLE` | 否 | `true` | 同 delivery；COS 需 `false` |
| `S3_ENDPOINT_INTERNAL` | 否 | 空 | **仅 Worker 取源片与水印图**使用的同桶内网 / 本机端点（如 COS `cos-internal.*`、自托管 `http://127.0.0.1:<端口>`）；留空 = 用 `S3_ENDPOINT` 直连。Worker 对候选通路实测吞吐择优（2026-10-17，ADR-0019 修订） |
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 加速域名（签名 origin 替换 / cdn_url_auth 签名 host） |
| `STORAGE_SIGN_MODE` | 否 | `s3_presign` | 同 delivery；**Worker 取源片 / 水印图已不走签名通路**（直连 + 内网端点择优，2026-10-17，ADR-0019 修订） |
| `STORAGE_CDN_AUTH_KEY` | 否 | 空 | 同 delivery（system_settings 中 MK 封装，env 兜底） |
| `STORAGE_CDN_AUTH_TYPE` | 否 | `a` | 同 delivery（EO Token 鉴权方式 `a`–`v`，与 CDN 控制台一致） |
| `STORAGE_CDN_AUTH_PARAM` | 否 | `sign` | 同 delivery（方式 A 鉴权参数名） |
| `STORAGE_CDN_AUTH_TOKEN_PARAM` | 否 | `token` | 同 delivery（方式 D 签名参数名） |
| `STORAGE_CDN_AUTH_TIME_PARAM` | 否 | `t` | 同 delivery（方式 D 时间戳参数名） |
| `STORAGE_CDN_AUTH_TTL_SEC` | 否 | `3600` | 同 delivery |
| `STORAGE_CUSTOM_SIGNER` | 否 | `custom` | 同 delivery（Worker 侧经 packages/storage 注册表路由） |

> **运行环境依赖（非环境变量）**：worker 启动自检 `ffmpeg` / `ffprobe`，缺失任一直接 `exit 1`。
> **硬约束**：worker 单实例（同一媒资任务必须串行，加密任务尤其如此，ADR-0006 §4.2）；禁止上任何函数（P0）。

---

## 3. admin（管理端，Next.js 全栈，`apps/admin`）

读取位置：`apps/admin/src/lib/auth.ts`（better-auth / OIDC / 会话）、`apps/admin/src/lib/storage.ts`（存储）、
`apps/admin/src/lib/keys.ts` 与 `scripts/bootstrap-playback.ts`（`MASTER_KEYS`）、
`apps/admin/src/lib/media.ts`（`MEDIA_ID_LENGTH`）、`apps/admin/src/lib/delivery-preview.ts`（分发端预览，经播放器 SDK 接入）、
`apps/admin/src/lib/settings.ts`（`DELIVERY_PUBLIC_BASE_URL` 回退提示）；DB 经 `@openvod/db`。

### .env 格式（可直接复制）

```dotenv
# ==================== admin（管理端） ====================
# 数据库（Prisma）：生产 MySQL；开发 SQLite 写 "file:./dev.db"
DATABASE_URL="mysql://openvod:changeit@127.0.0.1:3306/openvod"
# Prisma 客户端方言：mysql | sqlite
DB_PROVIDER="mysql"

# better-auth 加密密钥（≥32 字符随机串；生成：openssl rand -base64 32）
BETTER_AUTH_SECRET="please-generate-a-random-secret-min-32-chars"

# 主密钥 MK（"版本:64位hex"，逗号分隔多版本）；/api/admin/keys 解封 CEK、MK 轮换、建 JWT 签名密钥
# 必须与 delivery / worker 完全一致
MASTER_KEYS="1:0000000000000000000000000000000000000000000000000000000000000000"

# ---- 服务与鉴权 ----
ADMIN_PORT="8787"                       # 监听端口（亦有 PORT 兜底）
ADMIN_BASE_URL="http://localhost:8787"  # 对外基址（better-auth baseURL）；反代填外部地址，填错报 403 Invalid origin
ADMIN_TRUSTED_ORIGINS=""                # 额外信任来源，逗号分隔（可选；裸域名展开为 http+https，支持通配符）
ADMIN_SESSION_TTL_SEC="28800"           # 会话有效期（秒），默认 8h
# CNB_VSCODE_PROXY_URI 由平台自动注入，检测到会覆盖上面两项，通常无需手配

# ---- Worker 唤醒（ADR-0017 门铃；worker 为 http 模式时配置，也可在「系统设置 → 任务设置」维护）----
WORKER_NOTIFY_URL="https://worker.example.com"  # 发起转码 / 重启后 POST {URL}/wake 加速认领；通知可丢，队列兜底
WORKER_NOTIFY_SECRET=""                         # /wake Bearer 密钥；须与 worker 侧一致（worker 侧必填，admin 侧仅发通知可空）

# ---- OIDC（可选；留空则仅本地邮箱密码登录）----
OIDC_ISSUER="https://sso.example.com"   # discovery: {OIDC_ISSUER}/.well-known/openid-configuration
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
# 回调固定为 /api/auth/callback/generic-oidc（在 IdP 处登记）

# ---- 对象存储（S3 兼容：COS / MinIO 等；仅 S3，local 驱动已移除）----
STORAGE_ROOT_PREFIX=""                # 全局 root 前缀，空 = 桶顶层
S3_ENDPOINT=""                        # 必填
S3_REGION=""                          # 必填
S3_BUCKET=""                          # 必填
S3_ACCESS_KEY_ID=""                   # 必填
S3_SECRET_ACCESS_KEY=""               # 必填
S3_FORCE_PATH_STYLE="true"            # MinIO 用 true；COS 必须显式 "false"
STORAGE_CDN_BASE_URL=""               # 加速域名（原视频 / 封面 302、presign 分片 origin 替换，可选）

# ---- 媒资与播放预览 ----
MEDIA_ID_LENGTH="8"                              # 媒资数字 ID 位数（4–16，保留前导零）
DELIVERY_BASE_URL="http://127.0.0.1:9000"        # 「产物 → 播放」预览调用的分发端地址
DELIVERY_PREVIEW_USERNAME=""                     # 预览账号用户名（bootstrap-playback.ts 创建）；缺失则预览接口 501
DELIVERY_PREVIEW_PASSWORD=""                     # 预览账号口令
DELIVERY_PUBLIC_BASE_URL=""                      # /api/admin/settings 回退提示展示用（应与 delivery 同值）

# 运行环境依赖（非环境变量）：生成元数据 /api/admin/media/{id}/metadata 需安装 ffprobe
```

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | **是** | 无 | Prisma 连接串（同 worker，`env("DATABASE_URL")`） |
| `DB_PROVIDER` | 否 | `mysql` | `mysql` \| `sqlite` |
| `BETTER_AUTH_SECRET` | **是** | 无 | better-auth 加密密钥（≥32 字符随机串，`openssl rand -base64 32`） |
| `MASTER_KEYS` | **是** | 无 | `/api/admin/keys` 的 CEK 解封 / MK 轮换、创建 JWT 签名密钥（`bootstrap-playback.ts`）。**必须与 delivery 完全一致** |
| `ADMIN_PORT` | 否 | `8787` | 监听端口（另有 `PORT` 兜底；Docker 里由它控制 `next start -p`） |
| `ADMIN_BASE_URL` | 否 | `http://localhost:{ADMIN_PORT}` | 管理端对外基址（better-auth `baseURL`）。反代场景填外部地址；填错 host 会 403 `Invalid origin` |
| `ADMIN_TRUSTED_ORIGINS` | 否 | 空 | 额外信任来源（逗号分隔；裸域名展开为 http+https，支持通配符） |
| `ADMIN_SESSION_TTL_SEC` | 否 | `28800` | 管理端会话有效期（秒），默认 8h |
| `WORKER_NOTIFY_URL` | worker 为 http 模式时建议配 | 空 | admin 门铃目标：发起转码 / 重启后 fire-and-forget `POST {URL}/wake`（ADR-0017）；失败仅告警，任务留存队列。也可在「系统设置 → 任务设置」配置（DB > env） |
| `WORKER_NOTIFY_SECRET` | 同上 | 空 | `/wake` Bearer 密钥（admin 发通知用；worker 侧 http 模式必填）。「系统设置」里对应键 `worker_notify_secret` 为 MK 封装存储 |
| `OIDC_ISSUER` | 否 | 空 | 通用 OIDC（genericOAuth）。空 = 仅本地邮箱密码登录 |
| `OIDC_CLIENT_ID` | OIDC 时必填 | 空 | OIDC 客户端 ID |
| `OIDC_CLIENT_SECRET` | OIDC 时必填 | 空 | OIDC 客户端密钥 |
| `CNB_VSCODE_PROXY_URI` | 否 | 由平台注入 | CNB 云原生开发环境变量；检测到即以它覆盖 `ADMIN_BASE_URL` / `ADMIN_TRUSTED_ORIGINS`（**无需手工配置**） |
| `STORAGE_ROOT_PREFIX` | 否 | 空 | 全局 root 前缀 |
| `S3_ENDPOINT` | **是** | 空 | S3 兼容端点 |
| `S3_REGION` | **是** | 空 | 区域 |
| `S3_BUCKET` | **是** | 空 | 桶名 |
| `S3_ACCESS_KEY_ID` | **是** | 空 | 访问密钥 ID |
| `S3_SECRET_ACCESS_KEY` | **是** | 空 | 访问密钥 |
| `S3_FORCE_PATH_STYLE` | 否 | `true` | 同 delivery；COS 需 `false` |
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 加速域名（原视频 / 封面预览 302、presign 分片 origin 替换；cdn_url_auth 下为签名 host） |
| `STORAGE_SIGN_MODE` | 否 | `s3_presign` | 同 delivery（管理端 302 / probe 读取同一签名形态，ADR-0019） |
| `STORAGE_CDN_AUTH_KEY` | 否 | 空 | 同 delivery（system_settings 中 MK 封装，env 兜底） |
| `STORAGE_CDN_AUTH_TYPE` | 否 | `a` | 同 delivery（EO Token 鉴权方式 `a`–`v`，与 CDN 控制台一致） |
| `STORAGE_CDN_AUTH_PARAM` | 否 | `sign` | 同 delivery（方式 A 鉴权参数名） |
| `STORAGE_CDN_AUTH_TOKEN_PARAM` | 否 | `token` | 同 delivery（方式 D 签名参数名） |
| `STORAGE_CDN_AUTH_TIME_PARAM` | 否 | `t` | 同 delivery（方式 D 时间戳参数名） |
| `STORAGE_CDN_AUTH_TTL_SEC` | 否 | `3600` | 同 delivery |
| `STORAGE_CUSTOM_SIGNER` | 否 | `custom` | 同 delivery（实现入口 `packages/storage/src/custom-signer.ts`） |
| `MEDIA_ID_LENGTH` | 否 | `8` | 媒资数字 ID 位数（4–16，保留前导零，spec.md §1.3） |
| `DELIVERY_BASE_URL` | 预览时必填 | `http://127.0.0.1:9000` | 「产物 → 播放」预览调用的分发端地址（服务端 → 分发端） |
| `DELIVERY_PREVIEW_USERNAME` | 预览时必填 | 空 | 预览账号用户名（用 `bun apps/admin/scripts/bootstrap-playback.ts` 创建）。缺失时预览接口返回 501 |
| `DELIVERY_PREVIEW_PASSWORD` | 预览时必填 | 空 | 预览账号口令（同上） |
| `DELIVERY_PUBLIC_BASE_URL` | 否 | 空 | 仅用于 `/api/admin/settings` 的 `env_public_base_url` 回退提示展示；应与 delivery 同值 |

> **运行环境依赖（非环境变量）**：`/api/admin/media/{id}/metadata` 生成元数据需要运行环境安装 **ffprobe**。
> `task db:generate` 产出的两份 Prisma 客户端（mysql + sqlite）必须同时存在，否则 `next build` / `bun test` 报
> `Module not found: '../generated/sqlite'`。

---

## 4. player（播放演示 App，Next.js，`apps/player`；spec.md §11）

读取位置：`apps/player/src/app/api/session/route.ts`（预览账号 → 分发端 login，**服务端专用**，凭据不下发浏览器）、
`apps/player/src/lib/sdk.ts`（SDK 以 tokenProvider 接入：浏览器直连地址由 `/api/session` 运行时下发 `delivery_base`，
`NEXT_PUBLIC_*` 仅作兜底默认）。

### .env 格式（可直接复制）

```dotenv
# ==================== player（播放演示 App） ====================
PLAYER_PORT="3100"
DELIVERY_BASE_URL="http://127.0.0.1:9000"        # 服务端调分发端 login 的地址（容器内为容器网络视角）
PLAYER_PUBLIC_DELIVERY_BASE_URL=""               # 浏览器直连分发端（运行时下发；空 = 回退 DELIVERY_BASE_URL）
NEXT_PUBLIC_DELIVERY_BASE_URL=""                 # 兼容保留：构建期内联覆盖（一般留空）
PLAYER_PREVIEW_USERNAME=""                       # 预览播放账号（bootstrap-playback.ts 创建）
PLAYER_PREVIEW_PASSWORD=""                       # 预览播放账号口令；缺省回退 DELIVERY_PREVIEW_*
```

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PLAYER_PORT` | 否 | `3100` | dev / start 端口（`scripts/dev.ts` 与 compose 复用） |
| `DELIVERY_BASE_URL` | 否 | `http://127.0.0.1:9000` | **服务端**调分发端 `login` 的地址（换 JWT，凭据不出服务端；容器内为容器网络视角） |
| `PLAYER_PUBLIC_DELIVERY_BASE_URL` | 否 | 空 | **浏览器**直连分发端地址（运行时经 `/api/session` 下发，不在构建期内联，spec.md §11.8） |
| `NEXT_PUBLIC_DELIVERY_BASE_URL` | 否 | 空 | 兼容保留：构建期内联的浏览器直连地址（优先级低于 `PLAYER_PUBLIC_DELIVERY_BASE_URL`、高于 `DELIVERY_BASE_URL`） |
| `PLAYER_PREVIEW_USERNAME` | 是 | 空 | 预览播放账号；缺省回退 `DELIVERY_PREVIEW_USERNAME`；缺失时 `/api/session` 501 |
| `PLAYER_PREVIEW_PASSWORD` | 是 | 空 | 预览播放账号口令；缺省回退 `DELIVERY_PREVIEW_PASSWORD` |

> 免登录 = 任何能访问 player 的人都可用预览账号播放全部 READY 媒资——player 定位本地 / 内网体验，
> **不建议公网暴露**（spec.md §11.3）。浏览器直连分发端要求 `DELIVERY_CORS_ORIGINS` 放行 player 源站
> （本地默认 `*` 已满足）；分片直连对象存储要求**对象桶 CORS 放行 player 源站**（与管理端预览同一前提）。
> 独立模板 `apps/player/.env.example`；单独运行 `bun run --cwd apps/player dev`，仓库根运行 `bun scripts/dev.ts player`。
> 容器形态（`docker-compose.yml` 的 player 服务 / `task image:player`，spec.md §11.8）同样读这些键：
> 容器内服务端用 `DELIVERY_BASE_URL`，浏览器视角用 `PLAYER_PUBLIC_DELIVERY_BASE_URL`（两者视角不同时必须分别配置）。

---

## 附：各端变量对照速查

| 变量 | delivery | worker | admin | player |
|---|:---:|:---:|:---:|:---:|
| `DATABASE_URL` | ✅ | ✅ | ✅ | — |
| `DB_PROVIDER` | — | ✅ | ✅ | — |
| `MASTER_KEYS` | ✅ | ✅（加密任务） | ✅ | — |
| `URL_SIGN_KEY_HEX` / `URL_SIGN_KEY_KID` | ✅ | — | — | — |
| `BETTER_AUTH_SECRET` / `ADMIN_*` / `OIDC_*` | — | — | ✅ | — |
| `WORKER_MODE` / `WORKER_HTTP_PORT` / `WORKER_IDLE_EXIT_MINUTES` | — | ✅ | — | — |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_LEASE_MS` / `WORKER_MAX_ATTEMPTS` | — | ✅ | — | — |
| `WORKER_NOTIFY_URL` / `WORKER_NOTIFY_SECRET` | — | ✅（SECRET 必填） | ✅（仅发通知） | — |
| `DELIVERY_*`（JWT / TTL / CORS / LISTEN） | ✅ | — | — | — |
| `DELIVERY_PUBLIC_BASE_URL` | ✅ | ✅（占位基址） | ✅（回退提示） | — |
| `DELIVERY_BASE_URL` / `DELIVERY_PREVIEW_*` | — | — | ✅（预览） | ✅（服务端 login + 账号回退） |
| `PLAYER_PORT` / `PLAYER_PREVIEW_*` / `PLAYER_PUBLIC_DELIVERY_BASE_URL` / `NEXT_PUBLIC_DELIVERY_BASE_URL` | — | — | — | ✅ |
| `STORAGE_*` / `S3_*` | ✅ | ✅ | ✅ | — |
| `MEDIA_ID_LENGTH` | — | — | ✅ | — |
