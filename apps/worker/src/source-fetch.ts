// 取源通路优选（2026-10-17，ADR-0019 修订）：Worker 取**源片 / 水印图**不再走 GET 签名提供者。
//
// 背景：signMode=cdn_url_auth（或 s3_presign + 加速域名）下，Worker 取源会被引到 CDN 域名；
// 实测同一对象、同一时刻：CDN 通路 0.71 MB/s，COS 直连 44–103 MB/s（60–140 倍差距），
// 而 Worker 串行消费任务——取源耗时直接决定任务墙钟时长（166MB 源片：CDN ≈ 4 分钟 vs 直连 ≈ 2 秒）。
// 签名 URL 的意义是「给浏览器 / 播放端一个私有桶的临时访问凭证」；Worker 自己持有存储凭据，
// 不需要这层中转，应直连存储端点（有内网 / 本机端点时优先）。
//
// 候选通路（由 settings.ts 装配）：内网端点（可选）→ 存储直连 → 签名提供者（CDN，兜底）。
// 首次取源时对候选各做一次真实 Range 读测吞吐，选最快者并缓存（默认 10 分钟，
// 期间不再探测）；全部探测失败时回退到最后一个可生成 URL 的候选（保守路径）。
export interface SourceFetcher {
  /** 通路人读标识（日志 / 缓存指纹用），如 "internal:https://cos-internal…" */
  id: string;
  presign: (key: string, ttlSec: number) => Promise<string>;
}

export interface SourceResolution {
  url: string;
  /** 实际命中通路（日志追溯用） */
  via: string;
}

export interface SourceResolver {
  resolve(key: string, ttlSec: number): Promise<SourceResolution>;
}

export interface SourceResolverOptions {
  /** 实测 URL 吞吐（B/s）；null = 不可用。默认 measureThroughput（2MB Range 读 + 超时） */
  measure?: (url: string) => Promise<number | null>;
  /** 优选结果缓存时长（默认 10 分钟） */
  cacheTtlMs?: number;
  /** 探测读取字节数（默认 2MB；测试可调小） */
  probeBytes?: number;
  /** 探测超时（默认 10s；测试可调小） */
  probeTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROBE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** 全部候选探测失败时的回退缓存时长（不把「网络抖动」锁死 10 分钟） */
const FAILURE_CACHE_TTL_MS = 60_000;

/** 默认探测：对 URL 发 Range 读（2MB），实测吞吐；失败 / 超时返回 null。
 *  预签名 URL 的签名不含 Range 头，附加 Range 不影响验签（COS / CDN 均支持 206）。 */
export async function measureThroughput(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  bytes = DEFAULT_PROBE_BYTES,
): Promise<number | null> {
  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${bytes - 1}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    const dt = (Date.now() - t0) / 1000;
    return buf.byteLength > 0 && dt > 0 ? buf.byteLength / dt : null;
  } catch {
    return null;
  }
}

/** URL 去重键：同 origin + path（密钥/签名不同视为同一条通路） */
function routeKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

function formatBps(bps: number): string {
  return bps >= 1024 * 1024 ? `${(bps / 1024 / 1024).toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

export function createSourceResolver(fetchers: SourceFetcher[], opts: SourceResolverOptions = {}): SourceResolver {
  const measure = opts.measure ?? ((url) => measureThroughput(url, opts.probeTimeoutMs, opts.probeBytes));
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log;
  let cache: { fingerprint: string; choice: number; until: number } | null = null;

  const fingerprint = fetchers.map((f) => f.id).join("|");

  return {
    async resolve(key, ttlSec) {
      // 只有一条通路时无需探测（没有可选项；也避免无谓的 2MB 读）
      if (fetchers.length === 1) {
        return { url: await fetchers[0].presign(key, ttlSec), via: fetchers[0].id };
      }

      const t = now();
      if (cache && cache.fingerprint === fingerprint && cache.until > t && cache.choice < fetchers.length) {
        const chosen = fetchers[cache.choice];
        try {
          return { url: await chosen.presign(key, ttlSec), via: chosen.id };
        } catch {
          cache = null; // 签名失败（如 CDN 密钥变更）→ 重新探测
        }
      }

      const urls: Array<string | null> = [];
      const seen = new Map<string, number>(); // routeKey → 首次出现的候选下标
      const results: Array<{ index: number; bps: number }> = [];

      for (let i = 0; i < fetchers.length; i++) {
        let url: string;
        try {
          url = await fetchers[i].presign(key, ttlSec);
        } catch (e) {
          urls[i] = null;
          results.push({ index: i, bps: -1 });
          continue;
        }
        urls[i] = url;
        const route = routeKey(url);
        const dup = seen.get(route);
        if (dup !== undefined) {
          // 与已测候选同 origin + path（如 s3_presign 无加速域名时 direct 与 signed 等价）→ 直接继承结果
          const inherited = results.find((r) => r.index === dup);
          if (inherited) results.push({ index: i, bps: inherited.bps });
          continue;
        }
        seen.set(route, i);
        const bps = await measure(url);
        results.push({ index: i, bps: bps ?? -1 });
      }

      const healthy = results.filter((r) => r.bps >= 0 && urls[r.index]);
      let choice: number;
      let cacheTtl: number;
      if (healthy.length > 0) {
        healthy.sort((a, b) => b.bps - a.bps);
        choice = healthy[0].index;
        cacheTtl = cacheTtlMs;
      } else {
        // 全部探测失败：回退到最后一个可生成 URL 的候选（保守路径 = 签名提供者 / 兜底通路）
        const fallback = [...results].reverse().find((r) => urls[r.index] !== null);
        if (!fallback) throw new Error(`取源失败：全部候选通路均不可用（${fetchers.map((f) => f.id).join(" / ")}）`);
        choice = fallback.index;
        cacheTtl = Math.min(cacheTtlMs, FAILURE_CACHE_TTL_MS);
        log?.(`[source] 全部通路探测失败，回退 ${fetchers[choice].id}`);
      }

      log?.(
        `[source] 通路优选：${results
          .map((r) => `${fetchers[r.index].id}=${r.bps >= 0 ? formatBps(r.bps) : "不可用"}`)
          .join(" / ")} → 选 ${fetchers[choice].id}`,
      );

      cache = { fingerprint, choice, until: t + cacheTtl };
      return { url: urls[choice]!, via: fetchers[choice].id };
    },
  };
}
