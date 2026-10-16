import type { Metadata } from "next";
import { DashboardOverview } from "@/components/DashboardOverview";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "总览 - OpenVOD 管理端",
};

export default function ConsolePage() {
  return (
    <div className="flex flex-col gap-5">
      <Header />
      <DashboardOverview />
    </div>
  );
}
