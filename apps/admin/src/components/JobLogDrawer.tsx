"use client";

// 转码任务日志抽屉（ADR-0017 修订，2026-11-13）：
// 数据来自 Worker 每 2s 覆盖写的 transcode_jobs.log_tail（最近 48KB）+ log_seq 版本号。
// 打开时立即拉一次（after=0），任务未终结时按 1.5s 轮询增量（seq 未变服务端回 tail=null，不重传文本）；
// 关闭抽屉即停——不在后台产生请求。
import { Drawer, Empty, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

export interface JobLogDrawerProps {
  /** null = 未选中 */
  jobId: string | null;
  open: boolean;
  /** 任务是否未终结（决定是否继续轮询） */
  active: boolean;
  onClose(): void;
}

const POLL_MS = 1_500;
/** 距底部小于该值视为「跟随最新」；用户向上翻后不强行拉回 */
const STICK_THRESHOLD_PX = 24;

export function JobLogDrawer({ jobId, open, active, onClose }: JobLogDrawerProps) {
  const [tail, setTail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  /** 已加载的任务 id 与版本号：任务终结导致 active 变化时续用增量游标，不重置文本（避免闪白） */
  const loadedJobRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open || !jobId) return;
    let stopped = false;
    // 切换任务才重置；同一任务因 active 变化重跑 effect 时保持增量
    const reset = loadedJobRef.current !== jobId;
    loadedJobRef.current = jobId;
    if (reset) {
      seqRef.current = 0;
      setTail("");
    }
    setError(null);
    setLoading(reset);

    const pull = async (fromZero: boolean): Promise<void> => {
      try {
        const res = await fetch(`/api/admin/jobs/${jobId}/logs?after=${fromZero ? 0 : seqRef.current}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
        }
        const data = (await res.json()) as { seq: number; tail: string | null };
        if (stopped) return;
        seqRef.current = data.seq;
        if (data.tail != null) setTail(data.tail);
        setError(null);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : "日志读取失败");
      } finally {
        if (!stopped) setLoading(false);
      }
    };

    void pull(reset);
    const timer = active ? setInterval(() => void pull(false), POLL_MS) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [open, jobId, active]);

  // 跟随最新：只有在用户本就贴着底部时才自动滚动
  useEffect(() => {
    const el = preRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      title={
        <span>
          任务日志
          {jobId && (
            <Typography.Text code style={{ marginInlineStart: 8, fontSize: 12 }}>
              {jobId}
            </Typography.Text>
          )}
        </span>
      }
      styles={{ body: { display: "flex", flexDirection: "column", gap: 8 } }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        只保留最近 48KB（Worker 每 2 秒覆盖写一次）；{active ? "任务执行中，1.5 秒刷新" : "任务已终结，已停止刷新"}
      </Typography.Text>
      {error && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {error}
        </Typography.Text>
      )}
      {tail ? (
        <pre
          ref={preRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
          }}
          style={{
            flex: 1,
            margin: 0,
            overflow: "auto",
            padding: 12,
            borderRadius: 8,
            background: "#0b1020",
            color: "#d6deeb",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {tail}
        </pre>
      ) : (
        <Empty
          style={{ marginTop: 48 }}
          description={loading ? "加载中…" : "暂无日志（任务尚未被 Worker 认领，或日志尚未写入）"}
        />
      )}
    </Drawer>
  );
}
