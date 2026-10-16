import type { Metadata } from "next";
import { KeysManager } from "@/components/KeysManager";

export const metadata: Metadata = {
  title: "密钥管理 - OpenVOD 管理端",
};

export default function KeysPage() {
  return (
    <KeysManager />
  );
}
