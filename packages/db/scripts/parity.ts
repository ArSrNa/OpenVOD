// 双方言一致性检查（ADR-0004）：两份 schema 的 enum/model 段必须逐字一致
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma");
const section = (file: string) => {
  const text = readFileSync(join(dir, file), "utf8");
  const i = text.indexOf("\nenum ");
  if (i < 0) throw new Error(`${file} 中未找到模型段`);
  return text.slice(i).replace(/\r\n/g, "\n").trimEnd() + "\n";
};

const mysql = section("schema.mysql.prisma");
const sqlite = section("schema.sqlite.prisma");

if (mysql !== sqlite) {
  console.error("schema 漂移：enum/model 段不一致（ADR-0004 双方言纪律）");
  process.exit(1);
}
console.log("parity ok：两份 schema 模型段一致");
