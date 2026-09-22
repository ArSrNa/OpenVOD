# 环境变量清单（按应用拆分）

> **ADR-0015（2026-09-22 起）**：环境变量已收敛为**最小集**，本文件的多数变量降级为
> **env 兜底**——真正的运行配置存 `system_settings`，由管理台**首次启动向导 `/setup`**
> 写入（存储凭据、播放域名、TTL、播放签名密钥等），管理台「系统设置」页可随时调整。
>
> 解析顺序统一：**DB 设置值 > env 同名键 > 出厂默认**。
>
> - **必需 env（仅 4 个）**：`DATABASE_URL`、`DB_PROVIDER`、`MASTER_KEYS`、`DELIVERY_DATABASE_URL`
>   （外加进程装配期的 `ADMIN_PORT` / `DELIVERY_LISTEN`）；
> - **密钥类设置**（S3 SecretAccessKey、播放签名密钥等）以 **MK 封装 hex** 入库（ADR-0006 分层），
>   `MASTER_KEYS` 永远只存在于 env——它是唯一不可入库的密钥；
> - 下文表格保留作为「env 兜底清单」与旧部署迁移参考；三端对照速查表中的键凡与
>   `packages/shared` 的 `SETTING_KEYS` 同义者均已被设置覆盖。

本文件按 **delivery / worker / admin** 三个应用分别列出各自运行所需的环境变量。
三者**共享同一份 `.env`**（`scripts/gen-env.sh` 从密钥仓库 / 进程环境生成，模板见根目录 `.env.example`），
但**各应用实际读取的键不同**——本文件用于区分「谁真正需要哪个变量」，避免误以为某个键三端通用。

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

# 分发端接入库：仅支持 mysql://（受限账号：约定表只读 + playback_sessions 读写，ADR-0011）
# 本地调试若为 127.0.0.1/localhost，./start-delivery.sh 会回退用 DATABASE_URL
DELIVERY_DATABASE_URL="mysql://openvod_ro:changeit@127.0.0.1:3306/openvod"

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
| `DELIVERY_DATABASE_URL` | **是** | 无 | 分发端接入库。**仅支持 `mysql://`**（归一为 go-sql-driver DSN，自动补 `parseTime=true&loc=UTC&charset=utf8mb4`）。使用 ADR-0011 受限账号（约定表只读 + `playback_sessions` 读写）。本地调试 `./start-delivery.sh` 在该值为 127.0.0.1/localhost 时回退用 `DATABASE_URL` |
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
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 对象存储加速域名（ADR-0005），仅替换 GET 预签名 URL 的 origin |

> delivery **不读** `DATABASE_URL` / `DB_PROVIDER` / `BETTER_AUTH_SECRET`——它走独立的 `DELIVERY_DATABASE_URL`。
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

# ---- 队列认领（ADR-0008）----
WORKER_POLL_INTERVAL_MS="2000"   # 轮询间隔（毫秒）
WORKER_LEASE_MS="60000"          # 任务 lease 时长（执行期按 1/3 续期，崩溃后过期重派）
WORKER_MAX_ATTEMPTS="3"          # 单任务最大尝试次数，超过判 FAILED

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
| `WORKER_POLL_INTERVAL_MS` | 否 | `2000` | 轮询认领间隔（毫秒） |
| `WORKER_LEASE_MS` | 否 | `60000` | 任务 lease 时长；执行期按 1/3 续期，崩溃后 lease 过期即重派（ADR-0008） |
| `WORKER_MAX_ATTEMPTS` | 否 | `3` | 单任务最大尝试次数，超过判 `FAILED`，防崩溃循环 |
| `STORAGE_ROOT_PREFIX` | 否 | 空 | 全局 root 前缀（spec.md §1.1） |
| `S3_ENDPOINT` | **是** | 空 | S3 兼容端点 |
| `S3_REGION` | **是** | 空 | 区域 |
| `S3_BUCKET` | **是** | 空 | 桶名 |
| `S3_ACCESS_KEY_ID` | **是** | 空 | 访问密钥 ID |
| `S3_SECRET_ACCESS_KEY` | **是** | 空 | 访问密钥 |
| `S3_FORCE_PATH_STYLE` | 否 | `true` | 同 delivery；COS 需 `false` |
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 加速域名（GET 预签名 origin 替换） |

> **运行环境依赖（非环境变量）**：worker 启动自检 `ffmpeg` / `ffprobe`，缺失任一直接 `exit 1`。
> **硬约束**：worker 单实例（同一媒资任务必须串行，加密任务尤其如此，ADR-0006 §4.2）；禁止上任何函数（P0）。

---

## 3. admin（管理端，Next.js 全栈，`apps/admin`）

读取位置：`apps/admin/src/lib/auth.ts`（better-auth / OIDC / 会话）、`apps/admin/src/lib/storage.ts`（存储）、
`apps/admin/src/lib/keys.ts` 与 `scripts/bootstrap-playback.ts`（`MASTER_KEYS`）、
`apps/admin/src/lib/media.ts`（`MEDIA_ID_LENGTH`）、`apps/admin/src/lib/delivery-preview.ts`（分发端预览）、
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
| `STORAGE_CDN_BASE_URL` | 否 | 空 | 加速域名（原视频 / 封面预览 302、presign 分片 origin 替换） |
| `MEDIA_ID_LENGTH` | 否 | `8` | 媒资数字 ID 位数（4–16，保留前导零，spec.md §1.3） |
| `DELIVERY_BASE_URL` | 预览时必填 | `http://127.0.0.1:9000` | 「产物 → 播放」预览调用的分发端地址（服务端 → 分发端） |
| `DELIVERY_PREVIEW_USERNAME` | 预览时必填 | 空 | 预览账号用户名（用 `bun apps/admin/scripts/bootstrap-playback.ts` 创建）。缺失时预览接口返回 501 |
| `DELIVERY_PREVIEW_PASSWORD` | 预览时必填 | 空 | 预览账号口令（同上） |
| `DELIVERY_PUBLIC_BASE_URL` | 否 | 空 | 仅用于 `/api/admin/settings` 的 `env_public_base_url` 回退提示展示；应与 delivery 同值 |

> **运行环境依赖（非环境变量）**：`/api/admin/media/{id}/metadata` 生成元数据需要运行环境安装 **ffprobe**。
> `task db:generate` 产出的两份 Prisma 客户端（mysql + sqlite）必须同时存在，否则 `next build` / `bun test` 报
> `Module not found: '../generated/sqlite'`。

---

## 附：三端变量对照速查

| 变量 | delivery | worker | admin |
|---|:---:|:---:|:---:|
| `DATABASE_URL` | — | ✅ | ✅ |
| `DB_PROVIDER` | — | ✅ | ✅ |
| `DELIVERY_DATABASE_URL` | ✅ | — | — |
| `MASTER_KEYS` | ✅ | ✅（加密任务） | ✅ |
| `URL_SIGN_KEY_HEX` / `URL_SIGN_KEY_KID` | ✅ | — | — |
| `BETTER_AUTH_SECRET` / `ADMIN_*` / `OIDC_*` | — | — | ✅ |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_LEASE_MS` / `WORKER_MAX_ATTEMPTS` | — | ✅ | — |
| `DELIVERY_*`（JWT / TTL / CORS / LISTEN） | ✅ | — | — |
| `DELIVERY_PUBLIC_BASE_URL` | ✅ | ✅（占位基址） | ✅（回退提示） |
| `DELIVERY_BASE_URL` / `DELIVERY_PREVIEW_*` | — | — | ✅（预览） |
| `STORAGE_*` / `S3_*` | ✅ | ✅ | ✅ |
| `MEDIA_ID_LENGTH` | — | — | ✅ |
