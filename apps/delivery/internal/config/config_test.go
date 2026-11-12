package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDatabaseURLMySQL(t *testing.T) {
	db, err := ParseDatabaseURL(`mysql://ro:pw@10.0.0.1:3307/openvod?connection_limit=5`)
	if err != nil {
		t.Fatalf("ParseDatabaseURL: %v", err)
	}
	if db.Driver != DriverMySQL {
		t.Fatalf("driver=%q, want mysql", db.Driver)
	}
	for _, want := range []string{
		"ro:pw@tcp(10.0.0.1:3307)/openvod",
		"parseTime=true",
		"loc=UTC",
		"charset=utf8mb4",
		"connection_limit=5",
	} {
		if !strings.Contains(db.DSN, want) {
			t.Errorf("DSN 缺少 %q：%s", want, db.DSN)
		}
	}
	if db.Path != "" {
		t.Errorf("mysql 不应有 sqlite Path，得到 %q", db.Path)
	}
}

func TestParseDatabaseURLMySQLDefaultPort(t *testing.T) {
	db, err := ParseDatabaseURL("mysql://u:p@db.internal/openvod")
	if err != nil {
		t.Fatalf("ParseDatabaseURL: %v", err)
	}
	if !strings.Contains(db.DSN, "@tcp(db.internal:3306)/openvod") {
		t.Fatalf("未补默认端口：%s", db.DSN)
	}
}

func TestParseDatabaseURLBareMySQLDSN(t *testing.T) {
	const dsn = "u:p@tcp(127.0.0.1:3306)/openvod?parseTime=true"
	db, err := ParseDatabaseURL(dsn)
	if err != nil {
		t.Fatalf("ParseDatabaseURL: %v", err)
	}
	if db.Driver != DriverMySQL || db.DSN != dsn {
		t.Fatalf("裸 DSN 应原样保留，得到 driver=%q dsn=%q", db.Driver, db.DSN)
	}
}

func TestParseDatabaseURLSQLitePrismaFileURL(t *testing.T) {
	// 相对路径按 Prisma schema 目录归一，保证三端打开同一个库文件

	db, err := ParseDatabaseURL(`file:./dev.db?connection_limit=1`)
	if err != nil {
		t.Fatalf("ParseDatabaseURL: %v", err)
	}
	if db.Driver != DriverSQLite {
		t.Fatalf("driver=%q, want sqlite", db.Driver)
	}
	if !filepath.IsAbs(db.Path) {
		t.Fatalf("sqlite 路径应归一为绝对路径，得到 %q", db.Path)
	}
	if !strings.HasSuffix(db.Path, filepath.Join("packages", "db", "prisma", "dev.db")) {
		t.Fatalf("相对路径应按 Prisma schema 目录解析，得到 %q", db.Path)
	}
	if !strings.HasPrefix(db.DSN, db.Path+"?_pragma=") {
		t.Fatalf("DSN 应以路径 + pragma 开头：%s", db.DSN)
	}
	for _, want := range []string{"busy_timeout(5000)", "foreign_keys(1)"} {
		if !strings.Contains(db.DSN, want) {
			t.Errorf("DSN 缺少 pragma %q：%s", want, db.DSN)
		}
	}
	if strings.Contains(db.DSN, "connection_limit") {
		t.Errorf("Prisma 连接池参数应被丢弃：%s", db.DSN)
	}
}

func TestParseDatabaseURLSQLiteAbsoluteForms(t *testing.T) {
	for _, raw := range []string{
		"file:/tmp/openvod.db",
		"file:///tmp/openvod.db",
		"sqlite:///tmp/openvod.db",
		"/tmp/openvod.db",
	} {
		db, err := ParseDatabaseURL(raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if db.Driver != DriverSQLite || db.Path != "/tmp/openvod.db" {
			t.Fatalf("%s → driver=%q path=%q", raw, db.Driver, db.Path)
		}
	}
}

func TestParseDatabaseURLRejectsUnsupportedScheme(t *testing.T) {
	if _, err := ParseDatabaseURL("postgres://u:p@h/db"); err == nil {
		t.Fatal("postgres:// 应被拒绝")
	}
}

func TestParseDatabaseURLRejectsEmpty(t *testing.T) {
	if _, err := ParseDatabaseURL("  "); err == nil {
		t.Fatal("空连接串应报错")
	}
}

func TestLoadRejectsLegacyDeliveryDatabaseURL(t *testing.T) {
	t.Setenv("MASTER_KEYS", "1:"+strings.Repeat("ab", 32))
	t.Setenv("DATABASE_URL", "")
	t.Setenv("DELIVERY_DATABASE_URL", "mysql://ro:pw@db.example.com:3306/openvod")
	_, err := Load()
	if err == nil {
		t.Fatal("只有旧变量名时 Load 应失败")
	}
	if !strings.Contains(err.Error(), "DELIVERY_DATABASE_URL") || !strings.Contains(err.Error(), "改名") {
		t.Fatalf("报错应提示改名，得到：%v", err)
	}
}

func TestLoadReadsDatabaseURL(t *testing.T) {
	t.Setenv("MASTER_KEYS", "1:"+strings.Repeat("ab", 32))
	t.Setenv("DATABASE_URL", "file:/tmp/openvod-load.db")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DatabaseDriver != DriverSQLite || cfg.DatabasePath != "/tmp/openvod-load.db" {
		t.Fatalf("driver=%q path=%q", cfg.DatabaseDriver, cfg.DatabasePath)
	}
}
