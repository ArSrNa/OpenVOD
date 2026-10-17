package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

const edgeOneRuntimeEnvFilename = "openvod-runtime-env.json"

// RunEdgeOne 保持业务装配共用，额外适配 Makers 的环境与响应协议。
func RunEdgeOne() error {
	if err := LoadEdgeOneEnvironment(); err != nil {
		return err
	}
	return run(edgeOneResponseHeaders)
}

// 响应头协议来自固定 Makers CLI 1.6.41 的 Go/Node 适配器。
// 必须在 WriteHeader/Write 提交响应之前设置，否则正常的业务 401/403 也可能
// 被平台改写成 CLOUD_FUNCTION_INVOCATION_FAILED。该适配只用于 EdgeOne 入口。
func edgeOneResponseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Functions-Request-Id", r.Header.Get("x-scf-request-id"))
		rw := &edgeOneResponseWriter{ResponseWriter: w}
		next.ServeHTTP(rw, r)
		if !rw.wroteHeader {
			rw.WriteHeader(http.StatusOK)
		}
	})
}

type edgeOneResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *edgeOneResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *edgeOneResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.wroteHeader = true
	w.Header().Set("eo-pages-inner-scf-status", strconv.Itoa(status))
	// 受控业务错误也保留 JSON 正文，平台不得替换为 HTML 错误页。
	w.Header().Set("eo-pages-inner-status-intercept", "false")
	w.ResponseWriter.WriteHeader(status)
}

func (w *edgeOneResponseWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

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
	keys := []string{"DATABASE_URL", "MASTER_KEYS"}
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
