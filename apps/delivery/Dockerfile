# 分发端镜像（ADR-0003：SCF Web 函数容器目标；监听 :9000，30s 内启动）
# 注意：SCF 仅接受 x86，构建必须 docker buildx build --platform linux/amd64（Taskfile image:delivery 已锁定）
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
# 版本信息（GET /v1/meta）：版本号唯一真源是仓库根 package.json，构建上下文只有
# apps/delivery，故由 Taskfile / CNB 流水线以 --build-arg 传入；缺省 dev 表示未注入。
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags="-s -w -X openvod/apps/delivery/internal/version.Version=${VERSION} -X openvod/apps/delivery/internal/version.Commit=${COMMIT} -X openvod/apps/delivery/internal/version.BuildTime=${BUILD_TIME}" \
      -o /out/delivery .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/delivery /delivery
EXPOSE 9000
ENTRYPOINT ["/delivery"]
