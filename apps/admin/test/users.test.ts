// 播放端用户管理业务规则单测（ADR-0004 `users` 表；ADR-0007 账户域）
// 覆盖：
//   - 创建：字段归一（trim / 默认值）、用户名非法 400、口令过短 400、用户名冲突 409、
//     DTO 不回显 password_hash、新用户会话数恒 0；
//   - 更新（PATCH 部分语义）：仅改展示名不触碰状态、封禁（ACTIVE→DISABLED）吊销会话且只一次、
//     重复封禁不重复吊销、解封不吊销、用户不存在 404；
//   - 重置密码：口令哈希后写库 + **同步吊销会话**（凭据变更收敛）、404；
//   - 吊销会话：404、返回吊销条数、不改变用户状态；
//   - 删除：404、返回随用户级联删除的会话数；
//   - 列表 / 详情：active_sessions 按用户归组统计。
// 被测函数为依赖注入的纯编排（../src/lib/users），不连 DB。
import { describe, expect, it } from "bun:test";
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  resetUserPassword,
  revokeUserSessions,
  updateUser,
  type UserDeps,
  type UserRow,
  type UserWriteData,
} from "../src/lib/users";

const NOW = new Date("2026-09-18T00:00:00.000Z");

function makeRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    username: "alice",
    displayName: null,
    status: "ACTIVE",
    maxConcurrentSessions: 0,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** 内存 users 表 + 会话计数，模拟 Prisma 行为（含 P2002 唯一冲突） */
function makeDeps(over: Partial<UserDeps> = {}) {
  const rows: UserRow[] = [makeRow()];
  const sessionCounts: Record<string, number> = { u1: 3 };
  const revoked: string[] = [];
  const created: UserWriteData[] = [];
  const updated: Array<{ id: string; data: UserWriteData }> = [];
  const deps: UserDeps = {
    now: () => NOW,
    listUsers: async () => [...rows],
    countActiveSessions: async (ids) => {
      const out: Record<string, number> = {};
      for (const id of ids) out[id] = sessionCounts[id] ?? 0;
      return out;
    },
    findUser: async (id) => rows.find((r) => r.id === id) ?? null,
    createUser: async (data) => {
      created.push(data);
      if (rows.some((r) => r.username === data.username)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = makeRow({
        id: "u-new",
        username: data.username ?? "new",
        displayName: data.displayName ?? null,
        status: data.status ?? "ACTIVE",
        maxConcurrentSessions: data.maxConcurrentSessions ?? 0,
      });
      rows.push(row);
      sessionCounts[row.id] = 0;
      return row;
    },
    updateUser: async (id, data) => {
      updated.push({ id, data });
      const row = rows.find((r) => r.id === id);
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      Object.assign(row, {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.maxConcurrentSessions !== undefined
          ? { maxConcurrentSessions: data.maxConcurrentSessions }
          : {}),
      });
      return row;
    },
    deleteUser: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      rows.splice(i, 1);
    },
    revokeActiveSessions: async (userId) => {
      revoked.push(userId);
      const n = sessionCounts[userId] ?? 0;
      sessionCounts[userId] = 0;
      return n;
    },
    // 固定摘要，避免测试里跑 12 轮 bcrypt（12 × 单测开销）
    hashPassword: async (password) => `hash(${password})`,
  };
  return { deps, rows, sessionCounts, revoked, created, updated };
}

/** 业务错误断言辅助（UserError：code + status） */
async function expectUserError(
  p: Promise<unknown>,
  status: number,
): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; status?: number; message: string };
    expect(err.status).toBe(status);
    return { code: err.code ?? "", message: err.message };
  }
  throw new Error("预期抛错但未抛出");
}

// ---- 创建 ----

describe("createUser", () => {
  it("归一化入参：trim / 默认状态与并发上限，口令仅以哈希形式落库", async () => {
    const { deps, created } = makeDeps();
    const dto = await createUser(
      {
        username: "  bob  ",
        password: "supersecret",
        display_name: "  鲍勃  ",
      },
      deps,
    );
    expect(dto.username).toBe("bob");
    expect(dto.display_name).toBe("鲍勃");
    expect(dto.status).toBe("ACTIVE");
    expect(dto.max_concurrent_sessions).toBe(0);
    expect(created[0]).toEqual({
      username: "bob",
      passwordHash: "hash(supersecret)",
      displayName: "鲍勃",
      status: "ACTIVE",
      maxConcurrentSessions: 0,
    });
    // 新用户没有会话，DTO 不回显 password_hash
    expect(dto.active_sessions).toBe(0);
    expect(JSON.stringify(dto)).not.toContain("supersecret");
    expect(JSON.stringify(dto)).not.toContain("password_hash");
  });

  it("用户名不符合 3–32 位规则 → 400 且不落库", async () => {
    const { deps, created } = makeDeps();
    const err = await expectUserError(
      createUser({ username: "ab", password: "supersecret" }, deps),
      400,
    );
    expect(err.message).toContain("username");
    expect(created).toHaveLength(0);
  });

  it("口令少于 8 位 → 400", async () => {
    const { deps } = makeDeps();
    await expectUserError(createUser({ username: "bob", password: "short" }, deps), 400);
  });

  it("用户名重复（P2002）→ 409", async () => {
    const { deps } = makeDeps();
    const err = await expectUserError(
      createUser({ username: "alice", password: "supersecret" }, deps),
      409,
    );
    expect(err.message).toContain("alice");
  });
});

// ---- 更新 ----

describe("updateUser", () => {
  it("PATCH 部分语义：只改展示名时状态不变、不吊销会话", async () => {
    const { deps, revoked } = makeDeps();
    const { user, revoked_sessions } = await updateUser("u1", { display_name: "爱丽丝" }, deps);
    expect(user.display_name).toBe("爱丽丝");
    expect(user.status).toBe("ACTIVE");
    expect(revoked_sessions).toBe(0);
    expect(revoked).toHaveLength(0);
  });

  it("display_name 传 null = 清空展示名", async () => {
    const { deps } = makeDeps();
    const { user } = await updateUser("u1", { display_name: null }, deps);
    expect(user.display_name).toBeNull();
  });

  it("封禁（ACTIVE→DISABLED）→ 吊销全部未过期会话（ADR-0007）", async () => {
    const { deps, revoked, sessionCounts } = makeDeps();
    const { user, revoked_sessions } = await updateUser("u1", { status: "DISABLED" }, deps);
    expect(user.status).toBe("DISABLED");
    expect(revoked_sessions).toBe(3);
    expect(revoked).toEqual(["u1"]);
    expect(user.active_sessions).toBe(0);
    expect(sessionCounts.u1).toBe(0);
  });

  it("已封禁用户再次置 DISABLED → 不重复吊销", async () => {
    const { deps, revoked } = makeDeps();
    await updateUser("u1", { status: "DISABLED" }, deps);
    const second = await updateUser("u1", { status: "DISABLED" }, deps);
    expect(second.revoked_sessions).toBe(0);
    expect(revoked).toEqual(["u1"]);
  });

  it("解封（DISABLED→ACTIVE）不触发吊销", async () => {
    const { deps, revoked, sessionCounts } = makeDeps();
    sessionCounts.u1 = 2;
    await updateUser("u1", { status: "DISABLED" }, deps);
    const { user, revoked_sessions } = await updateUser("u1", { status: "ACTIVE" }, deps);
    expect(user.status).toBe("ACTIVE");
    expect(revoked_sessions).toBe(0);
    expect(revoked).toEqual(["u1"]);
  });

  it("仅改并发上限不改变状态与会话", async () => {
    const { deps } = makeDeps();
    const { user } = await updateUser("u1", { max_concurrent_sessions: 2 }, deps);
    expect(user.max_concurrent_sessions).toBe(2);
    expect(user.status).toBe("ACTIVE");
    expect(user.active_sessions).toBe(3);
  });

  it("用户不存在 → 404", async () => {
    const { deps } = makeDeps();
    await expectUserError(updateUser("nope", { status: "DISABLED" }, deps), 404);
  });

  it("并发上限非法（负数）→ 400", async () => {
    const { deps } = makeDeps();
    await expectUserError(updateUser("u1", { max_concurrent_sessions: -1 }, deps), 400);
  });
});

// ---- 重置密码 ----

describe("resetUserPassword", () => {
  it("写入口令哈希并同步吊销会话（凭据变更收敛，ADR-0007）", async () => {
    const { deps, updated, revoked } = makeDeps();
    const result = await resetUserPassword("u1", { password: "brandnewpass" }, deps);
    expect(result).toEqual({ id: "u1", username: "alice", revoked_sessions: 3 });
    expect(updated[0]?.data.passwordHash).toBe("hash(brandnewpass)");
    // 写库字段只有 passwordHash，绝不明文落库
    expect(Object.keys(updated[0]?.data ?? {})).toEqual(["passwordHash"]);
    expect(revoked).toEqual(["u1"]);
  });

  it("口令过短 → 400 且不写库", async () => {
    const { deps, updated } = makeDeps();
    await expectUserError(resetUserPassword("u1", { password: "short" }, deps), 400);
    expect(updated).toHaveLength(0);
  });

  it("用户不存在 → 404", async () => {
    const { deps } = makeDeps();
    await expectUserError(resetUserPassword("nope", { password: "brandnewpass" }, deps), 404);
  });
});

// ---- 吊销会话 / 删除 ----

describe("revokeUserSessions", () => {
  it("返回吊销条数，用户状态不受影响（可重新登录）", async () => {
    const { deps, rows } = makeDeps();
    const result = await revokeUserSessions("u1", deps);
    expect(result.revoked_sessions).toBe(3);
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("无会话时返回 0，用户不存在 → 404", async () => {
    const { deps, sessionCounts } = makeDeps();
    sessionCounts.u1 = 0;
    expect((await revokeUserSessions("u1", deps)).revoked_sessions).toBe(0);
    await expectUserError(revokeUserSessions("nope", deps), 404);
  });
});

describe("deleteUser", () => {
  it("删除用户并报告随用户级联删除的会话数", async () => {
    const { deps, rows } = makeDeps();
    const result = await deleteUser("u1", deps);
    expect(result).toEqual({ id: "u1", username: "alice", revoked_sessions: 3 });
    expect(rows).toHaveLength(0);
  });

  it("用户不存在 → 404", async () => {
    const { deps } = makeDeps();
    await expectUserError(deleteUser("nope", deps), 404);
  });
});

// ---- 列表 / 详情 ----

describe("list & get", () => {
  it("按用户归组统计未过期会话数", async () => {
    const { deps } = makeDeps();
    const list = await listUsers(deps);
    expect(list.total).toBe(1);
    expect(list.items[0].username).toBe("alice");
    expect(list.items[0].active_sessions).toBe(3);
    expect(list.items[0].status).toBe("ACTIVE");
  });

  it("详情：不存在 → 404", async () => {
    const { deps } = makeDeps();
    await expectUserError(getUser("nope", deps), 404);
  });
});
