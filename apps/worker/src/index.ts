// 转码 Worker 常驻容器入口（ADR-0008：禁止上函数，P0）
// 职责：轮询认领 transcode_jobs → 探测 → 逐档转码（可选 AES-128）→ 上传 → 密钥落库 → 状态联动。
import type { MasterKey } from "@openvod/crypto";
import { createStorageFromEnv } from "@openvod/storage";
import { DEFAULT_LADDER } from "@openvod/transcode";
import { executeClaimedJob } from "./executor";
import { createPrismaTranscodeJobStore } from "./job-store";
import { createPrismaMediaKeyStore } from "./media-key-store";
import { createPrismaMediaStore } from "./media-store";
import { describeMasterKeys, loadMasterKeys } from "./media-keys";

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

// 密钥前置自检（spec.md §4.2）：加密任务必需 MASTER_KEYS，未加密任务不依赖它 → 告警而非退出
let masterKeys: MasterKey[] | undefined;
try {
  masterKeys = loadMasterKeys();
  console.log(`[worker] MASTER_KEYS ${describeMasterKeys(masterKeys)}`);
} catch (e) {
  console.warn(`[worker] ${(e as Error).message} —— 加密转码任务将失败（未加密模板不受影响）`);
}

const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const leaseMs = Number(process.env.WORKER_LEASE_MS ?? 60_000);
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);

const jobStore = createPrismaTranscodeJobStore();
const mediaStore = createPrismaMediaStore();
const keyStore = createPrismaMediaKeyStore();
const storage = createStorageFromEnv();

let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

/** 单轮：认领一个任务并执行（无可认领任务立即返回） */
async function tick(): Promise<void> {
  const job = await jobStore.claim({ leaseMs, maxAttempts });
  if (!job) return;

  console.log(`[worker] 认领任务 ${job.id}（媒资 ${job.mediaId}，第 ${job.attempts} 次尝试）`);
  try {
    const result = await executeClaimedJob(job, {
      jobStore,
      mediaStore,
      keyStore,
      storage,
      masterKeys,
      leaseMs,
      log: (msg) => console.log(`[worker] ${msg}`),
    });
    const variants = result.variants.map((v) => `${v.name}(${v.files} 文件)`).join(" / ");
    console.log(
      `[worker] 任务 ${job.id} 完成：${variants}${result.encrypted ? "｜AES-128 加密" : ""}` +
        `${result.sourceFallback ? "｜按源规格兜底产出（无降级维度）" : ""}` +
        `｜上传 ${result.uploadedObjects} 个对象` +
        `${result.deletedStaleObjects ? `｜清理旧产物 ${result.deletedStaleObjects} 个` : ""}`,
    );
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[worker] 任务 ${job.id} 失败：${message}`);
    await jobStore
      .setStatus(job.id, "FAILED", { lastError: message, finishedAt: new Date(), leaseUntil: null })
      .catch((err) => console.error("[worker] 标记失败状态出错:", err));
  }
}

console.log(
  `[worker] polling every ${intervalMs}ms（lease ${leaseMs}ms，最大尝试 ${maxAttempts} 次）`,
);
while (running) {
  await tick().catch((e) => console.error("[worker] tick error:", (e as Error).message));
  await Bun.sleep(intervalMs);
}
console.log("[worker] bye");
