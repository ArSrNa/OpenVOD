-- 历史媒资回填默认分类「其他」（spec.md §8.1 修订 2026-09-24 / ADR-0016）：
-- 升级前创建的媒资 `category_id` 为 NULL 且没有自定义元数据投影（分发端 `custom` 为空对象）。
-- 按「未设置分类 = 其他」的语义把分类引用与投影补齐（投影只写 category 键：这些行的
-- description / tags 本来就为空；若曾被手工写入 description / tags，下一次保存会补齐投影）。
-- 幂等：`WHERE category_id IS NULL`，重复执行不再影响已回填的行。
-- 注意：MySQL 的 `--` 注释后必须跟空格，否则整个语句块报 1064
UPDATE `media`
SET `category_id` = 'cother00000000000000000',
    `custom_data` = JSON_SET(
        COALESCE(`custom_data`, JSON_OBJECT()),
        '$.category', JSON_OBJECT('id', 'cother00000000000000000', 'name', '其他', 'path', '其他')
    ),
    `updated_at` = NOW(3)
WHERE `category_id` IS NULL;
