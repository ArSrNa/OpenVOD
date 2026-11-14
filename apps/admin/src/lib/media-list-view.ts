// 媒资列表的排序与筛选（intent.md「媒资列表排序与筛选」/ spec.md §3.1，2026-11-15）——纯函数：
// v1 列表本就是一次全量列举（spec.md §1.4），这里全部在浏览器侧对已取回的数据算，
// 不改 GET /api/admin/media，也不加查询参数；将来列表转服务端分页再下沉到接口。

export type MediaSortKey = "title" | "size" | "uploadedAt";
export type MediaSortOrder = "asc" | "desc";
export type PresenceFilter = "any" | "has" | "none";
export type PresenceKey = "subtitles" | "cover" | "products" | "description";

export interface MediaSort {
  /** null = 不排序（保持服务端顺序：媒资 ID 降序，新媒资在前） */
  key: MediaSortKey | null;
  order: MediaSortOrder;
}

export interface MediaListFilters {
  /** 空数组 = 不限；多选取「或」，不同筛选之间取「与」 */
  statuses: string[];
  /** 选中的分类，每个含其全部子孙分类；空数组 = 不限 */
  categoryIds: string[];
  presence: Record<PresenceKey, PresenceFilter>;
}

/** 状态筛选里的「未入库」：DB 无记录（列表状态列同样显示为该值） */
export const UNASSIGNED_STATUS = "__none__";

export const DEFAULT_MEDIA_SORT: MediaSort = { key: null, order: "desc" };

/** 与列表状态列同一套标签（spec.md §3.1） */
export const MEDIA_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "UPLOADED", label: "已上传" },
  { value: "PROBING", label: "探测中" },
  { value: "TRANSCODING", label: "转码中" },
  { value: "READY", label: "就绪" },
  { value: "FAILED", label: "失败" },
  { value: "ARCHIVED", label: "已下架" },
  { value: UNASSIGNED_STATUS, label: "未入库" },
];

export const PRESENCE_OPTIONS: ReadonlyArray<{ value: PresenceFilter; label: string }> = [
  { value: "any", label: "全部" },
  { value: "has", label: "有" },
  { value: "none", label: "无" },
];

/** 「有无」筛选项的展示顺序 */
export const PRESENCE_FIELDS: ReadonlyArray<{ key: PresenceKey; label: string }> = [
  { key: "subtitles", label: "字幕" },
  { key: "cover", label: "封面" },
  { key: "products", label: "转码产物" },
  { key: "description", label: "描述" },
];

export const DEFAULT_MEDIA_FILTERS: MediaListFilters = {
  statuses: [],
  categoryIds: [],
  presence: { subtitles: "any", cover: "any", products: "any", description: "any" },
};

/** 排序 / 筛选只用到这些字段，组件传整条列表项即可 */
export interface MediaListViewItem {
  id: string;
  title: string | null;
  status: string | null;
  /** 自定义上传时间（null = 未设置，回退 lastModified） */
  uploadedAt?: string | null;
  lastModified?: string | null;
  posterKey: string | null;
  /** 原视频对象大小（列表「大小」列同一值） */
  size: number;
  subtitleCount: number;
  products: readonly unknown[];
  description: string | null;
  /** 归属分类（未设置时服务端已回退默认分类「其他」） */
  category: { id: string } | null;
}

/** 有无判定（列表列展示同一口径，spec.md §3.1） */
export const PRESENCE_TESTERS: Record<PresenceKey, (i: MediaListViewItem) => boolean> = {
  subtitles: (i) => i.subtitleCount > 0,
  cover: (i) => Boolean(i.posterKey),
  products: (i) => i.products.length > 0,
  description: (i) => Boolean(i.description?.trim()),
};

/** 是否设置了任一筛选（决定是否显示「筛出 x / 共 y」与「清空筛选」） */
export function isMediaFilterActive(filters: MediaListFilters): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.categoryIds.length > 0 ||
    PRESENCE_FIELDS.some((f) => filters.presence[f.key] !== "any")
  );
}

/** 两个筛选状态是否等价：表头受控筛选每次 onChange 都回传全量值，无变化时不要换引用（否则会重置页码） */
export function isSameMediaFilters(a: MediaListFilters, b: MediaListFilters): boolean {
  return (
    arraysEqual(a.statuses, b.statuses) &&
    arraysEqual(a.categoryIds, b.categoryIds) &&
    PRESENCE_FIELDS.every((f) => a.presence[f.key] === b.presence[f.key])
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 按状态 / 分类 / 有无筛选。`categoryScope` = 选中分类的子树 id 集合（含自身），
 * null = 不限分类；由调用方用 `collectSubtreeIds` 计算。
 */
export function filterMediaItems<T extends MediaListViewItem>(
  items: readonly T[],
  filters: MediaListFilters,
  categoryScope: ReadonlySet<string> | null,
): T[] {
  const statuses = filters.statuses;
  return items.filter((item) => {
    if (statuses.length && !statuses.includes(item.status ?? UNASSIGNED_STATUS)) return false;
    if (categoryScope && !(item.category && categoryScope.has(item.category.id))) return false;
    for (const f of PRESENCE_FIELDS) {
      const want = filters.presence[f.key];
      if (want === "any") continue;
      const has = PRESENCE_TESTERS[f.key](item);
      if (want === "has" ? !has : has) return false;
    }
    return true;
  });
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** 展示名排序键：未命名用媒资 ID 兜底（列表展示同理） */
function sortTitle(item: MediaListViewItem): string {
  const title = item.title?.trim();
  return title ? title : item.id;
}

/** 上传时间排序键：自定义上传时间优先，未设置回退对象存储写入时间；两者皆无 → null（恒排末尾） */
function uploadedAtMs(item: MediaListViewItem): number | null {
  const raw = item.uploadedAt ?? item.lastModified;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 排序。`key = null` 时保持服务端顺序（媒资 ID 降序）。
 * 升 / 降序只作用于有值的项：时间缺失的项恒排末尾；并列时按媒资 ID 降序（新媒资在前），保证顺序稳定。
 */
export function sortMediaItems<T extends MediaListViewItem>(items: readonly T[], sort: MediaSort): T[] {
  if (!sort.key) return items.slice();
  const dir = sort.order === "asc" ? 1 : -1;
  const key = sort.key;

  return items.slice().sort((a, b) => {
    let result: number;
    if (key === "title") {
      result = collator.compare(sortTitle(a), sortTitle(b));
    } else if (key === "size") {
      result = a.size - b.size;
    } else {
      const at = uploadedAtMs(a);
      const bt = uploadedAtMs(b);
      if (at === null || bt === null) {
        if (at === bt) result = 0;
        else return at === null ? 1 : -1; // 缺失恒排末尾，与升降序无关
      } else {
        result = at - bt;
      }
    }
    if (result !== 0) return result * dir;
    return b.id.localeCompare(a.id, "zh-CN", { numeric: true });
  });
}
