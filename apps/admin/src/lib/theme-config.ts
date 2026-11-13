// 主题的**无 hook 部分**：常量、类型与首帧内联脚本。
//
// 单独成文件是因为 root layout 是 Server Component：`lib/theme.ts` 依赖 useSyncExternalStore，
// 只能被 Client Component 导入；而防白闪脚本必须由服务端 layout 直接渲染到 <head>。
// 契约：两处共用同一个存储键（THEME_STORAGE_KEY），改键只改这里。

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "openvod.theme.mode";

/** 归一化读到的值：只有明确存了 light / dark 才生效，其余（含 system、脏数据）一律跟随系统 */
export function parseThemeMode(raw: string | null): ThemeMode {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** 内联脚本：在首帧绘制前把已存的偏好写到 <html data-theme>，避免刷新时先白后黑 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var m=localStorage.getItem(k);if(m!=="light"&&m!=="dark"&&m!=="system")m="system";var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
