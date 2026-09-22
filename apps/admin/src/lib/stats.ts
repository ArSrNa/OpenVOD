// 控制台总览统计：数据库运营指标 + S3 四分区资产统计（spec.md §2.1）。
import type { DashboardStats } from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { getMediaStats, type MediaStats } from "./media";
import { getActiveJobStats, type ActiveJobStats } from "./transcode";
import { getStorage } from "./storage";
import { getStorageStats } from "./storage-stats";

const db = getDb<any>();

export type { MediaStats, ActiveJobStats };
export type { DashboardStats } from "@openvod/contracts";

/** 播放端用户统计（users 表；分发端 login 校验 status=ACTIVE，ADR-0007） */
export type UserStats = DashboardStats["users"];

/** 用户数按状态拆分（两次 COUNT，不拉行） */
export async function getUserStats(): Promise<UserStats> {
  const [total, active] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { status: "ACTIVE" } }),
  ]);
  return { total, active, disabled: total - active };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const assetsTask = getStorage().then(getStorageStats);
  const [assets, media, jobs, users] = await Promise.all([
    assetsTask,
    assetsTask.then(({ originals }) => getMediaStats(originals)),
    getActiveJobStats(),
    getUserStats(),
  ]);
  const { storage, subtitles, products, metadata } = assets;
  return { media, jobs, users, storage, subtitles, products, metadata };
}
