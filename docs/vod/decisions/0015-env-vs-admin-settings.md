# ADR-0015：环境变量与系统设置（system_settings）的边界

- 状态：已接受（2026-09-22，用户委托决策）；**同日修订**：启动引导优先，env 收敛为最小集（见「修订」节，取代原 A 层第 3 条与 B/C 层部分结论）
- 日期：2026-09-22
- 关联：ADR-0002（12-factor）、ADR-0004、ADR-0005、ADR-0006（密钥分层）、ADR-0011（受限账号）、ADR-0013、`docs/vod/env-vars.md`

## 背景

三端共享一份 `.env`，变量总数约 40 个，且存在跨端同名不同义（`DELIVERY_PUBLIC_BASE_URL` 三端语义不同）、重复块（`S3_*` / `STORAGE_*` 三端照抄）等问题，部署者反馈"冗杂"。期望的方向之一是"全部嵌入管理端设置里"（存 `system_settings`，控制台 UI 维护）。需要决策：哪些变量可以移入数据库设置、哪些必须留在环境变量，以及迁移的模式。

现状先例：`system_settings.playback_base_url` 已实现"DB 值运行时覆盖 env 回退"的模式（管理端 `/api/admin/settings` 写入，分发端 60s 缓存读取，无需重启）。本决策把该模式推广为通用规则，同时明确**不可**入库的硬边界。

## 决策

**否决"全部嵌入管理端设置"，采纳三层分级**：变量按"是否是引导依赖 / 是否是密钥 / 是否是运行期业务可调项"分为 A / B / C 三层，只有 C 层进 `system_settings`；B 层为混合模式（env 定默认值，DB 覆盖，无行则回退）。

### A 层：必须留在 env（否决入库）

1. **引导依赖（鸡生蛋问题）**：`DATABASE_URL`、`DB_PROVIDER`、`DELIVERY_DATABASE_URL`、`DELIVERY_LISTEN`、`ADMIN_PORT`。从数据库读"数据库地址"在逻辑上不可能；端口 / 监听地址是进程装配期参数，先于任何 I/O。
2. **密钥类**：`MASTER_KEYS`、`URL_SIGN_KEY_HEX`、`BETTER_AUTH_SECRET`、`OIDC_CLIENT_SECRET`、`S3_SECRET_ACCESS_KEY`、`DELIVERY_PREVIEW_PASSWORD`。
   - ADR-0006 密钥分层的根基就是 **MK 在 env、DB 内一切密钥（CEK、JWT 私钥）均为 MK 封装产物**：MK 入库 = 分层坍塌，DB 备份 / 注入 / 只读账号泄露即全量失守，且失去"DB 泄露不必重转码"的轮换语义。
   - 部署平台（SCF / EdgeOne / Docker / CNB 密钥仓库）的密钥注入通道就是环境变量；`gen-env.sh` 的 600 权限 + 不入库纪律已覆盖开发侧。
   - **最致命的反例**：delivery 是受限账号（ADR-0011，约定表只读 + `playback_sessions` 读写）。若密钥落 `system_settings`，delivery 必须获得该表读权限 → 分发端被攻破即可读全量密钥，最小权限边界被击穿。推论：**`system_settings` 表永久禁止存密钥（写入侧白名单强制）**，这也是 C 层能够安全下放给 delivery 读的前提。
3. **启动期装配的基础设施**：`S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE`、`STORAGE_ROOT_PREFIX`（ADR-0005 2026-09-22 修订：仅 S3 兼容存储，`STORAGE_DRIVER` / `STORAGE_LOCAL_ROOT` 已删除）。存储客户端三端均在启动时构建（delivery 尤其在请求路径之外），换存储属"重新部署"级变更而非运行时调参；挪进 DB 只增加"配置与实际装配不一致"的漂移面，无收益。
4. **安全敏感的鉴权装配**：`ADMIN_BASE_URL`、`ADMIN_TRUSTED_ORIGINS`、`OIDC_ISSUER/CLIENT_ID`。better-auth 信任来源在启动期读取，配错即 403 或放宽信任面；变更频率趋近于零（部署拓扑属性），收益不抵风险 → 留 env（v1）。

### B 层：混合模式（env = 默认值，system_settings 可覆盖）

非密钥、纯业务语义、有真实"不改代码 / 不重启调整"诉求的运行期参数：

| 键（system_settings） | 对应 env（回退默认值） | 说明 |
|---|---|---|
| `playback_base_url` | `DELIVERY_PUBLIC_BASE_URL` | **已实现**（先例） |
| `jwt_ttl_sec` | `DELIVERY_JWT_TTL_SEC` | 播放端 JWT 有效期 |
| `playback_session_ttl_sec` | `PLAYBACK_SESSION_TTL_SEC` | 播放会话有效期 |
| `playback_manifest_ttl_sec` | `PLAYBACK_MANIFEST_TTL_SEC` | 清单 token / 预签名上限 |
| `playback_subtitle_ttl_sec` | `PLAYBACK_SUBTITLE_TTL_SEC` | 字幕 token 上限 |
| `cors_origins` | `DELIVERY_CORS_ORIGINS` | 允许跨域源 |
| `worker_poll_interval_ms` / `worker_lease_ms` / `worker_max_attempts` | `WORKER_*` | Worker 每轮轮询时读取，即时生效 |

统一规则：

- **解析顺序**：DB 有行 → 用 DB；无行 / 读取失败 → env 默认。env 永远是出厂兜底，`REQUIRED_KEYS` 不因迁移减少。
- **生效时延声明**：delivery 60s 缓存（复用 `playback_base_url` 机制）；worker 轮询周期内生效。UI 明示"最迟 N 秒生效"。
- **写入侧校验**：管理端 `/api/admin/settings` 对每个键做 zod 校验 + 范围防呆（TTL 设上限防误配成永久 token；TTL 语义约束 `manifest ≤ session` 在写入时校验）。**白名单外的键拒绝写入**（杜绝密钥被塞进设置表）。
- **键注册单点**：键名与默认值语义登记在 `packages/shared`（跨端常量，Go 手工对齐，与现有 token 类型 / TTL 默认值同机制）；设置值本身不进 contracts（key-value 动态结构，quicktype 无收益）。

### C 层：搁置（v1 不动）

`STORAGE_CDN_BASE_URL`、`DELIVERY_BASE_URL`、`MEDIA_ID_LENGTH`、`ADMIN_SESSION_TTL_SEC` 等灰色项：改频率低或属 admin/worker 私有装配，v1 留 env；后续若出现真实诉求，按 B 层模式逐个迁入，不需要新决策。

### 配套修订

- **ADR-0011**：delivery 受限账号追加 `system_settings` 的 SELECT 授权（仅 ADR-0015 白名单键；因该表强制无密钥，授权不扩大攻击面）。
- **Go 侧**：`internal/config` 扩展一个带缓存的 settings reader（与 `playback_base_url` 同一读取点、同一 60s 缓存，不另起机制）。
- **文档**：`docs/vod/env-vars.md` 增加一层标注（A/B/C 分层 + 哪些键已被 settings 覆盖）；`.env.example` 相应注释更新。**env 冗杂感的真正解法是分层 + 文档速查表，而不是消灭 env**。

## 修订（2026-09-22）：启动即用，env 收敛为最小集

用户进一步要求：**不要一开始就要求配大量 env，用户应在启动时（首次进入管理台）逐步配置**。原「B/C 层留 env」与「storage 留 env」的结论按此目标重排。核心洞察：上一版"密钥必须留 env"的论据其实只对 **MK 根密钥**成立——ADR-0006 分层只要求 MK 在 env，**其余密钥只要被 MK 封装（AES-256-GCM，复用 `packages/crypto` 机制）即可安全入库**（DB 泄露不解密，分层不破）。

### env 最小集（部署必需，仅 7 个）

| 应用 | 必需 env | 说明 |
|---|---|---|
| admin / worker | `DATABASE_URL`、`DB_PROVIDER`、`MASTER_KEYS` | 引导依赖 + MK 根密钥 |
| delivery | `DELIVERY_DATABASE_URL`、`MASTER_KEYS` | 受限账号接入库 + MK |
| 全部 | `ADMIN_PORT`、`DELIVERY_LISTEN` | 进程装配期参数（鸡生蛋） |

`REQUIRED_KEYS` 收敛为 `DATABASE_URL DB_PROVIDER MASTER_KEYS DELIVERY_DATABASE_URL`。

### 其余全部迁入 system_settings

- **明文键**（非密钥）：storage 端点 / 桶 / region / 寻址风格 / root 前缀、各 TTL、CORS、播放域名、加速域名、`MEDIA_ID_LENGTH`、OIDC issuer / client_id 等——沿用原 B 层"DB 覆盖 env 回退"解析规则与白名单写入纪律；
- **MK 封装键**（密钥）：`URL_SIGN_KEY_HEX`、`BETTER_AUTH_SECRET`、`S3_SECRET_ACCESS_KEY`、`OIDC_CLIENT_SECRET`、`DELIVERY_PREVIEW_PASSWORD`。存库形态 `"v1:<ciphertext>"`，读取时以 env MK 解封；写入侧强制走封装 API，**白名单明文写入密钥类键直接拒绝**（保住"下放 SELECT 给 delivery 受限账号"的安全性）。

### 首次启动向导（setup wizard）

- admin 检测到未初始化（如 `system_settings` 无 `setup_completed` 标记）→ 引导页逐步配置：存储（local / S3 凭据）→ 播放域名（可后补）→ 可选 OIDC；密钥类若用户不填则**自动生成**（better-auth secret、URL sign key 随机生成后封装入库）；
- 完成后写入 `setup_completed`，未完成前 `/api/admin/*` 业务端点与播放链路拒绝服务（安全失败），仅向导与登录可用；
- **升级兼容**：已有部署启动时做一次性导入——env 中存在的旧键值 seed 进 `system_settings`（明文键直写、密钥键封装后写）并标记完成，此后 env 同名键不再生效（DB 唯一真源，UI 显示来源）。

### 生效方式（取代原「生效时延」节的适用范围）

- delivery：启动仅要求 DB 可达（本来如此，ADR-0011 无新增约束）；sign key、storage、TTL 等经 DB 加载 + 60s 缓存（复用 `playback_base_url` 机制）；加载失败安全失败，拒绝签发 token；
- worker：启动先连 DB 读存储配置，再进入轮询（原本就连 DB，顺序无反转）；
- admin：**better-auth 改惰性初始化**——先连 DB 解封 `BETTER_AUTH_SECRET` 再构建 auth 实例（现 `auth.ts` 顶层初始化读 env，是本修订最大的工程改动点）。

### 保留 env 的最终清单与理由

仅两类：① 引导依赖（DB 连接、端口）——物理不可入库；② `MASTER_KEYS`——ADR-0006 分层根，入库即分层坍塌。其余一切（含 storage 与鉴权装配）均属"运行期可配置"，入库。



- 引导依赖与密钥在物理上或安全上不可入库（见 A 层），"全部嵌入"方案直接不可行；
- B 层只迁"确实想运行时调"的业务参数，既兑现管理端可调的诉求，又不制造"配置在两个地方、生效语义不明"的新混乱——混合模式用"DB 覆盖 env、无行回退"保证两处永远语义一致；
- 现有 `playback_base_url` 模式已被验证（管理端写入 + Go 缓存读取），B 层是零新机制的推广；
- 设置表禁存密钥 + 白名单写入，使下放 SELECT 给受限账号安全，保住 ADR-0011 最小权限。

## 备选（否决 / 搁置）

- **全部环境变量入库管理端设置**：原始形态（密钥明文入库）被否决——击穿 ADR-0006 分层与 ADR-0011 最小权限、DB 备份变密钥库；**修订后部分吸收**：非 MK 密钥以 MK 封装入库、其余配置明文入库，仅引导依赖与 MK 留 env；
- **保持全部 env、只优化文档**：不满足"运行时不重启调整"与"启动即用"两个诉求，冗余感依旧 —— 否决；
- **新增独立 settings 服务 / 配置中心（etcd、Nacos 等）**：单仓库三应用 + 双部署形态（函数 / 容器）下是过度设计，`system_settings` 表 + 缓存已够用 —— 否决；
- **storage / 鉴权装配参数迁入设置**：启动期装配 + 安全敏感，收益不抵漂移风险 —— 搁置（C 层）。
