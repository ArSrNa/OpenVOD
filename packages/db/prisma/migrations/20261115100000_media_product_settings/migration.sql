-- 媒资级转码产物展示与默认（spec.md §6.3/§11.1，2026-11-15）：
-- JSON {visible_template_ids: string[] | null, default_template_id: string | null}。
--   · visible_template_ids = null：全部模板产物对播放端展示（默认，同迁移前行为）；
--   · default_template_id   = null：未设置媒资级默认，回退全局默认模板 → 排序首项；
-- 仅影响分发端 play 的 templates[] 与自动选择，不改变产物本身的访问与鉴权。
-- expand 迁移：只加列不改既有列（ADR-0003），既有行该列为 NULL。
ALTER TABLE `media` ADD COLUMN `product_settings` JSON NULL;
