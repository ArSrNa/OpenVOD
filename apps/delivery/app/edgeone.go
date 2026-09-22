package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const edgeOneRuntimeEnvFilename = "openvod-runtime-env.json"

// LoadEdgeOneEnvironment 补齐 Makers Go Framework 上传产物未注入的引导变量。
// 文件由发布阶段从 Makers Production 配置生成，仅位于私有函数包，禁止放入 assets。
// 真实进程环境优先；SCF/Compose 入口不调用本适配器。见 ADR-0003 的运行配置修订。
func LoadEdgeOneEnvironment() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法定位 EdgeOne 运行配置")
	}
	return loadEdgeOneEnvironment(filepath.Join(filepath.Dir(executable), edgeOneRuntimeEnvFilename))
}

func loadEdgeOneEnvironment(path string) error {
	keys := []string{"DELIVERY_DATABASE_URL", "MASTER_KEYS"}
	if os.Getenv(keys[0]) == "" || os.Getenv(keys[1]) == "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("EdgeOne 引导变量缺失且私有运行配置不可读，请通过更新后的部署流水线重新发布")
		}
		var values map[string]string
		if json.Unmarshal(raw, &values) != nil || len(values) != len(keys) {
			return fmt.Errorf("EdgeOne 私有运行配置格式非法")
		}
		for _, key := range keys {
			if values[key] == "" {
				return fmt.Errorf("EdgeOne 私有运行配置缺少 %s", key)
			}
		}
		// 全量校验后才设置，报错不包含配置内容。
		for _, key := range keys {
			if os.Getenv(key) == "" {
				if os.Setenv(key, values[key]) != nil {
					return fmt.Errorf("无法设置 EdgeOne 引导变量 %s", key)
				}
			}
		}
	}
	// Makers 转发至固定 9000 端口，不能沿用开发机的 DELIVERY_LISTEN。
	return os.Setenv("DELIVERY_LISTEN", ":9000")
}
