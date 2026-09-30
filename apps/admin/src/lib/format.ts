// 字节数可读化（管理端共用，spec.md §9.3 任务列表「复用 formatSize 语义」）：
// 原实现抽自 MediaList.tsx，单一实现避免两页展示口径漂移。
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
