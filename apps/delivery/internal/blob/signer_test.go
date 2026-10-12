// URLSigner 提供者测试（ADR-0019）：fixtures 驱动（packages/crypto/fixtures/url-sign-v1.json），
// 与 packages/storage/test/signer.test.ts 共享同一向量——TS / Go 双语言互通防漂移。
// fixtures 缺失时 skip（与 Go token 测试同一前置）。
package blob

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"openvod/apps/delivery/internal/config"
)

const fixturePath = "../../../../packages/crypto/fixtures/url-sign-v1.json"

type urlSignFixture struct {
	FixedRand       string `json:"fixed_rand"`
	FixedUID        string `json:"fixed_uid"`
	Vectors         []struct {
		Name      string `json:"name"`
		Path      string `json:"path"`
		Timestamp int64  `json:"timestamp"`
		Rand      string `json:"rand"`
		UID       string `json:"uid"`
		Key       string `json:"key"`
		MD5Hash   string `json:"md5hash"`
		Sign      string `json:"sign"`
		URL       string `json:"url"`
	} `json:"vectors"`
	WindowAlignment struct {
		Formula string `json:"formula"`
		Vectors []struct {
			Name      string `json:"name"`
			Now       int64  `json:"now"`
			TTL       int64  `json:"ttl"`
			Timestamp int64  `json:"timestamp"`
		} `json:"vectors"`
	} `json:"window_alignment"`
}

func loadFixture(t *testing.T) *urlSignFixture {
	t.Helper()
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			t.Skipf("fixtures 不存在（%s）：先在仓库根生成或确认提交物（ADR-0019）", fixturePath)
		}
		t.Fatalf("读取 fixtures 失败: %v", err)
	}
	var f urlSignFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("fixtures 解析失败: %v", err)
	}
	return &f
}

func TestTypeAHashAgainstFixtures(t *testing.T) {
	f := loadFixture(t)
	if f.FixedRand != TypeAFixedRand || f.FixedUID != TypeAFixedUID {
		t.Fatalf("TS/Go 固定 rand/uid 约定漂移：fixtures(%s/%s) vs Go(%s/%s)",
			f.FixedRand, f.FixedUID, TypeAFixedRand, TypeAFixedUID)
	}
	for _, v := range f.Vectors {
		if got := TypeAHash(v.Path, v.Timestamp, v.Rand, v.UID, v.Key); got != v.MD5Hash {
			t.Errorf("向量 %s：md5 = %s, 期望 %s", v.Name, got, v.MD5Hash)
		}
		if v.Rand == TypeAFixedRand {
			// 本仓固定 rand/uid 向量：进一步断言完整 URL 形态（EO 官方向量的 rand 是随机串，URL 由文档示例给出）
			signer := &edgeOneTypeASigner{
				base: "https://cdn.example.com", key: v.Key, windowTtl: 3600, authParam: TypeAAuthParam,
				// 注入窗口内任一时刻（timestamp-1），对齐结果即 fixtures 的 timestamp
				nowSecFn: func() int64 { return v.Timestamp - 1 },
			}
			got, err := signer.Sign(context.Background(), strings.TrimLeft(v.Path, "/"), time.Hour)
			if err != nil {
				t.Fatalf("向量 %s：Sign 失败: %v", v.Name, err)
			}
			if want := "https://cdn.example.com" + v.Path + "?sign=" + v.Sign; got != want {
				t.Errorf("向量 %s：URL = %s, 期望 %s", v.Name, got, want)
			}
		}
	}
}

func TestTypeAWindowTimestamp(t *testing.T) {
	f := loadFixture(t)
	for _, v := range f.WindowAlignment.Vectors {
		got := TypeAWindowTimestamp(v.Now, v.TTL)
		if got != v.Timestamp {
			t.Errorf("窗口向量 %s：timestamp = %d, 期望 %d", v.Name, got, v.Timestamp)
		}
		if got <= v.Now || got > v.Now+v.TTL {
			t.Errorf("窗口向量 %s：timestamp %d 越界 (now=%d, ttl=%d)", v.Name, got, v.Now, v.TTL)
		}
	}
	// 同窗口稳定、跨窗口变化
	a := TypeAWindowTimestamp(1721030400, 3600)
	b := TypeAWindowTimestamp(1721030400+3599, 3600)
	c := TypeAWindowTimestamp(1721030400+3600, 3600)
	if a != b || a == c {
		t.Errorf("窗口稳定性破坏：%d %d %d", a, b, c)
	}
}

func TestNewURLSignerModeValidation(t *testing.T) {
	ctx := context.Background()
	// s3_presign 委托后端（ttl 透传）
	delegated := &fakeSigner{}
	signer, err := NewURLSigner(config.StorageConfig{SignMode: "s3_presign"}, delegated)
	if err != nil {
		t.Fatalf("s3_presign 装配失败: %v", err)
	}
	url, err := signer.Sign(ctx, "a/b.ts", 7*time.Minute)
	if err != nil || url != "fake://a/b.ts?ttl=7m0s" {
		t.Fatalf("s3_presign 委托异常: url=%q err=%v", url, err)
	}
	// 空 mode 默认 s3_presign
	if _, err := NewURLSigner(config.StorageConfig{}, delegated); err != nil {
		t.Fatalf("空 mode 应默认 s3_presign: %v", err)
	}
	// cdn_url_auth 缺配置报错（含设置键指引）
	for _, cfg := range []config.StorageConfig{
		{SignMode: "cdn_url_auth"},
		{SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com"},
		{SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com", CDNAuthKey: "k", CDNAuthTTLSec: 10},
	} {
		if _, err := NewURLSigner(cfg, delegated); err == nil {
			t.Errorf("cdn_url_auth 非法配置应报错: %+v", cfg)
		}
	}
	// cdn_url_auth 合法配置 → TypeA URL（窗口取配置值）
	signer, err = NewURLSigner(config.StorageConfig{
		SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com",
		CDNAuthKey: "0123456789abcdef0123456789abcdef", CDNAuthTTLSec: 3600,
	}, delegated)
	if err != nil {
		t.Fatalf("cdn_url_auth 装配失败: %v", err)
	}
	url, err = signer.Sign(ctx, "proceed/med00001/tpl00001/seg-000.ts", 10*time.Minute)
	if err != nil {
		t.Fatalf("cdn_url_auth 签名失败: %v", err)
	}
	ts := TypeAWindowTimestamp(time.Now().Unix(), 3600)
	if !strings.HasPrefix(url, "https://cdn.example.com/proceed/med00001/tpl00001/seg-000.ts?sign=") ||
		!strings.Contains(url, "-openvod-0-") {
		t.Fatalf("cdn_url_auth URL 形态异常: %s", url)
	}
	if !strings.Contains(url, "?sign="+strconv.FormatInt(ts, 10)+"-") {
		t.Errorf("URL timestamp 未按 3600 窗口对齐: %s (期望含 %d)", url, ts)
	}
	// 未知 mode 报错；custom 未注册报错（含注册文件指引）
	if _, err := NewURLSigner(config.StorageConfig{SignMode: "bogus"}, delegated); err == nil {
		t.Error("未知 sign mode 应报错")
	}
	if _, err := NewURLSigner(config.StorageConfig{SignMode: "custom", CustomSigner: "missing"}, delegated); err == nil ||
		!strings.Contains(err.Error(), "custom_signer.go") {
		t.Errorf("custom 未注册应报错且指明注册文件: %v", err)
	}
}

func TestCustomSignerRegistry(t *testing.T) {
	RegisterURLSigner("test-prov-go", func(cfg config.StorageConfig) (URLSigner, error) {
		return &fakeSigner{prefix: "prov:" + cfg.CustomSigner}, nil
	})
	signer, err := NewURLSigner(config.StorageConfig{SignMode: "custom", CustomSigner: "test-prov-go"}, &fakeSigner{})
	if err != nil {
		t.Fatalf("custom 装配失败: %v", err)
	}
	url, err := signer.Sign(context.Background(), "x/y.ts", time.Minute)
	if err != nil || url != "prov:test-prov-gofake://x/y.ts?ttl=1m0s" {
		t.Fatalf("custom 路由异常: url=%q err=%v", url, err)
	}
	// 重复注册 panic（装配期错误越早暴露越好）
	defer func() {
		if recover() == nil {
			t.Error("重复注册应 panic")
		}
	}()
	RegisterURLSigner("test-prov-go", func(config.StorageConfig) (URLSigner, error) { return nil, nil })
}

// fakeSigner 测试桩：记录 ttl 并回显 key（区分实例用 prefix）
type fakeSigner struct{ prefix string }

func (f *fakeSigner) Sign(_ context.Context, key string, ttl time.Duration) (string, error) {
	return f.prefix + "fake://" + key + "?ttl=" + ttl.String(), nil
}
