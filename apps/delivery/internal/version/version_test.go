package version

import "testing"

func TestCurrentEnvOverridesInjected(t *testing.T) {
	oldVer, oldCommit := Version, Commit
	t.Cleanup(func() { Version, Commit = oldVer, oldCommit })
	Version, Commit = "1.2.1", "abc1234"

	info := Current()
	if info.Version != "1.2.1" || info.Commit != "abc1234" {
		t.Fatalf("应使用注入值，得到 version=%q commit=%q", info.Version, info.Commit)
	}
	if info.GoVersion == "" || info.Platform == "" {
		t.Fatalf("go_version / platform 不应为空: %+v", info)
	}

	t.Setenv("APP_VERSION", "9.9.9")
	t.Setenv("APP_COMMIT", "deadbee")
	info = Current()
	if info.Version != "9.9.9" || info.Commit != "deadbee" {
		t.Fatalf("env 应覆盖注入值，得到 version=%q commit=%q", info.Version, info.Commit)
	}
}

func TestCurrentFallsBackToDev(t *testing.T) {
	t.Setenv("APP_VERSION", "")
	t.Setenv("APP_COMMIT", "")
	Version, Commit = "dev", "unknown"
	info := Current()
	if info.Version != "dev" || info.Commit != "unknown" {
		t.Fatalf("未注入 / 无 env 时应为 dev/unknown，得到 %+v", info)
	}
}
