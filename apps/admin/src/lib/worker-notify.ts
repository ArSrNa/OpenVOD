// admin → worker HTTP 门铃（ADR-0017 §3）：发起转码 / 任务重启成功后
// POST {WORKER_NOTIFY_URL}/wake（Bearer WORKER_NOTIFY_SECRET），拉起异步函数实例并让它认领本次任务。
// 载荷 `{ job_ids }` 只被 invoked 模式（异步云函数）消费：定向认领，不扫队列；
// http 模式忽略载荷、照常 drain 队列（兼容旧版本 worker：无 body 也能唤醒）。
// 设计原则：通知可以丢（任务留存 transcode_jobs，靠平台定时拉起或人工重启兜底），事实源不能丢。
// 因此失败仅告警、绝不把业务响应改成失败；未配置 WORKER_NOTIFY_URL 时安静跳过。
//
// 调用方必须 await（不能 void）：admin 以 serverless / 容器形态运行时，响应返回后实例可能立刻被
// 冻结或回收，未发出或被中断的外呼会被直接丢掉——结果就是任务入队了、函数始终没被拉起。
// 等待有上限（DEFAULT_WAKE_TIMEOUT_MS），超时按「未送达」告警，不会把管理端拖住。
import { WorkerWakeRequest } from "@openvod/contracts";
import { SETTING_KEYS } from "@openvod/shared";
import { resolvePlain, resolveSecret } from "./settings";

/** 单次唤醒的外呼上限：正常是毫秒级（异步平台收到即返回），只兜住不可达地址的等待 */
export const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

export interface WakeNotifyResult {
  notified: boolean;
  reason?: string;
}

/** 纯装配：给定地址 / 密钥 / 任务 id / fetch 实现，POST /wake 并归一化结果（不抛异常） */
export async function postWorkerWake(deps: {
  url: string;
  secret: string;
  /** 本次入队 / 重启的任务 id（invoked 模式定向认领；省略 = 让 http 模式扫队列） */
  jobIds?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WakeNotifyResult> {
  const url = deps.url.replace(/\/+$/, "");
  if (!url) return { notified: false, reason: "未配置 worker_notify_url" };
  if (!deps.secret) return { notified: false, reason: "未配置 worker_notify_secret，跳过通知" };
  // 载荷契约在 @openvod/contracts（WorkerWakeRequest）：超限 / 非法时退回「无载荷」，
  // 由 worker 的 http 模式扫队列兜底（invoked 模式空载荷也会退回扫描）
  const parsed = WorkerWakeRequest.safeParse({ job_ids: deps.jobIds });
  const jobIds = parsed.success ? (parsed.data.job_ids ?? []) : [];
  const body = jobIds.length ? JSON.stringify({ job_ids: jobIds }) : undefined;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${url}/wake`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.secret}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    // 202 = 异步受理（立即返回）；200 = 同步等待模式（WORKER_WAKE_SYNC，worker 已把任务跑完）
    if (res.ok) return { notified: true };
    return { notified: false, reason: `worker 返回 ${res.status}` };
  } catch (e) {
    return { notified: false, reason: (e as Error).message };
  }
}

/**
 * 业务侧入口：从 system_settings（DB > env，ADR-0015）解析唤醒配置并发送。
 * **调用方必须 await**（见文件头）：内部消化全部失败、最长等待 timeoutMs，
 * 业务响应仍是 202，只是确保外呼真的发出去了。
 */
export async function notifyWorkerWake(
  jobIds?: string[],
  opts?: { timeoutMs?: number },
): Promise<WakeNotifyResult> {
  const [url, secret] = await Promise.all([
    resolvePlain(SETTING_KEYS.workerNotifyUrl).catch(() => ""),
    resolveSecret("worker_notify_secret").catch(() => ""),
  ]);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;

  const parsed = WorkerWakeRequest.safeParse({ job_ids: jobIds });
  const ids = parsed.success ? (parsed.data.job_ids ?? []) : [];
  // invoked 模式：一次唤醒 = 一次异步实例。多模板提交必须逐任务各发一次，
  // 否则整批在同一实例内串行，后来的任务长时间停在 QUEUED 会被看门狗判失败（ADR-0017 §6）。
  // http 模式：多发几次只是多几轮空 drain（CAS 保证只有一个实例真正认领），代价可忽略。
  const result =
    ids.length > 1
      ? await Promise.all(ids.map((id) => postWorkerWake({ url, secret, jobIds: [id], timeoutMs }))).then((results) => {
          const failed = results.find((r) => !r.notified);
          return failed ? { notified: false, reason: failed.reason } : { notified: true };
        })
      : await postWorkerWake({ url, secret, jobIds: ids, timeoutMs });

  if (!result.notified) {
    console.warn(`[worker-notify] 唤醒通知未送达（${result.reason ?? "未知原因"}）；任务已入队，将由 worker 兜底拉取`);
  }
  return result;
}
