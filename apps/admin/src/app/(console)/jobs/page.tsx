import type { Metadata } from "next";
import { JobsManager } from "@/components/JobsManager";

export const metadata: Metadata = {
  title: "转码任务 - OpenVOD 管理端",
};

export default function JobsPage() {
  return (
    <JobsManager />
  );
}
