// 管理端外观主题（浅色 / 深色 / 跟随系统）。
//
// 这是**浏览器本地偏好**，不是系统设置：只存 localStorage，不进 system_settings
// （system_settings 是全站共享的服务端配置，写库还要走 revision / 审计 / 密钥封装，ADR-0015）；
// 因此换浏览器、换管理员各看各的，也不需要任何 API。
//
// 本文件带 hook，只能被 Client Component 导入（useSyncExternalStore 在 Server Component 里不可用）。
// Server Component（root layout）需要的内联脚本与常量在 lib/theme-config.ts。
// 首帧防白闪靠那段内联脚本在 React 水合前写 data-theme；
// 界面配色由 providers.tsx 的 antd 算法（defaultAlgorithm / darkAlgorithm）跟随同一份状态。
import { useSyncExternalStore } from "react";
import { parseThemeMode, THEME_STORAGE_KEY, type ResolvedTheme, type ThemeMode } from "./theme-config";

export { THEME_STORAGE_KEY, type ResolvedTheme, type ThemeMode };

function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

// useSyncExternalStore 要求 getSnapshot 返回稳定值，这里做进程内缓存
let cachedMode: ThemeMode | null = null;
let cachedSystemDark: boolean | null = null;

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // 隐私模式 / 禁用 localStorage：退回跟随系统
    return "system";
  }
}

export function getThemeMode(): ThemeMode {
  cachedMode ??= readStoredMode();
  return cachedMode;
}

/** 服务端与水合首帧快照：两端一致（跟随系统），水合完成后由 getThemeMode 校正 */
export function getServerThemeMode(): ThemeMode {
  return "system";
}

export function getSystemDark(): boolean {
  if (cachedSystemDark !== null) return cachedSystemDark;
  const mq = darkMediaQuery();
  if (!mq) return false;
  cachedSystemDark = mq.matches;
  return cachedSystemDark;
}

export function getServerSystemDark(): boolean {
  return false;
}

const modeListeners = new Set<() => void>();

function emitMode(): void {
  for (const listener of modeListeners) listener();
}

export function subscribeThemeMode(listener: () => void): () => void {
  modeListeners.add(listener);
  if (typeof window === "undefined") return () => modeListeners.delete(listener);
  // 多标签页同步：另一个标签改了偏好，本标签跟着变
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    cachedMode = readStoredMode();
    emitMode();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    modeListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function subscribeSystemDark(listener: () => void): () => void {
  const mq = darkMediaQuery();
  if (!mq) return () => {};
  const onChange = () => {
    cachedSystemDark = mq.matches;
    listener();
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return getSystemDark() ? "dark" : "light";
}

/** 把解析后的主题写到 <html>：globals.css 用 data-theme 定底色，color-scheme 管原生滚动条 / 表单控件 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function setThemeMode(mode: ThemeMode): void {
  cachedMode = mode;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 写不进去就只在本次会话生效
  }
  cachedSystemDark ??= darkMediaQuery()?.matches ?? false;
  applyTheme(resolveTheme(mode));
  emitMode();
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeThemeMode, getThemeMode, getServerThemeMode);
}

export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeMode();
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark, getServerSystemDark);
  return mode === "dark" || (mode === "system" && systemDark) ? "dark" : "light";
}
