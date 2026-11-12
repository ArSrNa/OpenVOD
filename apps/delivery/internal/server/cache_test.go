package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"openvod/apps/delivery/internal/config"
)

// P0 缓存纪律（ADR-0006 §5）：分发端**所有**响应都必须带 `Cache-Control: no-store`。
// 逐个 handler 断言会随新增路由漏掉，这里直接打路由入口的兜底中间件：
// 成功 / 鉴权失败 / 路由不存在 / 探活 / 预检全部覆盖。
func TestAllResponsesAreNoStore(t *testing.T) {
	h := New(Options{
		Cfg: &config.Config{
			CORSOrigins:   []string{"*"},
			URLSignKey:    make([]byte, 32),
			URLSignKeyKid: "urlsign-v1",
		},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		header map[string]string
	}{
		{name: "探活", method: http.MethodGet, path: "/healthz"},
		{name: "登录失败（未配置签名密钥）", method: http.MethodPost, path: "/v1/auth/login", body: `{"username":"u","password":"p"}`},
		{name: "业务 API 未带 JWT", method: http.MethodGet, path: "/v1/media"},
		{name: "主清单缺 token", method: http.MethodGet, path: "/v1/media/cmedia0000000000000000/manifest/master.m3u8"},
		{name: "字幕缺 token", method: http.MethodGet, path: "/v1/media/cmedia0000000000000000/subtitles/ctrack0000000000000000.vtt"},
		{name: "/v1 兜底 404", method: http.MethodGet, path: "/v1/not-exist"},
		{name: "根路径 404", method: http.MethodGet, path: "/not-exist"},
		{name: "CORS 预检", method: http.MethodOptions, path: "/v1/media", header: map[string]string{"Origin": "https://admin.example.com"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			for k, v := range c.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("%s %s：Cache-Control=%q，期望 no-store（status=%d）", c.method, c.path, got, rec.Code)
			}
		})
	}
}
