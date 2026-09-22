package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEdgeOneRuntimeEnvironment(t *testing.T) {
	t.Setenv("DELIVERY_DATABASE_URL", "")
	t.Setenv("MASTER_KEYS", "")
	t.Setenv("DELIVERY_LISTEN", ":9001")
	t.Setenv("BETTER_AUTH_SECRET", "admin-only")
	values := map[string]string{
		"DELIVERY_DATABASE_URL": "delivery:p#'$\\word@tcp(db.example.com:3306)/vod?tls=true",
		"MASTER_KEYS":           "1:" + strings.Repeat("ab", 32),
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
	t.Setenv("DELIVERY_DATABASE_URL", "platform-db")
	t.Setenv("MASTER_KEYS", "platform-mk")
	t.Setenv("DELIVERY_LISTEN", "")
	// 平台注入完整时不要求随包配置文件。
	if err := loadEdgeOneEnvironment(filepath.Join(t.TempDir(), "missing.json")); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DELIVERY_DATABASE_URL") != "platform-db" || os.Getenv("MASTER_KEYS") != "platform-mk" {
		t.Fatal("覆盖了平台变量")
	}
}

func TestEdgeOnePartialPlatformEnvironment(t *testing.T) {
	t.Setenv("DELIVERY_DATABASE_URL", "platform-db")
	t.Setenv("MASTER_KEYS", "")
	t.Setenv("DELIVERY_LISTEN", "")
	path := filepath.Join(t.TempDir(), edgeOneRuntimeEnvFilename)
	if err := os.WriteFile(path, []byte(`{"DELIVERY_DATABASE_URL":"file-db","MASTER_KEYS":"file-mk"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadEdgeOneEnvironment(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("DELIVERY_DATABASE_URL") != "platform-db" || os.Getenv("MASTER_KEYS") != "file-mk" {
		t.Fatal("未按进程环境优先合并配置")
	}
}

func TestEdgeOneRejectsInvalidRuntimeEnvironment(t *testing.T) {
	for _, raw := range []string{
		`private-secret-invalid-json`,
		`{"DELIVERY_DATABASE_URL":"private-secret"}`,
		`{"DELIVERY_DATABASE_URL":"private-secret","MASTER_KEYS":""}`,
		`{"DELIVERY_DATABASE_URL":"private-secret","MASTER_KEYS":"mk","EXTRA":"secret"}`,
		`{"DELIVERY_DATABASE_URL":"private-secret","MASTER_KEYS":123}`,
	} {
		t.Run(raw[:1], func(t *testing.T) {
			t.Setenv("DELIVERY_DATABASE_URL", "")
			t.Setenv("MASTER_KEYS", "")
			path := filepath.Join(t.TempDir(), edgeOneRuntimeEnvFilename)
			if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			err := loadEdgeOneEnvironment(path)
			if err == nil || strings.Contains(err.Error(), "private-secret") {
				t.Fatal("应安全失败且不输出配置值")
			}
			if os.Getenv("DELIVERY_DATABASE_URL") != "" || os.Getenv("MASTER_KEYS") != "" {
				t.Fatal("配置校验失败时不应部分设置环境变量")
			}
		})
	}
}
