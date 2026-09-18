"use client";

// 转码任务页（/jobs，M2；ADR-0008 队列 + ADR-0014 模板快照）：
// 列表来自 transcode_jobs，展示状态机（排队 → 探测 → 转码 → 封装上传 → 完成/失败）、
// 模板名（取任务快照，模板被删也能追溯）与失败原因；支持自动刷新观察执行进度。
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { App, Button, Empty, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTableBodyHeight } from "./tableScroll";

interface JobItem {
  id: string;
  media_id: string;
  media_title: string | null;
  status: string;
  template_id: string | null;
  template_name: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  QUEUED: { color: "default", label: "排队中" },
  PROBING: { color: "processing", label: "探测中" },
  ENCODING: { color: "processing", label: "转码中" },
  PACKAGING: { color: "processing", label: "封装上传中" },
  DONE: { color: "success", label: "完成" },
  FAILED: { color: "error", label: "失败" },
};

const ACTIVE = new Set(["QUEUED", "PROBING", "ENCODING", "PACKAGING"]);

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** 耗时（开始 → 完成；未完成则显示已耗时） */
function duration(item: JobItem): string {
  if (!item.started_at) return "—";
  const start = new Date(item.started_at).getTime();
  const end = item.finished_at ? new Date(item.finished_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} s`;
  return `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message ?? `请求失败（HTTP ${res.status}）`;
  } catch {
    return `请求失败（HTTP ${res.status}）`;
  }
}

export function JobsManager() {
  const { message } = App.useApp();
  // 表格滚动约定（spec.md §3.0）
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [items, setItems] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);

  const reload = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch("/api/admin/jobs", { cache: "no-store" });
        if (!res.ok) throw new Error(await parseError(res));
        const data = (await res.json()) as { items: JobItem[] };
        setItems(data.items ?? []);
      } catch (e) {
        if (!silent) message.error((e as Error).message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // 自动刷新：仅在存在未终结任务时轮询，避免空转
  const hasActive = items.some((i) => ACTIVE.has(i.status));
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void reload(true), 5000);
    return () => clearInterval(timer);
  }, [auto, reload]);

  const columns: ColumnsType<JobItem> = [
    {
      title: "任务",
      dataIndex: "id",
      width: 170,
      render: (id: string) => (
        <Tooltip title={id}>
          <Typography.Text code style={{ fontSize: 12 }}>
            {id.slice(0, 12)}…
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: "媒资",
      key: "media",
      width: 220,
      render: (_, row) => (
        <Space size={6} style={{ minWidth: 0 }}>
          <Typography.Text code style={{ fontSize: 12 }}>
            {row.media_id}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 130 }}>
            {row.media_title ?? "—"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (status: string) => {
        const meta = STATUS_META[status] ?? { color: "default", label: status };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: "模板",
      dataIndex: "template_name",
      width: 180,
      ellipsis: true,
      render: (name: string | null) => name ?? "—",
    },
    { title: "尝试", dataIndex: "attempts", width: 80 },
    {
      title: "耗时",
      key: "duration",
      width: 110,
      render: (_, row) => duration(row),
    },
    {
      title: "失败原因",
      dataIndex: "last_error",
      ellipsis: true,
      render: (err: string | null) =>
        err ? (
          <Tooltip title={err}>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {err}
            </Typography.Text>
          </Tooltip>
        ) : (
          "—"
        ),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      width: 165,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatTime(v)}
        </Typography.Text>
      ),
    },
  ];

  return (
    <ProCard bordered={false}>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
        <Space size={6}>
          <Switch checked={auto} onChange={setAuto} size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            自动刷新（5s）
          </Typography.Text>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <ThunderboltOutlined /> 任务由 Worker 认领执行；同一媒资同时只允许一个进行中的任务（发起入口在「媒资管理 → 更多 → 转码」）
        </Typography.Text>
      </Space>

      <div ref={tableRef}>
        <Table<JobItem>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个任务` }}
          size="middle"
          scroll={{ x: 1180, y: bodyHeight }}
          rowClassName={(row) => (hasActive && ACTIVE.has(row.status) ? "" : "")}
          locale={{
            emptyText: <Empty description="暂无转码任务（在「媒资管理 → 更多 → 转码」发起）" />,
          }}
        />
      </div>
    </ProCard>
  );
}
