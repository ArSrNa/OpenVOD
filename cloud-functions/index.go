// EdgeOne Makers Cloud Functions 入口（Go Framework 模式，ADR-0003）。
//
// 平台约定（官方文档「Go 运行时函数」）：
//   - 入口文件名决定 URL 前缀：index.go → "/"；若改名 api.go 则整站会变成 /api 前缀。
//     delivery 暴露 /healthz 与 /v1/...，故入口必须叫 index.go。
//   - scripts/edgeone.ts 在 .run/edgeone-delivery 准备独立 Go 项目：go.mod、app、internal
//     均在项目根，cloud-functions 只放本入口。不要把业务包复制到本目录；CLI 会递归扫描，
//     把创建 Chi 路由的 server.go 当成入口并生成错误的 /server 前缀（ADR-0003）。
//   - 平台自动交叉编译 GOOS=linux GOARCH=amd64，并把命中 catch-all 的请求转发给
//     监听 :9000 的本进程（config.Load 的 DELIVERY_LISTEN 默认值即 :9000）。
//   - 本文件与 apps/delivery/main.go 都是 app.Run() 的薄包装，装配逻辑单点维护。
package main

import (
	"log/slog"
	"os"

	"openvod/apps/delivery/app"
)

func main() {
	if err := app.Run(); err != nil {
		slog.Error("delivery 退出", "err", err)
		os.Exit(1)
	}
}
