# ADR-0010：分发端 API 面（v1）

- 状态：已接受（2026-09-23 按实现修订）
- 日期：2026-09-17（2026-09-23 修订）
- 关联：ADR-0004、ADR-0005、ADR-0006、ADR-0007、ADR-0009、ADR-0015

## 决策

- 前缀 `/v1`；JSON envelope：成功直接返回数据，失败 `{ "error": { "code": "...", "message": "..." } }`；错误码表入 contracts 包（分发端 Go 侧 `internal/contracts` 手工对齐）。
- 分页：cursor（`?cursor=&limit=`）。**2026-09-23 修订**：v1 未实现 cursor，`/v1/media` 只支持 `limit`（缺省 50、上限 200，非法 / 越界回退缺省），`next_cursor` 恒为 `null`。
- CORS：允许来源可配（`DELIVERY_CORS_ORIGINS` / `system_settings.cors_origins`，默认 `*`）；媒体 / 登录接口需要，清单 / 密钥 / 字幕同样开放给白名单域；预检 `OPTIONS` → 204，放行头含 `Authorization` 与 `X-Playback-Token`。

### 端点表（2026-09-23 与实现核对）

| 方法 / 路径 | 鉴权 | 说明 |
|---|---|---|
| POST `/v1/auth/login` | 凭据 | `{username,password}` → `{access_token, token_type, expires_in, kid}`；ES256（`signing_keys`，无可用私钥 503） |
| GET `/v1/media` | JWT | 媒资列表（仅 `status=READY`；`limit` 缺省 50 / 上限 200；条目含标题 / 封面 / 时长 / `custom`，`custom` 恒为 `{}`） |
| GET `/v1/media/{id}` | JWT | 元数据详情：probe 摘要 + 就绪字幕轨道（不含 URL）+ `playable` + `custom` |
| POST `/v1/media/{id}/play` | JWT | 创建 / 复用播放会话 → `{sid, manifest_url, expires_at, template_id, subtitles[]}`（签名主清单 URL；请求体可省略） |
| GET `/v1/media/{id}/manifest/master.m3u8?t=&tpl=` | token(m) | 改写后主清单（子清单 URL 注入 token），no-store |
| GET `/v1/media/{id}/manifest/{variant}/index.m3u8?t=&tpl=` | token(m) | 改写后子清单（`EXT-X-KEY` → typ=k；分片 → S3 预签名直出 URL），路径为通配（可含子目录），no-store |
| GET `/v1/media/{id}/key?t=` | token(k) | 16B AES-128 CEK，octet-stream，no-store |
| GET `/v1/media/{id}/subtitles/{trackId}.vtt?t=` | token(v) | WebVTT 正文（M4 已落地，规则见 spec.md §7.5），no-store |
| GET `/healthz` | 无 | 探活（`{"status":"ok","app":"delivery"}`） |

**2026-09-23 修订的端点变化**：

- `GET /v1/media/{id}/thumb/poster.jpg` **取消**：海报改由 `poster_url`（`cover/{id}/poster.{ext}` 预签名直出，ADR-0005）下发，不再有独立缩略图路由；
- `GET /v1/media/{id}/segment/{tpl}/{variant}/{seg}` **取消**（2026-09-22，ADR-0005 修订）：仅 S3 形态，分片一律预签名直出；`typ=s` 仅保留定义，不再签发；
- 子清单路由由 `{variant}.m3u8` 收敛为 `/manifest/*` 通配（子清单实际落在 `proceed/{id}/{tpl}/{variant}/index.m3u8`）。

### 关键行为约定

- `play` 幂等：同用户同媒资未过期且未吊销会话默认复用（`force_new=true` 强制新建）；并发上限命中 → 409 `session_limit`；媒资非 READY → 409 `not_playable`。
- 模板产物选择（ADR-0014）：`template_id` 显式指定 / 缺省自动（唯一产物 → 直接用；多套 → `transcode_templates.is_default`；无法唯一确定 → 409 列出可选值）；空串 = 显式请求旧布局产物。
- m3u8 改写实现：分发端从存储读清单文本 → 行级改写（`EXT-X-KEY` URI、分片行）→ 注入 token 输出；响应体须 ≤6MB（平台 body 上限，极长视频策略见 open-questions #12）。
- token 传递以 query `t` 为主、header `X-Playback-Token` 兜底（Safari 原生只能走 query）；所有播放资源请求每请求查库校验会话（比 ADR-0006 §6 的 60s 收敛更严格）。
- 限频：登录与 play 按 IP + 用户维度简单限频（进程内 / DB 计数，v1 无 Redis）——**未实现**（`rate_limited` 为契约保留码）。
- 运行配置：分发端启动只依赖 `DATABASE_URL` + `MASTER_KEYS`（env；2026-10-17 起与 admin 共用同一变量名，ADR-0011 修订），存储凭据 / 播放签名密钥 / TTL / CORS / 播放域名由 `system_settings` 提供并约 60s 整体热切换（ADR-0015），env 同名键兜底。

## 后果与风险

- 全部端点响应体 ≤6MB（EdgeOne CF 限制）；清单与元数据均远低于此。
- API 契约（请求 / 响应 schema + 错误码）进 contracts 包，供 admin-web 与 Go 侧生成使用（ADR-0001）；Go 侧错误码枚举手工对齐，`check:contracts-go` 门禁只覆盖 DTO。
