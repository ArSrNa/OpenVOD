// 分发端 Data Plane（ADR-0002：Go 1.26 + Chi；ADR-0003：EdgeOne CF / SCF 容器双目标）
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/server"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           server.New(cfg, logger),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("delivery listening", "addr", cfg.Listen, "env", cfg.Env)
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
