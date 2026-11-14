// 转码任务的「取消 / 重启 / 删除」操作守卫（纯函数；spec.md §5.1，ADR-0008）
//
// 语义（与 worker 的认领 / 租约 / 取消轮询机制对齐，apps/worker/src/job-store.ts）：
//   取消（2026-11-12 起可**立即打断**）：
//     - QUEUED / 租约已过期：直接置 CANCELLED（撤下队列或安全终止）；
//     - 租约有效（worker 正在执行）：写 cancel_requested_at 作为取消请求，worker 2s 内轮询到即
//       杀 ffmpeg / 中止拉源并落 CANCELLED；请求期间按钮显示「取消中」，重复提交被拒；
//   重启（重新入队）＝ FAILED 或 CANCELLED → QUEUED：attempts 清零、清 cancel_requested_at、
//     清错误与租约——不清零 attempts 会被认领逻辑立即判「超过重试上限」而秒失败；
//   删除（2026-11-14）＝ 仅终结态（DONE / FAILED / CANCELLED）可删，进行中的必须先取消。
// 本模块只做判定，不改库；DB 写入与 CAS 见 lib/transcode.ts。

import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";

/** 未终结状态（唯一真相源在 @openvod/contracts，spec.md §5.1 状态机） */
const ACTIVE_STATUSES: readonly string[] = ACTIVE_JOB_STATUSES;

export interface JobActionInput {
  status: string;
  /** 分发端是否持有有效租约（lease_until > now）；QUEUED 恒为 false */
  leaseActive: boolean;
  /** 是否已提交取消请求（cancel_requested_at 非空） */
  cancelRequested?: boolean;
}

export interface JobActionState {
  /** 取消可用：未终结，且（未请求取消 或 租约已过期可立即收尾） */
  canStop: boolean;
  /** 重启（重新入队）可用：FAILED / CANCELLED */
  canRestart: boolean;
  /** 执行中任务租约已过期（worker 失联）——状态列提示「中断」 */
  leaseExpired: boolean;
  /** 已提交取消请求、等待 worker 中断——状态列提示「取消中」 */
  cancelling: boolean;
  /** 取消被拒的原因（canStop 为 false 时给出） */
  stopBlocked?: string;
  /** 重启被拒的原因（canRestart 为 false 时给出） */
  restartBlocked?: string;
}

export function jobActionState(input: JobActionInput): JobActionState {
  const active = (ACTIVE_STATUSES as readonly string[]).includes(input.status);
  const cancelRequested = Boolean(input.cancelRequested);
  const leaseExpired = active && input.status !== "QUEUED" && !input.leaseActive;
  const cancelling = active && cancelRequested;

  let canStop = false;
  let stopBlocked: string | undefined;
  if (active) {
    if (cancelRequested && input.leaseActive) {
      // worker 已收到请求但还没收尾：不接受重复提交，避免覆盖请求时间（等待即可）
      stopBlocked = "取消请求已提交，正在等待 worker 中断执行";
    } else {
      canStop = true;
    }
  } else {
    stopBlocked = "任务已结束，无需取消";
  }

  let canRestart = false;
  let restartBlocked: string | undefined;
  if (input.status === "FAILED" || input.status === "CANCELLED") {
    canRestart = true;
  } else {
    restartBlocked = "只有失败或已取消的任务才能重启";
  }

  return { canStop, canRestart, leaseExpired, cancelling, stopBlocked, restartBlocked };
}

export interface JobDeletePartition {
  /** 可删除的任务 id（去重后，保持请求顺序） */
  deletable: string[];
  /** 不可删除的任务及原因（进行中 / 不存在） */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * 批量删除前的可删性划分（纯判定，不改库）：仅**非进行中**（终结态）可删。
 * 进行中的任务交给用户先「取消」，避免删掉正在写产物的任务行让 worker 收尾落空。
 */
export function partitionDeletableJobs(
  ids: string[],
  rows: Array<{ id: string; status: string }>,
): JobDeletePartition {
  const statusOf = new Map(rows.map((r) => [r.id, r.status]));
  const deletable: string[] = [];
  const skipped: JobDeletePartition["skipped"] = [];
  for (const id of new Set(ids)) {
    const status = statusOf.get(id);
    if (status === undefined) {
      skipped.push({ id, reason: "任务不存在" });
    } else if ((ACTIVE_STATUSES as readonly string[]).includes(status)) {
      skipped.push({ id, reason: "任务进行中，不能删除" });
    } else {
      deletable.push(id);
    }
  }
  return { deletable, skipped };
}
