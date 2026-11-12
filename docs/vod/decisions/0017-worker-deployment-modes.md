# ADR-0017：Worker 部署双模式（常驻轮询 / HTTP 门铃）与 serverless 数据库适配

- 状态：已接受（2026-09-24，用户委托决策）
- 日期：2026-09-24
- 修订：2026-11-13 —— 增加第三模式 `invoked`（异步云函数单任务触发）与任务日志尾部通道，见 §6
- 关联：ADR-0008（转码流水线，本 ADR 修订其「常驻容器」前提）、ADR-0003（部署目标）、ADR-0004（数据库与 ORM）、ADR-0011（部署拓扑）、ADR-0015（环境变量与系统设置边界）、spec.md §5.1

## 背景

v1 的 worker 是**常驻进程 + 轮询认领**（ADR-0008），admin 与 worker 之间没有任何直接通信，唯一交互介质是 `transcode_jobs` 表（CAS 认领 + lease 崩溃重派 + stop 的 409 语义）。

新的部署约束（2026-09-24 用户提出）：

- 生产数据库为 **serverless 形态**（自动暂停、按活跃计费）：worker 的永动轮询（含每 tick 读取 `system_settings`）会让数据库**永远无法进入暂停态**，空闲成本不可接受；
- worker 可能**不在本机部署**，也可能以 **serverless 方式按需运行**，不会一直常驻；
- 管理台的 SSE 观察循环（`apps/admin/src/lib/jobs-stream.ts`）仅在有浏览器订阅时轮询 DB（订阅归零即停机），不构成永动负载，无需处理。

需要决策：worker 的运行形态、admin 与 worker 之间的通知通道，以及 serverless 数据库场景下的适配方式。

## 决策

### 1. 通信介质不变：DB 是唯一事实源，HTTP 只是「门铃」

任务下发 / 进度上报 / 停止指令**全部继续走 `transcode_jobs`**，现状零改动：CAS 认领、lease 心跳、崩溃重派、`stop` 的「租约有效 → 409」语义、管理台 SSE 观察 DB 快照——全部保持。

引入的唯一新通道是**通知（信令）**：admin 在写入任务后 fire-and-forget 地调用 worker 的 HTTP 端点，加速认领。设计原则：**通知可以丢（DB 兜底），事实源不能丢**。

### 2. Worker 双模式（`WORKER_MODE`）

- `resident`（默认，现状）：常驻轮询（`while(running) tick → sleep`）。适用于自托管 Compose / 常驻 MySQL / SQLite 本地开发；
- `http`：`Bun.serve` 提供 HTTP 端点 `POST /wake`：
  - **鉴权**：共享密钥（`WORKER_NOTIFY_SECRET`，Bearer 校验），否则 401——端点暴露公网时防止「唤醒轰炸」计费攻击；
  - 收到请求 → **异步**触发一轮 claim-drain（循环认领直到队列空）→ 立即 `202` 返回；转码不占用请求生命周期；
  - 可选空闲退出：连续 N 分钟无可认领任务时 graceful exit，加速平台实例缩零；
  - `executor.ts` / `job-store.ts` / `settings.ts` 全部复用，模式只是入口分支。

部署形态映射：`resident` → 自托管 Compose；`http` → serverless 容器平台（任务型 / Web 服务型）；`invoked` → 异步云函数（见 §6，可选适配，非默认）。

### 3. admin 通知钩子

- 新增配置 `WORKER_NOTIFY_URL` + `WORKER_NOTIFY_SECRET`（env 或 `system_settings`，沿用 ADR-0015 的边界与 MK 封装纪律）；
- 发起转码 / 任务重启成功后 POST 通知，**失败仅告警不阻塞**（业务仍返回 202）；
- `stop` 不需要通知 worker（「租约有效 → 409」语义不依赖通道）；
- 多 worker 并存时任一实例收到通知即可（CAS 认领竞争自动分活）。

### 4. http 模式的平台准入清单（硬门槛）

serverless 平台必须同时满足四条，否则该形态退回 `resident` 或任务型：

1. **执行时长**：无硬上限，或 ≥ 最长任务时长（长视频小时级）；
2. **本地磁盘**：≥ 源片 + 全档产物峰值（ADR-0008 后果与风险节）；
3. **无请求期间实例可继续执行后台工作**（任务型 / 可配实例保活 / 允许后台执行）——转码期间不会有任何新 HTTP 请求，平台若按「无请求」判定空闲并回收实例，长任务会被反复杀死；
4. **计费**：可缩零、按量。

P0 边界重申：**转码禁止上「请求-响应型函数」**（SCF / EdgeOne Functions，ADR-0008 永久否决）不因本 ADR 改变。http 模式的端点只做「触发认领 + 202」，转码执行体必须是可独占 CPU + 大磁盘的**容器形态**。

### 5. 兜底与冷启动

- **通知丢失兜底**：任务留存 DB；由平台定时触发器低频拉起实例（如每小时一次，队列空即退），或管理台人工重启（现有 restart 语义覆盖）；
- **serverless DB 冷启动**：worker 启动时 DB 连接带退避重试（自动暂停恢复需数秒到数十秒），避免被定时器拉起后首连失败退出；
- **冷启动预期**：worker 镜像含 ffmpeg（体积大），首次唤醒 10~60s 才开跑属正常，需在产品预期上接受。

### 6. 第三模式 `invoked`（异步云函数单任务触发，2026-11-13 修订）

新增依据：确有平台的**异步调用**能同时给到「触发立即返回 + 最长 1 天执行」，即 §4 第 3 条硬门槛（无请求期间实例可继续后台工作）可以满足。但这类平台**没有稳定回连地址、也不适合长连接**，所以既不能沿用队列扫描，也不能用流式响应送日志。定位：**可选适配器**，不改变「服务器部署为主形态」的优先级。

- **入口**：复用 `POST /wake`（Bearer `WORKER_NOTIFY_SECRET`），载荷 `{ job_ids: string[] }`；admin 在发起转码 / 重启成功后把本次任务 id 一并发过去。http 模式忽略载荷、照常扫队列（旧客户端无 body 也兼容）。
- **认领**：`claimById` 定向 CAS（与 `claim` 同一套条件更新：未终结 + 租约空/过期 → PROBING + attempts+1），**不扫描队列**；平台重投 / 并发唤醒只有一次能抢到。
- **生命周期**：实例由异步平台管理；建议 `WORKER_IDLE_EXIT_MINUTES=1~5`，任务跑完后主动退出，避免平台按「进程还活着」继续计费。
- **磁盘（硬要求）**：`WORKER_JOBS_ROOT` 必须指向挂载的文件系统（CFS / NAS）。大内存不等于大磁盘，`/tmp` 通常 512MB，装不下「源片 + 全档产物」峰值——见 ADR-0008 2026-11-13 修订。
- **日志**：异步触发返回 `{ret_code:200}` 后没有响应通道，日志不走流式响应。Worker 每 2s 把环形尾部（48KB）覆盖写 `transcode_jobs.log_tail` 并把 `log_seq` +1；管理端 `GET /api/admin/jobs/{id}/logs?after=<seq>` 增量拉取，抽屉打开时才轮询（1.5s），关闭即停。日志是诊断数据、非事实源，任务结束仍保留尾部。
- **失效兜底**：`invoked` 下没有任何进程会重派任务。管理端在任务页观察循环里做**读时巡检**（60s 节流，仅 `worker_mode=invoked` 生效）：租约过期超过 5 分钟、或排队超过 10 分钟未认领 → 置 `FAILED`（「可重启重试」），不改变常驻 / 门铃模式的崩溃重派语义。
- **并发**：一次唤醒 = 一次异步实例。多模板提交时管理端**逐任务各发一次** `/wake`（载荷只带一个 jobId）——否则整批会在同一实例内串行，后面的任务长时间停在 `QUEUED`，被失效巡检误判。`/wake` 仍接受 `job_ids[]`（手工 / 批量调用兼容），实例内顺序执行；跨实例并发由平台并发上限约束（v1 管理端不做闸门）。
- **取消**：保留执行期 2s 读取 `cancel_requested_at`（现状），这是唯一需要的读轮询，且只在任务期间发生。

## 理由

- **拉取方向不变**（worker 主动认领，无稳定地址要求），此前 DB 队列的全部优点保留：serverless 可用、多 worker 并发安全（CAS）、崩溃自愈（lease 重派）、stop / SSE 语义单点收敛、无新增状态组件；
- **HTTP 门铃**比「admin 调云厂商 API 拉起任务容器」更简单可移植：不耦合云厂商 SDK，admin 只需一个 URL，实例拉起 / 缩零交给平台；
- **成本**：无任务时零实例、零 DB 连接，serverless 数据库正常暂停计费；对比常驻轮询（DB 100% 活跃）是数量级差异；
- 双模式开关恰好对应 ADR-0003 的双部署目标：自托管退路（resident）/ 云上 serverless（http）。

## 备选（否决 / 搁置）

- **admin ↔ worker 直连 RPC（gRPC / HTTP 双向调用）**：被叫方必须稳定可达，serverless worker 无地址不可行；指令通道与 DB 状态机分裂在两处，需重新发明幂等 / 超时 / 重派 —— 否决；
- **常驻 worker + 调大轮询间隔**：DB 仍被周期性唤醒，serverless 计费场景不可接受 —— 否决（自托管场景即现状 `resident`，无需此项）；
- **引入 Redis / BullMQ / 云 MQ 作任务事实源**：ADR-0008 已否决（多一个状态组件），维持；MQ 仅可作为门铃的替代实现（与 HTTP 门铃等价但更重）—— 不采用；
- **SCF / 事件函数直接执行转码**：平台三重限制撞墙，P0 永久否决（ADR-0008）—— 不变；
- **MySQL LISTEN/NOTIFY / binlog 订阅推送**：MySQL 无原生的跨连接通知，binlog 方案过重 —— 否决。

## 后果与风险

- **http 模式最大风险**：平台按「无请求」回收实例 → 转码中途被杀 → lease 过期重派自愈，但会消耗 attempts 上限（反复被杀的长任务最终 FAILED）。准入清单第 3 条是硬门槛，平台选型必须实测验证；
- **通知是可失败外呼**：fire-and-forget 降级后果 = 认领延迟（靠兜底拉起 / 人工重启），无一致性问题；
- **配置面扩大**：`WORKER_MODE` / `WORKER_NOTIFY_URL` / `WORKER_NOTIFY_SECRET` 三项，需明确进 ADR-0015 的 env / system_settings 边界；
- **空闲退出 × 平台 min instances 的组合**需在部署文档（deploy-delivery.md 同级）中验证与记录；
- **冷启动延迟（10~60s）**：镜像层优化可压缩，但产品预期必须管理（「点转码 → 任务开跑」不再是秒级）；
- 管理台 SSE 在「有人开着转码页」期间仍会以 1.5s/5s 间隔触碰 serverless DB——人的注意力本身是活跃信号，可接受；如需极致省，可调大 `idleIntervalMs`（演进项）。

## 实现记录（2026-09-26）

- **worker 双模式落地**（`apps/worker/src/index.ts` + 新增 `http-mode.ts`）：`WORKER_MODE=resident`（默认，原轮询行为不变）；`http` 模式 `Bun.serve` 暴露 `POST /wake`（Bearer `WORKER_NOTIFY_SECRET`，SHA-256 定长 + timingSafeEqual；**未配置密钥拒绝启动**）与 `GET /healthz`（平台探活）；合法请求异步 claim-drain（并发唤醒合并为一轮）立即 202；`WORKER_IDLE_EXIT_MINUTES>0` 时最后一次认领后空闲超时 graceful 退出，加速平台缩零；启动对 serverless DB 冷启动做 `pingDb` + 指数退避重试（区分「库未醒」与「存储真未配置」——`loadWorkerSettings` 对查询失败吞错为空快照，不能用作探活）。
- **admin 通知钩子**（新增 `apps/admin/src/lib/worker-notify.ts`）：`/api/admin/media/{id}/transcode` 与 `/api/admin/jobs/{id}/restart` 成功后 fire-and-forget `POST {WORKER_NOTIFY_URL}/wake`，失败仅告警不阻塞业务；`stop` 不通知（409 语义不依赖通道）。
- **配置面**：`worker_mode`（明文，枚举 `resident|http`）/`worker_notify_url`（明文 URL）/`worker_notify_secret`（MK 封装，≥16 字符）登记进 `system_settings` 键注册表（ADR-0015 边界：DB > env > 默认），「系统设置 → 任务设置」分组可维护；worker 侧 `WORKER_HTTP_PORT` / `WORKER_IDLE_EXIT_MINUTES` 为纯部署参数，仅 env。
- **测试**：`apps/worker/test/http-mode.test.ts`（鉴权 401、202、drain 合并、healthz、空密钥拒启、空闲退出）；`apps/admin/test/worker-notify.test.ts`（URL/Bearer 装配、失败不抛、新键校验）。

## 实现记录（2026-11-13，invoked 模式与任务日志）

- **第三模式**（`apps/worker/src/index.ts` / `settings.ts` / `http-mode.ts` / `job-store.ts`）：`WORKER_MODE=invoked` 与 http 共用门铃入口，`/wake` 载荷解析出 `job_ids`（去重、上限 50）后走 `claimById` 定向 CAS；drain 期间到达的 id 进 pending 队列，下一轮继续，不丢唤醒。`WORKER_JOBS_ROOT` 透传 `deps.jobsRoot`（CFS 挂载点）。
- **唤醒载荷**（`apps/admin/src/lib/worker-notify.ts`）：`POST /wake` 带 `{ job_ids }`；发起转码与重启各自传入本次任务 id。**多个任务时逐任务各发一次**（一次唤醒 = 一次异步实例），http 模式忽略载荷、行为不变（多发几次只是多几轮空 drain）。
- **日志尾部**（新增 `apps/worker/src/job-log.ts` + `packages/transcode` 的 `onStderrLine`）：worker 阶段日志与 ffmpeg stderr 逐行进环形缓冲（48KB / 单行 2KB 上限），每 2s 有变化才覆盖写；写库失败保持 dirty 下一轮重试。`transcode_jobs.log_tail MEDIUMTEXT` + `log_seq INTEGER`（expand 迁移）。
- **管理端**：`GET /api/admin/jobs/{id}/logs?after=<seq>`（未变化返回 `tail: null`）+ 任务页「日志」抽屉；`lib/job-watchdog.ts` 读时巡检（仅 invoked、60s 节流、租约过期 5 分钟 / 排队 10 分钟 → FAILED）。
- **测试**：`apps/worker/test/job-log.test.ts`（有变化才写 / 环形裁剪 / 单行上限 / 失败重试 / stop 收尾）、`http-mode.test.ts` 增补载荷与 pending 合并用例；`worker-notify.test.ts` 增补 JSON 载荷与 `invoked` 枚举。
