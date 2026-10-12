import { redirect } from "next/navigation";

// 系统设置父路由：仅作为侧边栏二级菜单的分组入口，真实设置页在 /settings/{域}
export default function SettingsIndexPage() {
  redirect("/settings/playback");
}
