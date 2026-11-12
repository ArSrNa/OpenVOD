package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"openvod/apps/delivery/internal/config"
)

// GET /v1/meta 公开可访问，且只暴露非敏感运行信息（不含连接串 / 密钥）。
func TestMetaEndpoint(t *testing.T) {
	now := time.Date(2026, 11, 12, 7, 0, 0, 0, time.UTC)
	h := New(Options{
		Cfg: &config.Config{
			DatabaseDriver: "mysql",
			PublicBaseURL:  "https://delivery.example.com",
			CORSOrigins:    []string{"*"},
			URLSignKey:     make([]byte, 32),
			URLSignKeyKid:  "urlsign-v1",
		},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:    func() time.Time { return now.Add(90 * time.Second) },
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/meta", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200；body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
	var fields map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &fields); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	var got metaResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应结构不符: %v", err)
	}
	if got.App != "delivery" || got.DatabaseDriver != "mysql" || got.PublicBaseURL != "https://delivery.example.com" {
		t.Fatalf("响应字段不符: %+v", got)
	}
	if got.Version == "" || got.Commit == "" || got.GoVersion == "" || got.Platform == "" {
		t.Fatalf("版本字段不应为空: %+v", got)
	}
	if got.StartedAt == "" || got.UptimeSec < 0 {
		t.Fatalf("started_at / uptime_sec 异常: %+v", got)
	}
	for _, banned := range []string{"database_url", "master_keys", "url_sign_key", "password"} {
		if _, ok := fields[banned]; ok {
			t.Fatalf("响应不应包含敏感字段 %q", banned)
		}
	}
}
