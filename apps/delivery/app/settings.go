package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/settings"
)

const settingsRefreshInterval = time.Minute
const settingsRefreshTimeout = 2 * time.Second

// settingsConfig 始终从启动环境构造新快照。删除数据库覆盖后会回退 env，不能继承旧 DB 值。
func settingsConfig(ctx context.Context, source settings.Source, base *config.Config) (*config.Config, error) {
	snap, err := settings.Load(ctx, source, base.MasterKeys)
	if err != nil {
		return nil, fmt.Errorf("系统设置加载失败: %w", err)
	}
	cfg := *base
	if err := snap.ApplyTo(&cfg); err != nil {
		return nil, fmt.Errorf("系统设置非法: %w", err)
	}
	if cfg.Storage.Bucket == "" || cfg.Storage.AccessKeyID == "" || cfg.Storage.SecretAccessKey == "" {
		return nil, fmt.Errorf("对象存储未配置：请先完成管理台首次启动向导（/setup）或配置 S3_* 环境变量")
	}
	if len(cfg.URLSignKey) != 32 {
		return nil, fmt.Errorf("播放签名密钥未配置：请先完成管理台首次启动向导（/setup）或设置 URL_SIGN_KEY_HEX")
	}
	// 与管理端白名单约束对齐；该 TTL 也用于 S3 SigV4 预签名（最多 7 天）。
	if cfg.ManifestTTLSec > 7*24*3600 || cfg.ManifestTTLSec > cfg.SessionTTLSec {
		return nil, fmt.Errorf("清单有效期不能超过 7 天或播放会话有效期")
	}
	return &cfg, nil
}

// settingsHandler 将配置、CORS、签名器与存储客户端作为一个完整版本切换。
// 到期请求负责刷新；其他并发请求继续使用旧版本。失败保留完整旧版本并节流重试，
// 不向日志输出原始错误（驱动错误可能包含连接凭据或密钥材料）。
type settingsHandler struct {
	mu        sync.Mutex
	current   http.Handler
	nextCheck time.Time
	loading   bool
	load      func(context.Context) (http.Handler, error)
	now       func() time.Time
	logger    *slog.Logger
}

func newSettingsHandler(initial http.Handler, load func(context.Context) (http.Handler, error), logger *slog.Logger) *settingsHandler {
	return &settingsHandler{
		current: initial, load: load, now: time.Now, logger: logger,
		nextCheck: time.Now().Add(settingsRefreshInterval),
	}
}

func (h *settingsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	current := h.current
	refresh := !h.loading && !h.now().Before(h.nextCheck)
	if refresh {
		h.loading = true
		h.nextCheck = h.now().Add(settingsRefreshInterval)
	}
	h.mu.Unlock()
	if refresh {
		ctx, cancel := context.WithTimeout(r.Context(), settingsRefreshTimeout)
		candidate, err := h.load(ctx)
		cancel()
		h.mu.Lock()
		h.loading = false
		if err == nil && candidate != nil {
			h.current = candidate
			current = candidate
		}
		h.mu.Unlock()
		if err != nil || candidate == nil {
			h.logger.Warn("系统设置刷新失败，继续使用最近一次有效配置")
		}
	}
	current.ServeHTTP(w, r)
}
