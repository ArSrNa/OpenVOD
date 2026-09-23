package server

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// nullString 便捷构造（Valid=false 表示 DB 列为 NULL）
func nullString(s string, valid bool) sql.NullString {
	return sql.NullString{String: s, Valid: valid}
}

func TestParseCustomMetadataWhitelist(t *testing.T) {
	tests := []struct {
		name string
		raw  sql.NullString
		want string // 期望的 JSON（键序无关，用 reflect.DeepEqual 比对）
	}{
		{
			name: "NULL 列 → 空对象",
			raw:  nullString("", false),
			want: `{}`,
		},
		{
			name: "空白字符串 → 空对象",
			raw:  nullString("   ", true),
			want: `{}`,
		},
		{
			name: "非法 JSON → 空对象（不报错）",
			raw:  nullString("{not json", true),
			want: `{}`,
		},
		{
			name: "非对象 JSON → 空对象",
			raw:  nullString(`["a"]`, true),
			want: `{}`,
		},
		{
			name: "白名单外的扩展键一律丢弃",
			raw:  nullString(`{"internal_note":"secret","owner":"ops","description":"简介"}`, true),
			want: `{"description":"简介"}`,
		},
		{
			name: "三项齐全（稀疏投影原样下发）",
			raw: nullString(
				`{"category":{"id":"cabc12345678901234567890","name":"科幻","path":"电影 / 科幻"},`+
					`"description":"  简介  ","tags":[" 4K ","科幻","4K",""]}`,
				true,
			),
			want: `{"category":{"id":"cabc12345678901234567890","name":"科幻","path":"电影 / 科幻"},` +
				`"description":"简介","tags":["4K","科幻"]}`,
		},
		{
			name: "分类字段被裁剪（仅保留 id / name / path，其余丢弃）",
			raw:  nullString(`{"category":{"id":"c1","name":"剧集","path":"剧集","media_count":99}}`, true),
			want: `{"category":{"id":"c1","name":"剧集","path":"剧集"}}`,
		},
		{
			name: "分类缺少 id 或 path → 整项丢弃",
			raw:  nullString(`{"category":{"name":"剧集"}}`, true),
			want: `{}`,
		},
		{
			name: "分类为 null → 丢弃",
			raw:  nullString(`{"category":null}`, true),
			want: `{}`,
		},
		{
			name: "描述为空白 → 丢弃",
			raw:  nullString(`{"description":"   "}`, true),
			want: `{}`,
		},
		{
			name: "描述类型非字符串 → 丢弃",
			raw:  nullString(`{"description":{"text":"x"}}`, true),
			want: `{}`,
		},
		{
			name: "标签为空数组 / 全空白 → 丢弃",
			raw:  nullString(`{"tags":["","  "]}`, true),
			want: `{}`,
		},
		{
			name: "标签类型非字符串数组 → 丢弃",
			raw:  nullString(`{"tags":"4K"}`, true),
			want: `{}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// 按**线上形态**（JSON）比对：白名单结果是 struct 还是 map 不影响下发字节
			gotRaw, err := json.Marshal(parseCustomMetadata(tt.raw))
			if err != nil {
				t.Fatalf("序列化失败：%v", err)
			}
			var got, want map[string]interface{}
			if err := json.Unmarshal(gotRaw, &got); err != nil {
				t.Fatalf("结果非法 JSON：%v", err)
			}
			if err := json.Unmarshal([]byte(tt.want), &want); err != nil {
				t.Fatalf("期望值非法：%v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("parseCustomMetadata() = %s，期望 %s", gotRaw, tt.want)
			}
		})
	}
}

func TestParseCustomTagsCap(t *testing.T) {
	items := make([]string, 0, maxCustomTags+5)
	for i := 0; i < maxCustomTags+5; i++ {
		items = append(items, "tag-"+strings.Repeat("x", 1)+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	raw, err := json.Marshal(map[string]interface{}{"tags": items})
	if err != nil {
		t.Fatal(err)
	}
	got := parseCustomMetadata(nullString(string(raw), true))
	tags, ok := got[customKeyTags].([]string)
	if !ok {
		t.Fatalf("tags 未被下发：%v", got)
	}
	if len(tags) != maxCustomTags {
		t.Fatalf("标签数 = %d，期望上限 %d", len(tags), maxCustomTags)
	}
}
