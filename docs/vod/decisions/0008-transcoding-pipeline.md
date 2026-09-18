# ADR-0008：转码流水线（ffmpeg / HLS）

- 状态：提议（待复核）
- 日期：2026-09-17
- 关联：ADR-0004、ADR-0005、ADR-0006、ADR-0014（模板存储）

## 背景

管理端要求「自定义 ffmpeg + HLS 加密」。平台约束：**转码禁止上函数**（P0），只能常驻容器 + 大磁盘。

## 决策

### 任务状态机

```
queued → probing → encoding → packaging → ready
                    ↘ failed（可重试 ≤3，指数退避）
queued/probing/encoding/packaging 带 lease_until（Worker 心跳续期，崩溃过期重派）
media 状态与 job 状态联动（ready / transcoding / failed / archived…）
```

### Worker（apps/worker，常驻容器）

1. 认领任务：MySQL `FOR UPDATE SKIP LOCKED`（`$queryRaw`）/ SQLite CAS（ADR-0004）；
2. 预取源片到 `/tmp/jobs/{jobId}/`（本地卷）；
3. `ffprobe` JSON → 写回 `media.probe`（时长 / 分辨率 / 编码 / 码率 / 音轨）；
4. 按 **ladder 模板** 逐档 ffmpeg 转码 → HLS TS + AES-128（key_info，ADR-0006）+ 主 / 子清单；
5. 抽帧：poster（取帧规则可配）→ `cover/{mediaId}/`；
6. 产物按 [spec.md §1 布局](../spec.md)上传至适配存储 → 更新 `hls_keys` / `media` → 清理工作目录；
7. 失败：结构化错误入 `job.last_error`，重试超限 → failed（管理端可见 / 可重派）。

### 自定义 ffmpeg 的安全边界

- 模板 = **结构化 params JSON**（存储见 ADR-0014），由 Worker 的白名单 argv builder 编译为 **argv 数组命令**（变量插值 `{input} {outdir} {height} {bitrate} ...`），**永不经 shell 拼接**（防注入）；
- 全局 presets（管理端 CRUD）+ 每媒资 override（JSON）；
- 执行超时、输出大小上限、禁网络输入源；密钥文件路径仅 Worker 注入。

### 默认 ladder（可配）

| 档 | 分辨率 | 视频编码 | 码率 | 音频 |
|---|---|---|---|---|
| 1080p | 1920x1080 | libx264（preset veryfast，CRF 模式可配） | ~5000k | AAC 128k |
| 720p | 1280x720 | 同上 | ~2800k | AAC 128k |
| 480p | 854x480 | 同上 | ~1400k | AAC 96k |

- 容器格式 v1 = **TS**（与 ffmpeg AES-128 全分片加密兼容性最好）；fMP4 见 open-questions #5（Shaka Packager 已备，为 CENC / DRM 演进路径）。
- `hls_time 6s`，`hls_playlist_type vod`；主清单由 Worker 生成模板版。

## 理由

- ffmpeg 单工具覆盖转码 + 加密 + 清单，Shaka / Bento4 仅在 fMP4 / CENC 演进时启用（镜像已备，避免 v1 复杂化）。
- 表队列 + lease 重派满足单 Worker 起步、多 Worker 扩展（MySQL 模式下可横向加 Worker）。

## 备选（否决 / 搁置）

- SCF 事件函数转码：平台三重限制撞墙 —— 永久否决（P0）。
- 引入 Redis / BullMQ：多一个状态组件，DB 队列足够 —— 否决。
- 云转码（腾讯云 MPS）：与自持转码参数 / 密钥的目标冲突 —— 否决。

## 后果与风险

- Worker 磁盘峰值 ≈ 源片 + 全档产物 + 加密重写，需容量预估与告警（specification 定阈值）。
- libx264 CPU 转码速度有限，长视频任务小时级；硬件加速（QSV / NVENC）留作宿主机可选项，不进默认镜像。
