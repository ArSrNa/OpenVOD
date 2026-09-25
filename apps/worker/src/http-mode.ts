// HTTP 门铃模式（ADR-0017 §2）：Bun.serve 暴露 POST /wake，Bearer 共享密钥鉴权；
// 收到合法请求 → 异步触发一轮 claim-drain（转码不占请求生命周期）→ 立即 202。
// 可选空闲退出：最后一次 drain 结束后连续超过 idleExitMs 无新唤醒 → 调用 onIdle（加速平台缩零）。
// 依赖注入（schedule/now/log）便于单测不依赖真实计时。
import { createHash, timingSafeEqual } from "node:crypto";

export interface HttpWorkerOptions {
  port: number;
  /** Bearer 共享密钥（WORKER_NOTIFY_SECRET）；为空必须拒绝启动——无鉴权的唤醒端点 = 计费攻击面 */
  notifySecret: string;
  /** 收到合法 /wake 时调用（内部做 claim-drain 直到队列空；异常必须自行消化） */
  onWake(): void | Promise<void>;
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

/** Bearer 常量时间比较：先 SHA-256 定长再 timingSafeEqual，避免长度泄露与伪命中 */
function bearerMatches(authorization: string | null, secret: string): boolean {
  if (!authorization) return false;
  const [scheme, token] = authorization.split(" ", 2);
  if (scheme !== "Bearer" || !token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export function createHttpWorker(opts: HttpWorkerOptions): HttpWorker {
  const schedule = opts.schedule ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((msg: string) => console.log(`[worker] ${msg}`));
  const idleExitMs = opts.idleExitMs && opts.idleExitMs > 0 ? opts.idleExitMs : 0;

  let server: ReturnType<typeof Bun.serve> | null = null;
  let draining = false;
  let lastDoneAt = now();
  let cancelIdle: (() => void) | null = null;

  /** 合并并发唤醒：drain 循环本身跑到队列空，唤醒风暴只触发一轮 */
  function kickDrain(): void {
    if (draining) return;
    draining = true;
    Promise.resolve()
      .then(() => opts.onWake())
      .catch((e) => log(`drain 出错：${(e as Error).message}`))
      .finally(() => {
        draining = false;
        lastDoneAt = now();
        armIdleCheck();
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
        fetch(req) {
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname === "/healthz") {
            return Response.json({ status: "ok", draining });
          }
          if (req.method === "POST" && url.pathname === "/wake") {
            if (!bearerMatches(req.headers.get("authorization"), opts.notifySecret)) {
              return Response.json({ error: "unauthorized" }, { status: 401 });
            }
            kickDrain();
            return Response.json({ accepted: true }, { status: 202 });
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
