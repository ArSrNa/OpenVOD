-- 媒资自定义上传时间（spec.md §3.1）：
-- NULL = 管理端「上传时间」展示回退存储对象原始写入时间（行为与迁移前一致）；
-- 设值后管理端列表 / 详情优先展示该时间，分发端列表排序回退链为
-- COALESCE(published_at, uploaded_at, created_at)（store.go，ADR-0004）。
ALTER TABLE `media` ADD COLUMN `uploaded_at` DATETIME(3) NULL;
