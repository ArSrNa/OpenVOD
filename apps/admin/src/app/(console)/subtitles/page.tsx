import type { Metadata } from "next";
import { SubtitleTracksPage } from "@/components/SubtitleTracksPage";

export const metadata: Metadata = {
  title: "字幕管理 - OpenVOD 管理端",
};

export default function SubtitlesPage() {
  return (
    <SubtitleTracksPage />
  );
}
