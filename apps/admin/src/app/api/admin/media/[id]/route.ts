// /api/admin/media/[id]：媒资详情 / 字段更新（重命名 + 自定义元数据）/ 删除（intent.md 媒资管理操作，M1）
//   GET    详情：存储资产 + DB 元数据合并展示（含自定义元数据三项，spec.md §8.3）
//   PATCH  部分字段更新（contracts UpdateMediaRequest）：
//            title                重命名（仅改展示名，绝不动 original 文件名与媒资 ID）
//            description / tags / category_id
//                                 自定义元数据设置 → 重算 media.custom_data 投影
//                                 （分类 / 描述 / 标签，spec.md §8.2/§8.3），并导出 metadata/{id}/custom.json
//            uploaded_at          自定义上传时间（null = 恢复默认；spec.md §3.1：仅管理端展示 +
//                                 分发端列表排序回退，不进入元数据投影 / 下发）
//   DELETE 删除：存储四分区该 id 全部对象 + DB 行（级联范围注记见 spec.md §2）
// POST [id]/transcode、[id]/subtitles、[id]/metadata 未实现 → 由 /api/admin/[...path] 返回 501。
import { NextRequest, NextResponse } from "next/server";
import { UpdateMediaRequest, z } from "@openvod/contracts";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import {
  deleteMedia,
  getMediaDetail,
  mediaErrorResponse,
  renameMedia,
  updateMediaMetadata,
  updateMediaUploadedAt,
} from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "请求体校验失败"}`;
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson(await getMediaDetail(id));
  } catch (e) {
    return mediaErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const parsed = UpdateMediaRequest.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return apiError("bad_request", firstIssue(parsed.error), 400);
    const input = parsed.data;

    const result: Record<string, unknown> = { id };
    if (input.title !== undefined) {
      const row = await renameMedia(id, input.title);
      await auditAction(req, session, "media.rename", id, { title: row.title });
      result.title = row.title;
    }

    // 自定义上传时间（spec.md §3.1）：null = 恢复默认；不重算元数据投影
    if (input.uploaded_at !== undefined) {
      const row = await updateMediaUploadedAt(id, input.uploaded_at);
      await auditAction(req, session, "media.uploaded_at_update", id, {
        uploaded_at: row.uploadedAt,
      });
      result.uploadedAt = row.uploadedAt;
    }

    // 自定义元数据三项任一命中即重算投影（spec.md §8.2）
    if (
      input.description !== undefined ||
      input.tags !== undefined ||
      input.category_id !== undefined
    ) {
      const updated = await updateMediaMetadata(id, {
        description: input.description,
        tags: input.tags,
        categoryId: input.category_id,
      });
      await auditAction(req, session, "media.metadata_update", id, {
        category_id: updated.custom.category?.id ?? null,
        tags: updated.custom.tags,
        has_description: Boolean(updated.custom.description),
        custom_object_written: updated.customObjectWritten,
      });
      result.custom = updated.custom;
      result.customData = updated.customData;
      result.customDataKey = updated.customObjectKey;
      result.customDataWritten = updated.customObjectWritten;
    }
    return apiJson(result);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteMedia(id);
    await auditAction(req, session, "media.delete", id, { removed: result.removed });
    return apiJson(result);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
