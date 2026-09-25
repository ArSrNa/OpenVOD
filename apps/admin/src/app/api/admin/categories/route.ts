// /api/admin/categories：媒资分类列表 / 新建（spec.md §8.1；ADR-0016）
//   GET   扁平列表（层级由 parent_id 表达，客户端组树；含直属 / 含子孙媒资计数）
//   POST  新建（parent_id 缺省 / null = 顶级；无限层级；同级重名 409）
// 分类是独立模块（/categories 页）：管理端维护，媒资通过 media.category_id 引用；
// 分发端不消费分类表（自定义元数据经 media.custom_data 公开白名单输出，spec.md §8.4）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { categoryErrorResponse, createCategory, listCategories } from "@/lib/categories";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listCategories());
  } catch (e) {
    return categoryErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const item = await createCategory(await req.json().catch(() => null));
    await auditAction(req, session, "category.create", item.id, {
      name: item.name,
      parent_id: item.parent_id,
    });
    return apiJson({ item }, 201);
  } catch (e) {
    return categoryErrorResponse(e);
  }
}
