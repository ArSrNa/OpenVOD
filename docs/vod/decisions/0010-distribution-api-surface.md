# ADR-0010：分发端 API 面（v1）

- 状态：提议（待复核）
- 日期：2026-09-17
- 关联：ADR-0006、ADR-0007、ADR-0009

## 决策

- 前缀 `/v1`；JSON envelope：成功直接返回数据，失败 `{ "error": { "code": "...", "message": "..." } }`；错误码表入 contracts 包。
- 分页：cursor（`?cursor=&limit=`，默认 20，上限 100）。
- CORS：播放端域名白名单可配；媒体 / 登录接口需要，清单 / 密钥 / 字幕同样开放给白名单域。

### 端点表

| 方法 / 路径 | 鉴权 | 说明 |
|---|---|---|
| POST `/v1/auth/login` | 凭据 | `{username,password}` → `{access_token, token_type, expires_in, kid}` |
| GET `/v1/media` | JWT | 媒资列表（仅上架 ready 项；标题 / 封面 / 时长 / 自定义公开字段白名单） |
| GET `/v1/media/{id}` | JWT | 元数据详情：系统 probe 摘要 + 自定义数据 + 字幕轨道列表 + 可播状态 |
| POST `/v1/media/{id}/play` | JWT | 创建播放会话 → `{sid, manifest_url, expires_at}`（签名主清单 URL） |
| GET `/v1/media/{id}/manifest/master.m3u8?t=` | token(m) | 改写后主清单（子清单 URL 注入 token），no-store |
| GET `/v1/media/{id}/manifest/{variant}.m3u8?t=` | token(m) | 改写后子清单（分片 / 密钥 URL 注入 token），no-store |
| GET `/v1/media/{id}/key?t=` | token(k) | 16B AES-128 CEK，octet-stream，no-store |
| GET `/v1/media/{id}/subtitles/{trackId}.vtt?t=` | token(v) | WebVTT 正文 |
| GET `/v1/media/{id}/thumb/poster.jpg` | token(s) / 公开可配 | 海报 |
| GET `/healthz` | 无 | 探活 |

### 关键行为约定

- `play` 幂等：同用户同媒资未过期会话默认复用（可配 force_new）；并发上限命中 → 409 `session_limit`。
- 未上架 / 转码中媒资：`media` 接口可见但 `play` 返回 409 `not_playable`。
- m3u8 改写实现：分发端从存储适配读清单文本 → 行级改写（`EXT-X-KEY` URI、分片行、必要时 `EXT-X-MEDIA`）→ 注入 token 输出；响应体须 ≤6MB（平台 body 上限，极长视频策略见 open-questions #12）。
- 限频：登录与 play 按 IP + 用户维度简单限频（进程内 / DB 计数，v1 无 Redis）。

## 后果与风险

- 全部端点响应体 ≤6MB（EdgeOne CF 限制）；清单与元数据均远低于此。
- API 契约（请求 / 响应 schema + 错误码）进 contracts 包，供 admin-web 与 Go 侧生成使用（ADR-0001）。
