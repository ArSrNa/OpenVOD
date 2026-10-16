// 字幕（player-sdk-spec.md §6）：轨道数据随 handle 下发；VTT 文本拉取辅助（挂载方式由宿主 / 播放器决定）。
// SDK 不做字幕解析 / 重排 / 翻译 / 样式。
import type { HttpClient } from "./client";
import type { PlaybackSubtitle } from "./types";

export type { PlaybackSubtitle };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 响应侧防御：非法轨道条目直接丢弃（脏数据不阻断播放，容错口径同 spec.md §8.4） */
export function sanitizeSubtitles(value: unknown): PlaybackSubtitle[] {
  if (!Array.isArray(value)) return [];
  const out: PlaybackSubtitle[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.url)) continue;
    out.push({
      id: raw.id,
      lang: typeof raw.lang === "string" ? raw.lang : "",
      label: typeof raw.label === "string" ? raw.label : "",
      is_default: raw.is_default === true,
      url: raw.url,
    });
  }
  return out;
}

/** 在（重签后的）轨道列表里定位同一条轨道：优先 id + lang，其次 id（spec §4.4 字幕重签重试） */
export function findMatchingTrack(
  tracks: readonly PlaybackSubtitle[],
  ref: Pick<PlaybackSubtitle, "id" | "lang">,
): PlaybackSubtitle | null {
  return (
    tracks.find((t) => t.id === ref.id && t.lang === ref.lang) ?? tracks.find((t) => t.id === ref.id) ?? null
  );
}

/** 拉取 VTT 文本（GET track.url；响应 no-store，**SDK 不缓存**，spec §6） */
export async function fetchVttText(
  client: HttpClient,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  return client.text(url, { signal, retry: true });
}
