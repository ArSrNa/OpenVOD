"use client";

// 媒资列表页（spec.md §11.4）：GET /v1/media（JWT）；卡片网格 → 点击进入播放页
import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Row, Skeleton, Space, Tag, Typography } from "antd";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PosterImage } from "@/components/PosterImage";
import { DeliveryError, listMedia } from "@/lib/delivery";
import { formatDuration } from "@/lib/format";
import { parseCustom, type MediaListItemDTO } from "@/lib/types";

export default function HomePage() {
  const [items, setItems] = useState<MediaListItemDTO[] | null>(null);
  const [error, setError] = useState<DeliveryError | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const page = await listMedia(50);
      setItems(page.items);
    } catch (e) {
      setError(e instanceof DeliveryError ? e : new DeliveryError("internal", String(e), 0));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <ListError error={error} onRetry={load} />;
  }

  if (items === null) {
    return (
      <Row gutter={[16, 16]}>
        {[0, 1, 2, 3].map((i) => (
          <Col key={i} xs={24} sm={12} md={8} lg={6}>
            <Card>
              <Skeleton active paragraph={{ rows: 2 }} />
            </Card>
          </Col>
        ))}
      </Row>
    );
  }

  if (items.length === 0) {
    return (
      <Empty
        description={
          <span>
            暂无 READY 媒资——请先在管理端上传视频并发起转码（转码完成后媒资状态变为 READY，列表即出现）
          </span>
        }
        style={{ marginTop: 80 }}
      />
    );
  }

  return (
    <>
      <Space style={{ marginBottom: 16 }} align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          媒资列表
        </Typography.Title>
        <Typography.Text type="secondary">共 {items.length} 条（GET /v1/media，仅 READY）</Typography.Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </Space>
      <Row gutter={[16, 16]}>
        {items.map((item) => (
          <MediaCard key={item.id} item={item} />
        ))}
      </Row>
    </>
  );
}

function ListError({ error, onRetry }: { error: DeliveryError; onRetry: () => void }) {
  // 501：预览账号未配置（服务端给出配置说明）；0：网络 / CORS；其余原样展示分发端消息
  const isConfig = error.status === 501;
  const extra = isConfig
    ? "配置后重启 player（bun scripts/dev.ts player），账号用 `bun apps/admin/scripts/bootstrap-playback.ts <用户名> <口令>` 创建"
    : error.status === 0
      ? "请确认分发端已启动（bun scripts/dev.ts delivery）、浏览器可直连分发端（DELIVERY_CORS_ORIGINS 放行 player 源站）"
      : undefined;
  return (
    <Alert
      type={isConfig ? "warning" : "error"}
      showIcon
      style={{ marginTop: 24 }}
      message={isConfig ? "播放演示 App 未配置预览播放账号" : `加载媒资列表失败（${error.code}）`}
      description={
        <Space direction="vertical" size={4}>
          <span>{error.message}</span>
          {extra ? <span style={{ color: "rgba(0,0,0,0.45)" }}>{extra}</span> : null}
        </Space>
      }
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  );
}

function MediaCard({ item }: { item: MediaListItemDTO }) {
  const custom = parseCustom(item.custom);
  const tags = custom.tags ?? [];
  return (
    <Col xs={24} sm={12} md={8} lg={6}>
      <Link href={`/play/${item.id}`} style={{ textDecoration: "none", display: "block", height: "100%" }}>
        <Card
          hoverable
          styles={{ body: { padding: 12 } }}
          cover={<PosterImage src={item.poster_url} alt={item.title} />}
        >
          <Typography.Text strong ellipsis style={{ display: "block", fontSize: 15 }}>
            {item.title || item.id}
          </Typography.Text>
          <Space size={4} wrap style={{ marginTop: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDuration(item.duration_ms)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ID {item.id}
            </Typography.Text>
          </Space>
          {custom.category ? (
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">{custom.category.path}</Tag>
            </div>
          ) : null}
          {custom.description ? (
            <Typography.Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}
            >
              {custom.description}
            </Typography.Paragraph>
          ) : null}
          {tags.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Space size={4} wrap>
                {tags.slice(0, 3).map((t) => (
                  <Tag key={t} style={{ marginInlineEnd: 0 }}>
                    {t}
                  </Tag>
                ))}
                {tags.length > 3 ? <Typography.Text type="secondary">+{tags.length - 3}</Typography.Text> : null}
              </Space>
            </div>
          ) : null}
        </Card>
      </Link>
    </Col>
  );
}
