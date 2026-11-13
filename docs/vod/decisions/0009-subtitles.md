# ADR-0009：字幕方案（WebVTT）

- 状态：提议（待复核）
- 日期：2026-09-17
- 更新：2026-09-20（进入实现阶段；细化与一处修订见文末「实现细化」，权威规范见 [spec.md §7](../spec.md)）；2026-11-13（**字幕进 CDN 缓存落地**：共享 token + 内容版本号，见文末「修订 2026-11-13」，权威规范见 [spec.md §7.5](../spec.md)）
- 关联：ADR-0005、ADR-0010

## 背景

字幕管理（WebVTT）在管理端；分发端按媒资向播放端下发字幕轨道。

## 决策

- v1 字幕格式**仅 WebVTT**（文本，不入 HLS 打包），存储于对象存储 `proceed/{mediaId}/subtitles/{trackId}.vtt`（布局见 spec.md §1）。
- `media_subtitles`：`id, media_id, lang(BCP-47), label, is_default, status, storage_key, bytes, created_by, timestamps`。
- 管理端：上传 .vtt（**服务端结构化校验**：header `WEBVTT`、cue 时间轴合法性、UTF-8 编码）→ 控制台可编辑文本（保存时再校验）→ 删除 / 设默认轨道。
- 分发端：
  - `GET /v1/media/{id}` 返回轨道列表（lang / label / default）；
  - `GET /v1/media/{id}/subtitles/{trackId}.vtt?t=TOKEN`（typ=v 签名 token，TTL 独立可配、默认比分片长；CDN 可缓存）；
  - 播放端集成方式 v1 = **播放器侧外挂轨道**（hls.js `addTextTrack` / `<track>` 引用），不依赖清单内 `EXT-X-MEDIA TYPE=SUBTITLES`（该方式需要字幕分段 playlist，列为演进项）。

## 理由

- 外挂 WebVTT 对播放器最简单、与加密分片链路解耦；token 走 query 与 native HLS 兼容（无 header）。
- 服务端校验避免脏字幕导致播放端解析失败（v1 只校验不重排）。

## 备选（否决 / 搁置）

- 字幕烧录进画面（ffmpeg subtitles filter）：不可选轨、不可编辑 —— 否决（可作为转码模板选项远期支持）。
- HLS 内嵌字幕轨（EXT-X-MEDIA + 分段 vtt）：更「标准」，但清单 / 分片改写复杂度上升 —— 演进项。

## 后果与风险

- vtt 单文件对超长视频偏大（MB 级可接受）；CDN 缓存命中良好。
- 编辑器 v1 为纯文本编辑 + 校验，可视化时间轴编辑器列为远期。

## 实现细化（2026-09-20）

进入实现阶段后对本文档的细化，以及一处修订（权威规范见 [spec.md §7](../spec.md)）：

- **轨道 ID**：`{trackId}` = `media_subtitles.id` = 存储文件名 = API 路径参数；服务端生成（cuid 形状 `^c[a-z0-9]{20,}$`）、**先于落库确定**（存储键必须先于 DB 行），一经写入不再变更 —— URL 与存储键同源，播放端持有的引用长期有效；
- **语言**：`lang` 以 BCP-47 连字符形态存取（`zh-CN` / `en-US`）；输入兼容下划线写法（`zh_CN`）并服务端归一化；**同一媒资内 `lang` 唯一**（DB 唯一约束 `(media_id, lang)`），避免播放端选轨歧义；
- **默认轨**：每媒资至多一条（MySQL / SQLite 无部分唯一索引 → 应用层事务保证）；首条上传自动置默认；删默认轨不自动改派；
- **上传语义**：v1 **同步校验**（UTF-8 / `WEBVTT` 头 / cue 时间轴合法），通过即 `status=READY`，失败直接拒绝且不落库不落存储；`PROCESSING` / `FAILED` 保留给未来异步链路（转写 / 翻译）；
- **输入格式（2026-09-20 补充）**：存储**恒为 WebVTT**；`.srt` 只作为**输入**格式，由管理端服务端按内容识别并自动转换（时间轴逗号改点、小时补两位、前置 `WEBVTT` 头、序号行保留、丢弃 SRT 定位参数），不并存 SRT 对象、不保存 SRT 原文。转换唯一实现在 `apps/admin/src/lib/vtt.ts` 的 `toVttText`（UI 上传与 API 直传共用），分发端不做任何格式处理；
- **下发方式**：字幕 URL 随 `POST /v1/media/{id}/play` 与清单一并返回（每条轨道一个 `typ=v` 签名 token）——`GET /v1/media/{id}` 仅返回轨道元信息，`GET /v1/media/{id}/subtitles/{trackId}.vtt` 取文本（分发端代理输出）；token 形态见文末「修订 2026-11-13」（**共享 token**：不绑会话，`exp` 窗口对齐；2026-09-20~2026-11-12 期间为逐会话 token，`exp = min(now + PLAYBACK_SUBTITLE_TTL_SEC, 会话 exp)`）；
- **修订（缓存纪律，2026-09-20）**：本文档原写「CDN 可缓存」，实现改为响应 **`Cache-Control: no-store`**（与清单 / 密钥同纪律）：字幕 token 逐会话签发、文本可就地覆盖，缓存会读到陈旧字幕；引入内容版本号 / 共享 token 形态后可作为演进项恢复；
- **非目标（v1）**：同语言多轨（简繁并存）、自动翻译 / 语音转写、烧录进画面、HLS 内嵌字幕轨（`EXT-X-MEDIA` + 分段 playlist）。

## 修订 2026-11-13（字幕进 CDN 缓存落地）

**用户拍板为 P0 待实现（同日）**；两个前置条件——内容版本号 + 共享 token 形态——均已引入，
原「修订（缓存纪律）」的 `no-store` 全量纪律改为**按 token 形态区分**（权威规范见 [spec.md §7.5](../spec.md)）：

- **内容版本号**：`media_subtitles.content_version`（`INTEGER NOT NULL DEFAULT 1`，双方言 schema + 迁移
  `20261113130000_subtitle_content_version`）；管理端**覆盖文本时 +1**（`PUT …/{trackId}/content`），
  改 label / lang / 默认轨不动版本（不改文本内容）。版本进入字幕 URL：`…/{trackId}.vtt?v=<N>&t=<token>` ——
  **版本变 = URL 变 = CDN 缓存键变**，覆盖文本不再依赖 no-store 保证新鲜度；
- **共享 token**：`typ=v` 的 token **不绑会话**（payload `sid` 字段整体缺失，TS `JSON.stringify` 丢弃
  `undefined` 与 Go `omitempty` 序列化逐字一致，互通向量 `crypto-v1.json#token_shared` 双端门禁）；
  `exp` 取 `PLAYBACK_SUBTITLE_TTL_SEC` 的**窗口对齐值**（当前窗口末端，同 ADR-0005 TypeA /
  ADR-0019 url-sign 的缓存友好形态）——同一窗口内任意一次 play 产出**逐字相同**的 URL，
  跨会话 / 跨用户命中同一缓存键；
- **响应缓存策略**（`subtitleCacheControl`）：共享 token → `Cache-Control: public, max-age=<N>`
  （`PLAYBACK_SUBTITLE_CACHE_MAX_AGE_SEC` / system_settings `playback_subtitle_cache_max_age_sec`，默认 600，
  0 = 关闭回退 no-store）；会话 token → 沿用 `no-store`；错误响应恒 `no-store`；
- **信任模型变化（接受的取舍）**：字幕是低敏公开文本，共享 token 不绑会话 → **会话吊销不再即时收回
  字幕 URL**，收敛依赖「版本推进 + TTL 窗口」（≤24h）；泄露面仅限「可读该媒资字幕文本」，
  分片 / 密钥仍逐会话签发（P0 纪律不动，ADR-0006 §5 清单 / 密钥 no-store 不变）；
- **陈旧窗口**：管理端覆盖文本后，已持有的旧 `?v=` URL 在缓存 TTL 内可能返回旧文本
  （上限 = max-age）；分发端回源时校验 `?v=` 与当前版本不符 → `403 bad_token`，播放端经
  重签（play / SDK `refresh`）拿到新地址。需要立即全局生效时调小 max-age 或清理 CDN 缓存；
- **否决的替代方案**：版本号进 token payload（新增字段破坏既有互通向量与双端 payload 规范，
  收益为零——URL 仍需版本参数隔离缓存键）；预签名 302 直出对象（对象响应头不受分发端控制，
  spec.md §7.5 规则 5 原结论不变）。
