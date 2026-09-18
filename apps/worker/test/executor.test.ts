// M2 转码执行器端到端测试（ADR-0008 / spec.md §4.2）
// 真 ffmpeg + 真本地存储 + 假 DB（依赖注入）：验证「探测 → 逐档转码 → 上传 → 密钥落库 → 状态联动 → 清理」全链路。
// 缺 ffmpeg 时整体跳过（与 Worker 启动自检的口径一致）。
import { describe, expect, it } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMediaKey, parseMasterKeys, pickWrappingMasterKey } from "@openvod/crypto";
import { STORAGE_KEYS } from "@openvod/shared";
import { createStorage, type StorageAdapter } from "@openvod/storage";
import { executeClaimedJob, type JobExecutorDeps } from "../src/executor";
import type { JobStatusName, TranscodeJobRow, TranscodeJobStore } from "../src/job-store";
import type { MediaKeyRecord, MediaKeyStore } from "../src/media-key-store";
import type { MediaRow, MediaStatusName, MediaStore } from "../src/media-store";

const hasFFmpeg = Boolean(Bun.which("ffmpeg"));
const MK = parseMasterKeys(`1:${"c".repeat(64)}`);
const MEDIA_ID = "00000123";
const JOB_ID = "job_m2_test";

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

  const storage = createStorage({ driver: "local", root: storageRoot, rootPrefix: "" });
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
    templateId: "tpl_test",
    templateSnapshot: snapshot,
    attempts: 1,
    startedAt: new Date(),
  };
}

/** 自适应 200 宽 + AES-128：源 320×240 → 目标 200×150（等比缩小后取偶） */
const TEMPLATE_ENCRYPTED = {
  template_id: "tpl_test",
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
      // 预置一份"上次转码"留下的陈旧产物，验证会被清理
      await env.storage.put(`proceed/${MEDIA_ID}/old/seg-00001.ts`, "stale", "video/mp2t");

      const result = await executeClaimedJob(job(TEMPLATE_ENCRYPTED), env.deps);

      // 1) 计划、状态机、清理
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0]).toMatchObject({ name: "150p", width: 200, height: 150 });
      expect(result.encrypted).toBe(true);
      expect(result.replacedKey).toBe(false);
      expect(env.jobStore.statuses).toEqual(["ENCODING", "PACKAGING", "DONE"]);
      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "READY"]);
      expect(result.deletedStaleObjects).toBe(1);

      // 2) ffprobe 摘要回写（源参数判定的事实来源）
      const probe = env.mediaStore.probe as { video: { width: number; height: number } };
      expect(probe.video).toMatchObject({ width: 320, height: 240 });

      // 3) 产物落位：master + 变体清单 + 分片，且旧目录已被清掉
      const objects = (await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).map((o) => o.key);
      expect(objects).toContain(`proceed/${MEDIA_ID}/master.m3u8`);
      expect(objects).toContain(`proceed/${MEDIA_ID}/150p/index.m3u8`);
      const segments = objects.filter((k) => k.endsWith(".ts"));
      expect(segments.length).toBeGreaterThan(0);
      expect(objects.some((k) => k.includes("/old/"))).toBe(false);

      // 4) 主清单带宽/分辨率与子清单加密标签（IV 不得出现双重 0x）
      const master = new TextDecoder().decode(await env.storage.get(`proceed/${MEDIA_ID}/master.m3u8`));
      expect(master).toContain("RESOLUTION=200x150");
      expect(master).toContain("150p/index.m3u8");
      const variant = new TextDecoder().decode(
        await env.storage.get(`proceed/${MEDIA_ID}/150p/index.m3u8`),
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
      expect(env.keyStore.rows.size).toBe(0);
      const variant = new TextDecoder().decode(
        await env.storage.get(`proceed/${MEDIA_ID}/150p/index.m3u8`),
      );
      expect(variant).not.toContain("EXT-X-KEY");
      env.cleanup();
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "全部档位被跳过：任务失败、媒资按既有产物回退、无产物与密钥残留",
    async () => {
      const env = setup();
      await seedSource(env, sourcePathOf(env));

      // 源 320×240，模板要求 1920×1080 → 升格被拒 → 无可用档位
      await expect(
        executeClaimedJob(
          job({
            ...TEMPLATE_ENCRYPTED,
            name: "1080p 升格",
            params: {
              codec: "libx264",
              bitrate_kbps: 5000,
              audio_bitrate_kbps: 128,
              resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
            },
          }),
          env.deps,
        ),
      ).rejects.toThrow(/所有档位均被跳过/);

      expect(await env.storage.listObjects(`proceed/${MEDIA_ID}/`)).toEqual([]);
      expect(env.keyStore.rows.size).toBe(0);
      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "FAILED"]); // 此前非 READY
      expect(env.jobStore.statuses).toEqual([]); // 计划阶段即失败，未进入 ENCODING
      expect(existsSync(join(env.jobsRoot, JOB_ID))).toBe(false);
      env.cleanup();
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "重转码：既有 READY 的媒资在失败时保持 READY（旧产物仍可播，不误报失败）",
    async () => {
      const env = setup("READY");
      await seedSource(env, sourcePathOf(env));

      await expect(
        executeClaimedJob(
          job({
            ...TEMPLATE_ENCRYPTED,
            params: {
              codec: "libx264",
              bitrate_kbps: 5000,
              audio_bitrate_kbps: 128,
              resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
            },
          }),
          env.deps,
        ),
      ).rejects.toThrow(/所有档位均被跳过/);

      expect(env.mediaStore.statuses).toEqual(["TRANSCODING", "READY"]);
      env.cleanup();
    },
    30_000,
  );
});
