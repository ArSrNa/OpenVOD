package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestEdgeOneResponseHeadersBeforeCommit(t *testing.T) {
	for _, status := range []int{200, 401, 403, 404, 500, 503} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/v1/media/test/key", nil)
			req.Header.Set("x-scf-request-id", "test-request-id")
			edgeOneResponseHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(status)
				w.WriteHeader(http.StatusOK) // 不能把先前的拒绝状态改成 200。
				_, _ = w.Write([]byte(`{"error":{"code":"bad_token"}}`))
			})).ServeHTTP(recorder, req)
			response := recorder.Result() // Result 取首次提交时的快照，防止事后设置头的无效实现通过。
			defer response.Body.Close()
			if response.StatusCode != status || response.Header.Get("eo-pages-inner-scf-status") != strconv.Itoa(status) {
				t.Fatal("业务状态或 Makers 状态头未在提交时保留")
			}
			if response.Header.Get("eo-pages-inner-status-intercept") != "false" || response.Header.Get("Functions-Request-Id") != "test-request-id" {
				t.Fatal("缺少平台响应头")
			}
			if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Content-Type") != "application/json" || !strings.Contains(recorder.Body.String(), "bad_token") {
				t.Fatal("业务正文或缓存策略被改写")
			}
		})
	}
}

func TestEdgeOneImplicitOKResponse(t *testing.T) {
	for _, body := range []string{"", "#EXTM3U\n", "\x00\x01\x02"} {
		recorder := httptest.NewRecorder()
		edgeOneResponseHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if body != "" {
				_, _ = w.Write([]byte(body))
			}
		})).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
		response := recorder.Result()
		response.Body.Close()
		if response.StatusCode != 200 || response.Header.Get("eo-pages-inner-scf-status") != "200" || recorder.Body.String() != body {
			t.Fatal("隐式 200 或二进制正文被破坏")
		}
	}
}

func TestEdgeOneRuntimeEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("MASTER_KEYS", "")
	t.Setenv("DELIVERY_LISTEN", ":9001")
	t.Setenv("BETTER_AUTH_SECRET", "admin-only")
	values := map[string]string{
		"DATABASE_URL": "delivery:p#'$\\word@tcp(db.example.com:3306)/vod?tls=true",
		"MASTER_KEYS":  "1:" + strings.Repeat("ab", 32),
	}
	raw, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), edgeOneRuntimeEnvFilename)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadEdgeOneEnvironment(path); err != nil {
		t.Fatal(err)
	}
	for key, want := range values {
		if os.Getenv(key) != want {
			t.Errorf("%s 未正确恢复", key)
		}
	}
	if os.Getenv("DELIVERY_LISTEN") != ":9000" || os.Getenv("BETTER_AUTH_SECRET") != "admin-only" {
		t.Fatal("监听端口未固定或修改了其他变量")
	}
}

func TestEdgeOnePreservesPlatformEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "platform-db")
	t.Setenv("MASTER_KEYS", "platform-mk")
	t.Setenv("DELIVERY_LISTEN", "")
	// 平台注入完整时不要求随包配置文件。
	if err := loadEdgeOneEnvironment(filepath.Join(t.TempDir(), "missing.json")); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DATABASE_URL") != "platform-db" || os.Getenv("MASTER_KEYS") != "platform-mk" {
		t.Fatal("覆盖了平台变量")
	}
}

func TestEdgeOnePartialPlatformEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "platform-db")
	t.Setenv("MASTER_KEYS", "")
	t.Setenv("DELIVERY_LISTEN", "")
	path := filepath.Join(t.TempDir(), edgeOneRuntimeEnvFilename)
	if err := os.WriteFile(path, []byte(`{"DATABASE_URL":"file-db","MASTER_KEYS":"file-mk"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadEdgeOneEnvironment(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DATABASE_URL") != "platform-db" || os.Getenv("MASTER_KEYS") != "file-mk" {
		t.Fatal("未按进程环境优先合并配置")
	}
}

func TestEdgeOneRejectsInvalidRuntimeEnvironment(t *testing.T) {
	for _, raw := range []string{
		`private-secret-invalid-json`,
		`{"DATABASE_URL":"private-secret"}`,
		`{"DATABASE_URL":"private-secret","MASTER_KEYS":""}`,
		`{"DATABASE_URL":"private-secret","MASTER_KEYS":"mk","EXTRA":"secret"}`,
		`{"DATABASE_URL":"private-secret","MASTER_KEYS":123}`,
	} {
		t.Run(raw[:1], func(t *testing.T) {
			t.Setenv("DATABASE_URL", "")
			t.Setenv("MASTER_KEYS", "")
			path := filepath.Join(t.TempDir(), edgeOneRuntimeEnvFilename)
			if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			err := loadEdgeOneEnvironment(path)
			if err == nil || strings.Contains(err.Error(), "private-secret") {
				t.Fatal("应安全失败且不输出配置值")
			}
			if os.Getenv("DATABASE_URL") != "" || os.Getenv("MASTER_KEYS") != "" {
				t.Fatal("配置校验失败时不应部分设置环境变量")
			}
		})
	}
}
