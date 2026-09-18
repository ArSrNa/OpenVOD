"use client";

// 管理端表格滚动约定（spec.md §3，2026-09-18 用户规定）：
// 所有管理相关表格必须「表体限高、内部纵向滚动、表头固定」，页面本身不随条目数增长；
// 超宽表格同时横向滚动（scroll.x = 各列宽合计）。所有表格页面必须复用本 hook，不得各自实现。
import { useEffect, useState } from "react";

/** 极窄视口下的兜底高度 */
export const TABLE_MIN_BODY_HEIGHT = 280;
/** 分页条约 56 + 卡片内边距 16 + PageContainer 底部 16（padding 已收敛为 16） */
export const TABLE_BOTTOM_RESERVE = 88;

/** 按「容器距文档顶部 + 视口高度」推算表体可用高度，随窗口尺寸变化重算 */
export function useTableBodyHeight(ref: { current: HTMLElement | null }): number {
  const [height, setHeight] = useState(TABLE_MIN_BODY_HEIGHT);

  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      // 取文档坐标而非视口坐标：表体限高后页面本身不再滚动，按「页面回到顶部」的可用高度计算更稳定
      const top = el.getBoundingClientRect().top + window.scrollY;
      const available = window.innerHeight - top - TABLE_BOTTOM_RESERVE;
      setHeight(Math.max(TABLE_MIN_BODY_HEIGHT, Math.round(available)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref]);

  return height;
}
