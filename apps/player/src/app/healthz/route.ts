// 就绪探测端点（scripts/dev.ts 轮询 GET /healthz；语义同 admin：进程存活即 200）
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, app: "player" }, { status: 200 });
}
