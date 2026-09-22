// 元数据生成（spec.md §2.1「生成元数据」；intent.md「更多 → 生成元数据」）：
// ffprobe 探测 original → 原始输出落 `metadata/{id}/probe.json`（spec.md §1.3），
// 归一化摘要回写 `media.probe` + `media.duration_ms`。
// ffprobe 在管理端运行环境就地执行（s3 预签名 GET URL 供流，字节不经管理端内存）；
// 与 Worker 转码链路探测共用 @openvod/transcode 的 ffprobe 封装。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "@openvod/db";
import { ffprobeJSON, summarizeProbe, type ProbeSummary } from "@openvod/transcode";
import { STORAGE_KEYS } from "@openvod/shared";
import { getStorage } from "./storage";
import { MediaError, assertMediaId, resolveOriginalKey } from "./media";

const execFileP = promisify(execFile);

const db = getDb<any>();

async function requireFFprobe(): Promise<void> {
  try {
    await execFileP("ffprobe", ["-version"], { timeout: 10_000 });
  } catch {
    throw new MediaError(
      "internal",
      "运行环境缺少 ffprobe，无法生成元数据（需安装 ffmpeg / ffprobe，见 .ide/Dockerfile）",
      500,
    );
  }
}

export interface GenerateMetadataResult {
  id: string;
  /** metadata/{id}/probe.json 相对键 */
  probeKey: string;
  /** 归一化摘要（同 media.probe 落库值） */
  summary: ProbeSummary;
}

/**
 * 为媒资生成系统元数据（幂等可重试：重复调用覆盖式更新 probe.json 与 DB 字段）：
 * 1. 校验媒资入库且 original 存在；
 * 2. ffprobe（s3 预签名 GET URL）；
 * 3. 原始输出写 `metadata/{id}/probe.json`，摘要回写 `media.probe` / `duration_ms`。
 */
export async function generateMetadata(id: string): Promise<GenerateMetadataResult> {
  assertMediaId(id);
  await requireFFprobe();
  const storage = await getStorage();
  const key = await resolveOriginalKey(id);
  if (!key) throw new MediaError("not_found", `媒资不存在或 original 缺失：${id}`, 404);
  if ((await storage.stat(key)) === null) {
    throw new MediaError("not_found", `original 对象不存在：${key}`, 404);
  }

  // 供片输入：S3 预签名 GET URL（ffprobe 原生支持 http(s) 协议）
  let input: string;
  try {
    input = await storage.presignGet(key, 3600);
  } catch (e) {
    throw new MediaError("internal", `生成预签名下载 URL 失败：${(e as Error).message}`, 500);
  }

  let raw;
  try {
    raw = await ffprobeJSON(input);
  } catch (e) {
    const stderr = ((e as { stderr?: string }).stderr ?? (e as Error).message ?? "").slice(-300);
    throw new MediaError("bad_request", `ffprobe 探测失败（非媒体文件或已损坏）：${stderr}`, 400);
  }
  if (!raw.streams?.length && !raw.format) {
    throw new MediaError("bad_request", "ffprobe 未识别到任何媒体流", 400);
  }

  const summary = summarizeProbe(raw);
  const probeKey = STORAGE_KEYS.metadataProbe(id);
  try {
    await storage.put(probeKey, JSON.stringify(raw, null, 2), "application/json");
  } catch (e) {
    throw new MediaError("internal", `probe.json 写入失败：${(e as Error).message}`, 500);
  }

  try {
    await db.media.update({
      where: { id },
      data: { probe: summary, durationMs: summary.durationMs ?? null },
      select: { id: true },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2025") {
      throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
    }
    throw new MediaError("internal", `元数据回写数据库失败：${(e as Error).message}`, 500);
  }
  return { id, probeKey, summary };
}
