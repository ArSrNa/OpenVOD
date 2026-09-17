// 本地文件系统实现（自托管 Compose / 开发，ADR-0005）
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StorageAdapter, StatResult } from "./index";

export interface LocalConfig {
  /** 存储根目录（.env: STORAGE_LOCAL_ROOT） */
  root: string;
  /** 公开访问基址（自托管下通常指向分发端/静态服务） */
  publicBaseUrl?: string;
}

export class LocalAdapter implements StorageAdapter {
  constructor(private cfg: LocalConfig) {}

  private path(key: string): string {
    if (key.includes("..")) throw new Error(`非法存储键：${key}`);
    return resolve(this.cfg.root, key);
  }

  async put(key: string, data: Uint8Array | string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname2(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    return readFile(this.path(key));
  }

  /** 流式读取（local 模式下分发端供片用，ADR-0005 local 分支） */
  stream(key: string): ReadableStream {
    return createReadStream(this.path(key)) as unknown as ReadableStream;
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const s = await stat(this.path(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => {});
  }

  async list(prefix: string): Promise<string[]> {
    const root = this.path(prefix);
    const walk = async (dir: string, base: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const out: string[] = [];
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
        else out.push(rel);
      }
      return out;
    };
    return (await walk(root, prefix.replace(/\/$/, ""))).map((k) => `${k}`);
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
    return `${base}/${key}`;
  }
}

function dirname2(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}
