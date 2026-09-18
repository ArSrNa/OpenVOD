// 全局 root 前缀处理（spec.md §1.1）：
// root（STORAGE_ROOT_PREFIX）可不在桶根、可与其它业务共享桶、可为空；
// 存储适配层负责拼接与剥离，调用方（业务代码 / @openvod/shared STORAGE_KEYS）
// 的出入参均为不含 root 的相对键。

/** 相对键 → 完整键（拼 root） */
export function withRootPrefix(root: string | undefined, key: string): string {
  const r = (root ?? "").replace(/^\/+|\/+$/g, "");
  const k = key.replace(/^\/+/, "");
  return r ? `${r}/${k}` : k;
}

/** 完整键 → 相对键（剥 root；非本 root 下的键原样返回） */
export function relativeTo(root: string | undefined, key: string): string {
  const r = (root ?? "").replace(/^\/+|\/+$/g, "");
  return r && key.startsWith(`${r}/`) ? key.slice(r.length + 1) : key;
}
