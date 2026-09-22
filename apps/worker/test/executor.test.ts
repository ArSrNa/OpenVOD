// M2 转码执行器端到端测试（ADR-0008 / spec.md §4.2）
// 真 ffmpeg + 磁盘假存储 + 假 DB（依赖注入）：验证「探测 → 逐档转码 → 上传 → 密钥落库 → 状态联动 → 清理」全链路。
// 缺 ffmpeg 时整体跳过（与 Worker 启动自检的口径一致）。
import { describe, expect, it } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMediaKey, parseMasterKeys, pickWrappingMasterKey } from "@openvod/crypto";
import { STORAGE_KEYS } from "@openvod/shared";
import type { StorageAdapter, StorageObject } from "@openvod/storage";
import { executeClaimedJob, type JobExecutorDeps } from "../src/executor";
import type { JobStatusName, TranscodeJobRow, TranscodeJobStore } from "../src/job-store";
import type { MediaKeyRecord, MediaKeyStore } from "../src/media-key-store";
import type { MediaRow, MediaStatusName, MediaStore } from "../src/media-store";

const hasFFmpeg = Boolean(Bun.which("ffmpeg"));
const MK = parseMasterKeys(`1:${"c".repeat(64)}`);
const MEDIA_ID = "00000123";
const JOB_ID = "job_m2_test";
/** 产物目录名 = 模板 ID（cuid 形状，spec.md §1.3） */
const TEMPLATE_A = "cmu6tpla0001mqe4uoyceqt3";
const TEMPLATE_B = "cmu6tplb0002mqe4uoyceqt3";
/** 本模板产物的落位前缀 */
const prefixOf = (templateId: string) => `proceed/${MEDIA_ID}/${templateId}`;

// ---- 假 DB（依赖注入点，避免测试依赖真实 MySQL/SQLite 表结构） ----

class FakeJobStore implements TranscodeJobStore {
  statuses: JobStatusName[] = [];
  leaseExtends = 0;
  async claim(): Promise<TranscodeJobRow | null> {
    return null;
  }
  async setStatus(_id: string, status: JobStatusName): Promise<void> {
    this.statuses.push(status);
  }
  async extendLease(): Promise<void> {
    this.leaseExtends += 1;
  }
}

class FakeMediaStore implements MediaStore {
  statuses: MediaStatusName[] = [];
  probe: unknown = null;
  durationMs: number | null = null;
  constructor(private readonly baseStatus: MediaStatusName) {}
  async get(id: string): Promise<MediaRow | null> {
    if (id !== MEDIA_ID) return null;
    return {
      id,
      title: "测试片",
      status: this.statuses.at(-1) ?? this.baseStatus,
      sourceKey: STORAGE_KEYS.original(MEDIA_ID, "mp4"),
    };
  }
  async setStatus(_id: string, status: MediaStatusName): Promise<void> {
    this.statuses.push(status);
  }
  async saveProbe(_id: string, probe: unknown, durationMs: number | null): Promise<void> {
    this.probe = probe;
    this.durationMs = durationMs;
  }
}

class FakeKeyStore implements MediaKeyStore {
  rows = new Map<string, MediaKeyRecord>();
  async replace(mediaId: string, record: MediaKeyRecord): Promise<{ replaced: boolean }> {
    const replaced = this.rows.has(mediaId);
    this.rows.set(mediaId, record);
    return { replaced };
  }
  async find(mediaId: string): Promise<(MediaKeyRecord & { createdAt: Date }) | null> {
    const row = this.rows.get(mediaId);
    return row ? { ...row, createdAt: new Date() } : null;
  }
}

// ---- 假存储适配器（local 驱动已移除，ADR-0005；测试用磁盘实现替代真实 S3） ----

/** 磁盘版 StorageAdapter：put/get 落本地临时目录；presignGet 返回本地文件路径（ffprobe/ffmpeg 可直读） */
class DiskStorage implements StorageAdapter {
  constructor(private root: string) {}

  private path(key: string): string {
    if (key.includes("..")) throw new Error(`非法存储键：${key}`);
    return join(this.root, key);
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }

  async putStream(key: string, body: ReadableStream): Promise<void> {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await this.put(key, concat(chunks));
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(this.path(key)));
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const s = statSync(this.path(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }

  async listObjects(prefix: string): Promise<StorageObject[]> {
    const base = this.path(prefix.replace(/\/+$/, ""));
    const walk = (dir: string, rel: string): StorageObject[] => {
      let entries: string[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
      } catch {
        return [];
      }
      const out: StorageObject[] = [];
      for (const name of entries) {
        const childRel = rel ? `${rel}/${name}` : name;
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) out.push(...walk(abs, childRel));
        else out.push({ key: childRel, size: statSync(abs).size, lastModified: statSync(abs).mtime });
      }
      return out;
    };
    return walk(base, prefix.replace(/\/+$/, ""));
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.listObjects(prefix)).map((o) => o.key);
  }

  async presignPut(): Promise<string> {
    throw new Error("测试适配器不支持上传预签名");
  }

  /** 测试内直读本地文件路径（等价 s3 预签名 GET 的角色：ffprobe / ffmpeg 的输入） */
  async presignGet(key: string): Promise<string> {
    return this.path(key);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---- 环境搭建：临时本地存储 + 320×240@15 的 2 秒源片 ----

interface TestEnv {
  deps: JobExecutorDeps;
  storage: StorageAdapter;
  jobStore: FakeJobStore;
  mediaStore: FakeMediaStore;
  keyStore: FakeKeyStore;
  jobsRoot: string;
  cleanup: () => void;
}

function setup(mediaStatus: MediaStatusName = "UPLOADED"): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "openvod-m2-"));
  const storageRoot = join(root, "storage");
  const jobsRoot = join(root, "jobs");
  const localSource = join(root, "src.mp4");

  const gen = Bun.spawnSync({
    cmd: [
      "ffmpeg", "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", localSource,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gen.exitCode !== 0) {
    throw new Error(`测试源片生成失败：${new TextDecoder().decode(gen.stderr)}`);
  }

  const storage = new DiskStorage(storageRoot);
  const jobStore = new FakeJobStore();
  const mediaStore = new FakeMediaStore(mediaStatus);
  const keyStore = new FakeKeyStore();

  return {
    storage,
    jobStore,
    mediaStore,
    keyStore,
    jobsRoot,
    deps: { jobStore, mediaStore, keyStore, storage, masterKeys: MK, jobsRoot, leaseMs: 60_000 },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 把测试源片放进 original/{id}.mp4（模拟 M1 上传结果） */
async function seedSource(env: TestEnv, localSourcePath: string): Promise<void> {
  await env.storage.put(
    STORAGE_KEYS.original(MEDIA_ID, "mp4"),
    new Uint8Array(readFileSync(localSourcePath)),
    "video/mp4",
  );
}

/** 任务行：模板快照直接给出（等价于管理端 submit 时落库的快照） */
function job(snapshot: Record<string, unknown>): TranscodeJobRow {
  return {
    id: JOB_ID,
    mediaId: MEDIA_ID,
    status: "PROBING",
    templateId: (snapshot.template_id as string | undefined) ?? null,
    templateSnapshot: snapshot,
    attempts: 1,
    startedAt: new Date(),
  };
}

/** 自适应 200 宽 + AES-128：源 320×240 → 目标 200×150（等比缩小后取偶） */
const TEMPLATE_ENCRYPTED = {
  template_id: TEMPLATE_A,
  name: "200p 加密",
  keep_original: false,
  encrypt: true,
  format: "HLS",
  params: {
    codec: "libx264",
    bitrate_kbps: 200,
    preset: "ultrafast",
    audio_bitrate_kbps: 64,
    resolutions: [{ mode: "adaptive", max_width: 200 }],
  },
};

/** 每次测试都重建源片：放回 setup 的临时目录（与存储根同父目录） */
function sourcePathOf(env: TestEnv): string {
  const jobsRootParent = env.jobsRoot.slice(0, env.jobsRoot.lastIndexOf("/"));
  return join(jobsRootParent, "src.mp4");
}

describe("M2 执行器", () => {
  it.skipIf(!hasFFmpeg)(
    "加密任务：转码 → 上传 → 密钥落库 → READY，且落库的 CEK 能解开上传的分片",
    async () => {
      const env = setup();
      await seedSource(env, sourcePathOf(env));
      // 预置一份"上次转码"留下的陈旧产物（同一模板子树内），验证会被清理
      await env.storage.put(`${prefixOf(TEMPLATE_A)}/old/seg-00001.ts`, "stale", "video/mp2t");

      const result = await executeClaimedJob(job(TEMPLATE_ENCRYPTED), env.deps);

      // 1) 计划、状态机、清理
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0]).toMatchObject({ name: "150p", width: 200, height: 150 });
      expect(result.encrypted).toBe(true);
      expect(result.replacedKey).toBe(false);
      expect(result.keyReused).toBe(false);
      // 产物按「媒资 → 模板」两级落位（spec.md §1.3）
      expect(result.outputPrefix).toBe(prefixOf(TEMPLATE_A));
      expect(env.jobStore.statuses).toEqual(["ENCODING", "PACKAGING", "DONE"]);
      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "READY"]);
      expect(result.deletedStaleObjects).toBe(1);

      // 2) ffprobe 摘要回写（源参数判定的事实来源）
      const probe = env.mediaStore.probe as { video: { width: number; height: number } };
      expect(probe.video).toMatchObject({ width: 320, height: 240 });

      // 3) 产物落位：{模板id}/master + {模板id}/{变体}/清单 + 分片，且本模板子树内的旧目录已被清掉
      const objects = (await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).map((o) => o.key);
      expect(objects).toContain(`${prefixOf(TEMPLATE_A)}/master.m3u8`);
      expect(objects).toContain(`${prefixOf(TEMPLATE_A)}/150p/index.m3u8`);
      const segments = objects.filter((k) => k.endsWith(".ts"));
      expect(segments.length).toBeGreaterThan(0);
      expect(objects.some((k) => k.includes("/old/"))).toBe(false);

      // 4) 主清单带宽/分辨率与子清单加密标签（IV 不得出现双重 0x）
      const master = new TextDecoder().decode(
        await env.storage.get(`${prefixOf(TEMPLATE_A)}/master.m3u8`),
      );
      expect(master).toContain("RESOLUTION=200x150");
      expect(master).toContain("150p/index.m3u8");
      const variant = new TextDecoder().decode(
        await env.storage.get(`${prefixOf(TEMPLATE_A)}/150p/index.m3u8`),
      );
      expect(variant).toContain("METHOD=AES-128");
      expect(variant).toContain("IV=0x");
      expect(variant).not.toContain("IV=0x0x");

      // 5) 最强断言：用**落库的封装 CEK** 解开**上传的分片**（密钥与产物一致）
      const stored = env.keyStore.rows.get(MEDIA_ID);
      expect(stored).toBeDefined();
      const cek = openMediaKey(pickWrappingMasterKey(MK), stored!.wrappedCekHex);
      const decipher = createDecipheriv("aes-128-cbc", cek, Buffer.from(stored!.ivHex, "hex"));
      const encrypted = await env.storage.get(segments[0]);
      const plain = Buffer.concat([decipher.update(Buffer.from(encrypted)), decipher.final()]);
      expect(plain[0]).toBe(0x47); // TS 同步字节

      // 6) 临时目录（含明文 CEK 与 key_info）必须已清理
      expect(existsSync(join(env.jobsRoot, JOB_ID))).toBe(false);
      env.cleanup();
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "不加密任务：不写密钥、子清单无 EXT-X-KEY",
    async () => {
      const env = setup();
      await seedSource(env, sourcePathOf(env));

      const result = await executeClaimedJob(
        job({ ...TEMPLATE_ENCRYPTED, name: "200p 明文", encrypt: false }),
        env.deps,
      );

      expect(result.encrypted).toBe(false);
      expect(result.replacedKey).toBeNull();
      expect(result.keyReused).toBe(false);
      expect(env.keyStore.rows.size).toBe(0);
      const variant = new TextDecoder().decode(
        await env.storage.get(`${prefixOf(TEMPLATE_A)}/150p/index.m3u8`),
      );
      expect(variant).not.toContain("EXT-X-KEY");
      env.cleanup();
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "全档无降级维度：不失败，按源规格兜底产出一档（分辨率/帧率保持原视频，仍按模板加密）",
    async () => {
      const env = setup();
      await seedSource(env, sourcePathOf(env));

      // 源 320×240：模板固定 1920×1080 属升格（取源分辨率）、码率不低于源 → 三维度均无降级 → 兜底
      const result = await executeClaimedJob(
        job({
          ...TEMPLATE_ENCRYPTED,
          name: "1080p 升格（兜底）",
          params: {
            codec: "libx264",
            bitrate_kbps: 5000,
            audio_bitrate_kbps: 128,
            resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
          },
        }),
        env.deps,
      );

      // 判定：1 档跳过 + 1 档兜底执行，源尺寸 320×240
      expect(result.sourceFallback).toBe(true);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toContain("升格");
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0]).toMatchObject({ name: "240p", width: 320, height: 240 });

      // 状态机与产物落位（模板子树；兜底档仍按模板加密）
      expect(env.jobStore.statuses).toEqual(["ENCODING", "PACKAGING", "DONE"]);
      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "READY"]);
      expect(result.encrypted).toBe(true);
      expect(env.keyStore.rows.size).toBe(1);
      const keys = (await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).map((o) => o.key);
      expect(keys).toContain(`${prefixOf(TEMPLATE_A)}/master.m3u8`);
      expect(keys).toContain(`${prefixOf(TEMPLATE_A)}/240p/index.m3u8`);
      // 兜底档不缩放（分辨率保持原视频）
      expect(result.uploadedObjects).toBeGreaterThan(0);
      const variant = new TextDecoder().decode(
        await env.storage.get(`${prefixOf(TEMPLATE_A)}/240p/index.m3u8`),
      );
      expect(variant).toContain("METHOD=AES-128");
      expect(existsSync(join(env.jobsRoot, JOB_ID))).toBe(false);
      env.cleanup();
    },
    45_000,
  );

  it.skipIf(!hasFFmpeg)(
    "重转码失败（脏快照）：既有 READY 的媒资保持 READY（旧产物仍可播，不误报失败）",
    async () => {
      const env = setup("READY");
      await seedSource(env, sourcePathOf(env));

      // 脏快照（bitrate 与 crf 并存）→ 快照校验即失败，不进入转码
      await expect(
        executeClaimedJob(
          job({
            ...TEMPLATE_ENCRYPTED,
            params: {
              codec: "libx264",
              bitrate_kbps: 5000,
              crf: 23,
              audio_bitrate_kbps: 128,
              resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
            },
          }),
          env.deps,
        ),
      ).rejects.toThrow(/模板快照非法/);

      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "READY"]);
      expect(env.jobStore.statuses).toEqual([]);
      env.cleanup();
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "多模板并存：两套产物互不覆盖、共用同一份 CEK、清理只作用于本模板子树",
    async () => {
      const env = setup();
      await seedSource(env, sourcePathOf(env));

      // 模板 A 出一套
      const a = await executeClaimedJob(job(TEMPLATE_ENCRYPTED), env.deps);
      expect(a.outputPrefix).toBe(prefixOf(TEMPLATE_A));
      expect(a.keyReused).toBe(false);
      const kidAfterA = env.keyStore.rows.get(MEDIA_ID)!.kid;
      // A 子树里留一个"上次转码"的旧档位，稍后重转 A 时应被清掉
      await env.storage.put(`${prefixOf(TEMPLATE_A)}/old/seg-00001.ts`, "stale", "video/mp2t");

      // 模板 B 再出一套（不同档位）
      const b = await executeClaimedJob(
        job({
          ...TEMPLATE_ENCRYPTED,
          template_id: TEMPLATE_B,
          name: "120p 加密",
          // 自适应 160 宽 → 源 320×240 等比缩放为 160×120 → 变体目录按输出高度命名即 120p
          params: { ...TEMPLATE_ENCRYPTED.params, resolutions: [{ mode: "adaptive", max_width: 160 }] },
        }),
        env.deps,
      );
      expect(b.outputPrefix).toBe(prefixOf(TEMPLATE_B));
      // 复用同一份密钥：不新增/替换密钥行 → 不会让 A 的密文失效
      expect(b.keyReused).toBe(true);
      expect(b.replacedKey).toBeNull();
      expect(env.keyStore.rows.size).toBe(1);
      expect(env.keyStore.rows.get(MEDIA_ID)!.kid).toBe(kidAfterA);

      // 两套产物并存（B 的转码没有清掉 A）
      const keys = (await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).map((o) => o.key);
      expect(keys).toContain(`${prefixOf(TEMPLATE_A)}/master.m3u8`);
      expect(keys).toContain(`${prefixOf(TEMPLATE_A)}/150p/index.m3u8`);
      expect(keys).toContain(`${prefixOf(TEMPLATE_B)}/master.m3u8`);
      expect(keys).toContain(`${prefixOf(TEMPLATE_B)}/120p/index.m3u8`);
      const bObjects = keys.filter((k) => k.startsWith(`${prefixOf(TEMPLATE_B)}/`)).length;

      // 重转 A：只清 A 子树内的陈旧对象，B 原封不动
      const a2 = await executeClaimedJob(job(TEMPLATE_ENCRYPTED), env.deps);
      expect(a2.deletedStaleObjects).toBe(1);
      const after = (await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).map((o) => o.key);
      expect(after.some((k) => k.includes(`${TEMPLATE_A}/old/`))).toBe(false);
      expect(after.filter((k) => k.startsWith(`${prefixOf(TEMPLATE_B)}/`)).length).toBe(bObjects);

      // 两套产物都能用同一份落库 CEK 解开（共同体现「每媒资一份密钥」）
      const stored = env.keyStore.rows.get(MEDIA_ID)!;
      const cek = openMediaKey(pickWrappingMasterKey(MK), stored.wrappedCekHex);
      for (const templateId of [TEMPLATE_A, TEMPLATE_B]) {
        const segment = after.find((k) => k.startsWith(`${prefixOf(templateId)}/`) && k.endsWith(".ts"));
        expect(segment).toBeDefined();
        const decipher = createDecipheriv("aes-128-cbc", cek, Buffer.from(stored.ivHex, "hex"));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(await env.storage.get(segment!))),
          decipher.final(),
        ]);
        expect(plain[0]).toBe(0x47);
      }

      env.cleanup();
    },
    45_000,
  );
});
