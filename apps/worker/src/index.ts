// 转码 Worker 入口（ADR-0008：禁止上函数，P0；ADR-0017：resident / http 双模式）。
// 职责：认领 transcode_jobs → 探测 → 逐档转码（可选 AES-128）→ 上传 → 密钥落库 → 状态联动。
// resident = 常驻轮询（自托管 / 本地开发）；http = 门铃模式，POST /wake 触发 claim-drain（serverless）。
// ADR-0015：启动只要求 DATABASE_URL / DB_PROVIDER / MASTER_KEYS；存储凭据与队列参数
// 从 system_settings 读取（首次启动向导写入，MK 封装密钥解封），env 同名键兜底。
import type { MasterKey } from "@openvod/crypto";
import { DEFAULT_LADDER, WATERMARK_FONT_FILES, WATERMARK_FONT_ROOT } from "@openvod/transcode";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeClaimedJob, JobCancelledError } from "./executor";
import { createHttpWorker } from "./http-mode";
import { createJobLogSink } from "./job-log";
import { createPrismaTranscodeJobStore } from "./job-store";
import { createPrismaMediaKeyStore } from "./media-key-store";
import { createPrismaMediaStore } from "./media-store";
import { describeMasterKeys, loadMasterKeys } from "./media-keys";
import { loadWorkerMode, loadWorkerSettings, pingDb } from "./settings";
import { createSourceResolver, type SourceFetcher } from "./source-fetch";

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

/**
 * 文字水印字体自检（spec.md §10.6 / ADR-0018）：drawtext 的 fontfile 缺失时 ffmpeg **不会报错**，
 * 而是静默回退到 fontconfig 默认字体——中文会渲染成豆腐块且任务仍报成功。故在此显式告警。
 * 与 ffmpeg 一样按「非必需」处理（只有用到文字水印的模板才受影响），不阻断启动。
 */
function checkWatermarkFonts(): void {
  const missing = Object.entries(WATERMARK_FONT_FILES)
    .filter(([, file]) => !existsSync(join(WATERMARK_FONT_ROOT, file)))
    .map(([font, file]) => `${font}→${file}`);
  if (!missing.length) {
    console.log(`[worker] 字体   ok    # 水印字体 ${WATERMARK_FONT_ROOT}（${Object.keys(WATERMARK_FONT_FILES).length} 种）`);
    return;
  }
  console.warn(
    `[worker] 字体   MISSING  # 水印字体缺失：${missing.join(", ")}（镜像应装 fonts-noto-cjk，见 .ide/Dockerfile）` +
      `—— 文字水印将回退到系统默认字体，中文可能渲染为豆腐块`,
  );
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
checkWatermarkFonts();

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

// 设置首载（DB > env；30s 缓存，每轮刷新参数，存储凭据变更自动重建适配器）。
// serverless DB 冷启动：自动暂停的库首连会失败，带指数退避重试（ADR-0017 §5）。
async function withDbRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const baseMs = 2_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === 5) break;
      const wait = baseMs * 2 ** (attempt - 1);
      console.warn(`[worker] ${label} 失败（${(e as Error).message}），${wait}ms 后重试（第 ${attempt}/5 次）`);
      await Bun.sleep(wait);
    }
  }
  throw lastErr;
}

const boot = await withDbRetry(async () => {
  await pingDb(); // loadWorkerSettings 对查询失败吞错为空快照，先探活区分「库未醒」与「真未配置」
  return loadWorkerSettings();
}, "数据库探活");
if (!boot.storageConfigured) {
  console.error(
    "[worker] 对象存储未配置：请先完成管理台首次启动向导（/setup）或配置 S3_* 环境变量后重启",
  );
  process.exit(1);
}
let storage = boot.storage;
// 取源通路优选（2026-10-17）：源片 / 水印图走存储直连（内网端点可选），不绕 CDN；
// 候选变化（设置里改端点等）时重建，解析器的探测结果缓存随实例保留
const fetcherKeyOf = (fetchers: SourceFetcher[]) => fetchers.map((f) => f.id).join("|");
const sourceLog = (m: string) => console.log(`[worker] ${m}`);
let sourceFetcherKey = fetcherKeyOf(boot.sourceFetchers);
let sourceResolver = createSourceResolver(boot.sourceFetchers, { log: sourceLog });
const mode = await loadWorkerMode();

let running = true;
process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

let pollIntervalMs = boot.pollIntervalMs;
/**
 * 任务临时目录根（ADR-0017 修订）：异步云函数实例的本地 /tmp 装不下「源片 + 全档产物」峰值，
 * 必须挂文件系统（CFS / NAS）并把 `WORKER_JOBS_ROOT` 指过去；不配则沿用 os.tmpdir()。
 */
const jobsRoot = process.env.WORKER_JOBS_ROOT?.trim() || undefined;

/** 认领并执行单个任务（无可认领任务返回 false）；各模式共用；jobId 有值时定向认领 */
async function runOnce(jobId?: string): Promise<boolean> {
  const s = await loadWorkerSettings().catch((e) => {
    console.error("[worker] 读取系统设置失败（沿用上次配置）:", (e as Error).message);
    return null;
  });
  if (s) {
    pollIntervalMs = s.pollIntervalMs;
    if (s.storageConfigured) {
      storage = s.storage;
      const key = fetcherKeyOf(s.sourceFetchers);
      if (key !== sourceFetcherKey) {
        sourceFetcherKey = key;
        sourceResolver = createSourceResolver(s.sourceFetchers, { log: sourceLog });
      }
    }
  }
  const claimOpts = { leaseMs: s?.leaseMs ?? boot.leaseMs, maxAttempts: s?.maxAttempts ?? boot.maxAttempts };
  const job = jobId ? await jobStore.claimById(jobId, claimOpts) : await jobStore.claim(claimOpts);
  if (!job) {
    if (jobId) console.log(`[worker] 任务 ${jobId} 不可认领（已终结 / 租约有效 / 超限），跳过`);
    return false;
  }

  // 实时日志（ADR-0017 修订）：阶段日志 + ffmpeg stderr 进环形尾部，每 2s 覆盖写 log_tail
  const sink = createJobLogSink({ write: (tail) => jobStore.writeLog(job.id, tail) });
  const say = (msg: string) => {
    console.log(`[worker] ${msg}`);
    sink.line(msg);
  };
  say(`认领任务 ${job.id}（媒资 ${job.mediaId}，第 ${job.attempts} 次尝试）`);

  try {
    const result = await executeClaimedJob(job, {
      jobStore,
      mediaStore,
      keyStore,
      storage,
      // 取源 / 水印图：走优选通路（内网 → 直连 → CDN 兜底），不默认绕 CDN
      resolveSourceUrl: (key, ttlSec) => sourceResolver.resolve(key, ttlSec).then((r) => r.url),
      masterKeys,
      leaseMs: s?.leaseMs ?? boot.leaseMs,
      jobsRoot,
      log: (msg) => console.log(`[worker] ${msg}`),
      onLog: (line) => sink.line(line),
    });
    const variants = result.variants.map((v) => `${v.name}(${v.files} 文件)`).join(" / ");
    say(
      `任务 ${job.id} 完成：${variants}${result.encrypted ? "｜AES-128 加密" : ""}` +
        `${result.sourceFallback ? "｜按源规格兜底产出（无降级维度）" : ""}` +
        `｜上传 ${result.uploadedObjects} 个对象` +
        `${result.deletedStaleObjects ? `｜清理旧产物 ${result.deletedStaleObjects} 个` : ""}`,
    );
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof JobCancelledError) {
      // 取消是用户意图，不写 last_error：管理端靠 CANCELLED 状态区分「失败」与「取消」（spec.md §5.1）
      say(`任务 ${job.id} 已取消：${message}`);
      await jobStore
        .setStatus(job.id, "CANCELLED", { lastError: null, finishedAt: new Date(), leaseUntil: null, progress: null })
        .catch((err) => console.error("[worker] 标记取消状态出错:", err));
      return true;
    }
    say(`任务 ${job.id} 失败：${message}`);
    await jobStore
      .setStatus(job.id, "FAILED", { lastError: message, finishedAt: new Date(), leaseUntil: null, progress: null })
      .catch((err) => console.error("[worker] 标记失败状态出错:", err));
  } finally {
    // 最后一次覆盖写（成功 / 失败 / 取消都要落，否则日志尾部停在中断前）
    await sink.stop();
  }
  return true;
}

/**
 * 一轮 drain（/wake 触发体）：
 *   jobIds 非空 = invoked 模式，只认领载荷里的任务（不扫队列，重复投递由 CAS 挡住）；
 *   jobIds 为空 = http 模式，循环认领直到队列空。
 */
async function drainOnce(jobIds: string[] = []): Promise<void> {
  const runGuarded = (id?: string) =>
    runOnce(id).catch((e) => {
      console.error("[worker] drain error:", (e as Error).message);
      return false;
    });
  if (jobIds.length) {
    for (const id of jobIds) {
      if (!running) return;
      await runGuarded(id);
    }
    return;
  }
  while (running && (await runGuarded())) {
    // runOnce 返回 true = 执行了一个任务，继续认领
  }
}

if (mode === "http" || mode === "invoked") {
  // ---- 门铃模式（ADR-0017 §2 + 2026-11-13 修订）：/wake 触发 drain，空闲超时退出加速平台缩零 ----
  const idleExitMinutes = Math.max(0, Number(process.env.WORKER_IDLE_EXIT_MINUTES ?? "0") || 0);
  /**
   * 同步唤醒（2026-11-14，SCF WebServer 镜像函数）：这类平台的实例存活期 = 一次请求的响应周期，
   * 202 一返回就冻结实例，后台 drain 里的 ffmpeg 会被挂起。开 WORKER_WAKE_SYNC=1 让 /wake
   * 等任务跑完再响应，配合 SCF「异步执行」（调用方立即拿 RequestId、函数最长 24h）才能跑长任务。
   */
  const awaitDrain = /^(1|true)$/i.test(process.env.WORKER_WAKE_SYNC?.trim() ?? "");
  const worker = createHttpWorker({
    port: Number(process.env.WORKER_HTTP_PORT ?? "9001") || 9001,
    notifySecret: process.env.WORKER_NOTIFY_SECRET ?? "",
    awaitDrain,
    onWake: (jobIds) => drainOnce(jobIds),
    idleExitMs: idleExitMinutes > 0 ? idleExitMinutes * 60_000 : 0,
    onIdle: () => {
      console.log("[worker] 空闲退出（队列已空，等待下次唤醒）");
      void worker.stop().finally(() => process.exit(0));
    },
  });
  await worker.start();
  console.log(
    `[worker] 运行模式 ${mode}${jobsRoot ? `，任务目录 ${jobsRoot}` : `，任务目录 ${join(tmpdir(), "openvod-jobs")}（默认）`}`,
  );
  process.on("SIGTERM", () => void worker.stop());
  process.on("SIGINT", () => void worker.stop());
} else {
  // ---- resident 模式（默认）：常驻轮询 ----
  console.log(
    `[worker] polling every ${pollIntervalMs}ms（lease ${boot.leaseMs}ms，最大尝试 ${boot.maxAttempts} 次）`,
  );
  while (running) {
    await runOnce().catch((e) => console.error("[worker] tick error:", (e as Error).message));
    await Bun.sleep(pollIntervalMs);
  }
  console.log("[worker] bye");
}
