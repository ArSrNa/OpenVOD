// 控制台总览统计（intent.md「控制台总览」2026-09-18）：
// 只聚合**已落地模块**的真实指标——媒资（M1，spec.md §1.4）、转码任务（M2，ADR-0008）、
// 播放端用户（用户管理，ADR-0004 users 表 / ADR-0007）；
// 存储 / 字幕 / 产物 / 元数据 / 会话仍是页面内 mock 占位，随对应里程碑接入后整体替换。
import { getDb } from "@openvod/db";
import { getMediaStats, type MediaStats } from "./media";
import { getActiveJobStats, type ActiveJobStats } from "./transcode";

const db = getDb<any>();

export type { MediaStats, ActiveJobStats };

/** 播放端用户统计（users 表；分发端 login 校验 status=ACTIVE，ADR-0007） */
export interface UserStats {
  total: number;
  active: number;
  disabled: number;
}

export interface DashboardStats {
  media: MediaStats;
  jobs: ActiveJobStats;
  users: UserStats;
}

/** 用户数按状态拆分（两次 COUNT，不拉行） */
export async function getUserStats(): Promise<UserStats> {
  const [total, active] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { status: "ACTIVE" } }),
  ]);
  return { total, active, disabled: total - active };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [media, jobs, users] = await Promise.all([
    getMediaStats(),
    getActiveJobStats(),
    getUserStats(),
  ]);
  return { media, jobs, users };
}
