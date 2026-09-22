import type { Metadata } from "next";
import { requireConsoleSession } from "@/lib/console";
import { ConsoleShell } from "@/components/ConsoleShell";
import { SubtitleTracksPage } from "@/components/SubtitleTracksPage";
// 版本号唯一来源：本包 package.json（服务端读取后传入，避免整份 JSON 进入客户端 bundle）
import pkg from "../../../package.json";

export const metadata: Metadata = {
  title: "字幕管理 - OpenVOD 管理端",
};

export default async function SubtitlesPage() {
  const session = await requireConsoleSession();
  return (
    <ConsoleShell userName={session.user.name} version={pkg.version} initialPath="/subtitles">
      <SubtitleTracksPage />
    </ConsoleShell>
  );
}
