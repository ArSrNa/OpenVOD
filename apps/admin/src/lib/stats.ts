// 控制台总览统计（intent.md「控制台总览」2026-09-18）：
// 只聚合**已落地模块**的真实指标——媒资（M1，spec.md §1.4）与转码任务（M2，ADR-0008）；
// 用户 / 存储 / 字幕 / 产物 / 元数据 / 会话仍是页面内 mock 占位，随对应里程碑接入后整体替换。
import { getMediaStats, type MediaStats } from "./media";
import { getActiveJobStats, type ActiveJobStats } from "./transcode";

export type { MediaStats, ActiveJobStats };

export interface DashboardStats {
  media: MediaStats;
  jobs: ActiveJobStats;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [media, jobs] = await Promise.all([getMediaStats(), getActiveJobStats()]);
  return { media, jobs };
}
