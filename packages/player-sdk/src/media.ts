// 媒资消费（player-sdk-spec.md §7）：listMedia / getMedia 透传服务端语义（不变量 N3），
// parseCustomMetadata 收敛 custom 公开白名单（spec.md §8.4）的防御性解析。
// DTO 类型以 type-only 引用契约（唯一真相源 packages/contracts），运行时零依赖。
import type { MediaDetail as MediaDetailSchema, MediaListItem as MediaListItemSchema, PageResponse as PageResponseSchema, z } from "@openvod/contracts";
import type { JsonRequestOptions } from "./client";
import type { SdkOperation } from "./events";

export type MediaListItem = z.infer<typeof MediaListItemSchema>;
export type MediaDetail = z.infer<typeof MediaDetailSchema>;
export type MediaPage = z.infer<typeof PageResponseSchema>;

/** 带 401 兜底的业务请求函数（由入口装配，playback 复用同一实现） */
export type AuthedRequestFn = (
  operation: SdkOperation,
  opts: Omit<JsonRequestOptions, "token" | "retry">,
) => Promise<unknown>;

/** custom 公开白名单（spec.md §8.4）：分发端只下发 category / description / tags 三个键 */
export interface CustomMetadata {
  category?: { id: string; name: string; path: string };
  description?: string;
  tags?: string[];
}

/**
 * custom 公开白名单的防御性解析（spec §7）：
 * - `category` 需 `id` 与 `path` 均为非空字符串，否则丢弃；
 * - `description` trim 后非空才保留；`tags` 丢弃空项、按首现去重；
 * - 输入为 null / 非对象 / 脏结构 → 返回 `{}`，**解析失败不阻断播放**（容错口径同 spec.md §8.4）。
 */
export function parseCustomMetadata(custom: unknown): CustomMetadata {
  const out: CustomMetadata = {};
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return out;
  const raw = custom as Record<string, unknown>;

  const category = raw.category;
  if (category && typeof category === "object" && !Array.isArray(category)) {
    const c = category as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id.trim() : "";
    const path = typeof c.path === "string" ? c.path.trim() : "";
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (id && path) out.category = { id, name, path };
  }
  if (typeof raw.description === "string" && raw.description.trim()) {
    out.description = raw.description.trim();
  }
  if (Array.isArray(raw.tags)) {
    const tags: string[] = [];
    for (const tag of raw.tags) {
      if (typeof tag !== "string") continue;
      const value = tag.trim();
      if (value && !tags.includes(value)) tags.push(value);
    }
    if (tags.length) out.tags = tags;
  }
  return out;
}

/** 清晰度选项展示名（spec §5.1）：`name` 可为 null（模板行已删） */
export function templateLabel(template: { id: string; name: string | null }): string {
  return template.name ?? `模板 ${template.id.slice(0, 8)}`;
}

export class MediaApi {
  constructor(private readonly request: AuthedRequestFn) {}

  /**
   * 媒资列表（GET /v1/media；恒为 READY；`next_cursor` v1 恒 null 原样透传）。
   * `limit` 原样传给服务端（缺省 50 / 1..200 / 非法静默回退，由服务端裁决，N3）。
   */
  async listMedia(options?: { limit?: number; signal?: AbortSignal }): Promise<MediaPage> {
    const query = options?.limit == null ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
    return (await this.request("list_media", {
      method: "GET",
      path: `/v1/media${query}`,
      signal: options?.signal,
    })) as MediaPage;
  }

  /** 媒资详情（GET /v1/media/{id}；非 READY 仍返回详情，`playable=false`） */
  async getMedia(mediaId: string, options?: { signal?: AbortSignal }): Promise<MediaDetail> {
    return (await this.request("get_media", {
      method: "GET",
      path: `/v1/media/${encodeURIComponent(mediaId)}`,
      signal: options?.signal,
    })) as MediaDetail;
  }
}
