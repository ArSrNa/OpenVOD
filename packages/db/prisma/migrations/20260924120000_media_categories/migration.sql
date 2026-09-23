-- 媒资分类（无限层级邻接表）+ 媒资分类引用 / 描述 / 标签（spec.md §8 / ADR-0016）
-- media.custom_data 语义扩展为「自定义元数据投影」（分类 / 描述 / 标签，分发端按公开白名单输出）
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
CREATE TABLE `media_categories` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `parent_id` VARCHAR(191) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `media_categories_parent_id_name_key`(`parent_id`, `name`),
    INDEX `media_categories_parent_id_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `media` ADD COLUMN `description` VARCHAR(191) NULL,
    ADD COLUMN `tags` JSON NULL,
    ADD COLUMN `category_id` VARCHAR(191) NULL;

CREATE INDEX `media_category_id_idx` ON `media`(`category_id`);

ALTER TABLE `media` ADD CONSTRAINT `media_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `media_categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `media_categories` ADD CONSTRAINT `media_categories_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `media_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
