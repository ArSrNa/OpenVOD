// 转码任务执行器（ADR-0008；M2 主干）
//
// 流程：认领后 → 探测(ffprobe) → 编译 argv（模板快照 + 实测源参数）→ 逐档 ffmpeg →
//       上传 proceed/{id}/{模板id}/ → 生成主清单 → **产物上传成功后**落 hls_keys → 媒资状态联动 → 清理临时目录。
// 产物按模板分组（spec.md §1.3）：同一媒资可由多个模板各出一套产物并存，故清理只作用于本模板子树。
//
// 依赖全部注入（jobStore / mediaStore / keyStore / storage），便于单测用假实现 + 真实 ffmpeg 跑端到端。
// 纪律：argv 一律数组插值（绝不经 shell，ADR-0008）；明文 CEK 只存在于任务临时目录，finally 必删。
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscodeTemplateSnapshot } from "@openvod/contracts";
import type { MasterKey } from "@openvod/crypto";
import { DEFAULTS, STORAGE_PARTITIONS } from "@openvod/shared";
import type { StorageAdapter } from "@openvod/storage";
import {
  buildMasterPlaylist,
  compileKeepOriginal,
  compileSourceMatched,
  compileTemplate,
  ffprobeJSON,
  runFFmpeg,
  summarizeProbe,
  type LadderEntry,
  type SourceInfo,
  type VariantPlan,
} from "@openvod/transcode";
import type { TranscodeJobRow, TranscodeJobStore } from "./job-store";
import { cleanupJobDir, writeKeyFiles } from "./key-files";
import { loadMasterKeys, persistMediaKey, resolveMediaKey, type ResolvedMediaKey } from "./media-keys";
import type { MediaKeyStore } from "./media-key-store";
import type { MediaStatusName, MediaStore } from "./media-store";

export class JobExecutionError extends Error {}

export interface JobExecutorDeps {
  jobStore: TranscodeJobStore;
  mediaStore: MediaStore;
  keyStore: MediaKeyStore;
  storage: StorageAdapter;
  /** 加密任务用 MK；缺省从 MASTER_KEYS 解析 */
  masterKeys?: MasterKey[];
  /** 任务临时目录根，缺省 `{os.tmpdir()}/openvod-jobs` */
  jobsRoot?: string;
  /** lease 时长（毫秒），执行期按 1/3 周期续期 */
  leaseMs?: number;
  hlsTimeSec?: number;
  log?: (msg: string) => void;
}

export interface ExecutedVariant {
  name: string;
  width: number;
  height: number;
  /** 该档产出的对象数（清单 + 分片） */
  files: number;
}

export interface ExecuteJobResult {
  variants: ExecutedVariant[];
  /** 被判定跳过的档位（三维度均不低于源） */
  skipped: string[];
  /** 该模板全部档位均无降级维度 → 已按源规格兜底产出一档（分辨率 / 帧率 / 码率保持原视频） */
  sourceFallback: boolean;
  encrypted: boolean;
  /** 密钥行是否替换了既有行（encrypted=false 时为 null；复用已有密钥时为 null） */
  replacedKey: boolean | null;
  /** 是否复用了该媒资已有密钥（多模板产物共用一份 CEK，spec.md §4.2） */
  keyReused: boolean;
  /** 产物落位前缀 `proceed/{id}/{templateId}` */
  outputPrefix: string;
  uploadedObjects: number;
  deletedStaleObjects: number;
}

const M3U8_CONTENT_TYPE = "application/vnd.apple.mpegurl";
const TS_CONTENT_TYPE = "video/mp2t";

function contentTypeFor(rel: string): string {
  if (rel.endsWith(".m3u8")) return M3U8_CONTENT_TYPE;
  if (rel.endsWith(".ts")) return TS_CONTENT_TYPE;
  return "application/octet-stream";
}

/** 模板快照校验（防脏快照：快照是 argv 编译的唯一输入，ADR-0014） */
function parseSnapshot(raw: unknown): { snapshot: TranscodeSnapshot; params: unknown } {
  const parsed = TranscodeTemplateSnapshot.safeParse(raw);
  if (!parsed.success) {
    throw new JobExecutionError(`模板快照非法（任务无法执行）：${parsed.error.issues[0]?.message ?? "未知"}`);
  }
  return { snapshot: parsed.data, params: parsed.data.params };
}
type TranscodeSnapshot = ReturnType<typeof TranscodeTemplateSnapshot.parse>;

/**
 * 主清单 BANDWIDTH 估算：仅在 v1 无目标码率（CRF 模式）/ 只加密流程时按高度粗估。
 * 该值只影响播放器起播选档提示，不影响编码质量与产物字节。
 */
function estimateVideoKbps(height: number, declared?: number | null): number {
  if (declared != null) return declared;
  if (height >= 2160) return 15000;
  if (height >= 1440) return 9000;
  if (height >= 1080) return 5000;
  if (height >= 720) return 2800;
  if (height >= 480) return 1400;
  return 800;
}

/**
 * 按模板快照编译逐档计划（keep_original = 只加密流程，单档 -c copy）。
 * 常规模板若**全部档位均无降级维度**（分辨率 / 帧率 / 码率都 ≥ 源），
 * 不空手失败：追加一档「源规格兜底」（compileSourceMatched）——编码器 / 加密按模板，
 * 分辨率 / 帧率 / 码率保持原视频（intent 规则 3，2026-09-18 修订）。
 */
function buildPlans(
  snapshot: TranscodeSnapshot,
  source: SourceInfo,
  opts: { input: string; outRoot: string; keyInfoPath?: string; hlsTimeSec: number },
): { plans: VariantPlan[]; entries: LadderEntry[]; sourceFallback: boolean } {
  let plans: VariantPlan[];
  let sourceFallback = false;

  if (snapshot.keep_original) {
    plans = [
      {
        name: source.height > 0 ? `${source.height}p` : "source",
        width: source.width,
        height: source.height,
        skipped: false,
        argv: compileKeepOriginal({
          input: opts.input,
          outDir: `${opts.outRoot}/${source.height > 0 ? `${source.height}p` : "source"}`,
          keyInfoPath: opts.keyInfoPath,
          hlsTimeSec: opts.hlsTimeSec,
        }),
      },
    ];
  } else {
    plans = compileTemplate(snapshot.params, source, {
      input: opts.input,
      outRoot: opts.outRoot,
      keyInfoPath: opts.keyInfoPath,
      hlsTimeSec: opts.hlsTimeSec,
    });
    if (plans.every((p) => p.skipped)) {
      plans = [
        ...plans,
        compileSourceMatched(snapshot.params, source, {
          input: opts.input,
          outRoot: opts.outRoot,
          keyInfoPath: opts.keyInfoPath,
          hlsTimeSec: opts.hlsTimeSec,
        }),
      ];
      sourceFallback = true;
    }
  }

  const params = (snapshot.params ?? null) as { bitrate_kbps?: number; audio_bitrate_kbps?: number } | null;
  const entries: LadderEntry[] = plans
    .filter((p) => !p.skipped)
    .map((p) => ({
      name: p.name,
      width: p.width,
      height: p.height,
      videoBitrateK: p.videoBitrateK ?? estimateVideoKbps(p.height, params?.bitrate_kbps ?? null),
      audioBitrateK: params?.audio_bitrate_kbps ?? 128,
    }));
  return { plans, entries, sourceFallback };
}

/** local 直读文件路径；s3 走预签名 GET（字节不经 Worker 落盘，ffmpeg 原生支持 http 输入） */
async function resolveInput(storage: StorageAdapter, key: string): Promise<string> {
  if (typeof storage.getFilePath === "function") {
    try {
      return storage.getFilePath(key);
    } catch {
      // 落到预签名分支（例如 local 适配器未配置本地根）
    }
  }
  return storage.presignGet(key, 6 * 3600);
}

async function resolveSourceKey(storage: StorageAdapter, mediaId: string, sourceKey: string | null): Promise<string> {
  if (sourceKey) return sourceKey;
  // 兜底：media.source_key 缺失时按 spec.md §1 的 original/ 布局反查（M1 之前的行）
  const objects = await storage.listObjects(`${STORAGE_PARTITIONS.original}/`);
  const hit = objects.find((o) => o.key.startsWith(`${STORAGE_PARTITIONS.original}/${mediaId}.`));
  if (!hit) throw new JobExecutionError(`原始文件不存在（original/ 中未找到媒资 ${mediaId}）`);
  return hit.key;
}

/** 递归列举本地目录（返回 posix 相对路径，与存储键布局一致） */
async function walkFiles(root: string, prefix = ""): Promise<Array<{ rel: string; abs: string }>> {
  const entries = await readdir(join(root, prefix || "."), { withFileTypes: true });
  const out: Array<{ rel: string; abs: string }> = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkFiles(root, rel)));
    else out.push({ rel, abs: join(root, ...rel.split("/")) });
  }
  return out;
}

/** 上传产物目录 → `proceed/{mediaId}/...`，返回已上传的相对键集合 */
async function uploadTree(
  storage: StorageAdapter,
  localRoot: string,
  prefix: string,
): Promise<{ keys: Set<string>; count: number }> {
  const files = await walkFiles(localRoot);
  const keys = new Set<string>();
  for (const file of files) {
    const key = `${prefix}/${file.rel}`;
    const data = new Uint8Array(await Bun.file(file.abs).arrayBuffer());
    await storage.put(key, data, contentTypeFor(file.rel));
    keys.add(key);
  }
  return { keys, count: keys.size };
}

/**
 * 清掉**本模板子树内**上一次转码留下的、本次未产出的对象（旧档位 / 旧分片），避免新旧混播。
 * 只作用于 `proceed/{id}/{templateId}/`：同一媒资其它模板的产物不受影响（spec.md §1.3）。
 */
async function pruneStale(storage: StorageAdapter, prefix: string, keep: Set<string>): Promise<number> {
  const existing = await storage.listObjects(`${prefix}/`);
  const stale = existing.filter((o) => !keep.has(o.key));
  for (const o of stale) await storage.delete(o.key);
  return stale.length;
}

/**
 * 执行已认领的任务。失败时向上抛错（由 tick 置 FAILED），但**媒资状态在内部按既有产物恢复**：
 * 该媒资此前已就绪 → 保持 READY（旧产物仍可播，不误报）；否则标记 FAILED。
 */
export async function executeClaimedJob(
  job: TranscodeJobRow,
  deps: JobExecutorDeps,
): Promise<ExecuteJobResult> {
  const log = deps.log ?? ((msg: string) => console.log(`[worker] ${msg}`));
  const leaseMs = deps.leaseMs ?? 60_000;
  const hlsTimeSec = deps.hlsTimeSec ?? DEFAULTS.hlsTimeSec;

  const media = await deps.mediaStore.get(job.mediaId);
  if (!media) throw new JobExecutionError(`媒资不存在：${job.mediaId}`);
  const previousStatus: MediaStatusName = media.status;

  const jobsRoot = deps.jobsRoot ?? join(tmpdir(), "openvod-jobs");
  const jobDir = join(jobsRoot, job.id);
  const outRoot = join(jobDir, "out");

  // 执行期心跳续期：长转码任务不被其它实例重派（ADR-0008 lease）
  const heartbeat = setInterval(() => {
    void deps.jobStore.extendLease(job.id, leaseMs).catch(() => {});
  }, Math.max(5_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  try {
    await mkdir(outRoot, { recursive: true });
    await deps.mediaStore.setStatus(media.id, "TRANSCODING");

    // 1) 输入与探测
    const sourceKey = await resolveSourceKey(deps.storage, media.id, media.sourceKey);
    const input = await resolveInput(deps.storage, sourceKey);
    const probe = await ffprobeJSON(input);
    const summary = summarizeProbe(probe);
    const source: SourceInfo = {
      width: summary.video?.width ?? 0,
      height: summary.video?.height ?? 0,
      fps: summary.video?.fps ?? null,
      // 码率维度判定用：优先视频轨码率，缺失回退容器总码率（intent 规则 1 三维度判定）
      bitrateBps: summary.video?.bitrate ?? summary.bitrate ?? null,
    };
    if (!source.width || !source.height) {
      throw new JobExecutionError("探测失败：未能取得视频分辨率（可能不是有效视频文件）");
    }
    await deps.mediaStore.saveProbe(media.id, summary, summary.durationMs);
    const { snapshot } = parseSnapshot(job.templateSnapshot);
    // 产物目录 = 模板 ID（spec.md §1.3）；快照优先，兼容只写了 templateId 的旧任务
    const templateId = snapshot.template_id || job.templateId;
    if (!templateId) {
      throw new JobExecutionError("任务缺少模板 ID（快照与任务记录都没有），无法确定产物目录 proceed/{id}/{模板id}/");
    }
    log(
      `任务 ${job.id}：源 ${source.width}×${source.height}${source.fps ? `@${source.fps}` : ""}，模板「${snapshot.name}」（${templateId}）`,
    );

    // 2) 加密则先备好密钥材料（**不落库**，spec.md §4.2）；已有密钥则复用（多模板产物共用一份 CEK）
    let key: ResolvedMediaKey | null = null;
    let keyInfoPath: string | undefined;
    if (snapshot.encrypt) {
      const mks = deps.masterKeys ?? loadMasterKeys();
      key = await resolveMediaKey(deps.keyStore, mks, media.id);
      const paths = await writeKeyFiles({ jobDir, mediaId: media.id, key });
      keyInfoPath = paths.keyInfoPath;
    }

    // 3) 编译计划（三维度均不低于源的档位在此被跳过；全档跳过则按源规格兜底出一档）
    const { plans, entries, sourceFallback } = buildPlans(snapshot, source, {
      input,
      outRoot,
      keyInfoPath,
      hlsTimeSec,
    });
    const executed = plans.filter((p) => !p.skipped && p.argv);
    const skipped = plans.filter((p) => p.skipped).map((p) => `${p.name}：${p.skipReason ?? "跳过"}`);
    if (!executed.length) {
      // 防御性兜底：keep_original 与 compileSourceMatched 都必产一档，正常不会走到这里
      throw new JobExecutionError(`所有档位均被跳过，无可用输出（${skipped.join("；") || "模板未产出任何档位"}）`);
    }
    for (const reason of skipped) log(`任务 ${job.id}：跳过 ${reason}`);
    if (sourceFallback) {
      log(`任务 ${job.id}：模板档位均无降级维度（分辨率 / 帧率 / 码率 ≥ 源），已按源规格兜底产出一档`);
    }

    // 4) 逐档转码（顺序执行：转码是 CPU 密集，v1 不做并行以免打满容器）
    await deps.jobStore.setStatus(job.id, "ENCODING");
    for (const plan of executed) {
      const outDir = `${outRoot}/${plan.name}`;
      await mkdir(outDir, { recursive: true });
      log(`任务 ${job.id}：转码 ${plan.name}（${plan.width}×${plan.height}${snapshot.encrypt ? "，AES-128" : ""}）`);
      await runFFmpeg(plan.argv!);
    }

    // 5) 生成主清单并上传（先写盘再整体上传）
    await deps.jobStore.setStatus(job.id, "PACKAGING");
    await writeFile(join(outRoot, "master.m3u8"), buildMasterPlaylist(entries, { mediaId: media.id }));
    const prefix = `${STORAGE_PARTITIONS.proceed}/${media.id}/${templateId}`;
    const { keys, count } = await uploadTree(deps.storage, outRoot, prefix);
    if (!count) throw new JobExecutionError("产物上传为空（疑似转码未产出任何文件）");
    const deletedStale = await pruneStale(deps.storage, prefix, keys);

    // 6) 产物就绪后才落密钥（每媒资一份：事务内整行替换）；已有密钥则复用，不落库
    let replacedKey: boolean | null = null;
    if (key && !key.reused) {
      replacedKey = (await persistMediaKey(deps.keyStore, media.id, key)).replaced;
      log(`任务 ${job.id}：密钥已落库（kid=${key.kid.slice(0, 8)}…，${replacedKey ? "替换旧密钥" : "首次生成"}）`);
    } else if (key) {
      log(`任务 ${job.id}：复用该媒资已有密钥（kid=${key.kid.slice(0, 8)}…，多模板产物共用一份 CEK）`);
    }

    // 7) 收尾：媒资就绪 + 任务完成
    await deps.mediaStore.setStatus(media.id, "READY");
    await deps.jobStore.setStatus(job.id, "DONE", { finishedAt: new Date(), leaseUntil: null, lastError: null });

    return {
      variants: executed.map((p) => ({
        name: p.name,
        width: p.width,
        height: p.height,
        files: [...keys].filter((k) => k.startsWith(`${prefix}/${p.name}/`)).length,
      })),
      skipped,
      sourceFallback,
      encrypted: Boolean(key),
      replacedKey,
      keyReused: Boolean(key?.reused),
      outputPrefix: prefix,
      uploadedObjects: count,
      deletedStaleObjects: deletedStale,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 旧产物仍在时不要误标失败（否则明明可播却显示失败）
    const restore: MediaStatusName = previousStatus === "READY" ? "READY" : "FAILED";
    await deps.mediaStore.setStatus(media.id, restore).catch(() => {});
    throw new JobExecutionError(message);
  } finally {
    clearInterval(heartbeat);
    // 明文 CEK 与 key_info 必须随任务目录消失（成功 / 失败 / 取消都一样）
    await cleanupJobDir(jobDir).catch((e) => {
      console.error(`[worker] 任务临时目录清理失败：${(e as Error).message}`);
    });
  }
}
