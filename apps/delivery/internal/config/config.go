// Package config 环境变量配置（12-factor，ADR-0002）
package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Env         string
	Listen      string
	DatabaseURL string
	URLSignKey  []byte
	MasterKeys  map[int][]byte // ver -> 32B（key 接口解封 CEK 用，ADR-0006）
}

// Load 读取环境变量；部署形态见 ADR-0003（EdgeOne CF 环境注入 / SCF 容器 env）。
func Load() (*Config, error) {
	cfg := &Config{
		Env:         getEnv("APP_ENV", "dev"),
		Listen:      getEnv("DELIVERY_LISTEN", ":9000"), // SCF Web 函数固定监听 9000
		DatabaseURL: os.Getenv("DELIVERY_DATABASE_URL"),
		URLSignKey:  nil,
		MasterKeys:  map[int][]byte{},
	}

	if key, err := hexKey("URL_SIGN_KEY_HEX"); err != nil {
		return nil, err
	} else {
		cfg.URLSignKey = key
	}

	mkEnv := os.Getenv("MASTER_KEYS")
	for _, part := range strings.Split(mkEnv, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		seg := strings.SplitN(part, ":", 2)
		if len(seg) != 2 {
			return nil, fmt.Errorf("MASTER_KEYS 片段非法: %q", part)
		}
		var ver int
		if _, err := fmt.Sscanf(seg[0], "%d", &ver); err != nil {
			return nil, fmt.Errorf("MASTER_KEYS 版本非法: %q", part)
		}
		key, err := hex.DecodeString(seg[1])
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("MASTER_KEYS 密钥非法（需 64 位 hex）: %q", part)
		}
		cfg.MasterKeys[ver] = key
	}
	if len(cfg.MasterKeys) == 0 {
		return nil, fmt.Errorf("MASTER_KEYS 未配置")
	}
	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func hexKey(env string) ([]byte, error) {
	v := os.Getenv(env)
	if v == "" {
		return nil, fmt.Errorf("%s 未配置", env)
	}
	b, err := hex.DecodeString(v)
	if err != nil {
		return nil, fmt.Errorf("%s 非法 hex: %w", env, err)
	}
	return b, nil
}
