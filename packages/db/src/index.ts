// @openvod/db — Prisma 客户端入口（ADR-0004 / ADR-0013）
// 生成物在 packages/db/generated/{mysql,sqlite}（.gitignore 已忽略），
// 先执行 `task db:generate`（按 DB_PROVIDER 方言）再使用。
// 注意：两份客户端为静态导入（Next/webpack 可打包），仅按 provider 实例化其一。
import { PrismaClient as MySQLPrismaClient } from "../generated/mysql";
import { PrismaClient as SQLitePrismaClient } from "../generated/sqlite";

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
  _db =
    provider === "mysql"
      ? new MySQLPrismaClient()
      : new SQLitePrismaClient();
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
