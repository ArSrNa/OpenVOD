import type { Metadata } from "next";
import { MediaList } from "@/components/MediaList";

export const metadata: Metadata = {
  title: "视频管理 - OpenVOD 管理端",
};

export default function MediaPage() {
  return (
    <MediaList />
  );
}
