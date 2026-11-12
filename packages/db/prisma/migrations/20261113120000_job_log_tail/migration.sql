-- 转码任务实时日志尾部（ADR-0017 修订，2026-11-13）：
--   ① transcode_jobs.log_tail 保存最近若干 KB 的 worker / ffmpeg 日志（环形缓冲，Worker 每 2s 覆盖写）；
--   ② transcode_jobs.log_seq 是覆盖版本号，管理端带 after=seq 轮询，未变化时不回传整段文本。
-- 为什么落库而不是走推送：Worker 可能部署为异步云函数（无稳定回连地址、无长连接），DB 是唯一共同介质；
-- 日志是诊断数据、非事实源，故只做有界尾部覆盖，不追加行、不参与状态机。
-- 列类型用 MEDIUMTEXT（Prisma schema 侧声明为 String?，与 system_settings.value 同一既有做法），
-- 避免 VARCHAR(191) 截断。
-- expand 迁移：只加不改——既有行 log_tail 为 NULL、log_seq 为 0，向后兼容（ADR-0003 迁移纪律）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
ALTER TABLE `transcode_jobs` ADD COLUMN `log_tail` MEDIUMTEXT NULL;

ALTER TABLE `transcode_jobs` ADD COLUMN `log_seq` INTEGER NOT NULL DEFAULT 0;
