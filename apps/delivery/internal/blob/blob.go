// Package blob 对象存储访问（ADR-0005）：
//   - s3（唯一驱动，2026-09-22 修订移除 local）：清单 GetObject 读出后改写；分片输出**预签名 GET URL 直出**
//     （私有桶，字节不经过分发端，P0）；可经 STORAGE_CDN_BASE_URL 把预签名 origin 替换为加速域名
//     （回源 COS + Host 透传才可验签）。
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
	/** PresignGet 预签名 GET（分片 / 海报直出，TTL 与播放会话对齐） */
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	/** ListPrefixes 列举一级子前缀（产物探测：proceed/{id}/ → 各模板子树） */
	ListPrefixes(ctx context.Context, prefix string) ([]string, error)
}

// New 构造 S3 兼容存储（COS / MinIO 等）
func New(cfg config.StorageConfig) (Store, error) {
	return newS3(cfg)
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
	cdnBase   string // 加速域名（STORAGE_CDN_BASE_URL）：GET 预签名 origin 替换；空 = 原样
	client    *s3.Client
	presigner *s3.PresignClient
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

func (s *s3Store) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(fullKey(s.prefix, key)),
	}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", fmt.Errorf("S3 预签名失败（%s）: %w", key, err)
	}
	return withCdnOrigin(req.URL, s.cdnBase), nil
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
