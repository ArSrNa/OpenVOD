package server

// 媒资级转码产物展示与默认（spec.md §6.3/§11.1，2026-11-15）单测：
// JSON 解析容错 / 可见候选过滤 / 默认产物生效范围 / 显式请求并集 / 响应默认打标。

import (
	"reflect"
	"testing"

	"openvod/apps/delivery/internal/store"
)

func TestParseProductSettings(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want productSettings
	}{
		{"空字符串 = 全部展示、无默认", "", productSettings{}},
		{"非法 JSON 降级", `{not json`, productSettings{}},
		{"null 字段 = 全部展示、无默认", `{"visible_template_ids":null,"default_template_id":null}`, productSettings{}},
		{"空数组等价全部展示", `{"visible_template_ids":[],"default_template_id":null}`, productSettings{}},
		{
			"白名单 + 默认（默认在范围内）",
			`{"visible_template_ids":["` + tplA + `","` + tplB + `"],"default_template_id":"` + tplB + `"}`,
			productSettings{VisibleTemplateIDs: []string{tplA, tplB}, DefaultTemplateID: tplB},
		},
		{
			"默认不在白名单 → 不生效",
			`{"visible_template_ids":["` + tplA + `"],"default_template_id":"` + tplB + `"}`,
			productSettings{VisibleTemplateIDs: []string{tplA}},
		},
		{
			"脏 ID 丢弃 + 去重",
			`{"visible_template_ids":["` + tplA + `","bad","` + tplA + `"],"default_template_id":"bad"}`,
			productSettings{VisibleTemplateIDs: []string{tplA}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseProductSettings(c.raw); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("parseProductSettings(%s) = %+v，want %+v", c.raw, got, c.want)
			}
		})
	}
}

func TestVisibleTemplateCandidates(t *testing.T) {
	candidates := []string{tplD, tplB, tplA, tplC}

	t.Run("无白名单 = 全部", func(t *testing.T) {
		got := visibleTemplateCandidates(candidates, productSettings{})
		if !reflect.DeepEqual(got, candidates) {
			t.Fatalf("got %v，want %v", got, candidates)
		}
	})

	t.Run("白名单按候选顺序保留（不按设置顺序）", func(t *testing.T) {
		got := visibleTemplateCandidates(candidates, productSettings{VisibleTemplateIDs: []string{tplC, tplA}})
		want := []string{tplA, tplC}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v，want %v", got, want)
		}
	})

	t.Run("白名单与已删产物无交集 → 回退全部（至少一套可播）", func(t *testing.T) {
		got := visibleTemplateCandidates(candidates, productSettings{VisibleTemplateIDs: []string{tplA + "x"}})
		if !reflect.DeepEqual(got, candidates) {
			t.Fatalf("got %v，want 全部 %v", got, candidates)
		}
	})

	t.Run("空候选不影响", func(t *testing.T) {
		if got := visibleTemplateCandidates(nil, productSettings{VisibleTemplateIDs: []string{tplA}}); len(got) != 0 {
			t.Fatalf("空候选应返回空，got %v", got)
		}
	})
}

func TestEffectiveDefaultTemplate(t *testing.T) {
	if got := effectiveDefaultTemplate(productSettings{DefaultTemplateID: tplB}, []string{tplA, tplB}); got != tplB {
		t.Fatalf("默认产物应在可见范围内生效，got %q", got)
	}
	if got := effectiveDefaultTemplate(productSettings{DefaultTemplateID: tplB}, []string{tplA}); got != "" {
		t.Fatalf("默认产物不在可见范围应返回空，got %q", got)
	}
	if got := effectiveDefaultTemplate(productSettings{}, []string{tplA}); got != "" {
		t.Fatalf("未设置默认应返回空，got %q", got)
	}
}

func TestUnionTemplateIDs(t *testing.T) {
	base := []string{tplA, tplB}
	if got := unionTemplateIDs(base, tplB); !reflect.DeepEqual(got, base) {
		t.Fatalf("已存在不应重复追加，got %v", got)
	}
	if got, want := unionTemplateIDs(base, tplC), []string{tplA, tplB, tplC}; !reflect.DeepEqual(got, want) {
		t.Fatalf("隐藏产物应并入，got %v，want %v", got, want)
	}
}

func TestBuildPlaybackTemplatesMarksOnlyEffectiveDefault(t *testing.T) {
	refs := map[string]store.TemplateRef{
		tplA: {ID: tplA, Name: "720p", IsDefault: true}, // 全局默认列不再直接采用
		tplB: {ID: tplB, Name: "1080p"},
	}
	// 未传有效默认：即使模板行标了 is_default，也不打标
	items := buildPlaybackTemplates([]string{tplA, tplB}, refs, true, "")
	for _, it := range items {
		if it.IsDefault {
			t.Fatalf("无有效默认时不应打标：%+v", dumpTemplates(items))
		}
	}

	// 媒资级默认覆盖全局默认：只打 B
	items = buildPlaybackTemplates([]string{tplA, tplB}, refs, true, tplB)
	if !items[0].IsDefault || items[0].ID != tplB {
		t.Fatalf("有效默认应排第一并唯一打标：%+v", dumpTemplates(items))
	}
	for _, it := range items[1:] {
		if it.IsDefault {
			t.Fatalf("只应有一个默认项：%+v", dumpTemplates(items))
		}
	}

	// 查表失败仍能标出有效默认（名称降级 null）
	items = buildPlaybackTemplates([]string{tplA, tplB}, nil, false, tplA)
	if !items[0].IsDefault || items[0].ID != tplA || items[0].Name != nil {
		t.Fatalf("查表失败时默认标记不符：%+v", items)
	}
}
