"use client";

// 控制台总览（管理端主页 /，intent.md「控制台总览」2026-09-18）：
// 一屏展示常用运营指标，只读、不承载写操作。
// 所有指标来自 GET /api/admin/stats；S3 只展示实际已用空间，不设置桶配额。
import {
  CloudServerOutlined,
  FileTextOutlined,
  FontSizeOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { DashboardStatsResponse, type DashboardStats } from "@openvod/contracts";
import { Button, Space, Statistic, Typography } from "antd";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

interface StatItem {
  key: string;
  label: string;
  value: number | undefined;
  suffix?: string;
  precision?: number;
  sub: string;
  icon: ReactNode;
}

function storageValue(bytes: number | undefined): Pick<StatItem, "value" | "suffix" | "precision"> {
  if (bytes === undefined) return { value: undefined };
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return { value, suffix: units[unit], precision: unit === 0 ? 0 : 1 };
}

export function DashboardOverview() {
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 首屏加载 + 手动刷新（刷新 = 重新拉取一次统计；任务变化不自动轮询，避免与 SSE 重复建设）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/admin/stats", { cache: "no-store" });
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
        const parsed = DashboardStatsResponse.safeParse(body);
        if (!parsed.success) throw new Error("统计数据格式异常，请刷新重试");
        if (!cancelled) setStats(parsed.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "统计加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, router]);

  const pendingText = loading ? "加载中…" : "暂不可用";
  const items: StatItem[] = [
    {
      key: "media",
      label: "媒资总数",
      value: stats?.media.total,
      sub: stats ? `就绪 ${stats.media.ready} · 未入库 ${stats.media.not_ingested}` : pendingText,
      icon: <VideoCameraOutlined />,
    },
    {
      key: "jobs",
      label: "进行中任务",
      value: stats?.jobs.active,
      sub: stats
        ? `转码 ${stats.jobs.encoding} · 探测 ${stats.jobs.probing} · 封装 ${stats.jobs.packaging} · 排队 ${stats.jobs.queued}`
        : pendingText,
      icon: <ThunderboltOutlined />,
    },
    {
      key: "users",
      label: "播放端用户",
      value: stats?.users.total,
      sub: stats ? `可用 ${stats.users.active} · 已封禁 ${stats.users.disabled}` : pendingText,
      icon: <TeamOutlined />,
    },
    {
      key: "storage",
      label: "已用存储空间",
      ...storageValue(stats?.storage.used_bytes),
      sub: "包含媒体、转码、字幕、元数据等产物",
      icon: <CloudServerOutlined />,
    },
    {
      key: "subtitles",
      label: "字幕文件",
      value: stats?.subtitles.total,
      sub: stats ? `已覆盖 ${stats.subtitles.media_count} 个媒资` : pendingText,
      icon: <FontSizeOutlined />,
    },
    {
      key: "products",
      label: "转码产物",
      value: stats?.products.total,
      suffix: stats ? "组" : undefined,
      sub: stats ? `按模板分组 · 已覆盖 ${stats.products.media_count} 个媒资` : pendingText,
      icon: <PlayCircleOutlined />,
    },
    {
      key: "metadata",
      label: "元数据对象",
      value: stats?.metadata.total,
      sub: stats
        ? `探测 ${stats.metadata.probe} · 自定义 ${stats.metadata.custom}${stats.metadata.other ? ` · 其他 ${stats.metadata.other}` : ""}`
        : pendingText,
      icon: <FileTextOutlined />,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ProCard
        title="平台概览"
        bordered={false}
        extra={
          <Space size={8} wrap>
            {error && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {error}{stats ? "（显示上次统计）" : ""}
              </Typography.Text>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => setReloadKey((n) => n + 1)}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
          {items.map(({ key, label, value, suffix, precision, sub, icon }) => (
            <ProCard key={key} bordered>
              <Space size={6} style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 16, display: "inline-flex" }}>{icon}</span>
                <Typography.Text type="secondary">{label}</Typography.Text>
              </Space>
              <Statistic
                value={value ?? "—"}
                suffix={suffix}
                precision={precision}
                loading={loading}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sub}
              </Typography.Text>
            </ProCard>
          ))}
        </div>
      </ProCard>
    </div>
  );
}
