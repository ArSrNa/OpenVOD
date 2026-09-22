// 就绪探测端点（scripts/dev.ts 轮询 GET /healthz；ADR-0013 单容器形态）
// 语义：进程存活即 200；db 字段仅作观测，不参与状态码——避免远端库抖动导致启动脚本误判「启动超时」。
import { dbHealth } from "@openvod/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealth();
  return Response.json({ ok: true, db }, { status: 200 });
}
