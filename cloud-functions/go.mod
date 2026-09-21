module openvod/edgeone/delivery

go 1.26

require openvod/apps/delivery v0.0.0

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/aws/aws-sdk-go-v2 v1.43.4 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.16 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.32.35 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.19.34 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.35 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.35 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.35 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.4.36 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.15 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.9.28 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.35 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.19.36 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.106.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.5.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.33.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.38.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.45.4 // indirect
	github.com/aws/smithy-go v1.27.6 // indirect
	github.com/go-chi/chi/v5 v5.2.3 // indirect
	github.com/go-sql-driver/mysql v1.9.3 // indirect
	github.com/jmoiron/sqlx v1.4.0 // indirect
	golang.org/x/crypto v0.55.0 // indirect
)

// 必须指向本目录内部：EdgeOne 的 Go builder 会把 cloud-functions/ 拷到隔离目录后再执行
// go mod tidy + go build，任何指向上级的 replace（如 ../apps/delivery）都会报
// "replacement directory ../apps/delivery does not exist"（2026-09-22 实测）。
// ./openvod/apps/delivery 由 task edgeone:prepare 从 apps/delivery 同步而来（生成物，不入库）。
replace openvod/apps/delivery => ./openvod/apps/delivery
