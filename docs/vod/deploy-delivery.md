# 分发端（delivery）部署

分发端是**同一份 Go 代码的两个同级目标**（ADR-0003）：SCF 容器与 EdgeOne Cloud Functions。
两边的装配逻辑单点维护在 `apps/delivery/app`：容器调用 `Run()`，EdgeOne 调用 `RunEdgeOne()`，共用内部装配：

| 目标 | 入口 | 形态 |
|---|---|---|
| SCF Web 函数（容器） | `apps/delivery/main.go` | Dockerfile 静态二进制（distroless），监听 `:9000` |
| EdgeOne Cloud Functions | `cloud-functions/index.go` | Go Framework 模式，平台交叉编译后监听 `:9000` |

因此**改装配逻辑只改 `apps/delivery/app/app.go`**；两个入口文件不要各自加逻辑，否则目标间必然漂移。

## 目标 A：SCF 容器（Docker）

```bash
task image:delivery     # docker buildx build --platform linux/amd64（SCF 仅 x86）
# 推同地域 TCR 私有仓库 → SCF 更新函数（镜像 + 环境变量）
```

无内网依赖，DB 可走 VPC 或公网。

## 目标 B：EdgeOne Makers Cloud Functions

> Pages 已更名 **EdgeOne Makers**，CLI 用 `edgeone makers <cmd>`（`edgeone pages` 过渡期等价）。

### 项目设置

- **CLI 构建根目录** = `task edgeone:prepare` 生成的 `.run/edgeone-delivery/`，不是仓库根；
- **函数扫描目录只有 `cloud-functions/index.go`**：平台按识别到的 Framework 入口文件名生成 URL 前缀，
  `index.go` → `/`，`api.go` → `/api`。delivery 需要根路径的 `/healthz` 与 `/v1/...`，因此构建后还要校验实际路由，不能只检查入口文件名；
- `apps/delivery` 的模块文件与 `app/`、`internal/` 复制到暂存项目根，避开 `cloud-functions/` 的递归函数扫描；
- 暂存项目使用无依赖、无构建脚本的最小 `package.json`，复制根 `edgeone.json`，安装 / 构建命令为空操作，
  `outputDirectory` 指向空的 `public/`，避免把 monorepo 当静态资源发布。

入口与前缀的官方规则见 [Go Framework 路由](https://pages.edgeone.ai/document/go)。
模块位于暂存根的布局以固定版本 CLI 的实际构建结果为准，详见下方 2026-09-22 修订。

### 环境变量（delivery 域，生产环境）

| 变量 | 说明 |
|---|---|
| `DELIVERY_DATABASE_URL` | **必须公网可达 + TLS**：Cloud Functions 无 VPC（ADR-0003 P0 结论）。`ParseDatabaseURL` 不做 TLS 兜底，公网库要自带 `?tls=true`（或自签场景 `tls=skip-verify`）。账号用 ADR-0011 的受限只读账号 |
| `DELIVERY_PUBLIC_BASE_URL` | 最终分发域名（清单 / 密钥 / 字幕 URL 基址）；运行时可被 `system_settings.playback_base_url` 覆盖 |
| `MASTER_KEYS` | 必填，与 admin / worker 的现有主密钥一致，格式为 `版本:64位hex`，多个版本用逗号分隔 |
| `URL_SIGN_KEY_HEX` / `S3_*` 等 | ADR-0015：通过管理台完成初始化后从共享数据库的 `system_settings` 加载；不属于 Makers 上传包的引导变量 |
| `DELIVERY_CORS_ORIGINS` | 默认 `*`；收敛为管理端源站即可 |
| `APP_ENV` / `DELIVERY_JWT_*` / `PLAYBACK_*_TTL_SEC` | 按需覆盖默认值。`DELIVERY_LISTEN` 保持默认 `:9000` |

### 平台限制对照

| 项 | 限制 | 对本项目的影响 |
|---|---|---|
| 执行时长 | 默认 30s，最大 120s | `edgeone.json` 已设 `cloudFunctions.maxDuration=120` |
| 请求 / 响应 body | ≤6MB | 分片走 S3 预签名直出，不受影响；禁止新增函数侧流式代理 |
| 代码包 | ≤128MB（含依赖） | 静态二进制约 17MB |
| 转码 | — | P0：转码永不上函数（delivery 本就不转码） |

### 部署

```bash
# 仓库根：生成独立暂存项目、交叉编译、执行 Makers build 并检查产物
task build:edgeone

# 只上传已检查的构建产物；显式选择生产环境
# EO_SECRET 从安全环境注入；不要把 Token 写入脚本或仓库
bun --no-env-file scripts/edgeone.ts deploy

# 先等待 healthz 就绪（最多 120s），再逐项验收健康与鉴权（单次最多 30s）
bun --no-env-file scripts/check-delivery-deployment.ts "https://delivery.ovod.skirk.cn"
```

`task build:edgeone` 委派 `bun --no-env-file scripts/edgeone.ts build`：先 prepare，再交叉编译 Linux/amd64，
用 `bunx --bun edgeone@1.6.41 makers build` 生成 `.edgeone/`，最后校验 Framework 为 Chi、
路由为根 catch-all、函数二进制为 Linux amd64 ELF。`deploy` 子命令重新检查产物，读取 Makers Production 的两个引导变量，复用脚本内固定的 CLI 版本，
在暂存目录向 `openvod-delivery` 的 `production` 环境发布，显式传入 `.edgeone`，按
[CLI 文档](https://pages.edgeone.ai/document/edgeone-cli) 上传已有产物，不再次自动构建。
`--no-env-file` 避免将仓库本地 `.env` 自动带入构建 / 发布进程。运行配置的传递方式见下文。

发布统一走 CNB 的 EdgeOne 按钮或上述命令。直接从仓库根运行 `makers deploy`、
或配置 Makers Git 自动部署，都不会采用这个受检查的暂存项目与产物，不是本仓库的发布入口。

## CDN 加速域名与资产签名配置清单（ADR-0019）

资产 GET URL 的签名形态由 `storage_sign_mode` 决定（管理端「存储设置」或 env `STORAGE_SIGN_MODE`，
spec.md §6.7）：`s3_presign`（默认，签名在 S3）| `cdn_url_auth`（签名在 CDN 边缘）| `custom`。
**桶恒为私有**（不变量，ADR-0005）——两种内置模式只改变签名位置。以下控制台配置是**切换前置条件**；
配置错误会复现 2026-10-05 实测的陈旧缓存 / 无签名命中缓存绕过鉴权（spec §6.5、dev-workflow §8）。

### 通用前置

- CDN 上的加速域名与「存储加速域名」（`storage_cdn_base_url`）填同一值，回源对象存储（COS 源站 / COS 桶域）；
- **每次切换模式后 CDN 全量刷新一次**，清退旧形态缓存条目（在途旧会话按旧模式有效至过期，无破坏性）。

### 模式一：`s3_presign`（默认；签名在 S3，CDN 透传）

| # | 配置项 | 要求 |
|---|---|---|
| 1 | 缓存键 | **含完整 query**（不过滤任何参数），或对带 query 的请求**不缓存**——二者必居其一。忽略 query 会导致①无签名裸打 URL 命中缓存**绕过鉴权**（返回 200）；②产物原位替换后**永远读旧分片**（重转码 / 改水印不生效） |
| 2 | 回源 Host | 透传 / 改写为桶端点——SigV4 签名覆盖 Host 头，否则 S3 侧验签失败 |
| 3 | 刷新 | 产物按模板树原位替换（路径不变）：转码完成后目录刷新 `proceed/{id}/` |

### 模式二：`cdn_url_auth`（EdgeOne Token 鉴权方式 A；签名在 CDN 边缘）

| # | 配置项 | 要求 |
|---|---|---|
| 1 | 私有回源 | 源站侧配置回源鉴权（EO「源站鉴权」/ COS 私有桶回源授权，以控制台实际入口为准）：存储凭证配在 CDN 控制台，**不入库、不进本仓库、不写日志** |
| 2 | Token 鉴权 | 站点加速 → 规则引擎 → Token 鉴权：**鉴权方式与「CDN 鉴权方式」（`storage_cdn_auth_type`，A/B/C/D/V）一致**；**主鉴权密钥 = 管理端「CDN 边缘鉴权密钥」（`storage_cdn_auth_key`）双侧一致**；「有效时长」=「CDN 鉴权有效期」（`storage_cdn_auth_ttl_sec`，默认 3600 秒）；方式 A 的「鉴权加密串参数名称」默认 `sign`、方式 D 为 `token` / `t`（控制台自定义参数名时须与代码一致） |
| 3 | 缓存 | 缓存键含 query；缓存 TTL ≤ 签名窗口。EO 在鉴权通过后**自动忽略鉴权参数参与缓存**（官方行为）——窗口内 URL 稳定即可跨会话命中；重转码后的陈旧缓存仍靠 TTL / 刷新治理 |
| 4 | 回源 Host | 私有回源由 CDN 凭据完成，无需再依赖 S3 签名透传 |

方式差异注意（与 `storage_cdn_auth_type` 一一对应，官方算法规格见 spec.md §6.7）：

- **B / C 为路径前缀式**（`/{timestamp}/{md5}/…`、`/{md5}/{timestamp}/…`）：规则引擎的 URL Path **匹配必须用正则把鉴权前缀纳入**，否则请求不命中规则；EO 验签后会剥离前缀回源（回源路径与对象键一致）；不同签名窗口 path 不同、缓存条目按窗口更替（命中率低于 A/D）；
- **B 的 timestamp 为 UTC+8 分钟**（`YYYYMMDDHHMM`）：窗口末签发的 URL 实际有效期最多少 1 分钟；
- **V 的 `t` 是过期时刻**（十六进制 Unix 秒，代码按窗口对齐 + 1 窗，EO 另加 300s 容差）：本实现不生成 `us` / `plive`（非 VOD 源站不支持）与 `exper`（试看）等选填参数。

### 验收（切换后逐项执行）

- [ ] 裸打分片 URL（不带签名）→ **403**（CI 门禁 `assert-unsigned-403` 同口径）；
- [ ] 管理端重新播放取带签名 URL → 200，播放器可正常解密播放；
- [ ] 重转码一次，对比 CDN 响应头 `last-modified` 与任务完成时间——不一致说明命中陈旧缓存，检查缓存键与刷新；
- [ ] 需要更新有效期时：同步调整 `storage_cdn_auth_ttl_sec` 与 EO 控制台「有效时长」（两侧不一致会提前 403 或延长暴露窗口）。

## CNB 一键构建（web_trigger 按钮）

分支详情页共五个按钮，`.cnb/web_trigger.yml` 的 `event` 与 `.cnb.yml` 中 `$` 下的 `web_trigger_*` 键**同名**对应。
分发端相关两个：

| 按钮 | 事件键 | 动作 |
|---|---|---|
| **构建delivery（Docker）** | `web_trigger_delivery_docker` | `cd apps/delivery && docker build -t ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/delivery:latest . --push` |
| **构建delivery（Edgeone）** | `web_trigger_delivery_edgeone` | 构建并检查 `.run/edgeone-delivery/.edgeone` → 固定版本 CLI 上传生产环境 → 真实域名冒烟 |

（其余三个：开发环境镜像、admin、worker —— 见 [deploy-apps.md](./deploy-apps.md)。
发版另有 `tag_push` 事件：一次性串行构建 worker / admin / delivery 三镜像推送制品库，
各打 `:latest` 与 `:<tag名>` 双标签，见 deploy-apps.md「CNB 一键构建」。）

两处容易踩的点：

- **Docker 构建的上下文必须是 `apps/delivery`**（Dockerfile 的 `COPY go.mod go.sum* ./` 相对该目录）。
  用仓库根作上下文会找不到 `go.mod`——所以脚本里先 `cd apps/delivery`，不能用 `docker build ... .` 直接打仓库根。
  （admin / worker 相反，上下文就是仓库根，用 `-f` 指 Dockerfile。）
- **架构**：SCF 仅接受 x86。流水线用的是默认 amd64 构建机，`docker build` 产出的就是 amd64；
  若换到 arm64 构建机，改用 `docker buildx build --platform linux/amd64 --push`（`.cnb.yml` 里已留注释）。

### EdgeOne 按钮的凭据与项目名

API Token 走 **stage 级 `imports`** 引密钥仓库（只对该 stage 生效，作用域最小）：

```yaml
- name: edgeone makers deploy
  imports: https://cnb.cool/arsrna/env/-/blob/main/tencent.yml   # 提供 EO_SECRET
  script: bun --no-env-file scripts/edgeone.ts deploy
```

项目名在脚本里写死为 `openvod-delivery`；发布前必须存在该项目及其 Production 引导配置。
**密钥一律不进仓库**：改凭据只改密钥仓库的 `tencent.yml`。
`EO_API_REGION=china` 指腾讯云中国站账号 API（与当前项目所在控制台一致）；国际站账号用 `global`。
它不是项目的全球 / 海外加速区域。运行配置查询与 CLI 发布使用同一账号站点。
部署后使用 `EO_DELIVERY_URL` 指定域名验收；未设置时使用 `https://delivery.ovod.skirk.cn`。
该地址应与管理端配置的分发地址一致，Makers 控制台须把域名绑定到此项目的生产部署。

## 构建与路由修订（2026-09-22）

旧方案为解决隔离构建中的 `replace ../apps/delivery` 失效，把整个 delivery 模块复制到
`cloud-functions/openvod/apps/delivery/`。这能通过 Go 编译，却不能保证 Makers 的入口识别正确：
CLI 1.6.41 递归扫描 `cloud-functions/`，把副本中含 `chi.NewRouter()` 的 `internal/server/server.go`
识别为 Framework 入口，产物因而得到 `^/server(.*)$`，而非 delivery 所需的根 catch-all。
`/v1/...` 与 `/healthz` 不匹配该规则。此前“所有 Go 源码必须放在 cloud-functions 内”的结论撤回。

### 采用独立暂存项目

`bun --no-env-file scripts/edgeone.ts prepare`（或 `task edgeone:prepare`）生成以下布局；全部属于可重新生成的产物，不入库：

```text
.run/edgeone-delivery/
├── go.mod / go.sum          # 来自 apps/delivery，保留原模块名
├── app/                    # 来自 apps/delivery/app
├── internal/               # 来自 apps/delivery/internal，不参与函数扫描
├── cloud-functions/
│   └── index.go             # 唯一 Go 函数入口
├── edgeone.json
├── package.json            # 最小项目，无依赖、无 build 脚本
└── public/                 # 空静态目录
```

CLI 1.6.41 支持从项目根读取 Go 模块并带上同模块源码构建，因而无需嵌套模块或 `replace`。
当扫描目录没有含 Framework 初始化语句的文件时，CLI 从根 `go.mod` 的 Chi 依赖判断 Framework，
将唯一的 `index.go` 作为入口，所以仍可共用业务装配，不需要复制业务路由到入口。
此布局是针对固定 CLI 的实现验证；官方 Go Modules 示例仍展示 `cloud-functions/go.mod`，
不能据此推断任意版本都采用同样的复制与扫描逻辑。升级 CLI 时必须重跑完整构建门禁。

门禁检查 `.edgeone/cloud-functions/api-go/config.json` 的 Framework 与根路由，
以及函数可执行文件的架构；只验证 `go build` 成功不再足够。
配置字段沿用首次部署时完成的迁移：`cloudFunctions.maxDuration` 与
`cloudFunctions.regions.{mainland,overseas}`。

### 如何区分平台 404 与业务错误

本次问题域名的 `/healthz`、无签名清单以及提供的签名清单均返回 Makers HTML 404，
包含 `NOT_FOUND` / `The site does not exist`，说明请求未到达 delivery 业务路由。
旧产物的 `/server` 前缀是已确认的构建缺陷；这份线上 HTML 响应本身还不能排除域名绑定、
生产部署选择等问题，必须在发布新产物后以真实域名验收。

- `/healthz` 应返回 delivery 的成功 JSON，不能只凭 200 状态码判定成功；
- 无签名 `/v1/media/.../manifest/master.m3u8` 应返回 403；若仍是 Makers HTML 404，检查域名绑定、
  生产环境与上传产物中的路由配置；
- 两项通过后，在管理端重新点击播放生成有效签名 URL，再检查完整播放链路；旧签名可能已经过期。

### 仍未验证

**`no-store` 在边缘的行为**。函数响应正常不应被缓存，但 P0 纪律要求以真实域名验证：
清单与密钥响应必须 `Cache-Control: no-store` 且不进任何边缘缓存（对应 CI 门禁 `assert-no-store`）；
同时用无签名请求打加速域名，断言 403（`assert-unsigned-403`）。

### Go Framework 上传产物的运行变量修订（2026-09-22）

实测：控制台已在部署前保存 `DELIVERY_DATABASE_URL`、`MASTER_KEYS` 且范围为全部环境，
部署 `dpiljo0vcwwh` 的 Go 进程仍报 `DELIVERY_DATABASE_URL 未配置`，外部返回 502。
因此撤回“控制台配置会自动注入本项目上传的 Go 进程”的保证。CLI 的显式产物上传跳过自动拉取环境变量，
其 Go Framework 构建器也不为业务变量生成初始化逻辑；不能以发布成功代替启动验收。

当前发布流程显式传递最小引导配置：

1. 以同一个 `EO_SECRET` 查询确切项目，再读取 **Production** 生效的环境变量。接口格式依据官方
   [`@edgeone/makers-sdk`](https://www.npmjs.com/package/@edgeone/makers-sdk)，环境过滤与固定 CLI 一致。
2. 只取 `DELIVERY_DATABASE_URL`、`MASTER_KEYS`，缺失 / 为空 / 重复配置即停止发布，不回退到 admin 的 `DATABASE_URL`。
   不复制整份 `.env`，不携带 admin 密钥或部署 Token。
3. 以 JSON 原值写入 `.edgeone/cloud-functions/api-go/openvod-runtime-env.json`，本地权限 `0600`。
   **这是包含明文引导密钥的私有函数配置，仅随函数包上传，禁止进入 assets、Git、日志或公开构建附件。**
   正常结束或失败时由 `finally` 删除本地文件；CI 工作区也不得对外归档该目录。
4. EdgeOne 入口调用 `app.RunEdgeOne()`，先按可执行文件所在目录读取配置，只补齐缺失的进程变量，
   并固定监听 `:9000`，随后执行共享装配。配置读取 / 解析失败时不输出内容。
   SCF / Compose 入口保持纯环境变量方式。

主密钥仍与数据库分开保存；其分发边界扩展到私有函数包的访问权限，因此该包必须按密钥材料管理。
其余运行设置由 `system_settings` 加载。控制台修改这两个引导变量后仍需重新执行流水线，生成新的配置快照。

### 冷启动与业务错误状态（2026-09-22）

发布后的第一次请求可能超过 10s。冒烟脚本先只请求 `/healthz`：单次最多 30s，
网络超时 / 平台 404 或 5xx 在 120s 总窗口内每隔 5s 重试。必须收到 `app=delivery,status=ok` 的 200 JSON，
随后才顺序检查六项路由，复用已预热实例。重定向、其他服务的 200 或错误 JSON 立即失败；
持续故障在窗口结束后仍使流水线失败。每次尝试 / 每项结果均输出进度。

Go Framework 根模块布局下，CLI 生成的响应中间件未自动接入嵌套的业务路由。
线上曾出现 healthz 正常、401/403 却被平台替换为 500 HTML（响应仍携带 delivery 的 CORS 头）。
`RunEdgeOne()` 现显式包装 HTTP 响应，在首次 `WriteHeader` / `Write` **之前**设置固定 CLI 使用的
`eo-pages-inner-scf-status`、`eo-pages-inner-status-intercept=false` 和请求 ID，保留业务状态及 JSON / no-store。
平台响应头只用于 EdgeOne，SCF / Compose 不受影响。适配的最终边缘行为仍需部署后以六项检查验收。
