// Package version 分发端版本信息（构建期注入 + 运行时覆盖）。
//
// 版本号唯一真源是**仓库根 package.json 的 version**（仓库约定），构建脚本读到后经
//
//	-ldflags "-X openvod/apps/delivery/internal/version.Version=<ver>"
//
// 写入二进制；未注入（go run / 裸 go build）时为 dev。
//
// 运行时 env APP_VERSION / APP_COMMIT 优先于注入值：EdgeOne Makers 的构建器不接受
// ldflags，需要精确版本时在部署环境配这两个变量（非密钥，可明文）。
package version

import (
	"os"
	"runtime"
	"runtime/debug"
	"strings"
)

// 构建期注入（-X 只能赋值字符串变量）
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "" // RFC3339（UTC）；空 = 未注入
)

// Info 版本信息（GET /v1/meta 的版本段）
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"build_time,omitempty"`
	GoVersion string `json:"go_version"`
	Platform  string `json:"platform"`
}

// Current 汇总版本信息；env APP_VERSION / APP_COMMIT 覆盖注入值。
func Current() Info {
	return Info{
		Version:   override("APP_VERSION", Version),
		Commit:    override("APP_COMMIT", Commit),
		BuildTime: BuildTime,
		GoVersion: goVersion(),
		Platform:  runtime.GOOS + "/" + runtime.GOARCH,
	}
}

func override(env, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(env)); v != "" {
		return v
	}
	return fallback
}

/** goVersion 实际构建产物记录的工具链版本；读不到时回退运行时版本 */
func goVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok && bi.GoVersion != "" {
		return bi.GoVersion
	}
	return runtime.Version()
}
