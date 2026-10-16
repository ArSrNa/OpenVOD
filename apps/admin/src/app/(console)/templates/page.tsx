import type { Metadata } from "next";
import { TemplatesManager } from "@/components/TemplatesManager";

export const metadata: Metadata = {
  title: "转码模板 - OpenVOD 管理端",
};

export default function TemplatesPage() {
  return (
    <TemplatesManager />
  );
}
