// 分发端 Data Plane（ADR-0002：Go 1.26 + Chi；ADR-0003：EdgeOne CF / SCF 容器双目标）
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"openvod/apps/delivery/internal/auth"
	"openvod/apps/delivery/internal/blob"
	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/mk"
	"openvod/apps/delivery/internal/server"
	"openvod/apps/delivery/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	db, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		logger.Error("数据库不可用", "err", err)
		os.Exit(1)
	}
	defer func() { _ = db.Close() }()

	bl, err := blob.New(cfg.Storage)
	if err != nil {
		logger.Error("存储不可用", "err", err)
		os.Exit(1)
	}

	signers := loadJWTSigners(cfg, db, logger)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           server.New(server.Options{Cfg: cfg, DB: db, Blob: bl, Logger: logger, JWTKeys: signers}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("delivery listening",
			"addr", cfg.Listen, "env", cfg.Env,
			"storage", bl.Driver(), "public_base_url", cfg.PublicBaseURL,
			"jwt_keys", len(signers), "mk_versions", len(cfg.MasterKeys))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	logger.Info("delivery stopped")
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
