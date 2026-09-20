-- 每媒资一份 HLS 密钥（spec.md §4.1 / ADR-0006）：media_id 唯一约束
-- 重转码 = 事务内整行替换（新 kid → 删旧 kid），不支持同媒资多版本并存。
-- 提醒：存量库若已存在同一 media_id 的多行密钥，本迁移会失败；需先人工合并（保留最新 kid）再执行。
CREATE UNIQUE INDEX `hls_keys_media_id_key` ON `hls_keys`(`media_id`);
