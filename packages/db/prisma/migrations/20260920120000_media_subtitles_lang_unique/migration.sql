-- 字幕：同一媒资内语言唯一（spec.md §7.1；ADR-0009 实现细化）
-- 播放端按语言选轨需无歧义；同语言的简繁等形态用不同语言区域表达（zh-CN / zh-TW 视为不同语言）。
-- 提醒：存量库若已有同媒资同语言的多行字幕，本迁移会失败；需先人工合并（保留最新一条）再执行。
CREATE UNIQUE INDEX `media_subtitles_media_id_lang_key` ON `media_subtitles`(`media_id`, `lang`);
