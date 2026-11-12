-- 转码任务支持「取消并立即打断」（spec.md §5.1，2026-11-12）：
--   ① JobStatus 追加终结态 CANCELLED——取消不再伪装成 FAILED，管理端可区分「失败」与「用户取消」；
--   ② transcode_jobs.cancel_requested_at 记录取消请求时间：管理端对**执行中**任务写入该列，
--      Worker 取消轮询命中后杀掉 ffmpeg / 中止拉源，再把状态落为 CANCELLED。
-- expand 迁移：只加不改——既有行 status 取值全部保留、cancel_requested_at 为 NULL，向后兼容（ADR-0003 迁移纪律）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
ALTER TABLE `transcode_jobs` MODIFY COLUMN `status` ENUM('QUEUED','PROBING','DOWNLOADING','ENCODING','PACKAGING','DONE','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED';

ALTER TABLE `transcode_jobs` ADD COLUMN `cancel_requested_at` DATETIME(3) NULL;
