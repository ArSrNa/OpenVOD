// 转码 Worker 常驻容器入口（ADR-0008：禁止上函数，P0）
// 职责：轮询认领 transcode_jobs → 探测 → 逐档转码（可选 AES-128）→ 上传 → 密钥落库 → 状态联动。
// ADR-0015：启动只要求 DATABASE_URL / DB_PROVIDER / MASTER_KEYS；存储凭据与队列参数
// 从 system_settings 读取（首次启动向导写入，MK 封装密钥解封），env 同名键兜底。
import type { MasterKey } from "@openvod/crypto";
import { DEFAULT_LADDER } from "@openvod/transcode";
import { executeClaimedJob } from "./executor";
import { createPrismaTranscodeJobStore } from "./job-store";
import { createPrismaMediaKeyStore } from "./media-key-store";
import { createPrismaMediaStore } from "./media-store";
import { describeMasterKeys, loadMasterKeys } from "./media-keys";
import { loadWorkerSettings } from "./settings";

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

const jobStore = createPrismaTranscodeJobStore();
const mediaStore = createPrismaMediaStore();
const keyStore = createPrismaMediaKeyStore();

// 设置首载（DB > env；30s 缓存，每轮 tick 刷新参数，存储凭据变更自动重建适配器）
const boot = await loadWorkerSettings();
if (!boot.storageConfigured) {
  console.error(
    "[worker] 对象存储未配置：请先完成管理台首次启动向导（/setup）或配置 S3_* 环境变量后重启",
  );
  process.exit(1);
}
let storage = boot.storage;

let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

let pollIntervalMs = boot.pollIntervalMs;

/** 单轮：刷新设置（30s 缓存）→ 认领一个任务并执行（无可认领任务立即返回） */
async function tick(): Promise<void> {
  const s = await loadWorkerSettings().catch((e) => {
    console.error("[worker] 读取系统设置失败（沿用上次配置）:", (e as Error).message);
    return null;
  });
  if (s) {
    pollIntervalMs = s.pollIntervalMs;
    if (s.storageConfigured) storage = s.storage;
  }
  const job = await jobStore.claim({ leaseMs: s?.leaseMs ?? boot.leaseMs, maxAttempts: s?.maxAttempts ?? boot.maxAttempts });
  if (!job) return;

  console.log(`[worker] 认领任务 ${job.id}（媒资 ${job.mediaId}，第 ${job.attempts} 次尝试）`);
  try {
    const result = await executeClaimedJob(job, {
      jobStore,
      mediaStore,
      keyStore,
      storage,
      masterKeys,
      leaseMs: s?.leaseMs ?? boot.leaseMs,
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
  `[worker] polling every ${pollIntervalMs}ms（lease ${boot.leaseMs}ms，最大尝试 ${boot.maxAttempts} 次）`,
);
while (running) {
  await tick().catch((e) => console.error("[worker] tick error:", (e as Error).message));
  await Bun.sleep(pollIntervalMs);
}
console.log("[worker] bye");
