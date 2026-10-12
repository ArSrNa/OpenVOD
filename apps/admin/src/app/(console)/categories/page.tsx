import type { Metadata } from "next";
import { CategoryManager } from "@/components/CategoryManager";

export const metadata: Metadata = {
  title: "分类管理 - OpenVOD 管理端",
};

export default function CategoriesPage() {
  return (
    <CategoryManager />
  );
}
