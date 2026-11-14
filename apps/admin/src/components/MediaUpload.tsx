"use client";

// 上传视频页（/media/upload，spec.md §9，2026-10-01）：
// 拖拽上传区（多文件、video/*）+ 上传任务列表（客户端队列 lib/upload-manager.ts 承载，
// 本页只做展示与操作入口——并发 2、切页不中断、取消 / 重试 / 移除 / 清空已完成）。
// 任务实时更新由队列 notify 驱动（useSyncExternalStore 订阅，无轮询 / SSE，§9.3）。
import { CloudUploadOutlined, InboxOutlined } from "@ant-design/icons";
import { Button, Progress, Space, Table, Tag, Tooltip, Typography, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatSize } from "@/lib/format";
import {
  isActiveTask,
  UPLOAD_CONCURRENCY,
  uploadManager,
  type UploadTask,
  type UploadTaskStatus,
} from "@/lib/upload-manager";
import { useTableBodyHeight } from "./tableScroll";

const STATUS_META: Record<UploadTaskStatus, { color: string; label: string }> = {
  PENDING: { color: "default", label: "待上传" },
  QUEUED: { color: "default", label: "排队中" },
  UPLOADING: { color: "processing", label: "上传中" },
  METADATA: { color: "processing", label: "元数据生成中" },
  DONE: { color: "success", label: "完成" },
  FAILED: { color: "error", label: "失败" },
  CANCELED: { color: "warning", label: "已取消" },
};

/** 耗时（mm:ss / h:mm:ss）；列由本地时钟每秒重算（不发请求，同 /jobs 耗时列思路） */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 表体限高 + 横向滚动（列宽合计，spec.md §3.0 表格滚动约定）
const TABLE_MIN_WIDTH = 1310;

export function MediaUpload() {
  const router = useRouter();
  const tasks = useSyncExternalStore(
    uploadManager.subscribe,
    uploadManager.getSnapshot,
    uploadManager.getServerSnapshot,
  );
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);

  // 有进行中任务才启动秒级时钟（重算耗时列）
  const hasActive = tasks.some(isActiveTask);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);

  // 离开确认（spec.md §9.3）：存在进行中任务时注册 beforeunload（原生确认框），全部终止 / 清空后解除
  useEffect(() => {
    if (!hasActive) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (uploadManager.activeCount() > 0) {
        e.preventDefault();
        e.returnValue = ""; // Chrome 需要 returnValue 才弹原生确认
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasActive]);

  const pendingCount = tasks.filter((t) => t.status === "PENDING").length;
  const uploadingCount = tasks.filter(
    (t) => t.status === "UPLOADING" || t.status === "QUEUED",
  ).length;
  const failedCount = tasks.filter((t) => t.status === "FAILED").length;
  const finishedCount = tasks.filter(
    (t) => t.status === "DONE" || t.status === "FAILED" || t.status === "CANCELED",
  ).length;

  const columns: ColumnsType<UploadTask> = [
    {
      title: "文件名",
      dataIndex: "filename",
      width: 240,
      ellipsis: { showTitle: false },
      render: (filename: string) => (
        <Tooltip title={filename} placement="topLeft">
          <span>{filename}</span>
        </Tooltip>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      width: 90,
      render: (size: number) => formatSize(size),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 130,
      render: (status: UploadTaskStatus, task) => (
        <Space size={4} wrap>
          <Tag color={STATUS_META[status].color} style={{ marginInlineEnd: 0 }}>
            {STATUS_META[status].label}
          </Tag>
          {status === "DONE" && task.metadata === "timeout" && (
            // DONE 且轮询超时（spec.md §9.2）：黄色告警，语义同媒资页「更多 → 生成元数据」
            <Tooltip title="元数据仍在生成或已失败，可在媒资页「更多 → 生成元数据」手动重跑">
              <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                元数据超时
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "进度",
      key: "progress",
      width: 190,
      render: (_, task) => {
        if (task.status === "UPLOADING") {
          return <Progress percent={task.pct} size="small" />;
        }
        if (task.status === "METADATA") {
          return (
            <Progress
              percent={100}
              status="active"
              size="small"
              format={() => "元数据生成中"}
            />
          );
        }
        return <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: "媒资 ID",
      dataIndex: "mediaId",
      width: 170,
      render: (mediaId: string | null) =>
        mediaId ? (
          <Typography.Text
            code
            copyable={{ text: mediaId, tooltips: ["点击复制媒资 ID", "已复制"] }}
          >
            {mediaId}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "耗时",
      key: "elapsed",
      width: 90,
      render: (_, task) => {
        if (!task.startedAt) return <Typography.Text type="secondary">—</Typography.Text>;
        const end = task.finishedAt ?? now;
        return <span>{formatElapsed(Math.max(0, end - task.startedAt))}</span>;
      },
    },
    {
      title: "失败原因",
      dataIndex: "error",
      width: 190,
      ellipsis: { showTitle: false },
      render: (error: string | null) =>
        error ? (
          <Tooltip title={error} placement="topLeft">
            <Typography.Text type="danger">{error}</Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 210,
      render: (_, task) => {
        const actions: ReactNode[] = [];
        if (task.status === "QUEUED" || task.status === "UPLOADING") {
          actions.push(
            <Button size="small" onClick={() => uploadManager.cancel(task.id)}>
              取消
            </Button>
          );
        }
        if (task.status === "FAILED" || task.status === "CANCELED") {
          actions.push(
            <Button
              key="retry"
              size="small"
              type="link"
              style={{ paddingInline: 4 }}
              onClick={() => uploadManager.retry(task.id)}
            >
              重试
            </Button>,
          );
        }
        if (task.status === "DONE") {
          actions.push(
            <Button
              key="media"
              size="small"
              type="link"
              style={{ paddingInline: 4 }}
              onClick={() => router.push("/media")}
            >
              去媒资列表
            </Button>,
          );
        }
        if (task.status === "PENDING") {
          actions.push(
            <Button
              key="remove"
              size="small"
              type="link"
              danger
              style={{ paddingInline: 4 }}
              onClick={() => uploadManager.remove(task.id)}
            >
              移除
            </Button>,
          );
        }
        if (task.status === "DONE" || task.status === "FAILED" || task.status === "CANCELED") {
          actions.push(
            <Button
              key="remove"
              size="small"
              type="link"
              danger
              style={{ paddingInline: 4 }}
              onClick={() => uploadManager.remove(task.id)}
            >
              移除
            </Button>,
          );
        }
        return actions.length ? (
          <Space size={4} wrap>
            {actions}
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        );
      },
    },
  ];

  return (
    <div>
      <Upload.Dragger
        multiple
        accept="video/*"
        showUploadList={false}
        beforeUpload={(file) => {
          // 关闭 antd 默认 POST：本次选择 / 拖入的文件逐个加入任务列表（不立即上传，
          // 由「开始上传」统一触发，spec.md §9.3 / §9.4）
          uploadManager.enqueue([file as File]);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽视频到此区域上传</p>
        <p className="ant-upload-hint">
          支持一次拖入多个文件，当前并发数：{UPLOAD_CONCURRENCY}
        </p>
      </Upload.Dragger>

      <div
        style={{
          marginTop: 16,
          marginBottom: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Typography.Text type="secondary">
          共 {tasks.length} 条任务：待上传 {pendingCount} · 上传中 {uploadingCount}。任务仅保留在本页会话，刷新页面即清空
        </Typography.Text>
        <Space>
          {/* 开始上传（spec.md §9.3，2026-10-01 用户定）：把全部待上传任务批量转入执行 */}
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            disabled={pendingCount === 0}
            onClick={() => uploadManager.startAll()}
          >
            开始上传{pendingCount > 0 ? `（${pendingCount}）` : ""}
          </Button>
          {/* 批量操作（spec.md §9.3）：重试全部失败 / 清空已完成 */}
          <Button disabled={failedCount === 0} onClick={() => uploadManager.retryAllFailed()}>
            重试失败任务{failedCount > 0 ? `（${failedCount}）` : ""}
          </Button>
          <Button disabled={finishedCount === 0} onClick={() => uploadManager.clearFinished()}>
            清空已完成{finishedCount > 0 ? `（${finishedCount}）` : ""}
          </Button>
        </Space>
      </div>

      <div ref={tableRef}>
        <Table<UploadTask>
          rowKey="id"
          columns={columns}
          dataSource={tasks}
          pagination={false}
          size="middle"
          scroll={{ x: TABLE_MIN_WIDTH, y: bodyHeight }}
          locale={{ emptyText: "暂无上传任务，拖入视频文件加入列表" }}
        />
      </div>
    </div>
  );
}
