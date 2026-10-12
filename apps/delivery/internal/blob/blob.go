// Package blob 对象存储访问（ADR-0005）：
//   - s3（唯一驱动，2026-09-22 修订移除 local）：清单 GetObject 读出后改写；分片输出**签名 GET URL 直出**
//     （私有桶，字节不经过分发端，P0）；签名方式由 storage_sign_mode 配置（ADR-0019）：
//     s3_presign（默认，可经 STORAGE_CDN_BASE_URL 把预签名 origin 替换为加速域名）/
//     cdn_url_auth（EO Token 鉴权，CDN 私有回源）/ custom（编译期注册，custom_signer.go）。
package blob

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"openvod/apps/delivery/internal/config"
)

type Store interface {
	/** Get 读整个对象（清单改写用；清单远小于 6MB，spec.md 约束） */
	Get(ctx context.Context, key string) ([]byte, error)
	/** PresignGet 签名 GET URL（分片 / 海报直出；ADR-0019：实现随 storage_sign_mode） */
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	/** ListPrefixes 列举一级子前缀（产物探测：proceed/{id}/ → 各模板子树） */
	ListPrefixes(ctx context.Context, prefix string) ([]string, error)
}

// New 构造 S3 兼容存储（COS / MinIO 等）；GET 签名按 cfg.SignMode 装配（ADR-0019）：
// s3_presign（默认）/ cdn_url_auth / custom（须先在 custom_signer.go 注册）。
func New(cfg config.StorageConfig) (Store, error) {
	store, err := newS3(cfg)
	if err != nil {
		return nil, err
	}
	signer, err := NewURLSigner(cfg, store)
	if err != nil {
		return nil, err
	}
	store.signer = signer
	return store, nil
}

// fullKey 拼接 root 前缀（业务键永远不含 root，spec.md §1.1）
func fullKey(rootPrefix, key string) string {
	if rootPrefix == "" {
		return key
	}
	return strings.Trim(rootPrefix, "/") + "/" + strings.TrimLeft(key, "/")
}

// ---- s3（COS / MinIO 等 S3 兼容） ----

type s3Store struct {
	prefix    string
	bucket    string
	cdnBase   string // 加速域名（STORAGE_CDN_BASE_URL）：s3_presign 模式下预签名 origin 替换；空 = 原样
	client    *s3.Client
	presigner *s3.PresignClient
	// signer GET 签名提供者（ADR-0019）：New() 装配后非 nil；直接 newS3（不经 New）时为 nil，
	// 此时 PresignGet 回退 s3_presign 行为（测试便利）
	signer URLSigner
}

func newS3(cfg config.StorageConfig) (*s3Store, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(cfg.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("S3 配置加载失败: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
		o.UsePathStyle = cfg.ForcePathStyle
	})
	return &s3Store{prefix: cfg.RootPrefix, bucket: cfg.Bucket, cdnBase: cfg.CDNBaseURL, client: client, presigner: s3.NewPresignClient(client)}, nil
}

// withCdnOrigin 预签名 URL origin 替换（路径与签名 query 原样保留）；SigV4 签名覆盖 Host，
// 前提是 CDN 回源 COS 时 Host 透传/改写为桶端点（ADR-0005 统一加速域名方案）
func withCdnOrigin(signed, cdnBase string) string {
	if cdnBase == "" {
		return signed
	}
	u, err := url.Parse(signed)
	if err != nil {
		return signed
	}
	return cdnBase + u.Path + "?" + u.RawQuery
}

func (s *s3Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(fullKey(s.prefix, key)),
	})
	if err != nil {
		return nil, fmt.Errorf("S3 GetObject 失败（%s）: %w", key, err)
	}
	defer func() { _ = out.Body.Close() }()
	return io.ReadAll(io.LimitReader(out.Body, 8<<20)) // 6MB 上限之外再留余量，防误读大对象
}

// PresignGet 签名 GET URL：委托按 sign mode 装配的 signer（ADR-0019）；
// signer 未装配（绕过 New 的测试路径）时保持 s3_presign 行为
func (s *s3Store) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	if s.signer != nil {
		return s.signer.Sign(ctx, key, ttl)
	}
	return s.presignGetDirect(ctx, key, ttl)
}

// presignGetDirect s3_presign 后端：SigV4 预签名 GET + 可选加速域名 origin 替换（ADR-0005）
func (s *s3Store) presignGetDirect(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(fullKey(s.prefix, key)),
	}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", fmt.Errorf("S3 预签名失败（%s）: %w", key, err)
	}
	return withCdnOrigin(req.URL, s.cdnBase), nil
}

// Sign 实现 URLSigner：s3Store 自身即 s3_presign 后端（New 装配时传给 NewURLSigner）
func (s *s3Store) Sign(ctx context.Context, key string, ttl time.Duration) (string, error) {
	return s.presignGetDirect(ctx, key, ttl)
}

func (s *s3Store) ListPrefixes(ctx context.Context, prefix string) ([]string, error) {
	out, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:    aws.String(s.bucket),
		Prefix:    aws.String(strings.TrimRight(fullKey(s.prefix, prefix), "/") + "/"),
		Delimiter: aws.String("/"),
	})
	if err != nil {
		return nil, fmt.Errorf("S3 ListObjects 失败（%s）: %w", prefix, err)
	}
	res := make([]string, 0, len(out.CommonPrefixes))
	for _, p := range out.CommonPrefixes {
		name := strings.TrimSuffix(*p.Prefix, "/")
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		res = append(res, name)
	}
	sort.Strings(res)
	return res, nil
}
