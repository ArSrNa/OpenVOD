package server

import (
	"net/http"
	"time"

	"openvod/apps/delivery/internal/version"
)

// metaResponse GET /v1/meta 响应。只含非敏感信息：不返回连接串、密钥材料、
// 主机名或环境变量原值（ADR-0006 红线）。
type metaResponse struct {
	App            string `json:"app"`
	Version        string `json:"version"`
	Commit         string `json:"commit"`
	BuildTime      string `json:"build_time,omitempty"`
	GoVersion      string `json:"go_version"`
	Platform       string `json:"platform"`
	StartedAt      string `json:"started_at"`
	UptimeSec      int64  `json:"uptime_sec"`
	DatabaseDriver string `json:"database_driver"`
	PublicBaseURL  string `json:"public_base_url"`
}

/**
 * handleMeta 运行信息（公开、无鉴权）：排障时确认「这个进程跑的是哪个版本、
 * 连的哪种数据库驱动、对外基址是什么」，用于区分「旧镜像」与「配置错」。
 * 与 /healthz 一样不进 packages/contracts（无请求体、纯运维探针）。
 */
func (a *api) handleMeta(w http.ResponseWriter, _ *http.Request) {
	info := version.Current()
	now := a.o.Now()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, metaResponse{
		App:            "delivery",
		Version:        info.Version,
		Commit:         info.Commit,
		BuildTime:      info.BuildTime,
		GoVersion:      info.GoVersion,
		Platform:       info.Platform,
		StartedAt:      a.startedAt.UTC().Format(time.RFC3339),
		UptimeSec:      int64(now.Sub(a.startedAt).Seconds()),
		DatabaseDriver: a.o.Cfg.DatabaseDriver,
		PublicBaseURL:  a.o.Cfg.PublicBaseURL,
	})
}
