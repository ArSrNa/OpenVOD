-- 转码模板（ADR-0014）
-- CreateTable
CREATE TABLE `transcode_templates` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `keep_original` BOOLEAN NOT NULL DEFAULT false,
    `encrypt` BOOLEAN NOT NULL DEFAULT false,
    `format` ENUM('HLS') NOT NULL DEFAULT 'HLS',
    `params` JSON NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `transcode_templates_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
