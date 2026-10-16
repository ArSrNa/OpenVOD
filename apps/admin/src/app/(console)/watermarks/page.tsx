import type { Metadata } from "next";
import { WatermarkManager } from "@/components/WatermarkManager";

export const metadata: Metadata = {
  title: "水印管理 - OpenVOD 管理端",
};

export default function WatermarksPage() {
  return (
    <WatermarkManager />
  );
}
