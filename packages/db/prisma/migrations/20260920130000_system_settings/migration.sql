-- 系统设置（key-value，控制台运行时可调项；避免改 env 重启）
-- 首个键：playback_base_url —— 控制台「产物 → 播放」清单 / 密钥请求使用的分发端域名
-- S3 签名播放：分片 URL 由分发端按对象存储端点预签名直出，不经过该域名（ADR-0005 修订）
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
CREATE TABLE `system_settings` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
