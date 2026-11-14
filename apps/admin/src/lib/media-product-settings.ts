// 媒资级转码产物展示与默认设置（spec.md §6.3/§11.1，2026-11-15）——纯函数，不依赖 DB / 存储：
//   · visibleTemplateIds = null：全部模板产物对播放端展示（新产物默认可见，兼容旧行为）；
//   · defaultTemplateId  = null：未设置媒资级默认，回退全局默认模板 → 排序首项；
// 存储形态是 media.product_settings 的 JSON（snake_case），读脏值时一律降级为默认，不阻断播放。
import { TEMPLATE_ID_PATTERN } from "@openvod/shared";

/** 媒资级产物设置（内部 camelCase 形态；写库 / 出参时转 snake_case） */
export interface MediaProductSettings {
  /** 对播放端展示的模板 ID 白名单；null = 全部展示 */
  visibleTemplateIds: string[] | null;
  /** 进入后默认加载的模板产物；null = 未设置 */
  defaultTemplateId: string | null;
}

export const DEFAULT_MEDIA_PRODUCT_SETTINGS: MediaProductSettings = {
  visibleTemplateIds: null,
  defaultTemplateId: null,
};

function isTemplateId(v: unknown): v is string {
  return typeof v === "string" && TEMPLATE_ID_PATTERN.test(v);
}

/**
 * 解析 media.product_settings（脏值 / 旧值一律降级为默认）：
 * 非对象、字段类型不符、模板 ID 形状不符 → 丢弃；默认产物不在展示范围 → 一并清空。
 */
export function parseMediaProductSettings(raw: unknown): MediaProductSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_MEDIA_PRODUCT_SETTINGS };
  }
  const rec = raw as Record<string, unknown>;

  let visible: string[] | null = null;
  if (Array.isArray(rec.visible_template_ids)) {
    const ids = [...new Set(rec.visible_template_ids.filter(isTemplateId))];
    visible = ids.length ? ids : null; // 空数组 = 全部展示
  }

  let def = isTemplateId(rec.default_template_id) ? rec.default_template_id : null;
  if (def && visible && !visible.includes(def)) def = null; // 展示范围外的默认产物不生效

  return { visibleTemplateIds: visible, defaultTemplateId: def };
}

/** 写库 / 出参形态（snake_case，与 MediaProductSettingsDTO 一致） */
export function serializeMediaProductSettings(s: MediaProductSettings): {
  visible_template_ids: string[] | null;
  default_template_id: string | null;
} {
  return {
    visible_template_ids: s.visibleTemplateIds,
    default_template_id: s.defaultTemplateId,
  };
}

/**
 * 播放端实际可见的模板产物（按传入顺序）：
 * visible = null → 全部；白名单里的过期 / 已删项忽略；白名单与现存产物无交集时回退全部
 * （至少保证一套可播，与分发端同一容错口径）。
 */
export function visibleProducts(
  settings: MediaProductSettings,
  allTemplateIds: string[],
): string[] {
  if (!settings.visibleTemplateIds) return [...allTemplateIds];
  const allow = new Set(settings.visibleTemplateIds);
  const out = allTemplateIds.filter((id) => allow.has(id));
  return out.length ? out : [...allTemplateIds];
}

/**
 * 切换单套产物的展示状态（管理端开关）：
 * 返回 null = 拒绝（会关掉最后一套展示产物）；覆盖全部产物时归一化为 null（= 全部展示）。
 * 关闭的正是当前默认产物时，同时取消默认。
 */
export function toggleProductVisibility(
  settings: MediaProductSettings,
  allTemplateIds: string[],
  templateId: string,
  visible: boolean,
): MediaProductSettings | null {
  const current = settings.visibleTemplateIds ?? allTemplateIds;
  const next = visible
    ? [...new Set([...current, templateId])]
    : current.filter((id) => id !== templateId);
  if (next.length === 0) return null;

  const allShown =
    next.length === allTemplateIds.length && allTemplateIds.every((id) => next.includes(id));
  const defaultTemplateId =
    settings.defaultTemplateId && next.includes(settings.defaultTemplateId)
      ? settings.defaultTemplateId
      : null;
  return { visibleTemplateIds: allShown ? null : next, defaultTemplateId };
}

/**
 * 设置 / 清除媒资级默认产物：
 * templateId = null 清除默认；目标必须处于展示范围，否则返回 null（由 UI 提示先展示）。
 */
export function setDefaultProduct(
  settings: MediaProductSettings,
  allTemplateIds: string[],
  templateId: string | null,
): MediaProductSettings | null {
  if (templateId === null) return { ...settings, defaultTemplateId: null };
  if (!visibleProducts(settings, allTemplateIds).includes(templateId)) return null;
  return { ...settings, defaultTemplateId: templateId };
}
