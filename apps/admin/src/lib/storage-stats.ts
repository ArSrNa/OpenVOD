// 总览存储统计（spec.md §1 / §2.1）：只列举对象元信息，不下载对象内容。
// StorageAdapter 负责 root 前缀隔离及 S3 分页；四分区各扫描一次，original 复用于媒资统计。
import type { DashboardStats } from "@openvod/contracts";
import { MEDIA_ID_CHARS, STORAGE_PARTITIONS } from "@openvod/shared";
import type { StorageAdapter, StorageObject } from "@openvod/storage";
import { countSubtitlesByMedia, groupProductsByMedia } from "./media-products";

type AssetStats = Pick<DashboardStats, "storage" | "subtitles" | "products" | "metadata">;

const METADATA_RE = new RegExp(`^${STORAGE_PARTITIONS.metadata}/(${MEDIA_ID_CHARS})/(.+)$`);

export async function getStorageStats(
  storage: Pick<StorageAdapter, "listObjects">,
): Promise<AssetStats & { originals: StorageObject[] }> {
  const [originals, proceeds, covers, metadatas] = await Promise.all(
    [STORAGE_PARTITIONS.original, STORAGE_PARTITIONS.proceed, STORAGE_PARTITIONS.cover, STORAGE_PARTITIONS.metadata].map(async (partition) =>
      // S3 控制台创建的目录占位键不算文件或产物。
      (await storage.listObjects(`${partition}/`)).filter((object) => !object.key.endsWith("/")),
    ),
  );

  let usedBytes = 0;
  for (const objects of [originals, proceeds, covers, metadatas]) {
    for (const object of objects) usedBytes += object.size;
  }

  const subtitlesByMedia = countSubtitlesByMedia(proceeds);
  const productsByMedia = groupProductsByMedia(proceeds);
  const metadata: AssetStats["metadata"] = { total: 0, probe: 0, custom: 0, other: 0 };
  for (const object of metadatas) {
    const match = METADATA_RE.exec(object.key);
    if (!match) continue;
    metadata.total++;
    if (match[2] === "probe.json") metadata.probe++;
    else if (match[2] === "custom.json") metadata.custom++;
    else metadata.other++;
  }

  return {
    originals,
    storage: { used_bytes: usedBytes },
    subtitles: {
      total: [...subtitlesByMedia.values()].reduce((sum, count) => sum + count, 0),
      media_count: subtitlesByMedia.size,
    },
    products: {
      total: [...productsByMedia.values()].reduce((sum, products) => sum + products.length, 0),
      media_count: productsByMedia.size,
    },
    metadata,
  };
}
