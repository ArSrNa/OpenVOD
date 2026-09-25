// 媒资分类 CRUD（spec.md §8.1 / ADR-0016）：无限层级邻接表，管理端独立模块（/categories）。
// 规则（应用层，DB 之外的必要校验）：
//   - **同级不允许重名**：DB 唯一索引 `(parent_id, name)` 对顶级（parent_id = NULL）不生效
//     （MySQL / SQLite 均视 NULL 互不相等），故顶级重名靠本层的同级查询兜底；
//   - **移动禁止环路**：不能把分类挂到自身或自己的子孙下；
//   - **系统默认分类「其他」不可删除**（`is_system`）：未设置分类的媒资默认归入它（spec.md §8.1 修订）；
//   - **删除要求无子分类**（先删 / 先移走子分类）：该分类下的媒资**迁入默认分类「其他」**（不删媒资），
//     删除后同步刷新这些媒资的自定义元数据投影（category 快照必须换成「其他」，spec.md §8.3）；
//   - 改名 / 移动会改变自身与子孙分类的 **path 快照**，同样刷新受影响媒资的投影。
import {
  CreateMediaCategoryRequest,
  MediaCategoryDTO,
  UpdateMediaCategoryRequest,
  z,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { collectSubtreeIds, isDescendantOf, type CategoryNode } from "./category-tree";
import {
  MediaError,
  ensureDefaultCategory,
  listMediaIdsByCategories,
  refreshMediaCustomProjections,
} from "./media";

const db = getDb<any>();

export type MediaCategoryDto = z.infer<typeof MediaCategoryDTO>;

/** 分类行（DB 最小投影 + 展示字段） */
interface CategoryRow extends CategoryNode {
  description: string | null;
  /** 系统内置（默认分类「其他」）：不可删除 */
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const msg = error.issues[0];
  const path = msg?.path?.length ? `${msg.path.join(".")}: ` : "";
  return `${path}${msg?.message ?? "请求体校验失败"}`;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}
function isRecordNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === "P2025";
}

const CATEGORY_SELECT = {
  id: true,
  name: true,
  description: true,
  parentId: true,
  sortOrder: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadRows(): Promise<CategoryRow[]> {
  return (await db.mediaCategory.findMany({ select: CATEGORY_SELECT })) as CategoryRow[];
}

async function findRow(id: string): Promise<CategoryRow | null> {
  return (await db.mediaCategory
    .findUnique({ where: { id }, select: CATEGORY_SELECT })
    .catch(() => null)) as CategoryRow | null;
}

/**
 * 直属媒资数（categoryId → 计数）。
 * **未设置分类（`category_id IS NULL`，历史数据）的媒资计入默认分类「其他」**（spec.md §8.1 修订）。
 */
async function loadDirectCounts(defaultCategoryId: string | null): Promise<Map<string, number>> {
  const [grouped, unassigned] = await Promise.all([
    db.media.groupBy({ by: ["categoryId"], _count: { _all: true } }) as Promise<
      Array<{ categoryId: string | null; _count: { _all: number } }>
    >,
    db.media.count({ where: { categoryId: null } }),
  ]);
  const counts = new Map<string, number>();
  for (const g of grouped) {
    if (g.categoryId) counts.set(g.categoryId, g._count._all);
  }
  if (defaultCategoryId && unassigned > 0) {
    counts.set(defaultCategoryId, (counts.get(defaultCategoryId) ?? 0) + unassigned);
  }
  return counts;
}

function toDto(row: CategoryRow, nodes: CategoryRow[], direct: Map<string, number>): MediaCategoryDto {
  const subtree = collectSubtreeIds(nodes, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parent_id: row.parentId,
    sort_order: row.sortOrder,
    is_system: row.isSystem,
    media_count: direct.get(row.id) ?? 0,
    descendant_media_count: subtree.reduce((sum, id) => sum + (direct.get(id) ?? 0), 0),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** 同级重名校验（parentId 为 null 时即全部顶级分类之间；excludeId 用于更新自身） */
async function assertSiblingNameFree(
  parentId: string | null,
  name: string,
  excludeId: string | null,
): Promise<void> {
  const sibling = await db.mediaCategory.findFirst({
    where: { parentId, name, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true },
  });
  if (sibling) {
    throw new MediaError(
      "bad_request",
      `同级已存在同名分类「${name}」（${sibling.id}）；同一上级下分类名唯一`,
      409,
    );
  }
}

// ---- 列表（扁平 + 直属 / 含子孙媒资计数；层级由 parent_id 表达，客户端组树） ----

export async function listCategories(): Promise<{ total: number; items: MediaCategoryDto[] }> {
  // 默认分类「其他」恒在（幂等确保；SQLite 开发库 / 历史库靠这里补齐）
  const defaultCategory = await ensureDefaultCategory();
  const [rows, direct] = await Promise.all([
    loadRows(),
    loadDirectCounts(defaultCategory?.id ?? null),
  ]);
  return { total: rows.length, items: rows.map((row) => toDto(row, rows, direct)) };
}

// ---- 创建 ----

export async function createCategory(body: unknown): Promise<MediaCategoryDto> {
  const parsed = CreateMediaCategoryRequest.safeParse(body);
  if (!parsed.success) throw new MediaError("bad_request", firstIssue(parsed.error), 400);
  const input = parsed.data;
  const parentId = input.parent_id ?? null;
  if (parentId && !(await findRow(parentId))) {
    throw new MediaError("not_found", `上级分类不存在：${parentId}`, 404);
  }
  // 先确保默认分类存在，避免顶级重名（「其他」）绕过校验
  await ensureDefaultCategory();
  await assertSiblingNameFree(parentId, input.name, null);

  let created: { id: string };
  try {
    created = await db.mediaCategory.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        parentId,
        sortOrder: input.sort_order,
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new MediaError("bad_request", `同级已存在同名分类「${input.name}」`, 409);
    }
    throw new MediaError("internal", `创建分类失败：${(e as Error).message}`, 500);
  }
  const { items } = await listCategories();
  const dto = items.find((i) => i.id === created.id);
  if (!dto) throw new MediaError("internal", "分类创建后读取失败", 500);
  return dto;
}

// ---- 更新（改名 / 描述 / 移动 / 排序） ----

export interface UpdateCategoryResult {
  item: MediaCategoryDto;
  /** 因 path 快照变化而被刷新自定义元数据投影的媒资数（0 = 未触发结构变化） */
  refreshed_media: number;
}

export async function updateCategory(id: string, body: unknown): Promise<UpdateCategoryResult> {
  const parsed = UpdateMediaCategoryRequest.safeParse(body);
  if (!parsed.success) throw new MediaError("bad_request", firstIssue(parsed.error), 400);
  const input = parsed.data;

  const current = await findRow(id);
  if (!current) throw new MediaError("not_found", `分类不存在：${id}`, 404);
  const rows = await loadRows();

  const nextParentId = input.parent_id !== undefined ? input.parent_id : current.parentId;
  if (nextParentId) {
    if (nextParentId === id) {
      throw new MediaError("bad_request", "不能把分类挂到自身之下", 400);
    }
    if (!rows.some((r) => r.id === nextParentId)) {
      throw new MediaError("not_found", `上级分类不存在：${nextParentId}`, 404);
    }
    if (isDescendantOf(rows, nextParentId, id)) {
      throw new MediaError("bad_request", "不能把分类移动到它自己的子孙分类之下（会形成环路）", 409);
    }
  }
  const nextName = input.name ?? current.name;
  if (nextName !== current.name || nextParentId !== current.parentId) {
    await assertSiblingNameFree(nextParentId, nextName, id);
  }

  try {
    await db.mediaCategory.update({
      where: { id },
      data: {
        name: nextName,
        description: input.description !== undefined ? input.description : current.description,
        parentId: nextParentId,
        sortOrder: input.sort_order !== undefined ? input.sort_order : current.sortOrder,
      },
    });
  } catch (e) {
    if (isRecordNotFound(e)) throw new MediaError("not_found", `分类不存在：${id}`, 404);
    if (isUniqueViolation(e)) {
      throw new MediaError("bad_request", `同级已存在同名分类「${nextName}」`, 409);
    }
    throw new MediaError("internal", `更新分类失败：${(e as Error).message}`, 500);
  }

  // 改名 / 移动会改变自身与子孙的 path 快照 → 刷新受影响媒资的投影（spec.md §8.3）
  const structureChanged = nextName !== current.name || nextParentId !== current.parentId;
  let refreshedMedia = 0;
  if (structureChanged) {
    // 默认分类「其他」改名 / 移动时：未设置分类（category_id IS NULL）的历史媒资同样受影响
    const defaultCategoryId = rows.find((r) => r.isSystem)?.id ?? null;
    const mediaIds = await listMediaIdsByCategories(
      collectSubtreeIds(rows, id),
      defaultCategoryId,
    );
    refreshedMedia = await refreshMediaCustomProjections(mediaIds);
  }

  const { items } = await listCategories();
  const item = items.find((i) => i.id === id);
  if (!item) throw new MediaError("internal", "分类更新后读取失败", 500);
  return { item, refreshed_media: refreshedMedia };
}

// ---- 删除（系统默认分类禁删；有子分类 → 409；该分类下媒资迁入默认分类「其他」并刷新投影） ----

export interface DeleteCategoryResult {
  id: string;
  name: string;
  /** 被迁出该分类的媒资数（媒资本身不删除，改为归入默认分类「其他」） */
  affected_media: number;
  /** 迁入的目标分类（系统默认分类「其他」）id */
  moved_to: string | null;
  refreshed_media: number;
}

export async function deleteCategory(id: string): Promise<DeleteCategoryResult> {
  const current = await findRow(id);
  if (!current) throw new MediaError("not_found", `分类不存在：${id}`, 404);
  if (current.isSystem) {
    throw new MediaError(
      "bad_request",
      `「${current.name}」是系统默认分类（未设置分类的媒资归属它），不可删除`,
      409,
    );
  }

  const children = await db.mediaCategory.count({ where: { parentId: id } });
  if (children > 0) {
    throw new MediaError(
      "bad_request",
      `该分类下还有 ${children} 个子分类，请先删除或移动子分类后再删除`,
      409,
    );
  }
  // 该分类下的媒资**迁入默认分类「其他」**（而不是留 NULL：未设置分类即「其他」）；
  // 先迁移再删分类，避免依赖 FK 的 SetNull 兜底
  const [mediaIds, defaultCategory] = await Promise.all([
    listMediaIdsByCategories([id]),
    ensureDefaultCategory(),
  ]);
  if (mediaIds.length && defaultCategory) {
    await db.media.updateMany({
      where: { categoryId: id },
      data: { categoryId: defaultCategory.id },
    });
  }
  try {
    await db.mediaCategory.delete({ where: { id } });
  } catch (e) {
    if (isRecordNotFound(e)) throw new MediaError("not_found", `分类不存在：${id}`, 404);
    throw new MediaError("internal", `删除分类失败：${(e as Error).message}`, 500);
  }
  const refreshed = await refreshMediaCustomProjections(mediaIds);
  return {
    id,
    name: current.name,
    affected_media: mediaIds.length,
    moved_to: defaultCategory?.id ?? null,
    refreshed_media: refreshed,
  };
}

/** 业务错误 → 统一错误信封响应（复用 MediaError 语义） */
export function categoryErrorResponse(e: unknown): NextResponse {
  if (e instanceof MediaError) return apiError(e.code, e.message, e.status);
  console.error("[categories] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
