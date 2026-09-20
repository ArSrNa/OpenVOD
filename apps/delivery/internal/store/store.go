// Package store 分发端 DB 读模型 + 播放会话写入（ADR-0004）：
// 不用 Prisma（Go 侧 database/sql + sqlx），只读 users/media/media_subtitles/hls_keys/
// signing_keys/transcode_templates，读写 playback_sessions。
// 与 Prisma schema 的对齐靠集成测试（apps/delivery）与列名显式映射。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"

	_ "github.com/go-sql-driver/mysql" // MySQL 驱动（v1 云形态；sqlite 自托管为后续）
)

var ErrNotFound = errors.New("store: 未找到")

type Store struct {
	db *sqlx.DB
}

func Open(databaseURL string) (*Store, error) {
	db, err := sqlx.Open("mysql", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(time.Hour)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("数据库连接失败: %w", err)
	}
	return &Store{db: db}, nil
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
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login_at = ? WHERE id = ?`, now.UTC(), userID)
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

/** ListReady 上架可播列表（status=READY；ADR-0010「仅上架 ready 项」） */
func (s *Store) ListReady(ctx context.Context, limit int) ([]Media, error) {
	rows := []Media{}
	err := s.db.SelectContext(ctx, &rows,
		`SELECT id, title, status, custom_data, duration_ms, poster_key, probe
		   FROM media WHERE status = 'READY'
		  ORDER BY COALESCE(published_at, created_at) DESC, id DESC
		  LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

type Subtitle struct {
	ID        string `db:"id"`
	Lang      string `db:"lang"`
	Label     string `db:"label"`
	IsDefault bool   `db:"is_default"`
}

func (s *Store) ReadySubtitles(ctx context.Context, mediaID string) ([]Subtitle, error) {
	rows := []Subtitle{}
	err := s.db.SelectContext(ctx, &rows,
		`SELECT id, lang, label, is_default FROM media_subtitles
		  WHERE media_id = ? AND status = 'READY'
		  ORDER BY is_default DESC, created_at ASC`, mediaID)
	if err != nil {
		return nil, err
	}
	return rows, nil
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
		  ORDER BY created_at DESC`, now.UTC(), now.UTC())
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ---- transcode_templates（默认模板：多套产物时的自动选择依据） ----

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

// ---- playback_sessions（分发端写，可吊销；ADR-0006 §6） ----

type PlaybackSession struct {
	ID        string    `db:"id"`
	UserID    string    `db:"user_id"`
	MediaID   string    `db:"media_id"`
	ExpiresAt time.Time `db:"expires_at"`
}

/** ActiveSession 同用户同媒资的可复用会话（未吊销且未过期，取最新） */
func (s *Store) ActiveSession(ctx context.Context, userID, mediaID string, now time.Time) (*PlaybackSession, error) {
	var row PlaybackSession
	err := s.db.GetContext(ctx, &row,
		`SELECT id, user_id, media_id, expires_at FROM playback_sessions
		  WHERE user_id = ? AND media_id = ? AND revoked_at IS NULL AND expires_at > ?
		  ORDER BY created_at DESC LIMIT 1`, userID, mediaID, now.UTC())
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
		  WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`, userID, now.UTC())
	return n, err
}

func (s *Store) CreateSession(ctx context.Context, id, userID, mediaID, ip, userAgent string, expiresAt, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO playback_sessions (id, user_id, media_id, ip, user_agent, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, userID, mediaID, nullIfEmpty(ip), nullIfEmpty(userAgent), expiresAt.UTC(), now.UTC())
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
		  WHERE id = ? AND media_id = ? AND revoked_at IS NULL AND expires_at > ?`, sid, mediaID, now.UTC())
	return n > 0, err
}

func nullIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}
