import type { Metadata } from "next";
import { UsersManager } from "@/components/UsersManager";

export const metadata: Metadata = {
  title: "用户管理 - OpenVOD 管理端",
};

// 播放端用户管理页（/users，ADR-0004 users 表；ADR-0007 账户域）。
// 会话守卫与壳层统一在 (console)/layout.tsx；数据由客户端从 /api/admin/users 拉取（同 /templates、/media）。
export default function UsersPage() {
  return (
    <UsersManager />
  );
}
