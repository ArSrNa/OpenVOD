// 上传后元数据「异步生成 → 前端延迟更新」编排（spec.md §2.1，2026-09-30）：
// 上传接口用 `after()` 异步触发探测（响应立即返回，metadata.status=pending），
// 浏览器侧按**递增间隔**轮询媒资详情，`probe` 就绪即刷新列表；超时则提示可手动重跑。
// 依赖注入（fetchDetail / sleep / delays）便于单测：apps/admin/test/metadata-poll.test.ts。
export interface MetadataPollDetail {
  /** 详情接口返回的 `media.probe`（未探测为 null / 缺省） */
  probe: unknown;
}

export interface MetadataPollDeps {
  fetchDetail(id: string): Promise<MetadataPollDetail>;
  sleep(ms: number): Promise<void>;
  /** 轮询间隔序列（缺省 METADATA_POLL_DELAYS_MS），累计约 30 秒 */
  delays?: readonly number[];
}

/**
 * 递增轮询间隔：探测通常在 1~3 秒内完成，前期密集、后期稀疏；
 * 累计 29.5 秒仍未见 `probe` → 判定超时（可能失败，提示手动重跑）。
 */
export const METADATA_POLL_DELAYS_MS = [1500, 3000, 5000, 8000, 12000] as const;

/**
 * 轮询至该媒资 `probe` 就绪：就绪返回 true，序列耗尽返回 false。
 * 单次查询失败（网络抖动 / 会话过期）**不终止**轮询——探测在服务端仍在进行，下一轮再试。
 */
export async function pollMetadataReady(id: string, deps: MetadataPollDeps): Promise<boolean> {
  const delays = deps.delays ?? METADATA_POLL_DELAYS_MS;
  for (const delay of delays) {
    await deps.sleep(delay);
    try {
      const detail = await deps.fetchDetail(id);
      if (detail.probe != null) return true;
    } catch {
      // 忽略：继续下一轮
    }
  }
  return false;
}
