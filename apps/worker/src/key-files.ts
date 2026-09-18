// 转码期临时密钥文件（ADR-0006 §2）：key_info 三行 + 本地 CEK 文件；任务结束必须清理。
//
// 目录约定：`{jobDir}/key_info` 与 `{jobDir}/ceks/{kid}.key`（jobDir 由调用方给出，通常 /tmp/jobs/{jobId}）。
// 明文 CEK 只写在这两个文件里，且随 jobDir 一起删除（spec.md §4.2 步骤 4）。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildKeyInfoFile } from "@openvod/transcode";
import type { GeneratedMediaKey } from "./media-keys";

export interface KeyFilePaths {
  jobDir: string;
  /** ffmpeg `-hls_key_info_file` 的入参 */
  keyInfoPath: string;
  /** 16B 明文 CEK 文件（ffmpeg 读；任务结束连同 jobDir 删除） */
  cekFilePath: string;
}

/** 未配置 DELIVERY_PUBLIC_BASE_URL 时的占位域名：`.invalid` 永不解析，避免占位 URL 被误用 */
const PLACEHOLDER_BASE = "https://delivery.openvod.invalid";

/**
 * key_info 第一行：转码期占位密钥 URI（分发端改写清单时整体替换为带签名的 /v1/media/{id}/key，ADR-0006 §2/§3）。
 * 占位值只需是一个 URI；用环境变量 `DELIVERY_PUBLIC_BASE_URL` 可让占位更贴近真实分发域名，便于人工排查。
 */
export function keyUriPlaceholder(
  mediaId: string,
  baseUrl: string | undefined = process.env.DELIVERY_PUBLIC_BASE_URL,
): string {
  const base = (baseUrl?.trim() || PLACEHOLDER_BASE).replace(/\/+$/, "");
  return `${base}/v1/media/${mediaId}/key`;
}

/**
 * 写 key_info 与本地 CEK 文件。
 * CEK 以 **16 字节二进制**写入（ffmpeg 原生支持：非 2n 长度的 hex 形态即按裸字节读取，实测 ffmpeg 6.1）；
 * key_info 第三行 IV 为纯 hex、**不带 0x**（buildKeyInfoFile 的注释里记了踩坑结论）。
 */
export async function writeKeyFiles(opts: {
  jobDir: string;
  mediaId: string;
  key: GeneratedMediaKey;
  deliveryBaseUrl?: string;
}): Promise<KeyFilePaths> {
  const { jobDir, mediaId, key } = opts;
  const cekDir = join(jobDir, "ceks");
  const keyInfoPath = join(jobDir, "key_info");
  const cekFilePath = join(cekDir, `${key.kid}.key`);

  await mkdir(cekDir, { recursive: true });
  await writeFile(cekFilePath, key.cek);
  await writeFile(
    keyInfoPath,
    buildKeyInfoFile({
      keyUriPlaceholder: keyUriPlaceholder(mediaId, opts.deliveryBaseUrl),
      cekFilePath,
      ivHex: key.ivHex,
    }),
  );
  return { jobDir, keyInfoPath, cekFilePath };
}

/** 清理任务临时目录（含 key_info 与明文 CEK）；幂等：目录不存在不报错 */
export async function cleanupJobDir(jobDir: string): Promise<void> {
  await rm(jobDir, { recursive: true, force: true });
}
