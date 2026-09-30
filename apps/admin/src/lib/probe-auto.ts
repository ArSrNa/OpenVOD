// 上传后自动生成元数据的 best-effort 编排（spec.md §2.1「上传完毕自动生成元数据」2026-09-30）：
// 上传（存储写入 + 落库）成功后立即探测；**探测失败绝不让上传请求失败**——
// 文件已存好，只是元数据缺失，降级为告警 + 响应标记，用户可手动「更多 → 生成元数据」重跑。
// 依赖注入（generate / log）便于单测：apps/admin/test/probe-auto.test.ts；真实实现见 probe.ts。
import type { GenerateMetadataResult } from "./probe";

/** 失败原因在响应 / 日志里的最大长度（ffprobe stderr 可能很长） */
export const AUTO_METADATA_ERROR_MAX = 300;

export interface AutoMetadataOutcome {
  /** 探测是否成功（false = 降级，上传仍然成功） */
  generated: boolean;
  /** 成功：`metadata/{id}/probe.json` 相对键；失败为 null */
  probeKey: string | null;
  /** 成功：归一化摘要里的时长（未探测到为 null）；失败为 null */
  durationMs: number | null;
  /** 失败原因（截断至 AUTO_METADATA_ERROR_MAX；仅供提示与日志，不构成错误信封） */
  error: string | null;
}

export interface AutoMetadataDeps {
  generate(id: string): Promise<GenerateMetadataResult>;
  /** 失败告警出口（默认 console.warn；测试注入收集） */
  log?(message: string): void;
}

/** 上传成功后自动探测：成功透传摘要定位；任何异常都降级为 `{generated:false, error}`，不抛出 */
export async function runAutoMetadata(
  id: string,
  deps: AutoMetadataDeps,
): Promise<AutoMetadataOutcome> {
  try {
    const result = await deps.generate(id);
    return {
      generated: true,
      probeKey: result.probeKey,
      durationMs: result.summary.durationMs ?? null,
      error: null,
    };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, AUTO_METADATA_ERROR_MAX);
    const log = deps.log ?? ((message: string) => console.warn(message));
    log(`[probe] 上传后自动生成元数据失败（${id}）：${error}`);
    return { generated: false, probeKey: null, durationMs: null, error };
  }
}
