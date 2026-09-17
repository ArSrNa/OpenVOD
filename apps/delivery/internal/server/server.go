// Package server HTTP 路由（ADR-0010 API 面）
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"openvod/apps/delivery/internal/config"
)

func New(cfg *config.Config, logger *slog.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(requestLogger(logger))

	// 探活
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "app": "delivery"})
	})

	r.Route("/v1", func(r chi.Router) {
		// ---- 业务 API（JWT，ADR-0007/0010） ----
		r.Post("/auth/login", stub(writing()))
		r.Get("/media", stub(writing()))
		r.Get("/media/{id}", stub(writing()))

		// ---- 播放链路（会话 + 签名 token，ADR-0006） ----
		r.Post("/media/{id}/play", stub(writing()))
		r.Get("/media/{id}/manifest/master.m3u8", stub(manifest()))
		r.Get("/media/{id}/manifest/{variant}.m3u8", stub(manifest()))
		r.Get("/media/{id}/key", stub(key()))
		r.Get("/media/{id}/subtitles/{trackId}.vtt", stub(subtitle()))

		// 兜底
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "not_found", "路由不存在")
		})
	})

	_ = cfg // specification：注入 DB 仓储 / 密钥表 / TypeA 签名器
	return r
}

// ---- stub 响应（scaffold 骨架，路由实现随 specification） ----

func stub(cacheControl string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", cacheControl)
		writeError(w, http.StatusNotImplemented, "not_implemented", "scaffold：路由随 specification 实现（ADR-0010）")
	}
}

// P0 缓存纪律（ADR-0006 §5）：清单与密钥绝不缓存
func writing() string { return "no-store" }

func manifest() string { return "no-store" }

func key() string { return "no-store" }

// 字幕/海报可缓存（签名 URL 由 CDN 缓存，ADR-0006 §5）
func subtitle() string { return "public, max-age=3600" }

// ---- 响应封装（ADR-0010 envelope） ----

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			logger.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"request_id", middleware.GetReqID(r.Context()),
			)
		})
	}
}
