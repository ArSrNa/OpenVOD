"use client";

// 转码任务页（/jobs，M2；ADR-0008 队列 + ADR-0014 模板快照）：
// 列表来自 transcode_jobs，展示状态机（排队 → 探测 → **拉取源片** → 转码 → 封装上传 → 完成/失败/取消）、
// 模板名（取任务快照，模板被删也能追溯）、阶段进度与失败原因；
// 操作：**取消**（立即打断：执行中的任务由 worker 收到取消请求后杀掉 ffmpeg，spec.md §5.1）与
// **重启**（失败 / 已取消的任务清零尝试次数重新入队）。
// 实时性走 SSE（/api/admin/jobs/stream，spec.md §2.1）：客户端零轮询，服务端仅在快照变化时推全量，
// 断线由 EventSource 自动重连（重连即拿最新快照）；「耗时」列用本地时钟每秒重算，不产生请求。
import { FileTextOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";
import { App, Button, Empty, Progress, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { jobActionState } from "@/lib/job-actions";
import { useCallback, useEffect, useRef, useState } from "react";
import { JobLogDrawer } from "./JobLogDrawer";
import { useTableBodyHeight } from "./tableScroll";

interface JobItem {
  id: string;
  media_id: string;
  media_title: string | null;
  status: string;
  template_id: string | null;
  template_name: string | null;
  attempts: number;
  /** 当前阶段进度（0–100；拉取源片 / 转码阶段有意义，其余为 null） */
  progress: number | null;
  /** 分发端是否持有有效租约（执行中）；未认领 / worker 失联时为 false */
  lease_active: boolean;
  /** 取消请求时间（有值 = 已提交取消，等待 worker 中断） */
  cancel_requested_at: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  QUEUED: { color: "default", label: "排队中" },
  PROBING: { color: "processing", label: "探测中" },
  DOWNLOADING: { color: "processing", label: "拉取源片中" },
  ENCODING: { color: "processing", label: "转码中" },
  PACKAGING: { color: "processing", label: "封装上传中" },
  DONE: { color: "success", label: "完成" },
  FAILED: { color: "error", label: "失败" },
  CANCELLED: { color: "default", label: "已取消" },
};

const ACTIVE = new Set<string>(ACTIVE_JOB_STATUSES);

/** SSE 连接状态：网络类断线浏览器自动重连；HTTP 非 200（如会话过期）会永久关闭，需人工刷新 */
type ConnState = "connecting" | "live" | "error" | "closed";

const CONN_META: Record<ConnState, { color: string; label: string }> = {
  connecting: { color: "default", label: "连接中…" },
  live: { color: "success", label: "实时推送中" },
  error: { color: "warning", label: "连接中断，自动重连中…" },
  closed: { color: "error", label: "连接已断开（会话可能过期），请刷新页面" },
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** 耗时（开始 → 完成；未完成则显示已耗时，now 由本地时钟每秒推进） */
function duration(item: JobItem, now: number): string {
  if (!item.started_at) return "—";
  const start = new Date(item.started_at).getTime();
  const end = item.finished_at ? new Date(item.finished_at).getTime() : now;
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} s`;
  return `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

export function JobsManager() {
  // 表格滚动约定（spec.md §3.0）
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [items, setItems] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true); // 首帧快照到达前
  const [conn, setConn] = useState<ConnState>("connecting");
  const [reconnect, setReconnect] = useState(0); // 手动刷新 = 重建 SSE 连接（服务端随即回放最新快照）
  const [now, setNow] = useState(() => Date.now()); // 仅驱动「耗时」列重算，不发请求
  const [logJob, setLogJob] = useState<JobItem | null>(null); // 日志抽屉当前任务（null = 关闭）

  // SSE：连上即收到全量快照（event: jobs），之后仅在服务端观察到变化时收帧；断线自动重连
  useEffect(() => {
    setConn("connecting");
    const es = new EventSource("/api/admin/jobs/stream");
    const onJobs = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as { items?: JobItem[] };
        setItems(data.items ?? []);
        setLoading(false);
        setConn("live");
      } catch {
        // 单帧坏数据忽略：下一帧是全量覆盖，可自愈
      }
    };
    es.addEventListener("jobs", onJobs);
    es.onopen = () => setConn("live");
    // 网络类错误 → readyState=CONNECTING，浏览器按 retry 自动重连（重连即重新校验会话）；
    // HTTP 非 200（如 401）→ readyState=CLOSED，浏览器不再重试，提示人工刷新
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? "closed" : "error");
    return () => {
      es.removeEventListener("jobs", onJobs);
      es.close();
    };
  }, [reconnect]);

  // 「耗时」列：存在未终结任务时用本地时钟每秒重算（纯展示，零网络请求）
  const hasActive = items.some((i) => ACTIVE.has(i.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);

  // ---- 停止 / 重启（spec.md §5.1）：写入后由 SSE 自动推送新状态，无需手动刷新 ----
  const { message, modal } = App.useApp();

  const callAction = useCallback(async (id: string, action: "stop" | "restart") => {
    const res = await fetch(`/api/admin/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
    }
  }, []);

  const handleStop = (row: JobItem) => {
    modal.confirm({
      title: `确认取消任务 ${row.id.slice(0, 12)}…？`,
      content: (
        <Typography.Text type="danger">
          排队中的任务立即撤下队列；执行中的任务会通知 worker 立即中断（杀掉 ffmpeg 进程、中止拉取）。
          取消后任务显示「已取消」，可用「重启」重新入队。
        </Typography.Text>
      ),
      okText: "取消任务",
      okButtonProps: { danger: true },
      cancelText: "返回",
      onOk: async () => {
        try {
          await callAction(row.id, "stop");
          message.success("取消请求已提交");
        } catch (e) {
          message.error(e instanceof Error ? e.message : "取消失败");
        }
      },
    });
  };

  const handleRestart = (row: JobItem) => {
    modal.confirm({
      title: `确认重启任务 ${row.id.slice(0, 12)}…？`,
      content: <Typography.Text>将清零尝试次数并重新入队（排队中），由 worker 认领执行。</Typography.Text>,
      okText: "重启",
      cancelText: "取消",
      onOk: async () => {
        try {
          await callAction(row.id, "restart");
          message.success("任务已重新入队");
        } catch (e) {
          message.error(e instanceof Error ? e.message : "重启失败");
        }
      },
    });
  };

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
      title: "进度",
      dataIndex: "progress",
      width: 140,
      render: (progress: number | null) => {
        // 进度只在「拉取源片 / 转码」阶段有值（其余阶段为 null，不显示误导性的空条）
        if (progress == null) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Progress
            percent={progress}
            size="small"
            status={progress >= 100 ? "success" : "active"}
            style={{ marginBottom: 0 }}
          />
        );
      },
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
      width: 130,
      render: (status: string, row) => {
        const meta = STATUS_META[status] ?? { color: "default", label: status };
        const st = jobActionState({
          status: row.status,
          leaseActive: row.lease_active,
          cancelRequested: row.cancel_requested_at != null,
        });
        return (
          <Space size={4}>
            <Tag color={meta.color}>{meta.label}</Tag>
            {st.cancelling && (
              <Tooltip title="取消请求已提交，正在中断执行（worker 每 2 秒轮询一次，通常数秒内完成）">
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  取消中
                </Tag>
              </Tooltip>
            )}
            {st.leaseExpired && (
              <Tooltip title="worker 失联：租约已过期，任务不会再被继续执行；可取消，或重启 worker 后等待重派">
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  中断
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
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
      render: (_, row) => duration(row, now),
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
    {
      title: "操作",
      key: "ops",
      width: 200,
      render: (_, row) => {
        const st = jobActionState({
          status: row.status,
          leaseActive: row.lease_active,
          cancelRequested: row.cancel_requested_at != null,
        });
        return (
          <Space size={0}>
            <Button type="link" size="small" icon={<FileTextOutlined />} onClick={() => setLogJob(row)}>
              日志
            </Button>
            {st.canStop && (
              <Button danger type="link" size="small" icon={<StopOutlined />} onClick={() => handleStop(row)}>
                取消
              </Button>
            )}
            {st.canRestart && (
              <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => handleRestart(row)}>
                重启
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  // 抽屉跟随 SSE 快照的最新状态（任务在抽屉打开期间终结 → 自动停止轮询）
  const logItem = logJob ? (items.find((i) => i.id === logJob.id) ?? logJob) : null;

  return (
    <ProCard bordered={false}>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => setReconnect((n) => n + 1)} loading={loading}>
          刷新
        </Button>
        <Tag color={CONN_META[conn].color}>{CONN_META[conn].label}</Tag>
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
          scroll={{ x: 1380, y: bodyHeight }}
          locale={{
            emptyText: <Empty description="暂无转码任务（在「媒资管理 → 更多 → 转码」发起）" />,
          }}
        />
      </div>

      <JobLogDrawer
        jobId={logItem?.id ?? null}
        open={logItem != null}
        active={logItem ? ACTIVE.has(logItem.status) : false}
        onClose={() => setLogJob(null)}
      />
    </ProCard>
  );
}
