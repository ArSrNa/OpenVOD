# 分发端镜像（ADR-0003：SCF Web 函数容器目标；监听 :9000，30s 内启动）
# 注意：SCF 仅接受 x86，构建必须 docker buildx build --platform linux/amd64（Taskfile image:delivery 已锁定）
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/delivery .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/delivery /delivery
EXPOSE 9000
ENTRYPOINT ["/delivery"]
