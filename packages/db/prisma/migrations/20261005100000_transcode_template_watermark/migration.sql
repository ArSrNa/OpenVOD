-- 转码模板关联水印模板（spec.md §10.4 / ADR-0018）：
-- transcode_templates.watermark_id 可空外键 → watermark_templates.id（SetNull 兜底）。
-- expand 迁移：只加不改，向后兼容（既有模板 watermark_id 为 NULL = 不烧录水印）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
ALTER TABLE `transcode_templates` ADD COLUMN `watermark_id` VARCHAR(191) NULL;

CREATE INDEX `transcode_templates_watermark_id_idx` ON `transcode_templates`(`watermark_id`);

ALTER TABLE `transcode_templates` ADD CONSTRAINT `transcode_templates_watermark_id_fkey`
    FOREIGN KEY (`watermark_id`) REFERENCES `watermark_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
