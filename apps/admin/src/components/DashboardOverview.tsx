"use client";

// 控制台总览（管理端主页 /，intent.md「控制台总览」2026-09-18）：
// 一屏展示常用运营指标。v1 全部为 mock 占位、不接接口；真实数据随各模块里程碑聚合接入
// （媒资统计可复用 /api/admin/media 列表聚合，任务 / 用户 / 存储随 M2 / M4 落地）。
import {
  CloudServerOutlined,
  EyeOutlined,
  FileTextOutlined,
  FontSizeOutlined,
  PlayCircleOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import { Progress, Space, Statistic, Tag, Typography } from "antd";
import type { ReactNode } from "react";

interface StatItem {
  key: string;
  label: string;
  value: number;
  suffix?: string;
  sub: string;
  icon: ReactNode;
}

// Mock 指标（数值为演示占位，接入真实接口时替换为聚合查询）
const MOCK_STATS: StatItem[] = [
  { key: "media", label: "媒资总数", value: 128, sub: "就绪 96 · 未入库 4", icon: <VideoCameraOutlined /> },
  { key: "jobs", label: "进行中任务", value: 3, sub: "转码中 2 · 探测中 1", icon: <ThunderboltOutlined />, },
  { key: "users", label: "播放端用户", value: 42, sub: "今日登录 9", icon: <TeamOutlined /> },
  { key: "storage", label: "已用存储空间", value: 512.3, suffix: "GB", sub: "配额 1 TB · 已用 50%", icon: <CloudServerOutlined />, },
  { key: "subtitles", label: "字幕文件", value: 56, sub: "已覆盖 32 个媒资", icon: <FontSizeOutlined />, },
  { key: "proceed", label: "转码产物", value: 312, sub: "不含 HLS 分片对象", icon: <PlayCircleOutlined />, },
  { key: "metadata", label: "元数据对象", value: 87, sub: "probe 42 · 自定义 45", icon: <FileTextOutlined />, },
  { key: "sessions", label: "活跃播放会话", value: 18, sub: "24 小时内签发", icon: <EyeOutlined />, },
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ProCard title="平台概览" bordered={false} extra={MOCK_TAG}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
          以下指标均为 mock 占位，真实接口将随对应模块里程碑聚合接入（媒资 / 转码任务 / 用户 / 存储用量）。
        </Typography.Paragraph>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
          {MOCK_STATS.map(({ key, label, value, suffix, sub, icon }) => (
            <ProCard key={key} bordered>
              <Space size={6} style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 16, display: "inline-flex" }}>{icon}</span>
                <Typography.Text type="secondary">{label}</Typography.Text>
              </Space>
              <Statistic value={value} suffix={suffix} precision={suffix ? 1 : undefined} />
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
