-- CEK 轮换（spec.md §4.4，2026-11-13）：transcode_jobs.key_plan 保存轮换计划密钥。
--   发起轮换时管理端生成**一次**新密钥材料（CEK/IV/kid），把 **MK 封装形态**（wrapped_cek）
--   固化进该批全部轮换任务的本列 —— 所有任务（含重启 / 乱序执行）产出与落库同一把新 CEK：
--   · 幂等：失败任务重启后仍用同一把，不会出现「重启后换第二把新密钥导致已完成的产物作废」；
--   · 失败安全：全部任务完成前 hls_keys 不被触碰，旧产物照常可播（短时维护窗口仅部分完成态）。
-- 仅存 MK 封装形态（与 hls_keys.wrapped_cek 同一信任域），明文 CEK 绝不落库（spec.md §4.1）。
-- expand 迁移：只加不改——既有行 key_plan 为 NULL，向后兼容（ADR-0003 迁移纪律）。
ALTER TABLE `transcode_jobs` ADD COLUMN `key_plan` JSON NULL;
