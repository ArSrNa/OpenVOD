// Package settings system_settings 运行时配置加载（ADR-0015）：
// 分发端启动只要求 DELIVERY_DATABASE_URL + MASTER_KEYS（env，MK 分层根不可入库），
// 其余配置（存储凭据 / 播放签名密钥 / TTL / CORS / kid）从 system_settings 读取，
// env 同名键兜底。密钥类键以 MK 封装 hex 存储（AES-256-GCM，与 signing_keys 同形态），
// 明文仅在解封瞬间存在于内存。
package settings

import (
	"context"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/mk"
	"openvod/apps/delivery/internal/store"
)

// 键名注册表（与 packages/shared SETTING_KEYS 手工对齐；Go 侧无生成物）
const (
	KeySetupCompleted     = "setup_completed"
	KeyS3Endpoint         = "s3_endpoint"
	KeyS3Region           = "s3_region"
	KeyS3Bucket           = "s3_bucket"
	KeyS3AccessKeyID      = "s3_access_key_id"
	KeyS3SecretAccessKey  = "s3_secret_access_key" // 密钥：MK 封装
	KeyS3ForcePathStyle   = "s3_force_path_style"
	KeyStorageRootPrefix  = "storage_root_prefix"
	KeyStorageCDNBaseURL  = "storage_cdn_base_url"
	KeyURLSignKeyHex      = "url_sign_key_hex" // 密钥：MK 封装
	KeyURLSignKeyKid      = "url_sign_key_kid"
	KeyJWTTTLSec          = "jwt_ttl_sec"
	KeySessionTTLSec      = "playback_session_ttl_sec"
	KeyManifestTTLSec     = "playback_manifest_ttl_sec"
	KeySubtitleTTLSec     = "playback_subtitle_ttl_sec"
	KeyCORSOrigins        = "cors_origins"
	KeyPlaybackBaseURL    = "playback_base_url"
	KeyWorkerPollMs       = "worker_poll_interval_ms"
	KeyWorkerLeaseMs      = "worker_lease_ms"
	KeyWorkerMaxAttempts  = "worker_max_attempts"
	KeyAdminBaseURL       = "admin_base_url"
	KeyAdminTrustedOrigins = "admin_trusted_origins"
	KeyAdminSessionTTL    = "admin_session_ttl_sec"
	KeyMediaIDLength      = "media_id_length"
	KeyDeliveryPreviewUser = "delivery_preview_username"
	KeyDeliveryPreviewPwd  = "delivery_preview_password" // 密钥：MK 封装
	KeyOIDCIssuer         = "oidc_issuer"
	KeyOIDCClientID       = "oidc_client_id"
	KeyOIDCClientSecret   = "oidc_client_secret" // 密钥：MK 封装
)

// secretKeys 密钥类键（读取时 MK 解封）；写入侧白名单由管理台强制，明文入库直接拒绝
var secretKeys = map[string]bool{
	KeyS3SecretAccessKey: true,
	KeyURLSignKeyHex:     true,
	KeyDeliveryPreviewPwd: true,
	KeyOIDCClientSecret:  true,
	"better_auth_secret": true, // 管理台自用；分发端读到也不解密（仅登记以保持白名单一致）
}

// Snapshot 一次加载的系统设置全集（已解封密钥；未配置的键为空串，由调用方决定兜底）
type Snapshot struct {
	Values map[string]string
}

// Load 读取全部设置行并解封密钥键。DB 故障返回 error（启动期致命；运行期读失败由调用方回退 env）。
func Load(ctx context.Context, st *store.Store, masterKeys map[int][]byte) (*Snapshot, error) {
	rows, err := st.AllSettings(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取 system_settings 失败: %w", err)
	}
	snap := &Snapshot{Values: map[string]string{}}
	for k, v := range rows {
		if secretKeys[k] && v != "" {
			plain, _, err := mkUnwrapAny(masterKeys, v)
			if err != nil {
				return nil, fmt.Errorf("设置 %s 解封失败（MK 轮换后未保留旧版本？）: %w", k, err)
			}
			v = string(plain)
		}
		snap.Values[k] = v
	}
	return snap, nil
}

// Get 明文键取值（不存在返回空串）
func (s *Snapshot) Get(key string) string { return strings.TrimSpace(s.Values[key]) }

// SignKeyHex 播放 token 签名密钥（hex 明文；未配置返回空串）
func (s *Snapshot) SignKeyHex() string { return s.Get(KeyURLSignKeyHex) }

// Int 键值转 int（非法 / 未配置回退 fallback）
func (s *Snapshot) Int(key string, fallback int) int {
	v := strings.TrimSpace(s.Values[key])
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

// Bool 键值转 bool（"false"/"0" 为假，其余真；未配置回退 fallback）
func (s *Snapshot) Bool(key string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(s.Values[key]))
	if v == "" {
		return fallback
	}
	return v != "false" && v != "0"
}

// StorageConfigured 存储四要素（端点 / 桶 / AK / SK）是否齐全
func (s *Snapshot) StorageConfigured() bool {
	return s.Get(KeyS3Endpoint) != "" && s.Get(KeyS3Bucket) != "" &&
		s.Get(KeyS3AccessKeyID) != "" && s.Get(KeyS3SecretAccessKey) != ""
}

// mkUnwrapAny 与 signing_keys 相同的逐版本尝试解封语义（hex 入库形态）
func mkUnwrapAny(masterKeys map[int][]byte, wrappedHex string) ([]byte, int, error) {
	wrapped, err := hex.DecodeString(wrappedHex)
	if err != nil {
		return nil, 0, fmt.Errorf("封装串非法 hex: %w", err)
	}
	return mk.UnwrapAny(masterKeys, wrapped)
}

// ApplyTo 把设置快照合并进启动配置（ADR-0015）：
// DB 设置逐字段覆盖 env 兜底（仅覆盖非空键）；签名密钥 / TTL / CORS / kid / 存储凭据全部生效于此。
// cfg.URLSignKey 在设置与 env 都缺省时保持 nil，由调用方安全失败。
func (s *Snapshot) ApplyTo(cfg *config.Config) error {
	// ---- 存储（逐字段：设置值优先，env 兜底） ----
	if v := s.Get(KeyS3Endpoint); v != "" {
		cfg.Storage.Endpoint = v
	}
	if v := s.Get(KeyS3Region); v != "" {
		cfg.Storage.Region = v
	}
	if v := s.Get(KeyS3Bucket); v != "" {
		cfg.Storage.Bucket = v
	}
	if v := s.Get(KeyS3AccessKeyID); v != "" {
		cfg.Storage.AccessKeyID = v
	}
	if v := s.Get(KeyS3SecretAccessKey); v != "" {
		cfg.Storage.SecretAccessKey = v
	}
	if v := s.Get(KeyS3ForcePathStyle); v != "" {
		cfg.Storage.ForcePathStyle = s.Bool(KeyS3ForcePathStyle, true)
	}
	if v := s.Get(KeyStorageRootPrefix); v != "" {
		cfg.Storage.RootPrefix = v
	}
	if v := s.Get(KeyStorageCDNBaseURL); v != "" {
		cfg.Storage.CDNBaseURL = strings.TrimRight(v, "/")
	}

	// ---- 播放签名密钥 / kid ----
	if hexKey := s.SignKeyHex(); hexKey != "" {
		key, err := hex.DecodeString(hexKey)
		if err != nil || len(key) != 32 {
			return fmt.Errorf("设置 %s 非法（需 64 位 hex = 32 字节）", KeyURLSignKeyHex)
		}
		cfg.URLSignKey = key
	}
	if v := s.Get(KeyURLSignKeyKid); v != "" {
		cfg.URLSignKeyKid = v
	}

	// ---- TTL（缺省回退 cfg 现值，即 env 兜底值） ----
	cfg.JWTTTLSec = s.Int(KeyJWTTTLSec, cfg.JWTTTLSec)
	cfg.SessionTTLSec = s.Int(KeySessionTTLSec, cfg.SessionTTLSec)
	cfg.ManifestTTLSec = s.Int(KeyManifestTTLSec, cfg.ManifestTTLSec)
	cfg.SubtitleTTLSec = s.Int(KeySubtitleTTLSec, cfg.SubtitleTTLSec)

	// ---- CORS ----
	if v := s.Get(KeyCORSOrigins); v != "" {
		origins := []string{}
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		if len(origins) > 0 {
			cfg.CORSOrigins = origins
		}
	}

	// ---- 播放域名（清单 / 密钥 / 字幕基址的兜底值；运行期仍由 server 60s 缓存读取覆盖） ----
	if v := strings.TrimRight(s.Get(KeyPlaybackBaseURL), "/"); v != "" {
		cfg.PublicBaseURL = v
	}
	return nil
}
