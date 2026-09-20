// 字幕轨道业务规则单测（spec.md §7；ADR-0009）
// 覆盖：
//   - 新建：语言归一化（zh_CN → zh-CN）、展示名 trim、trackId 生成、对象先写后落库、
//     首条自动默认、显式默认互斥、同语言 409、媒资未入库 404、校验失败 400 不落任何一侧、
//     落库失败回收对象（不留孤儿）；
//   - 更新：部分字段语义、语言冲突 409、is_default=true 事务内互斥、非法 trackId / 不存在 404；
//   - 覆盖文本：就地覆盖同一键 + 更新 bytes、校验失败不覆盖；
//   - 删除：先对象后行、幂等返回、不存在 404；
//   - 列表：storage_ok 反映对象存在性。
// 被测函数为依赖注入的纯编排（../src/lib/subtitle-tracks），不连 DB / 不碰真实存储。
import { describe, expect, it } from "bun:test";
import {
  createSubtitle,
  deleteSubtitle,
  listSubtitles,
  readSubtitleContent,
  replaceSubtitleContent,
  updateSubtitle,
  type SubtitleDeps,
  type SubtitleRow,
} from "../src/lib/subtitle-tracks";

const NOW = new Date("2026-09-20T00:00:00.000Z");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好\n";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

function makeDeps(over: Partial<SubtitleDeps> = {}) {
  const rows: SubtitleRow[] = [];
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const cleared: Array<{ mediaId: string; except: string }> = [];
  let seq = 0;

  const deps: SubtitleDeps = {
    mediaExists: async () => true,
    listTracks: async (mediaId) =>
      rows
        .filter((r) => r.mediaId === mediaId)
        .sort((a, b) =>
          a.isDefault === b.isDefault ? a.createdAt.getTime() - b.createdAt.getTime() : a.isDefault ? -1 : 1,
        ),
    findTrack: async (mediaId, trackId) =>
      rows.find((r) => r.id === trackId && r.mediaId === mediaId) ?? null,
    findTrackByLang: async (mediaId, lang) =>
      rows.find((r) => r.mediaId === mediaId && r.lang === lang) ?? null,
    hasTracks: async (mediaId) => rows.some((r) => r.mediaId === mediaId),
    createTrack: async (data) => {
      if (data.isDefault) {
        cleared.push({ mediaId: data.mediaId, except: data.id });
        for (const r of rows) if (r.mediaId === data.mediaId) r.isDefault = false;
      }
      const row: SubtitleRow = {
        id: data.id,
        mediaId: data.mediaId,
        lang: data.lang,
        label: data.label,
        isDefault: data.isDefault,
        status: "READY",
        storageKey: data.storageKey,
        bytes: data.bytes,
        createdAt: NOW,
        updatedAt: NOW,
      };
      rows.push(row);
      return row;
    },
    updateTrack: async (id, mediaId, data, makeDefault) => {
      if (makeDefault) {
        cleared.push({ mediaId, except: id });
        for (const r of rows) if (r.mediaId === mediaId && r.id !== id) r.isDefault = false;
      }
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("row not found");
      if (data.lang !== undefined) row.lang = data.lang;
      if (data.label !== undefined) row.label = data.label;
      if (data.isDefault !== undefined) row.isDefault = data.isDefault;
      if (data.bytes !== undefined) row.bytes = data.bytes;
      return row;
    },
    deleteTrack: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    newTrackId: () => `c${String(seq++).padStart(24, "0")}`,
    putObject: async (key, bytes) => {
      objects.set(key, bytes);
    },
    getObject: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("object not found");
      return bytes;
    },
    deleteObject: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
    objectExists: async (key) => objects.has(key),
    ...over,
  };
  return { deps, rows, objects, deleted, cleared };
}

async function expectSubtitleError(p: Promise<unknown>, status: number) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; status?: number; message: string };
    expect(err.status).toBe(status);
    return { code: err.code ?? "", message: err.message };
  }
  throw new Error("预期抛错但未抛出");
}

const createInput = (over: Partial<Parameters<typeof createSubtitle>[1]> = {}) => ({
  lang: "zh_CN",
  label: "简体中文",
  isDefault: false,
  createdBy: "admin-1",
  bytes: enc(VTT),
  ...over,
});

// ---- 新建 ----

describe("createSubtitle", () => {
  it("归一化语言与展示名，生成 trackId，写对象后落库；首条自动成为默认轨", async () => {
    const { deps, rows, objects } = makeDeps();
    const dto = await createSubtitle("00000042", createInput(), deps);

    expect(dto.lang).toBe("zh-CN");
    expect(dto.label).toBe("简体中文");
    expect(dto.is_default).toBe(true); // 首条自动默认（spec.md §7.1）
    expect(dto.status).toBe("READY");
    expect(dto.bytes).toBe(enc(VTT).length);
    expect(dto.storage_key).toBe(`proceed/00000042/subtitles/${dto.id}.vtt`);
    expect(dto.storage_ok).toBe(true);
    // 对象内容 = 归一化后的文本（UTF-8 / LF / 无 BOM）
    expect(dec(objects.get(dto.storage_key))).toBe(VTT);
    expect(rows).toHaveLength(1);
  });

  it("第二条轨道不自动默认；显式 is_default 时清除其它默认轨（事务语义）", async () => {
    const { deps, rows, cleared } = makeDeps();
    const first = await createSubtitle("00000042", createInput(), deps);
    const second = await createSubtitle(
      "00000042",
      createInput({ lang: "en_US", label: "English", isDefault: true }),
      deps,
    );

    expect(second.is_default).toBe(true);
    expect(rows.find((r) => r.id === first.id)?.isDefault).toBe(false);
    // 首条自动默认同样走「清其它默认轨」路径（当时无其它轨）；第二条显式默认时必须清掉第一条
    expect(cleared.at(-1)).toEqual({ mediaId: "00000042", except: second.id });

    const third = await createSubtitle(
      "00000042",
      createInput({ lang: "ja_JP", label: "日本語" }),
      deps,
    );
    expect(third.is_default).toBe(false);
    expect(rows.find((r) => r.id === second.id)?.isDefault).toBe(true);
  });

  it("上传 SRT → 自动转为 VTT 存储（对象键恒为 .vtt）", async () => {
    const { deps, objects } = makeDeps();
    const srt = "1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n";
    const dto = await createSubtitle("00000042", createInput({ bytes: enc(srt) }), deps);

    expect(dto.storage_key.endsWith(".vtt")).toBe(true);
    const stored = dec(objects.get(dto.storage_key));
    expect(stored.startsWith("WEBVTT\n\n")).toBe(true);
    expect(stored).toContain("00:00:01.000 --> 00:00:03.000");
    expect(stored).not.toContain(",");
    expect(dto.bytes).toBe(enc(stored).length);
  });

  it("同媒资同语言 → 409，且不写对象不落库", async () => {
    const { deps, rows, objects } = makeDeps();
    await createSubtitle("00000042", createInput(), deps);
    const err = await expectSubtitleError(
      createSubtitle("00000042", createInput({ label: "另一个名字" }), deps),
      409,
    );
    expect(err.message).toContain("zh-CN");
    expect(rows).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it("媒资未入库 → 404；媒资 ID 非法 → 404", async () => {
    const { deps } = makeDeps({ mediaExists: async () => false });
    await expectSubtitleError(createSubtitle("00000042", createInput(), deps), 404);
    const ok = makeDeps();
    await expectSubtitleError(createSubtitle("abc", createInput(), ok.deps), 404);
  });

  it("VTT 校验失败 → 400，且不写对象不落库", async () => {
    const { deps, rows, objects } = makeDeps();
    const err = await expectSubtitleError(
      createSubtitle("00000042", createInput({ bytes: enc("not a vtt file") }), deps),
      400,
    );
    expect(err.message).toContain("WEBVTT");
    expect(rows).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("语言非法 → 400，且不写对象不落库", async () => {
    const { deps, objects } = makeDeps();
    await expectSubtitleError(createSubtitle("00000042", createInput({ lang: "zh CN" }), deps), 400);
    expect(objects.size).toBe(0);
  });

  it("落库失败 → 回收刚写入的对象（不留孤儿）", async () => {
    const { deps, objects, deleted } = makeDeps({
      createTrack: async () => {
        throw new Error("db down");
      },
    });
    // 编排层原样抛出（路由层转 500）；关键是刚写入的对象被回收
    await expect(createSubtitle("00000042", createInput(), deps)).rejects.toThrow("db down");
    expect(deleted).toHaveLength(1);
    expect(objects.size).toBe(0);
  });
});

// ---- 更新 ----

describe("updateSubtitle", () => {
  it("部分字段更新：展示名 / 语言 / 默认轨；语言冲突 409、空 body 400", async () => {
    const { deps } = makeDeps();
    const first = await createSubtitle("00000042", createInput(), deps);
    const second = await createSubtitle(
      "00000042",
      createInput({ lang: "en_US", label: "English" }),
      deps,
    );

    const renamed = await updateSubtitle("00000042", first.id, { label: "  中文（简） " }, deps);
    expect(renamed.label).toBe("中文（简）");
    expect(renamed.is_default).toBe(true); // 未传 is_default → 不变

    const asDefault = await updateSubtitle("00000042", second.id, { is_default: true }, deps);
    expect(asDefault.is_default).toBe(true);
    const list = await listSubtitles("00000042", deps);
    expect(list.items.filter((t) => t.is_default).map((t) => t.lang)).toEqual(["en-US"]);

    const conflict = await expectSubtitleError(
      updateSubtitle("00000042", second.id, { lang: "zh_CN" }, deps),
      409,
    );
    expect(conflict.message).toContain("zh-CN");

    await expectSubtitleError(updateSubtitle("00000042", first.id, {}, deps), 400);
    await expectSubtitleError(
      updateSubtitle("00000042", first.id, { lang: "zh CN" }, deps),
      400,
    );
  });

  it("轨道不存在 / trackId 形状不符 → 404", async () => {
    const { deps } = makeDeps();
    await expectSubtitleError(updateSubtitle("00000042", "c0000000000000000000000000", { label: "x" }, deps), 404);
    await expectSubtitleError(updateSubtitle("00000042", "../../etc/passwd", { label: "x" }, deps), 404);
  });
});

// ---- 覆盖文本 ----

describe("replaceSubtitleContent", () => {
  it("就地覆盖同一对象并更新 bytes（trackId / 存储键不变）", async () => {
    const { deps, objects } = makeDeps();
    const track = await createSubtitle("00000042", createInput(), deps);
    const next = "WEBVTT\n\n00:00:10.000 --> 00:00:12.500\n新文本\n";
    const updated = await replaceSubtitleContent("00000042", track.id, enc(next), deps);

    expect(updated.id).toBe(track.id);
    expect(updated.storage_key).toBe(track.storage_key);
    expect(updated.bytes).toBe(enc(next).length);
    expect(dec(objects.get(track.storage_key))).toBe(next);
    expect(objects.size).toBe(1);
  });

  it("校验失败 → 400 且不覆盖旧内容", async () => {
    const { deps, objects } = makeDeps();
    const track = await createSubtitle("00000042", createInput(), deps);
    await expectSubtitleError(
      replaceSubtitleContent("00000042", track.id, enc("WEBVTT\n\nno cue here\n"), deps),
      400,
    );
    expect(dec(objects.get(track.storage_key))).toBe(VTT);
  });
});

// ---- 删除 / 列表 ----

describe("deleteSubtitle", () => {
  it("先删对象、再删行；返回轨道信息；重复删除 404", async () => {
    const { deps, rows, objects, deleted } = makeDeps();
    const track = await createSubtitle("00000042", createInput(), deps);
    const removed = await deleteSubtitle("00000042", track.id, deps);

    expect(removed).toEqual({ id: track.id, lang: "zh-CN", label: "简体中文" });
    expect(deleted).toEqual([track.storage_key]);
    expect(objects.size).toBe(0);
    expect(rows).toHaveLength(0);
    await expectSubtitleError(deleteSubtitle("00000042", track.id, deps), 404);
  });
});

describe("readSubtitleContent（字幕预览用）", () => {
  it("返回该轨道的 WebVTT 字节流与行信息", async () => {
    const { deps } = makeDeps();
    const track = await createSubtitle("00000042", createInput(), deps);
    const { track: row, body } = await readSubtitleContent("00000042", track.id, deps);

    expect(row.id).toBe(track.id);
    expect(row.storageKey).toBe(track.storage_key);
    expect(dec(body)).toBe(VTT);
  });

  it("轨道不存在 / 存储对象缺失 → 404（与 storage_ok=false 同口径）", async () => {
    const { deps, objects } = makeDeps();
    const track = await createSubtitle("00000042", createInput(), deps);
    objects.delete(track.storage_key);

    await expectSubtitleError(readSubtitleContent("00000042", track.id, deps), 404);
    await expectSubtitleError(
      readSubtitleContent("00000042", "c0000000000000000000000000", deps),
      404,
    );
  });
});

describe("listSubtitles", () => {
  it("默认轨在前，storage_ok 反映对象存在性；媒资未入库 404", async () => {
    const { deps, objects } = makeDeps();
    const first = await createSubtitle("00000042", createInput(), deps);
    const second = await createSubtitle(
      "00000042",
      createInput({ lang: "en_US", label: "English", isDefault: true }),
      deps,
    );
    // 模拟对象被外部清理
    objects.delete(first.storage_key);

    const list = await listSubtitles("00000042", deps);
    expect(list.items.map((t) => t.id)).toEqual([second.id, first.id]);
    expect(list.items[0].storage_ok).toBe(true);
    expect(list.items[1].storage_ok).toBe(false);

    const gone = makeDeps({ mediaExists: async () => false });
    await expectSubtitleError(listSubtitles("00000042", gone.deps), 404);
  });
});
