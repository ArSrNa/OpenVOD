// 转码 Worker 常驻容器入口（ADR-0008：禁止上函数，P0）
// 骨架：工具链自检 + 轮询框架；认领/执行/lease 续期逻辑随 specification 实现。
import { DEFAULT_LADDER } from "@openvod/transcode";

interface ToolCheck {
  name: string;
  bin: string;
  ok: boolean;
}

function checkTools(): ToolCheck[] {
  const checks: Array<[string, string]> = [
    ["ffmpeg", "ffmpeg"],
    ["ffprobe", "ffprobe"],
    ["shaka-packager（CENC 演进用）", "packager"],
    ["bento4（CENC 演进用）", "mp4info"],
  ];
  return checks.map(([name, bin]) => ({ name, bin, ok: Boolean(Bun.which(bin)) }));
}

const REQUIRED = ["ffmpeg", "ffprobe"];
const tools = checkTools();
for (const t of tools) {
  console.log(`[worker] ${t.bin.padEnd(8)} ${t.ok ? "ok" : "MISSING"}  # ${t.name}`);
}
const missing = tools.filter((t) => REQUIRED.includes(t.bin) && !t.ok);
if (missing.length) {
  console.error(`[worker] 缺少必需工具：${missing.map((t) => t.bin).join(", ")}（镜像应含转码链路，见 .ide/Dockerfile）`);
  process.exit(1);
}

console.log(`[worker] ladder = ${DEFAULT_LADDER.map((e) => e.name).join(" / ")}`);

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

async function tick(): Promise<void> {
  // TODO(specification, ADR-0008)：
  // 1) 认领：MySQL `FOR UPDATE SKIP LOCKED` / SQLite CAS，写 leaseUntil
  // 2) 预取源片 → ffprobe → 回写 media.probe
  // 3) 生成 CEK/IV/kid → key_info（@openvod/transcode buildKeyInfoFile）
  // 4) 逐档 ffmpeg（planHlsArgs）→ 产物上传（@openvod/storage）
  // 5) wrap CEK 写 hls_keys；media 状态联动；清理临时目录
  await Bun.sleep(0);
}

console.log(`[worker] polling every ${intervalMs}ms (scaffold: tick 为空实现)`);
while (running) {
  await tick().catch((e) => console.error("[worker] tick error:", e));
  await Bun.sleep(intervalMs);
}
console.log("[worker] bye");
