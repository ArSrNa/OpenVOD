-- 字幕内容版本号（spec.md §7.5；ADR-0009 2026-11-13 修订）
-- 前置：字幕 URL 引入共享 token（不绑会话，跨会话稳定 → CDN 可缓存）后，
-- 「就地覆盖文本」不能再用 no-store 保证新鲜度，改为版本进 URL：
-- 覆盖文本 → content_version +1 → play 签发的新 URL（?v=N+1）缓存键隔离；
-- 旧 URL（?v=N）由分发端校验版本不符 403。
-- 存量行回填 1（首次签发即 v=1）。
ALTER TABLE `media_subtitles` ADD COLUMN `content_version` INTEGER NOT NULL DEFAULT 1;
