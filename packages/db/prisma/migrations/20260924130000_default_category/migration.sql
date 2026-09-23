-- 系统默认分类「其他」（spec.md §8.1 修订 2026-09-24 / ADR-0016）：
-- 未设置分类的媒资默认归入该分类（读取回退 + 上传落库 + 删除分类时迁入），且该分类不可删除。
-- ID 为固定值，与 @openvod/shared MEDIA_DEFAULT_CATEGORY_ID 一致（运行时幂等创建共用）。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
ALTER TABLE `media_categories` ADD COLUMN `is_system` BOOLEAN NOT NULL DEFAULT false;

INSERT INTO `media_categories`
    (`id`, `name`, `description`, `parent_id`, `sort_order`, `is_system`, `created_at`, `updated_at`)
VALUES
    ('cother00000000000000000', '其他',
     '未设置分类的媒资默认归入此分类（系统内置，不可删除）',
     NULL, 10000, true, NOW(3), NOW(3));
