// 分类树纯函数（spec.md §8.1 / ADR-0016）：无限层级邻接表（parent_id）→ 树 / 路径 / 子孙 / 环路校验。
// 不碰 DB 与 Next，便于单测；生产接线见 lib/categories.ts。
import { mediaCategoryPath, type MediaCustomCategory } from "@openvod/shared";

/** 分类节点（DB 行最小投影；扁平列表即 API 返回形态） */
export interface CategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

/** 树节点：在扁平节点上补路径 / 深度 / 子节点 */
export interface CategoryTreeNode extends CategoryNode {
  /** 祖先名 → 自身名（如 `电影 / 科幻`；分隔符见 MEDIA_CATEGORY_PATH_SEPARATOR） */
  path: string;
  /** 顶级为 0 */
  depth: number;
  children: CategoryTreeNode[];
}

/** 同级排序：sort_order 升序 → 名称（zh-CN）→ id（保证稳定） */
export function compareNodes(a: CategoryNode, b: CategoryNode): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name, "zh-CN");
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * 扁平列表 → 树（无限层级）。异常数据的容错：
 * - 上级不存在（已被删或跨库脏数据）→ 该节点按顶级处理，避免整棵子树从列表里消失；
 * - parent_id 形成环路（正常路径不可达，DB 无环约束）→ 截断递归，避免栈溢出。
 */
export function buildCategoryTree(nodes: readonly CategoryNode[]): CategoryTreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childMap = new Map<string, CategoryNode[]>();
  const roots: CategoryNode[] = [];
  for (const n of nodes) {
    const parentId = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (parentId === null) {
      roots.push(n);
      continue;
    }
    const siblings = childMap.get(parentId) ?? [];
    siblings.push(n);
    childMap.set(parentId, siblings);
  }

  const toTreeNode = (
    n: CategoryNode,
    ancestorNames: readonly string[],
    depth: number,
    seen: ReadonlySet<string>,
  ): CategoryTreeNode => {
    const names = [...ancestorNames, n.name];
    const node: CategoryTreeNode = { ...n, path: mediaCategoryPath(names), depth, children: [] };
    if (seen.has(n.id)) return node; // 环路保护：截断，不再展开子节点
    const nextSeen = new Set(seen).add(n.id);
    node.children = (childMap.get(n.id) ?? [])
      .slice()
      .sort(compareNodes)
      .map((child) => toTreeNode(child, names, depth + 1, nextSeen));
    return node;
  };

  return roots.slice().sort(compareNodes).map((root) => toTreeNode(root, [], 0, new Set()));
}

/** 前序遍历树（TreeSelect 选项 / 表格扁平回退用） */
export function flattenCategoryTree(tree: readonly CategoryTreeNode[]): CategoryTreeNode[] {
  const out: CategoryTreeNode[] = [];
  const walk = (nodes: readonly CategoryTreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** id → 分类路径（含自身名；未在列表中的 id 不出现） */
export function categoryPathMap(nodes: readonly CategoryNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of flattenCategoryTree(buildCategoryTree(nodes))) map.set(node.id, node.path);
  return map;
}

/** 分类解析表（一次构建，列表 / 详情 / 投影多媒资共用；含默认分类 id） */
export interface CategoryLookup {
  nodes: CategoryNode[];
  pathById: Map<string, string>;
  nameById: Map<string, string>;
  /** 系统默认分类「其他」的 id；未创建 / 读取失败时为 null */
  defaultId: string | null;
}

/** 构建解析表：扁平分类 + 路径表 + 默认分类 id */
export function buildCategoryLookup(
  nodes: readonly CategoryNode[],
  defaultId: string | null,
): CategoryLookup {
  return {
    nodes: nodes.slice(),
    pathById: categoryPathMap(nodes),
    nameById: new Map(nodes.map((n) => [n.id, n.name])),
    defaultId,
  };
}

/** 按 id 精确解析分类引用（**不做默认回退**；分类不存在 → null）——写入路径校验用 */
export function categoryRefById(
  lookup: CategoryLookup,
  categoryId: string | null,
): MediaCustomCategory | null {
  if (!categoryId) return null;
  const path = lookup.pathById.get(categoryId);
  if (!path) return null;
  return { id: categoryId, name: lookup.nameById.get(categoryId) ?? "", path };
}

/**
 * 媒资分类引用解析（spec.md §8.1 修订）：显式 `categoryId` 优先；
 * **为空（未设置分类）时回退到系统默认分类「其他」**；两者都不可用 → null（降级为「未分类」展示）。
 */
export function pickCategoryRef(
  lookup: CategoryLookup,
  categoryId: string | null,
): MediaCustomCategory | null {
  return categoryRefById(lookup, categoryId ?? lookup.defaultId);
}

/** 子树 id 集合（含自身；环路保护） */
export function collectSubtreeIds(nodes: readonly CategoryNode[], rootId: string): string[] {
  const childMap = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const siblings = childMap.get(n.parentId) ?? [];
    siblings.push(n.id);
    childMap.set(n.parentId, siblings);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue; // 环路保护
    seen.add(id);
    out.push(id);
    queue.push(...(childMap.get(id) ?? []));
  }
  return out;
}

/** nodeId 是否位于 ancestorId 的子树内（含自身）：移动分类时禁止把节点挂到自己的子孙下 */
export function isDescendantOf(
  nodes: readonly CategoryNode[],
  nodeId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let cursor: string | null = nodeId;
  while (cursor) {
    if (cursor === ancestorId) return true;
    if (seen.has(cursor)) return false; // 环路保护
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}
