// 本地文件系统实现（自托管 Compose / 开发，ADR-0005）
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import type { StorageAdapter, StorageObject, StatResult } from "./index";
import { withRootPrefix } from "./prefix";

export interface LocalConfig {
  /** 存储根目录（.env: STORAGE_LOCAL_ROOT） */
  root: string;
  /** 全局 root 前缀（.env: STORAGE_ROOT_PREFIX，spec.md §1.1）；空 = 根目录顶层 */
  rootPrefix?: string;
  /** 公开访问基址（自托管下通常指向分发端/静态服务） */
  publicBaseUrl?: string;
}

export class LocalAdapter implements StorageAdapter {
  constructor(private cfg: LocalConfig) {}

  /** 相对键 → 完整键（拼全局 root 前缀，spec.md §1.1） */
  private fullKey(key: string): string {
    return withRootPrefix(this.cfg.rootPrefix, key);
  }

  private path(key: string): string {
    if (key.includes("..")) throw new Error(`非法存储键：${key}`);
    return resolve(this.cfg.root, key);
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const p = this.path(this.fullKey(key));
    await mkdir(dirname2(p), { recursive: true });
    await writeFile(p, data);
  }

  /** 流式上传：Web ReadableStream → 文件（原视频直传路径，避免整体进内存） */
  async putStream(key: string, body: ReadableStream): Promise<void> {
    const p = this.path(this.fullKey(key));
    await mkdir(dirname2(p), { recursive: true });
    await pipeline(
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
      createWriteStream(p),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    return readFile(this.path(this.fullKey(key)));
  }

  /** 按闭区间 [start, end] 流式读取（管理端原视频预览的 Range 请求用） */
  streamRange(key: string, start: number, end: number): ReadableStream {
    const s = createReadStream(this.path(this.fullKey(key)), { start, end });
    return Readable.toWeb(s) as unknown as ReadableStream;
  }

  /** 流式读取（local 模式下分发端供片用，ADR-0005 local 分支） */
  stream(key: string): ReadableStream {
    return createReadStream(this.path(this.fullKey(key))) as unknown as ReadableStream;
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const s = await stat(this.path(this.fullKey(key)));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.path(this.fullKey(key))).catch(() => {});
  }

  async listObjects(prefix: string): Promise<StorageObject[]> {
    // 出入参均为相对键：rel 基准用相对 prefix，落盘路径用 fullKey
    const relBase = prefix.replace(/\/+$/, "");
    const dirBase = this.path(this.fullKey(relBase));
    const walk = async (dir: string, rel: string): Promise<StorageObject[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const out: StorageObject[] = [];
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          out.push(...(await walk(join(dir, e.name), childRel)));
        } else {
          const s = await stat(join(dir, e.name)).catch(() => null);
          if (s?.isFile()) out.push({ key: childRel, size: s.size, lastModified: s.mtime });
        }
      }
      return out;
    };
    return walk(dirBase, relBase);
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.listObjects(prefix)).map((o) => o.key);
  }

  async presignPut(): Promise<string> {
    throw new Error("local 模式不支持预签名上传（ADR-0005）：管理端直传仅 s3 模式");
  }

  async presignGet(): Promise<string> {
    throw new Error("local 模式不支持预签名下载（ADR-0005）：播放走分发端 token");
  }

  publicUrl(key: string): string {
    const base = (this.cfg.publicBaseUrl ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("STORAGE_PUBLIC_BASE_URL 未配置");
    return `${base}/${this.fullKey(key)}`;
  }
}

function dirname2(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}
