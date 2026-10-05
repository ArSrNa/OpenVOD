-- 水印模板（spec.md §10 / ADR-0018）：图片 / 文字两类，参数 JSON 落库；
-- 图片资产落 watermark/{模板ID}.{ext}（平台级模板资产分区，非媒资 ID 索引）。
-- expand 迁移：仅新增，不改既有表（向后兼容）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
CREATE TABLE `watermark_templates` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `type` ENUM('image', 'text') NOT NULL,
    `image_ext` VARCHAR(191) NULL,
    `image_key` VARCHAR(191) NULL,
    `image_bytes` INTEGER NULL,
    `image_width` INTEGER NULL,
    `image_height` INTEGER NULL,
    `params` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `watermark_templates_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
