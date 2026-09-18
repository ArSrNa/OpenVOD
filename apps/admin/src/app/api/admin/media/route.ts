// GET /api/admin/media：媒资列表（存储视角，spec.md §1.4）
// 媒资集合以 original/ 分区为准（original/{id}.{ext}，id = 纯数字媒资 ID）；
// proceed / cover / metadata 三个分区只按 id 归组补充资产数量，不反向定义媒资。
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStorage } from "@/lib/storage";
import { MEDIA_ID_CHARS, STORAGE_PARTITIONS } from "@openvod/shared";

export const dynamic = "force-dynamic";

interface MediaListItem {
  /** 数字媒资 ID（字符串，保留前导零，spec.md §1.3） */
  id: string;
  /** 原始文件扩展名（格式，小写） */
  ext: string;
  /** 原始文件相对键（不含 root 前缀） */
  key: string;
  /** 原始文件字节数 */
  size: number;
  /** 原始文件最后修改时间（ISO 8601） */
  lastModified?: string;
  /** 各分区下该媒资的对象数量 */
  assets: {
    /** 转码与处理产物（HLS / 字幕） */
    proceed: number;
    /** 封面与图片 */
    cover: number;
    /** 元数据 */
    metadata: number;
  };
}

/** 数出某分区下每个媒资 id 的对象数（键形如 `{partition}/{id}/...`） */
function countUnder(objs: { key: string }[], partition: string): Map<string, number> {
  const re = new RegExp(`^${partition}/(${MEDIA_ID_CHARS})/`);
  const counts = new Map<string, number>();
  for (const o of objs) {
    const m = re.exec(o.key);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "未登录" } },
      { status: 401 },
    );
  }

  const storage = getStorage();
  // 四分区各一次全量列举，内存聚合（spec.md §1.4；分页/裁剪待媒资规模需要时再加）
  const [originals, proceeds, covers, metadatas] = await Promise.all([
    storage.listObjects(`${STORAGE_PARTITIONS.original}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.proceed}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.cover}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.metadata}/`),
  ]);

  const proceedCounts = countUnder(proceeds, STORAGE_PARTITIONS.proceed);
  const coverCounts = countUnder(covers, STORAGE_PARTITIONS.cover);
  const metadataCounts = countUnder(metadatas, STORAGE_PARTITIONS.metadata);

  const originalRe = new RegExp(
    `^${STORAGE_PARTITIONS.original}/(${MEDIA_ID_CHARS})\\.([^/]+)$`,
  );
  const items: MediaListItem[] = [];
  for (const o of originals) {
    const m = originalRe.exec(o.key);
    if (!m) continue; // spec.md §1.4：非数字文件名 / 异常层级不属于媒资，忽略
    items.push({
      id: m[1],
      ext: m[2].toLowerCase(),
      key: o.key,
      size: o.size,
      lastModified: o.lastModified?.toISOString(),
      assets: {
        proceed: proceedCounts.get(m[1]) ?? 0,
        cover: coverCounts.get(m[1]) ?? 0,
        metadata: metadataCounts.get(m[1]) ?? 0,
      },
    });
  }
  // 按媒资 ID 数值降序（新媒资在前）
  items.sort((a, b) => Number(b.id) - Number(a.id));

  return NextResponse.json({ total: items.length, items });
}
