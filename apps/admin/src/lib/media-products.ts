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
  /** 对播放端展示（**仅详情接口填写**；白名单未命中为 false，旧布局恒 false） */
  isVisible?: boolean;
  /** 媒资级默认产物（**仅详情接口填写**；null / 未设置时由分发端回退全局默认模板） */
  isDefault?: boolean;
}

const PROCEED_UNDER_MEDIA_RE = new RegExp(`^${STORAGE_PARTITIONS.proceed}/(${MEDIA_ID_CHARS})/(.+)$`);

/** 字幕对象键：`proceed/{id}/{保留段}/xxx.vtt`（保留段即 subtitles，spec.md §7.2） */
const SUBTITLE_OBJECT_RE = new RegExp(
  `^${STORAGE_PARTITIONS.proceed}/(${MEDIA_ID_CHARS})/${PROCEED_RESERVED_SEGMENTS[0]}/[^/]+\\.vtt$`,
  "i",
);

/** 统计各媒资的字幕对象数（spec.md §7.2；媒资列表 / 字幕管理页选择器用，纯函数） */
export function countSubtitlesByMedia(objs: StorageObject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of objs) {
    const m = SUBTITLE_OBJECT_RE.exec(o.key);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/** 旧布局产物在 URL / 表单里的占位 ID（该层没有模板段；spec.md §1.3） */
export const PRODUCT_LEGACY_ID = "legacy";

/**
 * 选出「删除这份产物」要删的对象键（纯函数，spec.md §1.3/§5.5）：
 *   - templateId = cuid：只选该模板子树 `proceed/{id}/{templateId}/**`
 *   - templateId = ""（旧布局）：选 `proceed/{id}/` 下所有**不属于**任何模板子树、也非保留段的对象
 * 保留段（`subtitles/`）永不入选。
 */
export function selectProductObjectKeys(
  objs: StorageObject[],
  mediaId: string,
  templateId: string,
): StorageObject[] {
  const out: StorageObject[] = [];
  for (const o of objs) {
    const m = PROCEED_UNDER_MEDIA_RE.exec(o.key);
    if (!m || m[1] !== mediaId) continue;
    const head = m[2].split("/")[0];
    if ((PROCEED_RESERVED_SEGMENTS as readonly string[]).includes(head)) continue;
    const isTemplate = TEMPLATE_ID_PATTERN.test(head);
    if (templateId) {
      if (isTemplate && head === templateId) out.push(o);
    } else if (!isTemplate) {
      out.push(o);
    }
  }
  return out;
}

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
