// 播放端用户管理业务逻辑（ADR-0004 `users` 表；ADR-0007 账户域）
//   users：播放端用户，管理端 CRUD（创建 / 封禁 / 重置密码 / 并发上限），分发端 login 校验。
// 与 admin_users（better-auth 控制台账号）是两套体系，切勿混用（ADR-0007）。
//
// 安全口径：
//   - 口令 bcrypt 哈希（cost 12）后入库，**绝不回显 password_hash**（DTO 无该字段）；
//   - 封禁（ACTIVE → DISABLED）与重置密码都会**立即吊销该用户未过期的播放会话**——
//     前者是 ADR-0007 明文规定，后者是凭据变更后的等价收敛（否则已下发 JWT 在 exp 前仍可播）；
//   - 已下发分片 token 在自身 exp 内仍有效（ADR-0006 已声明接受），吊销只影响新请求。
//
// 依赖注入：所有 DB / 哈希 / 时间读取经 `UserDeps`（默认实现见文件末尾 defaultDeps），
// 编排规则可纯单测（同 lib/transcode-submit.ts 的模式）。
import {
  CreateUserRequest,
  ResetUserPasswordRequest,
  UpdateUserRequest,
  UserDTO,
  UserListResponse,
  z,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./envelope";
import { hashPassword } from "./password";

// 懒取 Prisma 客户端（同包其他 lib 用顶层 `const db = getDb()`）：
// 本模块的默认依赖只在真实请求路径上触达 DB，单测全部走注入 deps。
// 顶层实例化会让「import 即连库」，既在 Next 服务端多开无用的连接池，
// 也会把 packages/db 的单例钉在首个调用者的 DB_PROVIDER 上
// （worker 的 key-landing 单测在进程内切 sqlite 时会被抢跑，见该测试 ② 段）。
const db = (): any => getDb<any>();

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type UserStatusValue = z.infer<typeof UserDTO>["status"];

/** `users` 行（按需 select，password_hash 不进对象，杜绝回显） */
export interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
  maxConcurrentSessions: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 用户写操作入参（create 全量；update 为部分字段） */
export interface UserWriteData {
  username?: string;
  passwordHash?: string;
  displayName?: string | null;
  status?: UserStatusValue;
  maxConcurrentSessions?: number;
}

export interface UserDeps {
  /** 当前时间（会话过期判定 / 吊销时间戳） */
  now(): Date;
  /** 全量用户（创建时间倒序） */
  listUsers(): Promise<UserRow[]>;
  /** 批量统计未过期且未吊销的播放会话数 */
  countActiveSessions(userIds: string[]): Promise<Record<string, number>>;
  findUser(id: string): Promise<UserRow | null>;
  /** 创建；用户名唯一冲突应抛 UserError(409) */
  createUser(data: UserWriteData): Promise<UserRow>;
  /** 更新；不存在应抛 UserError(404) */
  updateUser(id: string, data: UserWriteData): Promise<UserRow>;
  deleteUser(id: string): Promise<void>;
  /** 吊销该用户未过期会话，返回吊销条数 */
  revokeActiveSessions(userId: string): Promise<number>;
  /** bcrypt 哈希（ADR-0007） */
  hashPassword(password: string): Promise<string>;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "请求体校验失败"}`;
}

function toDto(row: UserRow, activeSessions: number): z.infer<typeof UserDTO> {
  return {
    id: row.id,
    username: row.username,
    display_name: row.displayName,
    status: row.status as UserStatusValue,
    max_concurrent_sessions: row.maxConcurrentSessions,
    active_sessions: activeSessions,
    last_login_at: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---- 列表 ----

export async function listUsers(deps: UserDeps): Promise<z.infer<typeof UserListResponse>> {
  const rows = await deps.listUsers();
  const counts = await deps.countActiveSessions(rows.map((r) => r.id));
  return {
    total: rows.length,
    items: rows.map((row) => toDto(row, counts[row.id] ?? 0)),
  };
}

// ---- 详情 ----

export async function getUser(id: string, deps: UserDeps): Promise<z.infer<typeof UserDTO>> {
  const row = await deps.findUser(id);
  if (!row) throw new UserError("not_found", `用户不存在：${id}`, 404);
  const counts = await deps.countActiveSessions([row.id]);
  return toDto(row, counts[row.id] ?? 0);
}

// ---- 创建 ----

export async function createUser(body: unknown, deps: UserDeps): Promise<z.infer<typeof UserDTO>> {
  const parsed = CreateUserRequest.safeParse(body);
  if (!parsed.success) throw new UserError("bad_request", firstIssue(parsed.error), 400);
  const input = parsed.data;
  // 展示名归一：未填（缺省 / null / 空串）= 默认沿用用户名（对应表单提示「留空默认与用户名一致」）
  const displayName = input.display_name || input.username;
  const passwordHash = await deps.hashPassword(input.password);
  try {
    const row = await deps.createUser({
      username: input.username,
      passwordHash,
      displayName,
      status: input.status,
      maxConcurrentSessions: input.max_concurrent_sessions,
    });
    // 新建用户的会话数必然为 0；DISABLED 创建的账号本就不可登录
    return toDto(row, 0);
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (isUniqueViolation(e)) {
      throw new UserError("bad_request", `用户名已存在：${input.username}`, 409);
    }
    throw new UserError("internal", `创建用户失败：${(e as Error).message}`, 500);
  }
}

// ---- 更新（展示名 / 状态 / 并发上限） ----

export async function updateUser(
  id: string,
  body: unknown,
  deps: UserDeps,
): Promise<{ user: z.infer<typeof UserDTO>; revoked_sessions: number }> {
  const parsed = UpdateUserRequest.safeParse(body);
  if (!parsed.success) throw new UserError("bad_request", firstIssue(parsed.error), 400);
  const input = parsed.data;

  const current = await deps.findUser(id);
  if (!current) throw new UserError("not_found", `用户不存在：${id}`, 404);

  const data: UserWriteData = {};
  // 展示名归一（与创建一致）：null / 空串 = 回退沿用用户名，而非清空
  if (input.display_name !== undefined) {
    data.displayName = input.display_name || current.username;
  }
  if (input.status !== undefined) data.status = input.status;
  if (input.max_concurrent_sessions !== undefined) {
    data.maxConcurrentSessions = input.max_concurrent_sessions;
  }

  // ADR-0007：封禁用户 → 登录拒绝 + **全会话吊销**（只在 ACTIVE → DISABLED 跳变时执行一次）
  const shouldRevoke = input.status === "DISABLED" && current.status === "ACTIVE";

  let row: UserRow;
  try {
    row = await deps.updateUser(id, data);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError("internal", `更新用户失败：${(e as Error).message}`, 500);
  }

  const revoked = shouldRevoke ? await deps.revokeActiveSessions(id) : 0;
  const counts = await deps.countActiveSessions([id]);
  return { user: toDto(row, counts[id] ?? 0), revoked_sessions: revoked };
}

// ---- 重置密码（凭据变更 → 同步吊销会话） ----

export async function resetUserPassword(
  id: string,
  body: unknown,
  deps: UserDeps,
): Promise<{ id: string; username: string; revoked_sessions: number }> {
  const parsed = ResetUserPasswordRequest.safeParse(body);
  if (!parsed.success) throw new UserError("bad_request", firstIssue(parsed.error), 400);

  const current = await deps.findUser(id);
  if (!current) throw new UserError("not_found", `用户不存在：${id}`, 404);

  const passwordHash = await deps.hashPassword(parsed.data.password);
  try {
    await deps.updateUser(id, { passwordHash });
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError("internal", `重置密码失败：${(e as Error).message}`, 500);
  }
  // 口令已变更：旧凭据签发的会话必须失效（等价于封禁的会话侧效果，ADR-0007）
  const revoked = await deps.revokeActiveSessions(id);
  return { id: current.id, username: current.username, revoked_sessions: revoked };
}

// ---- 吊销会话（手动；用户仍可重新登录） ----

export async function revokeUserSessions(
  id: string,
  deps: UserDeps,
): Promise<{ id: string; username: string; revoked_sessions: number }> {
  const current = await deps.findUser(id);
  if (!current) throw new UserError("not_found", `用户不存在：${id}`, 404);
  const revoked = await deps.revokeActiveSessions(id);
  return { id: current.id, username: current.username, revoked_sessions: revoked };
}

// ---- 删除（playback_sessions 随用户级联删除，ADR-0004） ----

export async function deleteUser(
  id: string,
  deps: UserDeps,
): Promise<{ id: string; username: string; revoked_sessions: number }> {
  const current = await deps.findUser(id);
  if (!current) throw new UserError("not_found", `用户不存在：${id}`, 404);
  const counts = await deps.countActiveSessions([id]);
  try {
    await deps.deleteUser(id);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError("internal", `删除用户失败：${(e as Error).message}`, 500);
  }
  // 行级联删除即等效吊销；返回值让调用方在审计与提示里带上条数
  return {
    id: current.id,
    username: current.username,
    revoked_sessions: counts[id] ?? 0,
  };
}

// ---- 默认依赖：Prisma + bcrypt（生产实现） ----

export const defaultUserDeps: UserDeps = {
  now: () => new Date(),
  listUsers: () => db().user.findMany({ orderBy: { createdAt: "desc" } }) as Promise<UserRow[]>,
  countActiveSessions: async (userIds) => {
    if (!userIds.length) return {};
    const rows: Array<{ userId: string; _count?: { _all?: number } }> = await db().playbackSession.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: new Date() } },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r?.userId) counts[r.userId] = r._count?._all ?? 0;
    }
    return counts;
  },
  findUser: (id) =>
    db().user.findUnique({ where: { id } }).then((row: UserRow | null) => row ?? null),
  createUser: async (data) => {
    try {
      return (await db().user.create({ data })) as UserRow;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const conflict = (e as { meta?: { target?: unknown } }).meta?.target;
        throw new UserError(
          "bad_request",
          `用户名已存在${conflict ? `（${String(conflict)}）` : ""}`,
          409,
        );
      }
      throw e;
    }
  },
  updateUser: async (id, data) => {
    try {
      return (await db().user.update({ where: { id }, data })) as UserRow;
    } catch (e) {
      if ((e as { code?: string }).code === "P2025") {
        throw new UserError("not_found", `用户不存在：${id}`, 404);
      }
      throw e;
    }
  },
  deleteUser: async (id) => {
    try {
      await db().user.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2025") {
        throw new UserError("not_found", `用户不存在：${id}`, 404);
      }
      throw e;
    }
  },
  revokeActiveSessions: async (userId) => {
    const result = await db().playbackSession.updateMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    return (result as { count?: number }).count ?? 0;
  },
  hashPassword,
};

/** 业务错误 → 统一错误信封响应 */
export function userErrorResponse(e: unknown): NextResponse {
  if (e instanceof UserError) return apiError(e.code, e.message, e.status);
  console.error("[users] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
