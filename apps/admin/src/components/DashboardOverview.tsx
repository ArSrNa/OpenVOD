"use client";

// 控制台总览（管理端主页 /，intent.md「控制台总览」2026-09-18）：
// 一屏展示常用运营指标，只读、不承载写操作。
// 真实指标（GET /api/admin/stats）：媒资总数（就绪 / 未入库拆分，spec.md §1.4）、
// 进行中转码任务（按状态拆分，ADR-0008）、播放端用户（总数 / 可用 / 已封禁，ADR-0007）；
// 其余指标（存储 / 字幕 / 产物 / 元数据 / 会话）仍为 mock 占位，随各模块里程碑聚合接入
// （接入即替换，页面结构不变）。
import {
  CloudServerOutlined,
  EyeOutlined,
  FileTextOutlined,
  FontSizeOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { Button, Progress, Space, Statistic, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { DashboardStats } from "@/lib/stats";

interface StatItem {
  key: string;
  label: string;
  value: number;
  suffix?: string;
  sub: string;
  icon: ReactNode;
  /** 真实数据（加载中显示骨架）；false = mock 占位 */
  real: boolean;
}

// Mock 指标（接入真实接口时替换为聚合查询）
const MOCK_STATS: StatItem[] = [
  { key: "storage", label: "已用存储空间", value: 512.3, suffix: "GB", sub: "配额 1 TB · 已用 50%", icon: <CloudServerOutlined />, real: false },
  { key: "subtitles", label: "字幕文件", value: 56, sub: "已覆盖 32 个媒资", icon: <FontSizeOutlined />, real: false },
  { key: "proceed", label: "转码产物", value: 312, sub: "不含 HLS 分片对象", icon: <PlayCircleOutlined />, real: false },
  { key: "metadata", label: "元数据对象", value: 87, sub: "probe 42 · 自定义 45", icon: <FileTextOutlined />, real: false },
  { key: "sessions", label: "活跃播放会话", value: 18, sub: "24 小时内签发", icon: <EyeOutlined />, real: false },
];

// 存储用量 mock：按 spec.md §1 的四个分区拆分（合计与「已用存储空间」一致）
const MOCK_STORAGE_PARTITIONS = [
  { label: "original/（原视频）", size: "402.0 GB", pct: 39 },
  { label: "proceed/（转码产物）", size: "92.0 GB", pct: 9 },
  { label: "cover/（封面图片）", size: "12.1 GB", pct: 1 },
  { label: "metadata/（元数据）", size: "6.2 GB", pct: 1 },
];

const MOCK_TAG = <Tag color="orange">Mock 数据占位</Tag>;

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
        const body = (await res.json().catch(() => null)) as
          | (DashboardStats & { error?: { message?: string } })
          | null;
        if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
        if (!cancelled) setStats(body);
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

  const items: StatItem[] = [
    {
      key: "media",
      label: "媒资总数",
      value: stats?.media.total ?? 0,
      sub: stats ? `就绪 ${stats.media.ready} · 未入库 ${stats.media.not_ingested}` : "加载中…",
      icon: <VideoCameraOutlined />,
      real: true,
    },
    {
      key: "jobs",
      label: "进行中任务",
      value: stats?.jobs.active ?? 0,
      sub: stats
        ? `转码 ${stats.jobs.encoding} · 探测 ${stats.jobs.probing} · 封装 ${stats.jobs.packaging} · 排队 ${stats.jobs.queued}`
        : "加载中…",
      icon: <ThunderboltOutlined />,
      real: true,
    },
    {
      key: "users",
      label: "播放端用户",
      value: stats?.users.total ?? 0,
      sub: stats ? `可用 ${stats.users.active} · 已封禁 ${stats.users.disabled}` : "加载中…",
      icon: <TeamOutlined />,
      real: true,
    },
    ...MOCK_STATS,
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
                {error}
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
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              媒资 / 任务 / 用户为实时数据
            </Tag>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
          媒资总数、进行中任务与播放端用户为实时统计（/api/admin/stats）；存储 / 字幕 / 产物 / 元数据 /
          会话仍为 mock 占位，随对应模块里程碑聚合接入。
        </Typography.Paragraph>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
          {items.map(({ key, label, value, suffix, sub, icon, real }) => (
            <ProCard key={key} bordered>
              <Space size={6} style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 16, display: "inline-flex" }}>{icon}</span>
                <Typography.Text type="secondary">{label}</Typography.Text>
                {!real && (
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                    Mock
                  </Tag>
                )}
              </Space>
              <Statistic
                value={value}
                suffix={suffix}
                precision={suffix ? 1 : undefined}
                loading={loading && real}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sub}
              </Typography.Text>
            </ProCard>
          ))}
        </div>
      </ProCard>

      <ProCard title="存储用量（按分区）" bordered={false} extra={MOCK_TAG}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {MOCK_STORAGE_PARTITIONS.map(({ label, size, pct }) => (
            <div key={label}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <Typography.Text>{label}</Typography.Text>
                <Typography.Text type="secondary">{size}</Typography.Text>
              </div>
              <Progress percent={pct} size="small" />
            </div>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          百分比为分区占用 / 桶配额（mock：1 TB）；分区布局见 spec.md §1。
        </Typography.Text>
      </ProCard>
    </div>
  );
}
