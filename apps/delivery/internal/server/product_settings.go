package server

// 媒资级转码产物展示与默认（spec.md §6.3 / §11.1，2026-11-15）：
// media.product_settings 的解析与生效范围计算（纯函数，便于单测）。
// 脏值一律降级为「全部展示、无媒资级默认」——播放链路不因设置损坏中断（同 §8.4 容错口径）。

import (
	"encoding/json"
	"strings"
)

type productSettings struct {
	// 对播放端展示的模板 ID 白名单；空 = 全部展示
	VisibleTemplateIDs []string
	// 进入后默认加载的模板产物；"" = 未设置（回退全局默认模板 → 排序首项）
	DefaultTemplateID string
}

type productSettingsJSON struct {
	VisibleTemplateIDs []string `json:"visible_template_ids"`
	DefaultTemplateID  *string  `json:"default_template_id"`
}

/**
 * parseProductSettings 解析 media.product_settings（JSON）：
 *   - 空 / 非法 JSON / 字段类型不符 → 全部展示、无媒资级默认；
 *   - 白名单里非模板 ID 形状的脏值丢弃并去重；空数组等价 null（= 全部展示）；
 *   - 默认产物不在展示范围 → 不生效（回退全局默认）。
 */
func parseProductSettings(raw string) productSettings {
	if strings.TrimSpace(raw) == "" {
		return productSettings{}
	}
	var v productSettingsJSON
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return productSettings{}
	}

	ids := make([]string, 0, len(v.VisibleTemplateIDs))
	seen := make(map[string]bool, len(v.VisibleTemplateIDs))
	for _, id := range v.VisibleTemplateIDs {
		if !templateIDPattern.MatchString(id) || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}

	def := ""
	if v.DefaultTemplateID != nil && templateIDPattern.MatchString(*v.DefaultTemplateID) {
		def = *v.DefaultTemplateID
	}
	if len(ids) == 0 {
		ids = nil // 空数组 = 全部展示（与 null 同义，避免 nil / 空切片两种表示）
	}
	if def != "" && len(ids) > 0 && !containsString(ids, def) {
		def = ""
	}
	return productSettings{VisibleTemplateIDs: ids, DefaultTemplateID: def}
}

/**
 * visibleTemplateCandidates 按设置过滤候选（保持存储列举顺序）：
 * 白名单为空 = 全部展示；白名单与候选无交集时回退全部——至少保证一套可播（可用性优先）。
 */
func visibleTemplateCandidates(candidates []string, s productSettings) []string {
	if len(s.VisibleTemplateIDs) == 0 {
		return candidates
	}
	allow := make(map[string]bool, len(s.VisibleTemplateIDs))
	for _, id := range s.VisibleTemplateIDs {
		allow[id] = true
	}
	out := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if allow[c] {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return candidates
	}
	return out
}

/** effectiveDefaultTemplate 媒资级默认产物：仅当它确实落在可见候选内时生效，否则空（交给全局默认） */
func effectiveDefaultTemplate(settings productSettings, visible []string) string {
	if settings.DefaultTemplateID != "" && containsString(visible, settings.DefaultTemplateID) {
		return settings.DefaultTemplateID
	}
	return ""
}

/** unionTemplateIDs 把显式请求的产物并入展示列表（已存在则原样返回） */
func unionTemplateIDs(base []string, extra string) []string {
	if containsString(base, extra) {
		return base
	}
	out := make([]string, 0, len(base)+1)
	out = append(out, base...)
	return append(out, extra)
}

func containsString(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}
