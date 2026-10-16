/** 时长（毫秒）→ `mm:ss` / `h:mm:ss`；空值给 `—` */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 码率（bps）→ `x.x Mbps` / `xxx kbps` */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps == null || bps <= 0) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** RFC3339 / ISO 时间 → 本地可读文本（解析失败原样返回） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}
