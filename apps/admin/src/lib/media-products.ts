// 转码产物按「媒资 → 模板」归组（spec.md §1.3/§1.4）——**纯函数，不依赖数据库/存储**，
// 便于单测；模板名的补全（查 transcode_templates）留在 lib/media.ts（那里才碰 DB）。
import {
  LEGACY_PRODUCT_LABEL,
  MEDIA_ID_CHARS,
  PROCEED_RESERVED_SEGMENTS,
  STORAGE_PARTITIONS,
  TEMPLATE_ID_PATTERN,
} from "@openvod/shared";
import type { StorageObject } from "@openvod/storage";

/** 一份模板产物（同一媒资可有多个模板各出一套） */
export interface MediaProduct {
  /** 模板 ID（cuid）；空串 = 旧布局产物（该层没有模板段） */
  templateId: string;
  /** 模板展示名（transcode_templates；模板已删为 null，旧布局为「未分组（旧布局）」） */
  templateName: string | null;
  /** 对象数（主清单 + 子清单 + 分片） */
  objects: number;
  /** 体积（byte） */
  bytes: number;
  /** 变体目录名（如 1080p / 720p），升序 */
  variants: string[];
}

const PROCEED_UNDER_MEDIA_RE = new RegExp(`^${STORAGE_PARTITIONS.proceed}/(${MEDIA_ID_CHARS})/(.+)$`);

/**
 * 把 `proceed/` 分区对象按「媒资 → 模板」归组（一次遍历）。
 * 目录名匹配 cuid 视为模板产物；其余（旧布局的 `1080p/` 等）归入空模板 ID；
 * 保留段（`subtitles/`）不参与分组。
 */
export function groupProductsByMedia(objs: StorageObject[]): Map<string, MediaProduct[]> {
  const byMedia = new Map<string, Map<string, { objects: number; bytes: number; variants: Set<string> }>>();
  for (const o of objs) {
    const m = PROCEED_UNDER_MEDIA_RE.exec(o.key);
    if (!m) continue;
    const mediaId = m[1];
    const rest = m[2];
    const head = rest.split("/")[0];
    if ((PROCEED_RESERVED_SEGMENTS as readonly string[]).includes(head)) continue;
    const isTemplate = TEMPLATE_ID_PATTERN.test(head);
    const templateId = isTemplate ? head : "";
    const tail = isTemplate ? rest.slice(head.length + 1) : rest;
    const slash = tail.indexOf("/");
    const variant = slash > 0 ? tail.slice(0, slash) : "";
    const perTemplate = byMedia.get(mediaId) ?? new Map();
    const entry = perTemplate.get(templateId) ?? { objects: 0, bytes: 0, variants: new Set<string>() };
    entry.objects += 1;
    entry.bytes += o.size;
    if (variant) entry.variants.add(variant);
    perTemplate.set(templateId, entry);
    byMedia.set(mediaId, perTemplate);
  }

  const out = new Map<string, MediaProduct[]>();
  for (const [mediaId, perTemplate] of byMedia) {
    const list: MediaProduct[] = [...perTemplate.entries()].map(([templateId, e]) => ({
      templateId,
      templateName: templateId ? null : LEGACY_PRODUCT_LABEL,
      objects: e.objects,
      bytes: e.bytes,
      variants: [...e.variants].sort(),
    }));
    // 有模板 ID 的在前（按 ID 升序），旧布局兜底在后
    list.sort((a, b) => (a.templateId === "" ? 1 : b.templateId === "" ? -1 : a.templateId.localeCompare(b.templateId)));
    out.set(mediaId, list);
  }
  return out;
}
