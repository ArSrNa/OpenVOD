package server

// 自定义元数据公开白名单（spec.md §8.4 / ADR-0004「按公开白名单输出」）。
//
// media.custom_data 由管理端写入（分类 / 描述 / 标签的**稀疏投影**，spec.md §8.3），列里也
// 可能残留白名单外的扩展键；分发端**只**下发白名单内的三个键，其余一律丢弃——避免把内部
// 字段暴露给播放端。白名单键与 TS 侧 @openvod/shared MEDIA_CUSTOM_KEYS 手工对齐（Go 无生成物）。
import (
	"database/sql"
	"encoding/json"
	"strings"
)

const (
	customKeyCategory    = "category"
	customKeyDescription = "description"
	customKeyTags        = "tags"
)

// maxCustomTags 下发标签数上限（管理端已限制 20 个，这里再兜一层防御）
const maxCustomTags = 20

// customCategory 分类投影（含 name / path 快照，管理端在分类改名 / 移动时同步刷新）
type customCategory struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// parseCustomMetadata 把 media.custom_data 解析为公开白名单对象（缺省键不出现）：
//   - 空值 / 非法 JSON / 非对象 → 空对象：播放链路不因元数据脏数据中断；
//   - category：仅保留 id / name / path 三个非空字符串（其余字段丢弃；id 与 path 必有）；
//   - description：仅保留非空字符串；
//   - tags：字符串数组（逐项 trim、去重、丢弃空串，上限 20）。
func parseCustomMetadata(raw sql.NullString) map[string]interface{} {
	out := map[string]interface{}{}
	if !raw.Valid || strings.TrimSpace(raw.String) == "" {
		return out
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &data); err != nil {
		return out
	}
	if category, ok := parseCustomCategory(data[customKeyCategory]); ok {
		out[customKeyCategory] = category
	}
	if description, ok := parseCustomDescription(data[customKeyDescription]); ok {
		out[customKeyDescription] = description
	}
	if tags, ok := parseCustomTags(data[customKeyTags]); ok {
		out[customKeyTags] = tags
	}
	return out
}

func parseCustomCategory(raw json.RawMessage) (customCategory, bool) {
	if len(raw) == 0 {
		return customCategory{}, false
	}
	var c customCategory
	if err := json.Unmarshal(raw, &c); err != nil {
		return customCategory{}, false
	}
	c.ID = strings.TrimSpace(c.ID)
	c.Name = strings.TrimSpace(c.Name)
	c.Path = strings.TrimSpace(c.Path)
	if c.ID == "" || c.Path == "" {
		return customCategory{}, false
	}
	return c, true
}

func parseCustomDescription(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	s = strings.TrimSpace(s)
	return s, s != ""
}

func parseCustomTags(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var items []string
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	tags := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		tag := strings.TrimSpace(item)
		if tag == "" {
			continue
		}
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
		if len(tags) >= maxCustomTags {
			break
		}
	}
	if len(tags) == 0 {
		return nil, false
	}
	return tags, true
}
