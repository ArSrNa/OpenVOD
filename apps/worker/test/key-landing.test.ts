// Worker 密钥落地测试（spec.md §4.2；ADR-0006 §2）
//   ① 生成 → key_info → 落库 的编排语义（fake store，纯逻辑）
//   ② 「每媒资一份」整行替换的真实事务语义（临时 SQLite 库 + Prisma）
//   ③ ffmpeg 加密端到端（缺 ffmpeg 时跳过）：key_info 可用、清单 IV 不出现双重 0x、产物能用生成的 CEK 解密
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { openMediaKey, parseMasterKeys, pickWrappingMasterKey } from "@openvod/crypto";
import { getDb, resetDb } from "@openvod/db";
import { cleanupJobDir, keyUriPlaceholder, writeKeyFiles } from "../src/key-files";
import { generateMediaKey, persistMediaKey } from "../src/media-keys";
import {
  createPrismaMediaKeyStore,
  type MediaKeyRecord,
  type MediaKeyStore,
} from "../src/media-key-store";

const MK_HEX_1 = "a".repeat(64);
const MK_HEX_2 = "b".repeat(64);
const MKS = parseMasterKeys(`1:${MK_HEX_1},2:${MK_HEX_2}`);
const MEDIA_ID = "00000042";

/** 内存 store：验证编排顺序与「每媒资一份」的调用约定 */
class FakeStore implements MediaKeyStore {
  readonly rows = new Map<string, MediaKeyRecord>();
  replacedFlags: boolean[] = [];

  async replace(mediaId: string, record: MediaKeyRecord): Promise<{ replaced: boolean }> {
    const replaced = this.rows.has(mediaId);
    this.rows.set(mediaId, record);
    this.replacedFlags.push(replaced);
    return { replaced };
  }

  async find(mediaId: string): Promise<(MediaKeyRecord & { createdAt: Date }) | null> {
    const row = this.rows.get(mediaId);
    return row ? { ...row, createdAt: new Date() } : null;
  }
}

describe("① 密钥生成与落库编排", () => {
  it("generateMediaKey：用 active MK（最大版本）封装，返回材质形态齐全", () => {
    const key = generateMediaKey(MKS);
    expect(key.mkVer).toBe(2);
    expect(key.method).toBe("AES-128");
    expect(key.kid).toMatch(/^[0-9a-f]{32}$/);
    expect(key.ivHex).toMatch(/^[0-9a-f]{32}$/);
    expect(key.cek.length).toBe(16);
    // 明文与封装串必须不同：落库形态绝不含明文
    expect(key.wrappedCekHex).not.toContain(key.cek.toString("hex"));
    // 封装串可用 active MK 解封回同一 CEK（分发端 /key 与 MK 轮换都依赖这一点）
    expect(openMediaKey(pickWrappingMasterKey(MKS), key.wrappedCekHex).equals(key.cek)).toBe(true);
  });

  it("persistMediaKey：落库的是封装形态，且每媒资一份（第二次为替换）", async () => {
    const store = new FakeStore();
    const first = await persistMediaKey(store, MEDIA_ID, generateMediaKey(MKS));
    expect(first.replaced).toBe(false);
    expect(store.rows.size).toBe(1);

    const secondKey = generateMediaKey(MKS);
    const second = await persistMediaKey(store, MEDIA_ID, secondKey);
    expect(second.replaced).toBe(true);
    // 仍是同一媒资的唯一一行，且 kid 已换成新的（旧 kid 立即失效）
    expect(store.rows.size).toBe(1);
    expect(store.replacedFlags).toEqual([false, true]);
    expect(store.rows.get(MEDIA_ID)?.kid).toBe(secondKey.kid);
  });

  it("同一媒资两次生成的 kid / CEK / IV 互不相同（不做固定密钥）", () => {
    const a = generateMediaKey(MKS);
    const b = generateMediaKey(MKS);
    expect(a.kid).not.toBe(b.kid);
    expect(a.ivHex).not.toBe(b.ivHex);
    expect(a.cek.equals(b.cek)).toBe(false);
  });
});

// ---- ② 真实 DB 语义：临时 SQLite 库（建表 SQL 与 schema.sqlite.prisma 的 hls_keys 对齐） ----

const tmpRoot = mkdtempSync(join(tmpdir(), "openvod-worker-key-"));
const dbPath = join(tmpRoot, "test.db");
process.env.DB_PROVIDER = "sqlite";
process.env.DATABASE_URL = `file:${dbPath}`;

const DDL = `
CREATE TABLE "hls_keys" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "media_id" TEXT NOT NULL,
  "kid" TEXT NOT NULL,
  "method" TEXT NOT NULL DEFAULT 'AES-128',
  "iv" TEXT NOT NULL,
  "wrapped_cek" TEXT NOT NULL,
  "mk_ver" INTEGER NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "hls_keys_media_id_key" ON "hls_keys"("media_id");
CREATE UNIQUE INDEX "hls_keys_kid_key" ON "hls_keys"("kid");
`;

describe("② Prisma 存储：每媒资一份整行替换", () => {
  let raw: Database;

  beforeAll(() => {
    raw = new Database(dbPath);
    raw.exec(DDL);
    // 其他测试文件可能已在模块加载时按 .env（mysql）绑定过单例，这里按本文件的 sqlite env 重建
    resetDb();
  });

  afterAll(async () => {
    raw.close();
    await getDb<any>().$disconnect().catch(() => {});
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("首次落库 replaced=false；再次落库 replaced=true 且行数恒为 1", async () => {
    const store = createPrismaMediaKeyStore();
    const a = generateMediaKey(MKS);
    expect((await store.replace(MEDIA_ID, toRecord(a))).replaced).toBe(false);
    expect(raw.query("select count(*) c from hls_keys where media_id = ?").get(MEDIA_ID)).toEqual({
      c: 1,
    });

    const b = generateMediaKey(MKS);
    expect((await store.replace(MEDIA_ID, toRecord(b))).replaced).toBe(true);
    expect(raw.query("select count(*) c from hls_keys where media_id = ?").get(MEDIA_ID)).toEqual({
      c: 1,
    });
    expect((await store.find(MEDIA_ID))?.kid).toBe(b.kid);
  });

  it("不同媒资各自一行（互不影响）", async () => {
    const store = createPrismaMediaKeyStore();
    await store.replace("00000001", toRecord(generateMediaKey(MKS)));
    await store.replace("00000002", toRecord(generateMediaKey(MKS)));
    expect(raw.query("select count(*) c from hls_keys").get()).toEqual({ c: 3 });
  });

  it("事务失败必须整体回滚：kid 撞车时旧密钥行原样保留（不会留下无密钥的空洞）", async () => {
    const store = createPrismaMediaKeyStore();
    const existing = await store.find("00000001");
    expect(existing).not.toBeNull();

    // 用「已被 00000002 占用的 kid」替换 00000001 → create 违反 kid 唯一约束
    const conflict = await store.find("00000002");
    const bad = { ...toRecord(generateMediaKey(MKS)), kid: conflict!.kid };
    await expect(store.replace("00000001", bad)).rejects.toThrow();

    // 关键：deleteMany 已随事务回滚 → 旧行仍在，且 kid 未变
    const after = await store.find("00000001");
    expect(after?.kid).toBe(existing!.kid);
    expect(raw.query("select count(*) c from hls_keys where media_id = ?").get("00000001")).toEqual({
      c: 1,
    });
  });
});

function toRecord(key: ReturnType<typeof generateMediaKey>): MediaKeyRecord {
  return {
    kid: key.kid,
    method: key.method,
    ivHex: key.ivHex,
    wrappedCekHex: key.wrappedCekHex,
    mkVer: key.mkVer,
  };
}

// ---- ③ ffmpeg 端到端（缺 ffmpeg 直接跳过） ----

const hasFFmpeg = Boolean(Bun.which("ffmpeg"));

describe("③ ffmpeg 加密端到端", () => {
  it.skipIf(!hasFFmpeg)(
    "key_info 可用、清单 IV 无双重 0x、产物能用生成的 CEK 解密",
    async () => {
      const jobDir = mkdtempSync(join(tmpdir(), "openvod-worker-job-"));
      const key = generateMediaKey(MKS);
      const paths = await writeKeyFiles({ jobDir, mediaId: MEDIA_ID, key });

      // CEK 文件：16 字节裸字节（ffmpeg 原生支持）
      expect(readFileSync(paths.cekFilePath).length).toBe(16);
      // key_info 三行：占位 URI / CEK 路径 / **纯 hex IV**
      const keyInfo = readFileSync(paths.keyInfoPath, "utf8");
      const lines = keyInfo.split("\n");
      expect(lines[0]).toBe(keyUriPlaceholder(MEDIA_ID));
      expect(lines[0].endsWith(`/v1/media/${MEDIA_ID}/key`)).toBe(true);
      expect(lines[1]).toBe(paths.cekFilePath);
      expect(lines[2]).toBe(key.ivHex);
      expect(lines[2].startsWith("0x")).toBe(false);

      const playlistPath = join(jobDir, "index.m3u8");
      const proc = Bun.spawnSync({
        cmd: [
          "ffmpeg", "-y", "-loglevel", "error",
          "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2",
          "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-shortest",
          "-hls_time", "1", "-hls_playlist_type", "vod",
          "-hls_segment_filename", join(jobDir, "seg-%03d.ts"),
          "-hls_key_info_file", paths.keyInfoPath,
          playlistPath,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);

      const playlist = readFileSync(playlistPath, "utf8");
      expect(playlist).toContain("METHOD=AES-128");
      expect(playlist).toContain(`URI="${keyUriPlaceholder(MEDIA_ID)}"`);
      expect(playlist).toContain(`IV=0x${key.ivHex}`);
      // 回归守卫：第三行带 0x 会让 ffmpeg 产出 0x0x… 并加密失败（本次实测修复的坑）
      expect(playlist).not.toContain("IV=0x0x");

      // 真正的证明：用落库形态对应的 CEK 能解出 HLS 分片的 TS 同步字节
      const iv = Buffer.from(key.ivHex, "hex");
      const decipher = createDecipheriv("aes-128-cbc", key.cek, iv);
      const segment = readFileSync(join(jobDir, "seg-000.ts"));
      const plain = Buffer.concat([decipher.update(segment), decipher.final()]);
      expect(plain[0]).toBe(0x47);

      // 清理：明文 CEK 与 key_info 必须随任务目录消失，且可重复调用（成功 / 失败 / 取消路径共用）
      await cleanupJobDir(jobDir);
      await cleanupJobDir(jobDir); // 幂等
      expect(() => readFileSync(paths.keyInfoPath)).toThrow();
      expect(() => readFileSync(paths.cekFilePath)).toThrow();
    },
  );
});
