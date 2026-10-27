// Package app 分发端装配与启动（ADR-0003：同一份 Go 代码服务两个部署目标）。
//
// 两个目标共用 run() 装配，避免漂移：
//   - SCF 容器：apps/delivery/main.go（Dockerfile 静态二进制，监听 :9000）；
//   - EdgeOne Cloud Functions：cloud-functions/index.go → RunEdgeOne（适配配置与响应头，监听 :9000）。
package app

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"reflect"
	"syscall"
	"time"

	"openvod/apps/delivery/internal/auth"
	"openvod/apps/delivery/internal/blob"
	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/mk"
	"openvod/apps/delivery/internal/server"
	"openvod/apps/delivery/internal/store"
)

// shutdownTimeout 优雅关闭窗口（平台回收实例时给在途请求留的排空时间）
const shutdownTimeout = 10 * time.Second

/**
 * Run 读取环境变量、装配依赖并启动 HTTP 服务，阻塞至收到 SIGINT / SIGTERM 后优雅关闭。
 * 返回非 nil 表示启动失败或服务异常退出，由调用方决定退出码（两个部署目标都是非零退出）。
 */
func Run() error {
	return run(nil)
}

func run(wrap func(http.Handler) http.Handler) error {
	base, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	db, err := store.Open(base.DatabaseDriver, base.DatabaseURL)
	if err != nil {
		return fmt.Errorf("数据库不可用: %w", err)
	}
	defer func() { _ = db.Close() }()
	// 只报驱动，不打印连接串（MySQL DSN 含口令）
	attrs := []any{"driver", base.DatabaseDriver}
	if base.DatabasePath != "" {
		attrs = append(attrs, "sqlite_path", base.DatabasePath)
	}
	logger.Info("数据库已连接", attrs...)

	// ADR-0015：启动只依赖数据库连接串 + MASTER_KEYS；存储凭据 / 播放签名密钥 /
	// TTL / CORS 从 system_settings 加载（首次启动向导写入，MK 封装的密钥在此解封），env 兜底。
	cfg, err := settingsConfig(context.Background(), db, base)
	if err != nil {
		return err
	}

	bl, err := blob.New(cfg.Storage)
	if err != nil {
		return fmt.Errorf("存储不可用: %w", err)
	}

	signers := loadJWTSigners(cfg, db, logger)
	currentCfg := cfg
	currentHandler := server.New(server.Options{Cfg: cfg, DB: db, Blob: bl, Logger: logger, JWTKeys: signers})
	handler := newSettingsHandler(currentHandler, func(ctx context.Context) (http.Handler, error) {
		next, err := settingsConfig(ctx, db, base)
		if err != nil {
			return nil, err
		}
		if reflect.DeepEqual(next, currentCfg) {
			return currentHandler, nil
		}
		nextBlob, err := blob.New(next.Storage)
		if err != nil {
			return nil, err
		}
		candidate := server.New(server.Options{Cfg: next, DB: db, Blob: nextBlob, Logger: logger, JWTKeys: signers})
		currentCfg, currentHandler = next, candidate
		return candidate, nil
	}, logger)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if wrap != nil {
		srv.Handler = wrap(srv.Handler)
	}

	// 监听失败不能只留在 goroutine 里（否则进程会静默挂着），经 channel 回传后由 Run 返回
	listenErr := make(chan error, 1)
	go func() {
		logger.Info("delivery listening",
			"addr", cfg.Listen, "env", cfg.Env,
			"storage", "s3", "public_base_url", cfg.PublicBaseURL,
			"jwt_keys", len(signers), "mk_versions", len(cfg.MasterKeys))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-listenErr:
		return fmt.Errorf("listen: %w", err)
	case <-stop:
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	logger.Info("delivery stopped")
	return nil
}

/**
 * loadJWTSigners 从 signing_keys 加载 JWT 私钥（private_enc = hex(MK(PKCS#8 DER))，ADR-0007）。
 * signing_keys 没有 mk_ver 列，按 MK 版本逐个尝试解封；没有可用私钥不致命——
 * login 会返回 503，便于先起服务再补密钥（scripts/bootstrap-playback.ts）。
 */
func loadJWTSigners(cfg *config.Config, db *store.Store, logger *slog.Logger) []*auth.Signer {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rows, err := db.JWTSigningKeys(ctx, time.Now())
	if err != nil {
		logger.Error("查询 signing_keys 失败", "err", err)
		return nil
	}
	signers := make([]*auth.Signer, 0, len(rows))
	for _, row := range rows {
		wrapped, err := hex.DecodeString(row.PrivateEnc)
		if err != nil {
			logger.Warn("JWT 私钥 hex 非法，跳过", "kid", row.Kid)
			continue
		}
		plain, ver, err := mk.UnwrapAny(cfg.MasterKeys, wrapped)
		if err != nil {
			logger.Warn("JWT 私钥解封失败，跳过", "kid", row.Kid, "err", err)
			continue
		}
		key, err := auth.ParsePrivateKey(plain)
		if err != nil {
			logger.Warn("JWT 私钥解析失败，跳过", "kid", row.Kid, "err", err)
			continue
		}
		logger.Info("已加载 JWT 签名密钥", "kid", row.Kid, "mk_ver", ver)
		signers = append(signers, &auth.Signer{Kid: row.Kid, Issuer: cfg.JWTIssuer, Key: key})
	}
	if len(signers) == 0 {
		logger.Warn("signing_keys 无可用 JWT 私钥：login 将返回 503（运行 apps/admin/scripts/bootstrap-playback.ts 生成）")
	}
	return signers
}
