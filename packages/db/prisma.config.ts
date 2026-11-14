// Prisma CLI 配置（ADR-0020）：Prisma 7 起 datasource URL 不再写在 schema 里，改由本文件提供。
// schema 由各脚本的 --schema 指定；这里只负责连接串与迁移目录。
// generate 不需要连接串（镜像构建阶段没有 .env），因此 DATABASE_URL 缺失时不注入 datasource。
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL;

export default defineConfig({
  ...(url ? { datasource: { url } } : {}),
  migrations: { path: "prisma/migrations" },
});
