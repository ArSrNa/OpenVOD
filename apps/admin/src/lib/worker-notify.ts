// admin → worker HTTP 门铃（ADR-0017 §3）：发起转码 / 任务重启成功后 fire-and-forget
// POST {WORKER_NOTIFY_URL}/wake（Bearer WORKER_NOTIFY_SECRET），加速 worker 认领。
// 设计原则：通知可以丢（任务留存 transcode_jobs，靠平台定时拉起或人工重启兜底），事实源不能丢。
// 因此失败仅告警、绝不阻塞业务响应；未配置 WORKER_NOTIFY_URL 时安静跳过。
import { SETTING_KEYS } from "@openvod/shared";
import { resolvePlain, resolveSecret } from "./settings";

export interface WakeNotifyResult {
  notified: boolean;
  reason?: string;
}

/** 纯装配：给定地址 / 密钥 / fetch 实现，POST /wake 并归一化结果（不抛异常） */
export async function postWorkerWake(deps: {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WakeNotifyResult> {
  const url = deps.url.replace(/\/+$/, "");
  if (!url) return { notified: false, reason: "未配置 worker_notify_url" };
  if (!deps.secret) return { notified: false, reason: "未配置 worker_notify_secret，跳过通知" };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${url}/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.secret}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (res.status === 202) return { notified: true };
    return { notified: false, reason: `worker 返回 ${res.status}` };
  } catch (e) {
    return { notified: false, reason: (e as Error).message };
  }
}

/**
 * 业务侧入口：从 system_settings（DB > env，ADR-0015）解析唤醒配置并发送。
 * fire-and-forget 语义——内部消化全部失败，调用方无需 await 结果；
 * 返回 Promise 仅为便于测试观测。
 */
export async function notifyWorkerWake(): Promise<WakeNotifyResult> {
  const [url, secret] = await Promise.all([
    resolvePlain(SETTING_KEYS.workerNotifyUrl).catch(() => ""),
    resolveSecret("worker_notify_secret").catch(() => ""),
  ]);
  const result = await postWorkerWake({ url, secret });
  if (!result.notified) {
    console.warn(`[worker-notify] 唤醒通知未送达（${result.reason ?? "未知原因"}）；任务已入队，将由 worker 兜底拉取`);
  }
  return result;
}
