// 自定义元数据投影纯函数（spec.md §8.3 / ADR-0016）：把「分类 + 描述 + 标签」重算为
// `media.custom_data` 的稀疏投影（空项不出现），并保留白名单之外的扩展键。
// 不碰 DB / 存储，便于单测；落库与导出见 lib/media.ts（updateMediaMetadata）。
import { MEDIA_CUSTOM_KEYS, buildMediaCustomData, type MediaCustomCategory } from "@openvod/shared";

export interface MediaMetadataInput {
  /** 分类投影（含 name / path 快照）；null = 未分类 */
  category: MediaCustomCategory | null;
  description: string | null;
  tags: readonly string[];
}

/** 从 DB 行读取标签（Json 列，形如 `["a","b"]`）：非法形态按空数组处理，不放大脏数据 */
export function parseMediaTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 合并既有 custom_data：白名单三键（category / description / tags）按输入重算，空项删除；
 * **其余扩展键原样保留**——v1 管理端虽无任意 JSON 的写入口，但历史 / 手工写入的键
 * 不应被一次元数据保存抹掉（spec.md §8.3）。
 */
export function mergeCustomData(
  existing: unknown,
  input: MediaMetadataInput,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const key of Object.values(MEDIA_CUSTOM_KEYS)) delete base[key];
  return { ...base, ...buildMediaCustomData(input) };
}

/** custom_data → `metadata/{id}/custom.json` 文本（导出配置，2 空格缩进便于人工查看） */
export function serializeCustomData(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2);
}
