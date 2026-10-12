// 播放器消费的分发端契约类型（唯一真相源 packages/contracts，仅 `import type`，运行时零依赖）
import type {
  MediaDetail,
  MediaListItem,
  PlaybackResponse,
  PlaybackSubtitleDTO,
  PlaybackTemplateDTO,
  z,
} from "@openvod/contracts";

export type MediaListItemDTO = z.infer<typeof MediaListItem>;
export type MediaDetailDTO = z.infer<typeof MediaDetail>;
export type PlaybackDTO = z.infer<typeof PlaybackResponse>;
export type PlaybackSubtitle = z.infer<typeof PlaybackSubtitleDTO>;
export type PlaybackTemplate = z.infer<typeof PlaybackTemplateDTO>;

/** custom 公开白名单（spec.md §8.4）：分发端只下发 category / description / tags 三个键 */
export interface CustomMetadata {
  category?: { id: string; name: string; path: string };
  description?: string;
  tags?: string[];
}

/** 白名单值的防御性解析（类型为 unknown；脏数据一律忽略，不阻断播放） */
export function parseCustom(custom: Record<string, unknown> | null | undefined): CustomMetadata {
  const out: CustomMetadata = {};
  if (!custom || typeof custom !== "object") return out;
  const category = custom.category;
  if (category && typeof category === "object") {
    const c = category as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "";
    const name = typeof c.name === "string" ? c.name : "";
    const path = typeof c.path === "string" ? c.path : "";
    if (id && path) out.category = { id, name, path };
  }
  if (typeof custom.description === "string" && custom.description.trim()) {
    out.description = custom.description.trim();
  }
  if (Array.isArray(custom.tags)) {
    const tags = custom.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (tags.length) out.tags = tags;
  }
  return out;
}
