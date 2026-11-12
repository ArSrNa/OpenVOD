// 就绪探测端点（scripts/dev.ts 轮询 GET /healthz；ADR-0013 单容器形态）
// 语义：进程存活即 200；db 字段仅作观测，不参与状态码——避免远端库抖动导致启动脚本误判「启动超时」。
import { dbHealth } from "@openvod/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealth();
  // 探活结果随时会变，且 next.config.ts 的 headers() 已覆盖 /healthz（这里显式写一遍，
  // 避免日后调整 headers() 规则时探活被中间层缓存）
  return Response.json({ ok: true, db }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
