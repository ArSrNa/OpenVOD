// 分发端 Data Plane 入口（ADR-0002：Go 1.26 + Chi；ADR-0003：EdgeOne CF / SCF 容器双目标）
//
// 本文件只做进程退出码包装，装配与启动逻辑在 app 包——SCF 容器镜像与
// EdgeOne Cloud Functions 入口（cloud-functions/index.go）共用同一份 app.Run()。
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
