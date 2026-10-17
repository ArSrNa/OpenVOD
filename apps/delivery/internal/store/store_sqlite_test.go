package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Prisma schema 在 SQLite 下的真实列类型（DateTime = DATETIME + 整数毫秒，Boolean = 0/1）。
// 这里保留同样的声明类型与存储形态，确保仓储层不依赖 MySQL 的 parseTime 行为。
var sqliteDDL = []string{
	`CREATE TABLE users (
		id TEXT NOT NULL PRIMARY KEY,
		username TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		display_name TEXT,
		status TEXT NOT NULL DEFAULT 'ACTIVE',
		max_concurrent_sessions INTEGER NOT NULL DEFAULT 0,
		last_login_at DATETIME,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	)`,
	`CREATE TABLE media (
		id TEXT NOT NULL PRIMARY KEY,
		title TEXT NOT NULL,
		status TEXT NOT NULL,
		probe JSONB,
		custom_data JSONB,
		duration_ms INTEGER,
		poster_key TEXT,
		published_at DATETIME,
		uploaded_at DATETIME,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	)`,
	`CREATE TABLE media_subtitles (
		id TEXT NOT NULL PRIMARY KEY,
		media_id TEXT NOT NULL,
		lang TEXT NOT NULL,
		label TEXT NOT NULL,
		is_default BOOLEAN NOT NULL DEFAULT false,
		status TEXT NOT NULL,
		storage_key TEXT NOT NULL,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	)`,
	`CREATE TABLE hls_keys (
		id TEXT NOT NULL PRIMARY KEY,
		media_id TEXT NOT NULL,
		kid TEXT NOT NULL,
		method TEXT NOT NULL,
		iv TEXT NOT NULL,
		wrapped_cek TEXT NOT NULL,
		mk_ver INTEGER NOT NULL,
		created_at DATETIME NOT NULL
	)`,
	`CREATE TABLE signing_keys (
		id TEXT NOT NULL PRIMARY KEY,
		kid TEXT NOT NULL,
		kind TEXT NOT NULL,
		state TEXT NOT NULL,
		private_enc TEXT,
		not_before DATETIME NOT NULL,
		not_after DATETIME,
		created_at DATETIME NOT NULL
	)`,
	`CREATE TABLE transcode_templates (
		id TEXT NOT NULL PRIMARY KEY,
		name TEXT NOT NULL,
		is_default BOOLEAN NOT NULL DEFAULT false,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	)`,
	"CREATE TABLE system_settings (`key` TEXT NOT NULL PRIMARY KEY, `value` TEXT NOT NULL, updated_at DATETIME NOT NULL)",
	`CREATE TABLE playback_sessions (
		id TEXT NOT NULL PRIMARY KEY,
		user_id TEXT NOT NULL,
		media_id TEXT NOT NULL,
		ip TEXT,
		user_agent TEXT,
		expires_at DATETIME NOT NULL,
		revoked_at DATETIME,
		created_at DATETIME NOT NULL
	)`,
}

func newSQLiteStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "openvod.db")

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开原始连接: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	for _, ddl := range sqliteDDL {
		if _, err := raw.Exec(ddl); err != nil {
			t.Fatalf("建表失败: %v\n%s", err, ddl)
		}
	}

	st, err := Open(driverSQLite, path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, raw
}

// seedPrismaRows 以 Prisma 的物理形态（DateTime = 整数毫秒、Boolean = 0/1）写入数据。
func seedPrismaRows(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, q := range []string{
		`INSERT INTO users (id, username, password_hash, display_name, status, max_concurrent_sessions, last_login_at, created_at, updated_at)
		 VALUES ('u1','alice','hash',NULL,'ACTIVE',3,1792231200000,1790000000000,1790000000000)`,
		// m1 无 published_at → 用 uploaded_at；m2 published_at 更晚；m3 非 READY 不出现
		`INSERT INTO media (id, title, status, probe, custom_data, duration_ms, poster_key, published_at, uploaded_at, created_at, updated_at)
		 VALUES ('m1','旧片','READY','{"width":1920}','{"category":{"name":"其他"}}',60000,'cover/m1.jpg',NULL,1790000000000,1780000000000,1780000000000)`,
		`INSERT INTO media (id, title, status, probe, custom_data, duration_ms, poster_key, published_at, uploaded_at, created_at, updated_at)
		 VALUES ('m2','新片','READY',NULL,NULL,90000,NULL,1791000000000,NULL,1780000000000,1780000000000)`,
		`INSERT INTO media (id, title, status, created_at, updated_at)
		 VALUES ('m3','转码中','TRANSCODING',1780000000000,1780000000000)`,
		`INSERT INTO media_subtitles (id, media_id, lang, label, is_default, status, storage_key, created_at, updated_at)
		 VALUES ('s1','m1','zh','中文',1,'READY','subtitle/m1/s1.vtt',1780000000000,1780000000000)`,
		`INSERT INTO media_subtitles (id, media_id, lang, label, is_default, status, storage_key, created_at, updated_at)
		 VALUES ('s2','m1','en','English',0,'READY','subtitle/m1/s2.vtt',1780000000000,1780000000000)`,
		`INSERT INTO media_subtitles (id, media_id, lang, label, is_default, status, storage_key, created_at, updated_at)
		 VALUES ('s3','m1','ja','日本語',0,'PROCESSING','subtitle/m1/s3.vtt',1780000000000,1780000000000)`,
		`INSERT INTO hls_keys (id, media_id, kid, method, iv, wrapped_cek, mk_ver, created_at)
		 VALUES ('k1','m1','kid-1','AES-128','00112233445566778899aabbccddeeff','deadbeef',1,1780000000000)`,
		`INSERT INTO signing_keys (id, kid, kind, state, private_enc, not_before, not_after, created_at)
		 VALUES ('sk1','jwt-1','JWT','ACTIVE','enc',1000,NULL,1780000000000)`,
		`INSERT INTO signing_keys (id, kid, kind, state, private_enc, not_before, not_after, created_at)
		 VALUES ('sk2','jwt-old','JWT','REVOKED','enc',1000,NULL,1780000000000)`,
		`INSERT INTO transcode_templates (id, name, is_default, created_at, updated_at)
		 VALUES ('t1','默认模板',1,1780000000000,1780000000000)`,
		`INSERT INTO transcode_templates (id, name, is_default, created_at, updated_at)
		 VALUES ('t2','备用模板',0,1780000000000,1780000000000)`,
		"INSERT INTO system_settings (`key`, `value`, updated_at) VALUES ('playback_base_url','https://play.example.com',1780000000000)",
		"INSERT INTO system_settings (`key`, `value`, updated_at) VALUES ('storage_sign_mode','s3_presign',1780000000000)",
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("插入种子数据失败: %v\n%s", err, q)
		}
	}
}

func TestSQLiteReadsPrismaRows(t *testing.T) {
	st, raw := newSQLiteStore(t)
	seedPrismaRows(t, raw)
	ctx := context.Background()

	u, err := st.UserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("UserByUsername: %v", err)
	}
	if u.MaxConcurrentSessions != 3 || u.Status != "ACTIVE" {
		t.Fatalf("user=%+v", u)
	}

	m, err := st.MediaByID(ctx, "m1")
	if err != nil {
		t.Fatalf("MediaByID: %v", err)
	}
	if !m.CustomData.Valid || m.CustomData.String != `{"category":{"name":"其他"}}` {
		t.Fatalf("custom_data=%+v", m.CustomData)
	}

	ready, err := st.ListReady(ctx, 10)
	if err != nil {
		t.Fatalf("ListReady: %v", err)
	}
	if len(ready) != 2 || ready[0].ID != "m2" || ready[1].ID != "m1" {
		t.Fatalf("ListReady 顺序应按 COALESCE(published_at, uploaded_at, created_at) 倒序: %+v", ready)
	}

	subs, err := st.ReadySubtitles(ctx, "m1")
	if err != nil {
		t.Fatalf("ReadySubtitles: %v", err)
	}
	if len(subs) != 2 || !subs[0].IsDefault || subs[0].ID != "s1" {
		t.Fatalf("subs=%+v（BOOLEAN 0/1 应能扫进 bool）", subs)
	}
	if _, err := st.SubtitleByTrackID(ctx, "m1", "s3"); err != ErrNotFound {
		t.Fatalf("未就绪字幕应 not found，得到 %v", err)
	}

	key, err := st.HlsKeyByMedia(ctx, "m1")
	if err != nil || key.Kid != "kid-1" || key.MkVer != 1 {
		t.Fatalf("HlsKeyByMedia: %+v, %v", key, err)
	}

	keys, err := st.JWTSigningKeys(ctx, time.UnixMilli(1790000000000))
	if err != nil {
		t.Fatalf("JWTSigningKeys: %v", err)
	}
	if len(keys) != 1 || keys[0].Kid != "jwt-1" {
		t.Fatalf("keys=%+v（not_before 整数毫秒比较失败）", keys)
	}

	tpl, err := st.DefaultTemplateID(ctx)
	if err != nil || tpl != "t1" {
		t.Fatalf("DefaultTemplateID=%q, %v", tpl, err)
	}
	refs, err := st.TemplateRefs(ctx, []string{"t1", "t2"})
	if err != nil || len(refs) != 2 {
		t.Fatalf("TemplateRefs=%+v, %v", refs, err)
	}

	if v, err := st.SettingValue(ctx, "playback_base_url"); err != nil || v != "https://play.example.com" {
		t.Fatalf("SettingValue=%q, %v（反引号 quoting）", v, err)
	}
	all, err := st.AllSettings(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("AllSettings=%v, %v", all, err)
	}
}

func TestSQLiteWritesPrismaCompatibleSessions(t *testing.T) {
	st, raw := newSQLiteStore(t)
	seedPrismaRows(t, raw)
	ctx := context.Background()

	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	expires := now.Add(4 * time.Hour)
	if err := st.CreateSession(ctx, "sess-1", "u1", "m1", "1.2.3.4", "test-agent", expires, now); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// 写出的必须是 Prisma 认得的整数毫秒（否则管理端 / 分发端会读到 1970 或 5 万年后）
	var rawExpires, rawCreated int64
	if err := raw.QueryRow(`SELECT expires_at, created_at FROM playback_sessions WHERE id='sess-1'`).
		Scan(&rawExpires, &rawCreated); err != nil {
		t.Fatalf("读取原始列: %v", err)
	}
	if rawExpires != expires.UnixMilli() || rawCreated != now.UnixMilli() {
		t.Fatalf("raw expires=%d created=%d, want %d/%d", rawExpires, rawCreated, expires.UnixMilli(), now.UnixMilli())
	}

	got, err := st.ActiveSession(ctx, "u1", "m1", now)
	if err != nil {
		t.Fatalf("ActiveSession: %v", err)
	}
	if !got.ExpiresAt.Equal(expires) {
		t.Fatalf("ExpiresAt=%s, want %s", got.ExpiresAt, expires)
	}

	alive, err := st.SessionAlive(ctx, "sess-1", "m1", now)
	if err != nil || !alive {
		t.Fatalf("SessionAlive=%v, %v", alive, err)
	}
	// 过期后不应再复用
	if _, err := st.ActiveSession(ctx, "u1", "m1", expires.Add(time.Millisecond)); err != ErrNotFound {
		t.Fatalf("过期会话应 not found，得到 %v", err)
	}

	n, err := st.CountActiveSessions(ctx, "u1", now)
	if err != nil || n != 1 {
		t.Fatalf("CountActiveSessions=%d, %v", n, err)
	}

	if err := st.TouchLastLogin(ctx, "u1", now); err != nil {
		t.Fatalf("TouchLastLogin: %v", err)
	}
	var rawLogin int64
	if err := raw.QueryRow(`SELECT last_login_at FROM users WHERE id='u1'`).Scan(&rawLogin); err != nil {
		t.Fatalf("读取 last_login_at: %v", err)
	}
	if rawLogin != now.UnixMilli() {
		t.Fatalf("last_login_at=%d, want %d", rawLogin, now.UnixMilli())
	}
}

func TestOpenRejectsUnknownDriver(t *testing.T) {
	if _, err := Open("postgres", "dsn"); err == nil {
		t.Fatal("未知驱动应报错")
	}
}

func TestOpenSQLiteRequiresInitializedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.db")
	_, err := Open(driverSQLite, path)
	if err == nil || !strings.Contains(err.Error(), "task db:push") {
		t.Fatalf("空库应给出建表提示，得到 %v", err)
	}
}
