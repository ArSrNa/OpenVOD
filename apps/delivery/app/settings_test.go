package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/server"
	"openvod/apps/delivery/internal/settings"
)

type settingsRows map[string]string

func (rows settingsRows) AllSettings(context.Context) (map[string]string, error) { return rows, nil }

func environmentConfig() *config.Config {
	return &config.Config{
		URLSignKey: bytes.Repeat([]byte{1}, 32), URLSignKeyKid: "env-key",
		PublicBaseURL: "https://env.example.com", CORSOrigins: []string{"https://env-admin.example.com"},
		JWTTTLSec: 86400, SessionTTLSec: 14400, ManifestTTLSec: 14400, SubtitleTTLSec: 86400,
		Storage: config.StorageConfig{Bucket: "env-bucket", AccessKeyID: "env-ak", SecretAccessKey: "env-sk", ForcePathStyle: true},
	}
}

func TestSettingsConfigClearingOverridesReturnsToEnvironment(t *testing.T) {
	base := environmentConfig()
	rows := settingsRows{
		settings.KeyPlaybackBaseURL: "https://db.example.com/", settings.KeyJWTTTLSec: "3600",
		settings.KeyS3Bucket: "db-bucket", settings.KeyCORSOrigins: "https://db-admin.example.com",
		settings.KeyS3ForcePathStyle: "false",
	}
	first, err := settingsConfig(context.Background(), rows, base)
	if err != nil {
		t.Fatal(err)
	}
	if first.PublicBaseURL != "https://db.example.com" || first.JWTTTLSec != 3600 || first.Storage.Bucket != "db-bucket" || first.Storage.ForcePathStyle {
		t.Fatal("database settings were not applied")
	}
	second, err := settingsConfig(context.Background(), settingsRows{}, base)
	if err != nil {
		t.Fatal(err)
	}
	if second.PublicBaseURL != base.PublicBaseURL || second.JWTTTLSec != 86400 || second.Storage.Bucket != "env-bucket" || !second.Storage.ForcePathStyle {
		t.Fatal("cleared database overrides must return to environment defaults")
	}
	if base.Storage.Bucket != "env-bucket" || base.CORSOrigins[0] != "https://env-admin.example.com" {
		t.Fatal("loading settings mutated the environment baseline")
	}
}

func TestSettingsConfigRejectsUnusablePresignLifetime(t *testing.T) {
	base := environmentConfig()
	for _, rows := range []settingsRows{
		{settings.KeyManifestTTLSec: "691200", settings.KeySessionTTLSec: "691200"},
		{settings.KeyManifestTTLSec: "3600", settings.KeySessionTTLSec: "1800"},
	} {
		if _, err := settingsConfig(context.Background(), rows, base); err == nil {
			t.Fatal("invalid presign lifetime was accepted")
		}
	}
}

func TestSettingsConfigRejectsMissingSigningKey(t *testing.T) {
	base := environmentConfig()
	base.URLSignKey = nil
	if _, err := settingsConfig(context.Background(), settingsRows{}, base); err == nil {
		t.Fatal("missing signing key must prevent publishing a new handler")
	}
}

func bodyHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) })
}

func requestBody(h http.Handler) string {
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/", nil))
	return r.Body.String()
}

func TestSettingsHandlerRefreshesAtMostOncePerMinute(t *testing.T) {
	now := time.Unix(1000, 0)
	calls := 0
	h := newSettingsHandler(bodyHandler("old"), func(context.Context) (http.Handler, error) {
		calls++
		return bodyHandler("new"), nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.now = func() time.Time { return now }
	h.nextCheck = now.Add(settingsRefreshInterval)
	if got := requestBody(h); got != "old" || calls != 0 {
		t.Fatalf("before expiration = %q, loads = %d", got, calls)
	}
	now = now.Add(settingsRefreshInterval)
	if got := requestBody(h); got != "new" || calls != 1 {
		t.Fatalf("expired request = %q, loads = %d", got, calls)
	}
	for range 10 {
		requestBody(h)
	}
	if calls != 1 {
		t.Fatalf("cache hit caused %d loads", calls)
	}
}

func TestSettingsHandlerFailureRetainsLastGoodVersionAndRedactsErrors(t *testing.T) {
	now := time.Unix(1000, 0)
	calls := 0
	var logs bytes.Buffer
	h := newSettingsHandler(bodyHandler("good"), func(context.Context) (http.Handler, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("secret-key-material")
		}
		return bodyHandler("recovered"), nil
	}, slog.New(slog.NewTextHandler(&logs, nil)))
	h.now = func() time.Time { return now }
	h.nextCheck = now
	if got := requestBody(h); got != "good" {
		t.Fatalf("failed refresh replaced good handler: %q", got)
	}
	requestBody(h)
	if calls != 1 || strings.Contains(logs.String(), "secret-key-material") {
		t.Fatal("failed refresh was not throttled or leaked secret error")
	}
	now = now.Add(settingsRefreshInterval)
	if got := requestBody(h); got != "recovered" || calls != 2 {
		t.Fatalf("subsequent refresh did not recover: %q, loads = %d", got, calls)
	}
}

func TestSettingsHandlerServesOldVersionWhileOneRefreshBuilds(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	h := newSettingsHandler(bodyHandler("old"), func(context.Context) (http.Handler, error) {
		calls.Add(1)
		close(started)
		<-release
		return bodyHandler("new"), nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.nextCheck = time.Time{}
	finished := make(chan string, 1)
	go func() { finished <- requestBody(h) }()
	<-started
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if got := requestBody(h); got != "old" {
				t.Errorf("concurrent request observed incomplete candidate: %q", got)
			}
		})
	}
	wg.Wait()
	close(release)
	if got := <-finished; got != "new" || calls.Load() != 1 {
		t.Fatalf("refresh request = %q, loads = %d", got, calls.Load())
	}
}

func TestSettingsHandlerPublishesUpdatedCORS(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	base := environmentConfig()
	initial := server.New(server.Options{Cfg: base, Logger: logger})
	h := newSettingsHandler(initial, func(ctx context.Context) (http.Handler, error) {
		cfg, err := settingsConfig(ctx, settingsRows{settings.KeyCORSOrigins: "https://new.example.com"}, base)
		if err != nil {
			return nil, err
		}
		return server.New(server.Options{Cfg: cfg, Logger: logger}), nil
	}, logger)
	h.nextCheck = time.Time{}
	req := httptest.NewRequest(http.MethodOptions, "/v1/media", nil)
	req.Header.Set("Origin", "https://new.example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://new.example.com" {
		t.Fatalf("updated CORS not active: %q", got)
	}
}
