import type { Metadata } from "next";
import { MediaUpload } from "@/components/MediaUpload";

export const metadata: Metadata = {
  title: "视频上传 - OpenVOD 管理端",
};

export default function MediaUploadPage() {
  return (
    <MediaUpload />
  );
}
