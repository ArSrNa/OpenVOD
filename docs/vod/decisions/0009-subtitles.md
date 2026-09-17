# ADR-0009：字幕方案（WebVTT）

- 状态：提议（待复核）
- 日期：2026-09-17
- 关联：ADR-0005、ADR-0010

## 背景

字幕管理（WebVTT）在管理端；分发端按媒资向播放端下发字幕轨道。

## 决策

- v1 字幕格式**仅 WebVTT**（文本，不入 HLS 打包），存储于对象存储 `sub/{mediaId}/{trackId}.vtt`。
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
