-- 转码任务模板引用与快照（ADR-0014）
-- AlterTable
ALTER TABLE `transcode_jobs` ADD COLUMN `template_id` VARCHAR(191) NULL,
    ADD COLUMN `template_snapshot` JSON NULL;
