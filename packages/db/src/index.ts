// @openvod/db — Prisma 客户端入口（ADR-0004 / ADR-0020）
// Prisma 7 起客户端不内置数据库驱动，必须显式传 driver adapter：
//   - MySQL：@prisma/adapter-mariadb（mariadb 驱动，schema provider 仍写 "mysql"）
//   - SQLite：@prisma/adapter-libsql（Node 与 Bun 通用；better-sqlite3 在 Bun 下装不上，见 ADR-0020）
// 生成物在 packages/db/generated/{mysql,sqlite}（.gitignore 已忽略），先执行 `task db:generate`。
// 两份客户端静态导入（Next/webpack 需同时可解析），按 provider 实例化其一。
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient as MySQLPrismaClient } from "../generated/mysql/client";
import { PrismaClient as SQLitePrismaClient } from "../generated/sqlite/client";

export type DBProvider = "mysql" | "sqlite";

export function currentProvider(): DBProvider {
  const p = (process.env.DB_PROVIDER ?? "mysql").toLowerCase();
  if (p !== "mysql" && p !== "sqlite") {
    throw new Error(`DB_PROVIDER 非法：${p}（应为 mysql | sqlite）`);
  }
  return p;
}

/**
 * 从 CWD 向上定位 packages/db/prisma。
 * 与 Go 分发端 config.resolveSQLitePath 同一基准：`file:./dev.db` 指的是
 * packages/db/prisma/dev.db，不是进程 CWD 下的 dev.db。
 */
function findPrismaSchemaDir(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "packages", "db", "prisma");
    if (existsSync(join(candidate, "sqlite", "schema.sqlite.prisma"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * SQLite 连接串归一：`file:./dev.db` / `file:///abs.db` / `sqlite:///abs.db` → `file:/abs.db`。
 * 相对路径以 packages/db/prisma 为基准；找不到 schema 目录（独立部署）时按 CWD 解析，
 * 此时应改用绝对路径。
 */
export function sqliteFileUrl(raw: string): string {
  let path = raw.trim();
  let relativeAllowed = false;
  if (path.startsWith("file:")) path = path.slice("file:".length);
  else if (path.startsWith("sqlite:")) {
    path = path.slice("sqlite:".length);
    relativeAllowed = true; // sqlite://rel.db 是相对路径，sqlite:///abs.db 是绝对路径
  } else throw new Error(`SQLite 连接串必须以 file: 或 sqlite: 开头：${raw}`);
  const query = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  if (!path) throw new Error("SQLite 连接串缺少文件路径");
  if (path.startsWith("///")) path = path.slice(2); // file:///abs.db → /abs.db
  else if (path.startsWith("//")) path = relativeAllowed ? path.slice(2) : path.slice(1);
  if (!isAbsolute(path)) path = join(findPrismaSchemaDir() ?? process.cwd(), path);
  return `file:${path}`;
}

/**
 * SQLite 适配器（唯一构造点：时间戳格式写死在这里，测试与运行时代码共用）。
 * timestampFormat 必须显式指定：Prisma 7 适配器默认把 DateTime 存成 ISO 8601 文本，
 * 而本仓库的物理表示是整数毫秒（Go 侧 store.Time 按整数读，ADR-0011 修订）。
 */
export function createSQLiteAdapter(url: string): PrismaLibSql {
  return new PrismaLibSql({ url: sqliteFileUrl(url) }, { timestampFormat: "unixepoch-ms" });
}

/** 按 provider 构造驱动适配器；DATABASE_URL 缺失时立即失败，不带病启动 */
function createAdapter(provider: DBProvider): PrismaMariaDb | PrismaLibSql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未配置");
  return provider === "mysql" ? new PrismaMariaDb(url) : createSQLiteAdapter(url);
}

let _db: unknown;

/** 仅供测试：丢弃单例，下一次 getDb() 按当前 env 重建（多测试文件共享进程时隔离用） */
export function resetDb(): void {
  _db = undefined;
}

/** 懒加载单例；未执行 generate 前调用会抛出明确错误 */
export function getDb<T = unknown>(): T {
  if (_db) return _db as T;
  const provider = currentProvider();
  const adapter = createAdapter(provider);
  // 两份 PrismaClient 的联合推断会触发 TS2589（泛型实例化过深，next build 会失败），
  // 故先擦除为「只接收 adapter 的构造函数」再实例化；运行时行为不变。
  const Ctor = (provider === "mysql" ? MySQLPrismaClient : SQLitePrismaClient) as unknown as new (args: {
    adapter: PrismaMariaDb | PrismaLibSql;
  }) => unknown;
  _db = new Ctor({ adapter });
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
