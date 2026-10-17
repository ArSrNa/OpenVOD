// 转码任务的「停止 / 重启」操作守卫（纯函数；spec.md §5.1，ADR-0008）
//
// 语义（与 worker 的认领 / 租约机制对齐，apps/worker/src/job-store.ts）：
//   停止（取消）＝ 标记为 FAILED（原因：手动停止）并清空租约：
//     - QUEUED：撤下队列，永不被认领；
//     - PROBING/ENCODING/PACKAGING 且租约已过期：worker 失联 / 已死，安全终止；
//     - 租约仍有效（worker 正在执行）：拒绝——任务状态会被 worker 覆盖，
//       执行中的中途取消需要 worker 侧检查点配合（演进项，spec.md §5.1）。
//   重启（重新入队）＝ 仅 FAILED（失败或手动停止）可重启：status → QUEUED、attempts 清零、
//     清错误与租约——不清零 attempts 会被认领逻辑立即判「超过重试上限」而秒失败。
// 本模块只做判定，不改库；DB 写入与 CAS 见 lib/transcode.ts。

import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";

/** 未终结状态（唯一真相源在 @openvod/contracts，spec.md §5.1 状态机） */
const ACTIVE_STATUSES: readonly string[] = ACTIVE_JOB_STATUSES;

export interface JobActionInput {
  status: string;
  /** 分发端是否持有有效租约（lease_until > now）；QUEUED 恒为 false */
  leaseActive: boolean;
}

export interface JobActionState {
  /** 停止（取消）可用：未终结且租约无效 */
  canStop: boolean;
  /** 重启（重新入队）可用：仅 FAILED */
  canRestart: boolean;
  /** 执行中任务租约已过期（worker 失联）——状态列提示「中断」 */
  leaseExpired: boolean;
  /** 停止被拒的原因（canStop 为 false 时给出） */
  stopBlocked?: string;
  /** 重启被拒的原因（canRestart 为 false 时给出） */
  restartBlocked?: string;
}

export function jobActionState(input: JobActionInput): JobActionState {
  const active = (ACTIVE_STATUSES as readonly string[]).includes(input.status);
  const leaseExpired = active && input.status !== "QUEUED" && !input.leaseActive;

  let canStop = false;
  let stopBlocked: string | undefined;
  if (active) {
    if (input.leaseActive) {
      stopBlocked = "任务正被 worker 执行（租约有效），无法停止；如 worker 已失联，请等租约过期后再试";
    } else {
      canStop = true;
    }
  } else {
    stopBlocked = "任务已结束，无需停止";
  }

  let canRestart = false;
  let restartBlocked: string | undefined;
  if (input.status === "FAILED") {
    canRestart = true;
  } else {
    restartBlocked = "只有失败（含手动停止）的任务才能重启";
  }

  return { canStop, canRestart, leaseExpired, stopBlocked, restartBlocked };
}
