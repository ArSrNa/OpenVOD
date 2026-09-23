# ADR-0017：Worker 部署双模式（常驻轮询 / HTTP 门铃）与 serverless 数据库适配

- 状态：已接受（2026-09-24，用户委托决策）
- 日期：2026-09-24
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

部署形态映射：`resident` → 自托管 Compose；`http` → serverless 容器平台（任务型 / Web 服务型）。

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
