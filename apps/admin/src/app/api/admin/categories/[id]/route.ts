// /api/admin/categories/[id]：分类更新 / 删除（spec.md §8.1；ADR-0016）
//   PATCH  改名 / 描述 / 移动（禁止环路）/ 同级排序；改名与移动会刷新受影响媒资的自定义元数据投影
//   DELETE 删除：有子分类 → 409；该分类下媒资只被置空引用（不删媒资），并刷新其自定义元数据投影
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { categoryErrorResponse, deleteCategory, updateCategory } from "@/lib/categories";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const { item, refreshed_media } = await updateCategory(id, await req.json().catch(() => null));
    await auditAction(req, session, "category.update", id, {
      name: item.name,
      parent_id: item.parent_id,
      sort_order: item.sort_order,
      refreshed_media,
    });
    return apiJson({ item, refreshed_media });
  } catch (e) {
    return categoryErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteCategory(id);
    await auditAction(req, session, "category.delete", id, {
      name: result.name,
      affected_media: result.affected_media,
      refreshed_media: result.refreshed_media,
    });
    return apiJson(result);
  } catch (e) {
    return categoryErrorResponse(e);
  }
}
