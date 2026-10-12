import type { Metadata } from "next";
import { AboutContent } from "@/components/AboutContent";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "关于 - OpenVOD 管理端",
};

export default function AboutPage() {
  return (
    <div className="flex flex-col gap-5">
      <Header />
      <AboutContent />
    </div>
  );
}
