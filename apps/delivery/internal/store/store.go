// Package store 分发端 DB 读模型 + 播放会话写入（ADR-0004 / ADR-0011 2026-10-17 修订）：
// 不用 Prisma（Go 侧 database/sql + sqlx），只读 users/media/media_subtitles/hls_keys/
// signing_keys/transcode_templates/system_settings，读写 playback_sessions。
// 同时支持 MySQL（生产 / 云函数）与 SQLite（单机同卷自托管）：SQL 只用两种方言的公共子集，
// 差异集中在驱动选择与时间类型（见 Time / ts）。与 Prisma schema 的对齐靠仓储集成测试。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	_ "github.com/go-sql-driver/mysql" // MySQL（v1 云形态 / 生产）
	_ "modernc.org/sqlite"             // SQLite（纯 Go 驱动，CGO_ENABLED=0 的云函数构建可用）
)

var ErrNotFound = errors.New("store: 未找到")

const (
	driverMySQL  = "mysql"
	driverSQLite = "sqlite"
)

type Store struct {
	db     *sqlx.DB
	driver string
}

/**
 * Open 按驱动建立连接池。driver 由连接串 scheme 推导（config.ParseDatabaseURL），
 * 不接受空值以免静默连错库。
 * SQLite 连接池固定 1：单文件库的写锁竞争由 busy_timeout 兜底，串行化比多连接更稳，
 * 且分发端每次查询均为毫秒级点查（trial / 单机形态足够）。
 */
func Open(driver, dsn string) (*Store, error) {
	if driver != driverMySQL && driver != driverSQLite {
		return nil, fmt.Errorf("不支持的数据库驱动: %q", driver)
	}
	db, err := sqlx.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	if driver == driverSQLite {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(8)
		db.SetMaxIdleConns(4)
		db.SetConnMaxLifetime(time.Hour)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("数据库连接失败: %w", err)
	}
	// SQLite 打开不存在的文件会静默新建空库，首个查询才报 no such table——这里提前失败并给出路径，
	// 避免「相对路径解析错 → 连到另一份空文件」被误判成 schema 问题。
	if driver == driverSQLite {
		var n int
		if err := db.GetContext(ctx, &n, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'`); err != nil || n == 0 {
			_ = db.Close()
			return nil, fmt.Errorf("SQLite 库未初始化（%s 缺少 users 表）：先执行 task db:push，并确认与 Prisma 使用同一个库文件", sqliteDisplayPath(dsn))
		}
	}
	return &Store{db: db, driver: driver}, nil
}

func sqliteDisplayPath(dsn string) string {
	if i := strings.IndexByte(dsn, '?'); i >= 0 {
		return dsn[:i]
	}
	return dsn
}

// ts 时间参数的方言表示：Prisma 在 SQLite 里把 DateTime 存为整数毫秒，
// MySQL 存为 DATETIME（parseTime=true 回读 time.Time）。
func (s *Store) ts(t time.Time) any {
	if s.driver == driverSQLite {
		return t.UTC().UnixMilli()
	}
	return t.UTC()
}

func (s *Store) Close() error { return s.db.Close() }

// ---- users（播放端用户，ADR-0007） ----

type User struct {
	ID                    string         `db:"id"`
	Username              string         `db:"username"`
	PasswordHash          string         `db:"password_hash"`
	DisplayName           sql.NullString `db:"display_name"`
	Status                string         `db:"status"`
	MaxConcurrentSessions int            `db:"max_concurrent_sessions"`
}

func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	var u User
	err := s.db.GetContext(ctx, &u,
		`SELECT id, username, password_hash, display_name, status, max_concurrent_sessions
		   FROM users WHERE username = ? LIMIT 1`, username)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	var u User
	err := s.db.GetContext(ctx, &u,
		`SELECT id, username, password_hash, display_name, status, max_concurrent_sessions
		   FROM users WHERE id = ? LIMIT 1`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) TouchLastLogin(ctx context.Context, userID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login_at = ? WHERE id = ?`, s.ts(now), userID)
	return err
}

// ---- media / 字幕 ----

type Media struct {
	ID         string         `db:"id"`
	Title      string         `db:"title"`
	Status     string         `db:"status"`
	CustomData sql.NullString `db:"custom_data"`
	DurationMs sql.NullInt64  `db:"duration_ms"`
	PosterKey  sql.NullString `db:"poster_key"`
	Probe      sql.NullString `db:"probe"`
}

func (s *Store) MediaByID(ctx context.Context, id string) (*Media, error) {
	var m Media
	err := s.db.GetContext(ctx, &m,
		`SELECT id, title, status, custom_data, duration_ms, poster_key, probe
		   FROM media WHERE id = ? LIMIT 1`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

/** ListReady 上架可播列表（status=READY；ADR-0010「仅上架 ready 项」）
 *  排序回退链：发布时间 → 自定义上传时间（管理端可设置，spec.md §3.1）→ 入库时间 */
func (s *Store) ListReady(ctx context.Context, limit int) ([]Media, error) {
	rows := []Media{}
	err := s.db.SelectContext(ctx, &rows,
		`SELECT id, title, status, custom_data, duration_ms, poster_key, probe
		   FROM media WHERE status = 'READY'
		  ORDER BY COALESCE(published_at, uploaded_at, created_at) DESC, id DESC
		  LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

type Subtitle struct {
	ID         string `db:"id"`
	Lang       string `db:"lang"`
	Label      string `db:"label"`
	IsDefault  bool   `db:"is_default"`
	StorageKey string `db:"storage_key"`
}

/** ReadySubtitles 该媒资的就绪字幕轨道（status=READY；spec.md §7.5：未就绪不下发） */
func (s *Store) ReadySubtitles(ctx context.Context, mediaID string) ([]Subtitle, error) {
	rows := []Subtitle{}
	err := s.db.SelectContext(ctx, &rows,
		`SELECT id, lang, label, is_default, storage_key FROM media_subtitles
		  WHERE media_id = ? AND status = 'READY'
		  ORDER BY is_default DESC, created_at ASC`, mediaID)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

/**
 * SubtitleByTrackID 按轨道 ID 取字幕行（spec.md §7.5）：
 * trackId 同时是 media_subtitles.id 与存储文件名，但读取**以行内 storage_key 为准**（键可迁移）。
 * 限定 media_id 防跨媒资引用；限定 status=READY 与下发口径一致。
 */
func (s *Store) SubtitleByTrackID(ctx context.Context, mediaID, trackID string) (*Subtitle, error) {
	var row Subtitle
	err := s.db.GetContext(ctx, &row,
		`SELECT id, lang, label, is_default, storage_key FROM media_subtitles
		  WHERE id = ? AND media_id = ? AND status = 'READY' LIMIT 1`, trackID, mediaID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ---- hls_keys（每媒资一份 CEK，spec.md §4.1） ----

type HlsKey struct {
	Kid        string `db:"kid"`
	Method     string `db:"method"`
	IV         string `db:"iv"`
	WrappedCek string `db:"wrapped_cek"`
	MkVer      int    `db:"mk_ver"`
}

func (s *Store) HlsKeyByMedia(ctx context.Context, mediaID string) (*HlsKey, error) {
	var k HlsKey
	err := s.db.GetContext(ctx, &k,
		`SELECT kid, method, iv, wrapped_cek, mk_ver FROM hls_keys WHERE media_id = ? LIMIT 1`, mediaID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &k, nil
}

// ---- signing_keys（JWT 私钥，MK 封装；ADR-0004/0007） ----

type SigningKey struct {
	Kid        string `db:"kid"`
	PrivateEnc string `db:"private_enc"`
}

/** JWTSigningKeys 当前有效（ACTIVE）的 JWT 私钥；轮换期为多把（双 kid 宽限） */
func (s *Store) JWTSigningKeys(ctx context.Context, now time.Time) ([]SigningKey, error) {
	rows := []SigningKey{}
	err := s.db.SelectContext(ctx, &rows,
		`SELECT kid, private_enc FROM signing_keys
		  WHERE kind = 'JWT' AND state = 'ACTIVE' AND private_enc IS NOT NULL
		    AND (not_before IS NULL OR not_before <= ?)
		    AND (not_after IS NULL OR not_after > ?)
		  ORDER BY created_at DESC`, s.ts(now), s.ts(now))
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ---- transcode_templates（默认模板：多套产物时的自动选择依据） ----

type TemplateRef struct {
	ID        string `db:"id"`
	Name      string `db:"name"`
	IsDefault bool   `db:"is_default"`
}

func (s *Store) DefaultTemplateID(ctx context.Context) (string, error) {
	var id string
	err := s.db.GetContext(ctx, &id, `SELECT id FROM transcode_templates WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1`)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

/**
 * TemplateRefs 批量查模板行（spec.md §11.1：play 响应 templates[] 补当前名称与默认标记）。
 * 一次 IN 查询；查不到的行由调用方降级为 name=null（历史产物，模板行已删）。
 */
func (s *Store) TemplateRefs(ctx context.Context, ids []string) ([]TemplateRef, error) {
	if len(ids) == 0 {
		return []TemplateRef{}, nil
	}
	query, args, err := sqlx.In(
		`SELECT id, name, is_default FROM transcode_templates WHERE id IN (?)`, ids)
	if err != nil {
		return nil, err
	}
	rows := []TemplateRef{}
	if err := s.db.SelectContext(ctx, &rows, s.db.Rebind(query), args...); err != nil {
		return nil, err
	}
	return rows, nil
}

// ---- system_settings（只读；播放域名运行时覆盖，spec.md §2.1.2；ADR-0015 设置加载） ----

/**
 * SettingValue 读单个设置值（key 为 MySQL 保留字风格的列名，必须反引号）。
 * 返回原始字符串；配置刷新与失败回退由装配层负责。
 */
func (s *Store) SettingValue(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.GetContext(ctx, &v, "SELECT `value` FROM system_settings WHERE `key` = ? LIMIT 1", key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

/**
 * AllSettings 全量设置（key -> value 原始值；密钥键为封装 hex，由 internal/settings 解封）。
 * ADR-0015：分发端启动与 60s 热刷新时读取，env 同名键兜底。
 */
func (s *Store) AllSettings(ctx context.Context) (map[string]string, error) {
	rows := []struct {
		Key   string `db:"key"`
		Value string `db:"value"`
	}{}
	err := s.db.SelectContext(ctx, &rows, "SELECT `key`, `value` FROM system_settings")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Key] = r.Value
	}
	return out, nil
}

// ---- playback_sessions（分发端写，可吊销；ADR-0006 §6） ----

type PlaybackSession struct {
	ID        string `db:"id"`
	UserID    string `db:"user_id"`
	MediaID   string `db:"media_id"`
	ExpiresAt Time   `db:"expires_at"` // 方言无关：SQLite 整数毫秒 / MySQL time.Time
}

/** ActiveSession 同用户同媒资的可复用会话（未吊销且未过期，取最新） */
func (s *Store) ActiveSession(ctx context.Context, userID, mediaID string, now time.Time) (*PlaybackSession, error) {
	var row PlaybackSession
	err := s.db.GetContext(ctx, &row,
		`SELECT id, user_id, media_id, expires_at FROM playback_sessions
		  WHERE user_id = ? AND media_id = ? AND revoked_at IS NULL AND expires_at > ?
		  ORDER BY created_at DESC LIMIT 1`, userID, mediaID, s.ts(now))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *Store) CountActiveSessions(ctx context.Context, userID string, now time.Time) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n,
		`SELECT COUNT(*) FROM playback_sessions
		  WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`, userID, s.ts(now))
	return n, err
}

func (s *Store) CreateSession(ctx context.Context, id, userID, mediaID, ip, userAgent string, expiresAt, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO playback_sessions (id, user_id, media_id, ip, user_agent, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, userID, mediaID, nullIfEmpty(ip), nullIfEmpty(userAgent), s.ts(expiresAt), s.ts(now))
	return err
}

/**
 * SessionAlive 会话有效性（清单 / 密钥 / 分片请求都过这里）。
 * v1 每请求一次 DB 查询：语义上严格（吊销立即收敛），ADR-0006 §6 的 60s 进程内缓存为演进项。
 */
func (s *Store) SessionAlive(ctx context.Context, sid, mediaID string, now time.Time) (bool, error) {
	var n int
	err := s.db.GetContext(ctx, &n,
		`SELECT COUNT(*) FROM playback_sessions
		  WHERE id = ? AND media_id = ? AND revoked_at IS NULL AND expires_at > ?`, sid, mediaID, s.ts(now))
	return n > 0, err
}

func nullIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}
