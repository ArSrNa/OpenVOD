// EdgeOne Makers Cloud Functions 入口（Go Framework 模式，ADR-0003）。
//
// 平台约定（官方文档「Go 运行时函数」）：
//   - 入口文件名决定 URL 前缀：index.go → "/"；若改名 api.go 则整站会变成 /api 前缀。
//     delivery 暴露 /healthz 与 /v1/...，故入口必须叫 index.go。
//   - 构建在**隔离目录**里执行 go mod tidy + go build（只带本目录内容），因此
//     go.mod 的 replace 必须指向本目录内部（./openvod/apps/delivery，由 task edgeone:prepare 生成）。
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
