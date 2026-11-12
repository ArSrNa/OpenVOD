// 门铃式入口（ADR-0017 §2 / 2026-11-13 修订）：Bun.serve 暴露 POST /wake，Bearer 共享密钥鉴权；
// 收到合法请求 → 异步触发一轮 claim-drain（转码不占请求生命周期）→ 立即 202。
//
// 两种模式的差别只在 onWake 的载荷：
//   http    ：忽略载荷，扫描队列直到空（队列模式）；
//   invoked ：载荷里的 job_ids 定向认领（异步云函数触发，不扫队列），空载荷才退回扫描。
//
// 可选空闲退出：最后一次 drain 结束后连续超过 idleExitMs 无新唤醒 → 调用 onIdle
// （加速平台缩零）。invoked 模式建议开启（1~5 分钟）——否则实例跑完仍活着，
// 异步平台可能按进程存活继续计费。
// 依赖注入（schedule/now/log）便于单测不依赖真实计时。
import { createHash, timingSafeEqual } from "node:crypto";

export interface HttpWorkerOptions {
  port: number;
  /** Bearer 共享密钥（WORKER_NOTIFY_SECRET）；为空必须拒绝启动——无鉴权的唤醒端点 = 计费攻击面 */
  notifySecret: string;
  /** 收到合法 /wake 时调用（http 模式做 claim-drain 直到队列空；invoked 模式按 jobIds 定向认领） */
  onWake(jobIds: string[]): void | Promise<void>;
  /** 空闲退出阈值（毫秒）；缺省 / 0 = 不退出 */
  idleExitMs?: number;
  /** 空闲超时回调（ graceful 退出由调用方实现） */
  onIdle?(): void;
  /** 调度器（默认 setTimeout；单测注入手动推进） */
  schedule?: (ms: number, fn: () => void) => () => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface HttpWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 实际监听端口（port: 0 随机分配时用于日志 / 测试） */
  port(): number;
  /** 测试观测点：当前是否有 drain 在跑 */
  isDraining(): boolean;
}

const DEFAULT_CHECK_MS = 60_000;
/** /wake 载荷只带 jobId，限制条数防滥用（多模板单次最多 10 条，留余量） */
const MAX_JOB_IDS = 50;

/** Bearer 常量时间比较：先 SHA-256 定长再 timingSafeEqual，避免长度泄露与伪命中 */
function bearerMatches(authorization: string | null, secret: string): boolean {
  if (!authorization) return false;
  const [scheme, token] = authorization.split(" ", 2);
  if (scheme !== "Bearer" || !token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * 解析 /wake 载荷里的 job_ids（可选）。
 * 非法 JSON / 非数组一律按「空」处理 = 扫描队列（http 模式兼容旧调用方：无 body）。
 */
async function readJobIds(req: Request): Promise<string[]> {
  // 载荷只该有若干 jobId；超大 body 直接忽略（有密钥也不让 /wake 成为内存放大器）
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 64 * 1024) return [];
  const text = await req.text().catch(() => "");
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as { job_ids?: unknown };
    if (!Array.isArray(parsed.job_ids)) return [];
    const ids = parsed.job_ids
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    return [...new Set(ids)].slice(0, MAX_JOB_IDS);
  } catch {
    return [];
  }
}

export function createHttpWorker(opts: HttpWorkerOptions): HttpWorker {
  const schedule = opts.schedule ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((msg: string) => console.log(`[worker] ${msg}`));
  const idleExitMs = opts.idleExitMs && opts.idleExitMs > 0 ? opts.idleExitMs : 0;

  let server: ReturnType<typeof Bun.serve> | null = null;
  let draining = false;
  /** 待认领的 jobId（invoked 模式）：drain 期间到达的唤醒不丢，合并到下一轮 */
  let pending: string[] = [];
  let lastDoneAt = now();
  let cancelIdle: (() => void) | null = null;

  /**
   * 合并并发唤醒：drain 循环本身跑到队列空，唤醒风暴只触发一轮。
   * invoked 模式的 jobId 先入 pending —— 正在跑的那轮结束后会再起一轮，不会遗漏。
   */
  function kickDrain(jobIds: string[]): void {
    for (const id of jobIds) if (!pending.includes(id)) pending.push(id);
    if (draining) return;
    draining = true;
    Promise.resolve()
      .then(() => {
        const ids = pending;
        pending = [];
        return opts.onWake(ids);
      })
      .catch((e) => log(`drain 出错：${(e as Error).message}`))
      .finally(() => {
        draining = false;
        lastDoneAt = now();
        armIdleCheck();
        if (pending.length) kickDrain([]); // drain 期间又是新的唤醒
      });
  }

  function armIdleCheck(): void {
    cancelIdle?.();
    cancelIdle = null;
    if (!idleExitMs || draining) return;
    cancelIdle = schedule(Math.min(idleExitMs, DEFAULT_CHECK_MS), checkIdle);
  }

  function checkIdle(): void {
    cancelIdle = null;
    if (draining) return; // 执行中不判空闲（下一次 finally 会重新 arm）
    if (now() - lastDoneAt >= idleExitMs) {
      log(`空闲超过 ${Math.round(idleExitMs / 60000)} 分钟，准备退出`);
      opts.onIdle?.();
      return;
    }
    armIdleCheck();
  }

  return {
    async start() {
      if (!opts.notifySecret) {
        throw new Error("http 模式必须配置 WORKER_NOTIFY_SECRET（无鉴权的 /wake 端点会成为计费攻击面）");
      }
      server = Bun.serve({
        port: opts.port,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname === "/healthz") {
            return Response.json({ status: "ok", draining });
          }
          if (req.method === "POST" && url.pathname === "/wake") {
            if (!bearerMatches(req.headers.get("authorization"), opts.notifySecret)) {
              return Response.json({ error: "unauthorized" }, { status: 401 });
            }
            const jobIds = await readJobIds(req);
            kickDrain(jobIds);
            return Response.json({ accepted: true, job_ids: jobIds.length || null }, { status: 202 });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });
      lastDoneAt = now();
      armIdleCheck();
      log(`http 门铃模式 listening :${opts.port}（/wake + /healthz${idleExitMs ? `，空闲 ${Math.round(idleExitMs / 60000)} 分钟退出` : ""}）`);
    },
    async stop() {
      cancelIdle?.();
      cancelIdle = null;
      server?.stop();
      server = null;
    },
    port: () => server?.port ?? 0,
    isDraining: () => draining,
  };
}
