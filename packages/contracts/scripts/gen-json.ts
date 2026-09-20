// zod → JSON Schema（供 quicktype 生成 Go struct，ADR-0001）
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ErrorEnvelope,
  LoginRequest,
  LoginResponse,
  MediaDetail,
  MediaListItem,
  MediaSubtitleDTO,
  PageQuery,
  PageResponse,
  PlaybackRequest,
  PlaybackResponse,
  PlaybackSubtitleDTO,
} from "../src/index";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "jsonschema");
mkdirSync(outDir, { recursive: true });

const schemas: Array<[string, z.ZodType]> = [
  ["ErrorEnvelope", ErrorEnvelope],
  ["LoginRequest", LoginRequest],
  ["LoginResponse", LoginResponse],
  ["MediaListItem", MediaListItem],
  ["MediaDetail", MediaDetail],
  ["MediaSubtitleDTO", MediaSubtitleDTO],
  ["PlaybackSubtitleDTO", PlaybackSubtitleDTO],
  ["PageQuery", PageQuery],
  ["PageResponse", PageResponse],
  ["PlaybackRequest", PlaybackRequest],
  ["PlaybackResponse", PlaybackResponse],
];

for (const [name, schema] of schemas) {
  if (typeof (z as any).toJSONSchema !== "function") {
    console.error("当前 zod 版本无 z.toJSONSchema()，需要 zod >= 4.0");
    process.exit(1);
  }
  const json = (z as any).toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  json.$id = `${name}.json`;
  json.title = name;
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log("wrote", `${name}.json`);
}
