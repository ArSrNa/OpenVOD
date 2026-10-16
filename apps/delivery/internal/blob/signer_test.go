// URLSigner 提供者测试（ADR-0019）：fixtures 驱动（packages/crypto/fixtures/），
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
const methodsFixturePath = "../../../../packages/crypto/fixtures/url-sign-eo-methods-v1.json"

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

// methodsFixture EO Token 鉴权方式 B/C/D/V 向量（url-sign-eo-methods-v1.json）：
// timestampSec 为组装函数时间戳入参（B/C/D 签发时刻、V 过期时刻），base 为 URL host。
type methodsFixture struct {
	Methods map[string]struct {
		Spec    string `json:"spec"`
		Vectors []struct {
			Name         string `json:"name"`
			Base         string `json:"base"`
			Path         string `json:"path"`
			TimestampSec int64  `json:"timestampSec"`
			Timestamp    string `json:"timestamp"`
			Key          string `json:"key"`
			MD5Hash      string `json:"md5hash"`
			T            string `json:"t"`
			Exper        string `json:"exper"`
			Us           string `json:"us"`
			Sign         string `json:"sign"`
			URL          string `json:"url"`
		} `json:"vectors"`
	} `json:"methods"`
}

func loadMethodsFixture(t *testing.T) *methodsFixture {
	t.Helper()
	data, err := os.ReadFile(methodsFixturePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			t.Skipf("fixtures 不存在（%s）：先在仓库根生成或确认提交物（ADR-0019）", methodsFixturePath)
		}
		t.Fatalf("读取 fixtures 失败: %v", err)
	}
	var f methodsFixture
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
			signer := &edgeOneSigner{
				authType: "a", base: "https://cdn.example.com", key: v.Key, windowTtl: 3600,
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

// 方式 B/C/D/V 的算法哈希：官方示例 + 本仓向量（与 TS 侧同一份 fixtures）
func TestEdgeOneMethodHashesAgainstFixtures(t *testing.T) {
	f := loadMethodsFixture(t)
	for _, v := range f.Methods["b"].Vectors {
		if got := TypeBHash(v.Path, v.Timestamp, v.Key); got != v.MD5Hash {
			t.Errorf("方式 B 向量 %s：md5 = %s, 期望 %s", v.Name, got, v.MD5Hash)
		}
	}
	for _, v := range f.Methods["c"].Vectors {
		if got := TypeCHash(v.Path, v.Timestamp, v.Key); got != v.MD5Hash {
			t.Errorf("方式 C 向量 %s：md5 = %s, 期望 %s", v.Name, got, v.MD5Hash)
		}
	}
	for _, v := range f.Methods["d"].Vectors {
		if got := TypeDHash(v.Path, v.Timestamp, v.Key); got != v.MD5Hash {
			t.Errorf("方式 D 向量 %s：md5 = %s, 期望 %s", v.Name, got, v.MD5Hash)
		}
	}
	for _, v := range f.Methods["v"].Vectors {
		if got := TypeVHash(v.Path, v.Key, TypeVParams{T: v.T, Exper: v.Exper, Us: v.Us}); got != v.Sign {
			t.Errorf("方式 V 向量 %s：sign = %s, 期望 %s", v.Name, got, v.Sign)
		}
	}
}

// 方式 B/C/D/V 的 URL 组装：与 fixtures 的 url 字段逐字一致
func TestEdgeOneMethodURLsAgainstFixtures(t *testing.T) {
	f := loadMethodsFixture(t)
	defaultParams := func(tsSec int64) edgeOneURLParams {
		return edgeOneURLParams{tsSec: tsSec, authParam: TypeAAuthParam, tokenParam: TypeDTokenParam, timeParam: TypeDTimeParam}
	}
	for _, method := range []string{"b", "c", "d"} {
		for _, v := range f.Methods[method].Vectors {
			if got := buildEdgeOneURL(method, v.Base, v.Path, v.Key, defaultParams(v.TimestampSec)); got != v.URL {
				t.Errorf("方式 %s 向量 %s：URL = %s, 期望 %s", method, v.Name, got, v.URL)
			}
		}
	}
	for _, v := range f.Methods["v"].Vectors {
		// 官方示例带 us / exper 可选参数；本仓组装不生成它们（非 VOD 源站不支持 us / plive）——
		// 这些向量的 hash 已在上方断言，URL 组装用无选填参数的向量对照
		if v.Us != "" || v.Exper != "" {
			continue
		}
		if got := buildEdgeOneURL("v", v.Base, v.Path, v.Key, defaultParams(v.TimestampSec)); got != v.URL {
			t.Errorf("方式 V 向量 %s：URL = %s, 期望 %s", v.Name, got, v.URL)
		}
	}
}

// 窗口稳定性（五种方式一致）：同窗口 URL 不变、跨窗口变化
func TestEdgeOneSignerWindowStability(t *testing.T) {
	key := "0123456789abcdef0123456789abcdef"
	windowStart := int64(1721026800)
	for _, method := range []string{"a", "b", "c", "d", "v"} {
		sign := func(nowSec int64) string {
			s := &edgeOneSigner{authType: method, base: "https://cdn.example.com", key: key, windowTtl: 3600,
				nowSecFn: func() int64 { return nowSec }}
			url, err := s.Sign(context.Background(), "proceed/med00001/tpl00001/seg-000.ts", time.Minute)
			if err != nil {
				t.Fatalf("方式 %s Sign 失败: %v", method, err)
			}
			return url
		}
		a := sign(windowStart)
		b := sign(windowStart + 3599)
		c := sign(windowStart + 3600)
		if a != b {
			t.Errorf("方式 %s：同窗口 URL 不稳定\n  %s\n  %s", method, a, b)
		}
		if a == c {
			t.Errorf("方式 %s：跨窗口 URL 未变化", method)
		}
	}
	// V 的 t 是「过期时刻」：签发于窗口内任意时刻，URL 剩余有效期都 ≥ 窗口（另加 EO 300s 容差）
	s := &edgeOneSigner{authType: "v", base: "https://cdn.example.com", key: key,
		windowTtl: 3600, nowSecFn: func() int64 { return windowStart }}
	url, _ := s.Sign(context.Background(), "a.ts", time.Minute)
	if !strings.Contains(url, "?t=") || !strings.Contains(url, "&sign=") {
		t.Fatalf("方式 V URL 形态异常: %s", url)
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
	// cdn_url_auth 合法配置（默认方式 A）→ TypeA URL（窗口取配置值）
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
	// 方式 B/C/D/V：装配后 URL 形态（时间窗/算法正确性由 fixtures 测试覆盖）
	baseCfg := config.StorageConfig{
		SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com",
		CDNAuthKey: "0123456789abcdef0123456789abcdef", CDNAuthTTLSec: 3600,
	}
	for _, method := range []string{"b", "c", "d", "v"} {
		cfg := baseCfg
		cfg.CDNAuthType = method
		s, err := NewURLSigner(cfg, delegated)
		if err != nil {
			t.Fatalf("方式 %s 装配失败: %v", method, err)
		}
		u, err := s.Sign(ctx, "proceed/med00001/tpl00001/seg-000.ts", time.Minute)
		if err != nil {
			t.Fatalf("方式 %s 签名失败: %v", method, err)
		}
		if !strings.Contains(u, "proceed/med00001/tpl00001/seg-000.ts") {
			t.Errorf("方式 %s：URL 缺资源路径片段: %s", method, u)
		}
		switch method {
		case "b", "c":
			if !strings.HasPrefix(u, "https://cdn.example.com/") || strings.Contains(u, "?") {
				t.Errorf("方式 %s 形态异常（应为 path 前缀式且无 query）: %s", method, u)
			}
		case "d":
			if !strings.Contains(u, "?token=") || !strings.Contains(u, "&t=") {
				t.Errorf("方式 D 形态异常: %s", u)
			}
		case "v":
			if !strings.Contains(u, "?t=") || !strings.Contains(u, "&sign=") {
				t.Errorf("方式 V 形态异常: %s", u)
			}
		}
	}
	// 非法 auth type：装配即报错（含设置键指引）
	if _, err := NewURLSigner(config.StorageConfig{
		SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com",
		CDNAuthKey: "k", CDNAuthTTLSec: 3600, CDNAuthType: "x",
	}, delegated); err == nil || !strings.Contains(err.Error(), "storage_cdn_auth_type") {
		t.Errorf("非法 storage_cdn_auth_type 应报错: %v", err)
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

// 方式 A 的鉴权参数名可配置（storage_cdn_auth_param，默认 sign）：URL 与 CDN 控制台「鉴权加密串参数名称」一致
func TestEdgeOneAuthParamConfigurable(t *testing.T) {
	ctx := context.Background()
	base := config.StorageConfig{
		SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com",
		CDNAuthKey: "0123456789abcdef0123456789abcdef", CDNAuthTTLSec: 3600,
	}
	// 默认 sign
	signer, err := NewURLSigner(base, &fakeSigner{})
	if err != nil {
		t.Fatalf("默认装配失败: %v", err)
	}
	url, _ := signer.Sign(ctx, "a/b.ts", time.Minute)
	if !strings.Contains(url, "?sign=") {
		t.Errorf("默认参数名应为 sign: %s", url)
	}
	// 自定义参数名（控制台「鉴权加密串参数名称」）
	cfg := base
	cfg.CDNAuthParam = "token"
	signer, err = NewURLSigner(cfg, &fakeSigner{})
	if err != nil {
		t.Fatalf("自定义参数名装配失败: %v", err)
	}
	url, _ = signer.Sign(ctx, "a/b.ts", time.Minute)
	if !strings.HasPrefix(url, "https://cdn.example.com/a/b.ts?token=") || strings.Contains(url, "?sign=") {
		t.Errorf("自定义参数名未生效: %s", url)
	}
	// 非法参数名：装配即报错（含设置键指引）
	cfg.CDNAuthParam = "bad name"
	if _, err := NewURLSigner(cfg, &fakeSigner{}); err == nil || !strings.Contains(err.Error(), "storage_cdn_auth_param") {
		t.Errorf("非法参数名应报错: %v", err)
	}
}

// 方式 D 的参数名可配置（storage_cdn_auth_token_param / storage_cdn_auth_time_param，默认 token / t）
func TestEdgeOneMethodDParamConfigurable(t *testing.T) {
	ctx := context.Background()
	base := config.StorageConfig{
		SignMode: "cdn_url_auth", CDNBaseURL: "https://cdn.example.com",
		CDNAuthKey: "0123456789abcdef0123456789abcdef", CDNAuthTTLSec: 3600, CDNAuthType: "d",
	}
	// 默认 token / t
	signer, err := NewURLSigner(base, &fakeSigner{})
	if err != nil {
		t.Fatalf("默认装配失败: %v", err)
	}
	url, _ := signer.Sign(ctx, "a/b.ts", time.Minute)
	if !strings.Contains(url, "?token=") || !strings.Contains(url, "&t=") {
		t.Errorf("默认参数名应为 token / t: %s", url)
	}
	// 自定义参数名
	cfg := base
	cfg.CDNAuthTokenParam = "sign"
	cfg.CDNAuthTimeParam = "ts"
	signer, err = NewURLSigner(cfg, &fakeSigner{})
	if err != nil {
		t.Fatalf("自定义参数名装配失败: %v", err)
	}
	url, _ = signer.Sign(ctx, "a/b.ts", time.Minute)
	if !strings.Contains(url, "?sign=") || !strings.Contains(url, "&ts=") {
		t.Errorf("自定义参数名未生效: %s", url)
	}
	// 两个参数名相同：装配即报错（URL 会出现重复参数）
	cfg.CDNAuthTimeParam = "sign"
	if _, err := NewURLSigner(cfg, &fakeSigner{}); err == nil || !strings.Contains(err.Error(), "不能相同") {
		t.Errorf("参数名相同应报错: %v", err)
	}
	// 非法形状
	cfg.CDNAuthTokenParam = "bad name"
	cfg.CDNAuthTimeParam = "t"
	if _, err := NewURLSigner(cfg, &fakeSigner{}); err == nil || !strings.Contains(err.Error(), "storage_cdn_auth_token_param") {
		t.Errorf("非法参数名应报错: %v", err)
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
