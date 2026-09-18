"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { Alert, Button, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface MediaListItem {
  id: string;
  ext: string;
  key: string;
  size: number;
  lastModified?: string;
  assets: { proceed: number; cover: number; metadata: number };
}

interface MediaListResponse {
  total: number;
  items: MediaListItem[];
}

// 存储布局分区（spec.md §1；列展示与 API 响应字段一一对应）
const ASSET_COLUMNS: { key: keyof MediaListItem["assets"]; label: string }[] = [
  { key: "proceed", label: "转码产物" },
  { key: "cover", label: "封面图片" },
  { key: "metadata", label: "元数据" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

const COLUMNS: ColumnsType<MediaListItem> = [
  {
    title: "媒资 ID",
    dataIndex: "id",
    width: 120,
    render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
  },
  {
    title: "原始文件",
    dataIndex: "ext",
    render: (ext: string, record) => (
      <Tooltip title={record.key}>
        <Tag>{ext.toUpperCase()}</Tag>
      </Tooltip>
    ),
  },
  {
    title: "大小",
    dataIndex: "size",
    width: 110,
    render: (size: number) => formatSize(size),
  },
  {
    title: "上传时间",
    dataIndex: "lastModified",
    width: 180,
    render: (iso?: string) => (
      <Typography.Text type="secondary">{formatTime(iso)}</Typography.Text>
    ),
  },
  ...ASSET_COLUMNS.map(({ key, label }) => ({
    title: label,
    dataIndex: ["assets", key],
    width: 110,
    render: (n: number) =>
      n > 0 ? (
        <Tag color="green">{n} 个对象</Tag>
      ) : (
        <Tag color="default">无</Tag>
      ),
  })),
];

export function MediaList() {
  const router = useRouter();
  const [items, setItems] = useState<MediaListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/media", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      }
      const data = (await res.json()) as MediaListResponse;
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProCard
      title={
        <span>
          存储媒资列表{" "}
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            （original/ 分区为准，spec.md §1.4）
          </Typography.Text>
        </span>
      }
      bordered={false}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      }
    >
      {error && (
        <Alert
          type="error"
          showIcon
          message="媒资列表获取失败"
          description={error}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" danger onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}
      <Table<MediaListItem>
        rowKey="id"
        columns={COLUMNS}
        dataSource={items}
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个媒资` }}
        size="middle"
        locale={{ emptyText: "存储中暂无媒资（original/ 分区为空）" }}
      />
    </ProCard>
  );
}
