// /api/admin/jobs/stream：转码任务实时推送（SSE；spec.md §2.1 / §3.1）
// 契约：连接即回放全量快照（event: jobs），此后仅在服务端观察到快照变化时推送（全量覆盖，幂等）；
// event: ping 为保活心跳；连接到期 / 断线由浏览器按 retry 提示自动重连（重连即重新校验会话）。
// 客户端不轮询；服务端观察机制见 lib/jobs-stream（多连接共享同一观察循环）。
import { NextRequest } from "next/server";
import { getAdminSession, unauthorized } from "@/lib/api";
import { jobsHub } from "@/lib/jobs-live";

export const dynamic = "force-dynamic";
// 长连接流式响应：固定 Node 运行时（管理端本就是 Node 容器，ADR-0013）
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;
/** 连接寿命上限：到期主动断开 → EventSource 自动重连，顺带重新校验会话（吊销可收敛） */
const MAX_CONNECTION_MS = 10 * 60_000;

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();

  const encoder = new TextEncoder();
  let dispose = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = (): void => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let expiry: ReturnType<typeof setTimeout> | null = null;

      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close(); // 对端已断：按正常关闭收尾（取消订阅 / 清定时器）
        }
      };
      const send = (event: string, data: unknown): void =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (expiry) clearTimeout(expiry);
        unsubscribe();
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // 已被运行时关闭，忽略
        }
      };
      dispose = close;

      write("retry: 3000\n\n"); // 断线重连间隔提示
      write(": connected\n\n"); // 立刻冲掉响应头，浏览器才会认为连接建立
      unsubscribe = jobsHub.subscribe((snapshot) => send("jobs", snapshot));
      heartbeat = setInterval(() => send("ping", Date.now()), HEARTBEAT_MS);
      expiry = setTimeout(close, MAX_CONNECTION_MS);
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      dispose();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // 绝不进任何缓存 / 转换层（与 m3u8 / key 的 no-store 纪律同源）
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // 反向代理（nginx 等）不缓冲，否则事件被攒着不发
      "X-Accel-Buffering": "no",
    },
  });
}
