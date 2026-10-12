# ADR-0011：部署拓扑——两应用共享数据面

- 状态：已接受（用户确认，2026-09-17）
- 日期：2026-09-17
- 关联：ADR-0003、ADR-0004、ADR-0005、ADR-0007

## 背景

管理端与分发端**分开部署为两个独立应用**，共享同一个数据库与 S3 兼容存储。经评估确认为推荐形态，本 ADR 固化拓扑、收益与硬约束。

## 决策

### 拓扑

```
播放端 App ──▶ 分发端 delivery ──┐
（hls.js/原生）  EdgeOne CF /    │
                SCF 容器         ├──▶ 共享数据库（MySQL，TLS；SQLite 仅同机自托管）
                                │        ▲ 迁移仅由 packages/db 执行
管理员 ─────▶ 管理端 admin ─────┘
              （admin API + admin-web + worker 常驻容器）
                  │
                  └──▶ 对象存储（COS / MinIO，S3 兼容）──(S3 预签名直出，可前置任意 CDN 透传)──▶ 播放端 App
```

- **两个应用**：分发端（delivery，无状态，公网热点）与管理端（admin API + admin-web + worker，常驻容器）。
- **一库一桶**：共享一个 MySQL（或自托管 SQLite，见约束 3）与一个对象存储桶（键前缀分区）。

### 收益

| 维度 | 收益 |
|---|---|
| 风险隔离 | 分发端被打 / 被打挂不影响管理端；管理端或 Worker 宕机时**已发布视频照常播放** |
| 发布节奏 | 管理端随业务频繁发版；分发端 API 稳定低频发布，播放链路不被牵连 |
| 扩缩容画像 | 分发端无状态横向扩；管理端 + Worker 按转码吞吐扩，互不干扰 |
| 运行时差异 | 分发端跑函数 / 容器，管理端必须常驻容器——本来就无法合并 |
| 产品化 | 第三方部署者可整套自托管，也可只取分发端接入自己的平台 |

### 硬约束（违反即缺陷）

1. **Schema 归属权唯一**：迁移仅由管理端 `packages/db` 执行；两应用独立发版，迁移必须向后兼容（expand-contract：先加列、双写过渡、后删列），纳入 CI 检查。
2. **数据库账号分权**：分发端暴露公网，其 DB 凭据为全系统最高危凭据——开独立受限账号：`users / media / media_subtitles / hls_keys / signing_keys / system_settings / transcode_templates` 只读 + `playback_sessions` 读写 + 其余拒绝（`system_settings` 仅 `playback_base_url` 播放域名一键被消费，spec.md §2.1.2；`transcode_templates` 为 **2026-10-12 修订新增**——`play` 的默认模板自动选择与响应 `templates[]` 模板名依赖它，spec.md §11.1；`signing_keys` 同为 2026-10-12 修订补入——分发端启动需读取 ACTIVE 的 JWT 私钥（`loadJWTSigners`，ADR-0007），原清单遗漏会导致 `login` 恒 503）；管理端另持全权账号。绝不共用 root。
3. **SQLite 边界**：SQLite 为嵌入文件库，两应用分开部署时仅允许「单机同卷共享一个文件」（单机 compose）；**跨机器 / 云函数部署必须 MySQL**。
4. **存储凭据分权**：S3 **写**凭据仅管理端 / Worker 持有；分发端仅持**受限只读凭据**（限 `proceed/`、`cover/`、`metadata/` 前缀，用于生成播放预签名 URL——2026-09-20 随 ADR-0005 放弃 EO TypeA，由原「零读凭据」约束调整而来）。
5. **键前缀分区即隔离**：`original/` 仅管理端写；`proceed/`、`cover/`、`metadata/` 管理端与 Worker 写、分发端经预签名读。单桶足够，不按应用拆桶。

### 失败场景

| 故障 | 影响 |
|---|---|
| Worker 宕机 | 播放不受影响，新转码暂停，任务经 lease 过期自动重派 |
| 管理端宕机 | 播放不受影响，管理操作不可用 |
| 分发端宕机 | 播放不可用，管理端正常 |
| 数据库不可用 | 新播放会话不可建、密钥不可下发；已下发 token 的分片仍可播（预签名直出） |

## 备选（否决）

- 单应用单体（admin + delivery 同进程）：部署最简，但风险面 / 发布节奏 / 运行时全部耦合 —— 否决。
- 三应用粒度（worker 独立成应用）：worker 本就是独立容器进程，与 admin 同仓同库同编排，拆 ADR 粒度无收益 —— 维持「两应用 + N 进程」。

## 后果与风险

- 发布流水线两套并存（ADR-0003 已定），CI 需覆盖「delivery 旧版本 × 新 schema」的兼容性测试。
- 交付物清单：delivery 二进制 / 镜像、admin + worker 镜像、compose 示例、部署文档（含 DB 账号授权清单）—— specification 落实。
