// @openvod/db — Prisma 客户端入口（ADR-0004）
// 生成物在 packages/db/generated/{mysql,sqlite}（.gitignore 已忽略），
// 先执行 `task db:generate`（按 DB_PROVIDER 方言）再使用。

export type DBProvider = "mysql" | "sqlite";

export function currentProvider(): DBProvider {
  const p = (process.env.DB_PROVIDER ?? "mysql").toLowerCase();
  if (p !== "mysql" && p !== "sqlite") {
    throw new Error(`DB_PROVIDER 非法：${p}（应为 mysql | sqlite）`);
  }
  return p;
}

let _db: unknown;

/** 懒加载单例；未执行 generate 前调用会抛出明确错误 */
export function getDb<T = unknown>(): T {
  if (_db) return _db as T;
  const provider = currentProvider();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(`../generated/${provider}`);
  _db = new mod.PrismaClient();
  return _db as T;
}

export async function dbHealth(): Promise<boolean> {
  try {
    const db = getDb<{ $queryRaw: (q: TemplateStringsArray) => Promise<unknown[]> }>();
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch (e) {
    console.error("[db] health check failed:", (e as Error).message);
    return false;
  }
}
