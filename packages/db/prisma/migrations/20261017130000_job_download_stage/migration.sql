-- 转码任务新增「拉取源片」阶段（spec.md §5.1 状态机 / ADR-0008 修订，2026-10-17）：
--   ① JobStatus 枚举插入 DOWNLOADING（位于 PROBING 与 ENCODING 之间）——源片拉取到本地与转码是两个阶段，
--      转码期输入本地文件，且多档只下载一次；
--   ② transcode_jobs.progress 记录当前阶段百分比（0–100；DOWNLOADING / ENCODING 阶段有意义，其余为 NULL）。
-- expand 迁移：只加不改——既有行的 status 取值全部保留、progress 为 NULL，向后兼容（ADR-0003 迁移纪律）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
ALTER TABLE `transcode_jobs` MODIFY COLUMN `status` ENUM('QUEUED','PROBING','DOWNLOADING','ENCODING','PACKAGING','DONE','FAILED') NOT NULL DEFAULT 'QUEUED';

ALTER TABLE `transcode_jobs` ADD COLUMN `progress` INTEGER NULL;
