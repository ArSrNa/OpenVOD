// /api/setup：首次启动向导 API（ADR-0015）
//   GET  初始化状态（未完成初始化时开放；已完成返回 403，避免暴露配置细节）
//   POST 完成初始化：写存储 / 播放配置（密钥 MK 封装入库），可选创建首个管理员账号
// 本路由不走 getAdminSession（首次启动时还没有可登录的管理员）；
// 完成后路由即失效（POST 由 completeSetup 的 setup_completed 检查拒绝）。
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@openvod/db";
import { apiJson, apiError } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import {
  completeSetup,
  getSettingsSnapshot,
  hasMasterKeys,
  isSetupCompleted,
  settingsErrorResponse,
  type SetupPayload,
} from "@/lib/settings";
// 说明：settingsErrorResponse 内部已处理 SettingsError 映射，路由无需显式 instanceof

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    if (await isSetupCompleted()) {
      return apiError("forbidden", "系统已完成初始化", 403);
    }
    // 环境自检（只报状态，不回显任何密钥值）
    return apiJson({
      setup_completed: false,
      master_keys_ok: hasMasterKeys(),
      storage_configured: (await getSettingsSnapshot().catch(() => null))?.storage.configured ?? false,
    });
  } catch (e) {
    return settingsErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as Partial<SetupPayload> | null;
    if (!body) return apiError("bad_request", "请求体必须是 JSON", 400);
    if (!body.s3_endpoint || !body.s3_bucket || !body.s3_access_key_id || !body.s3_secret_access_key) {
      return apiError("bad_request", "对象存储必填项缺失（端点 / 桶 / AccessKeyID / SecretAccessKey）", 400);
    }
    const result = await completeSetup(body as SetupPayload);

    // 可选：创建首个管理员（email + password ≥8 位；失败不回滚初始化，错误信息返回给向导展示）
    let adminError: string | null = null;
    if (body.admin_email && body.admin_password) {
      try {
        const db = getDb<any>();
        const existing: number = await db.adminUser.count();
        if (existing === 0) {
          const auth = await getAuth();
          await auth.api.signUpEmail({
            body: {
              email: body.admin_email.trim(),
              password: body.admin_password,
              name: body.admin_name?.trim() || body.admin_email.split("@")[0],
            },
          });
        }
      } catch (e) {
        adminError = (e as Error).message;
      }
    }
    return apiJson({ ...result, admin_error: adminError });
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
