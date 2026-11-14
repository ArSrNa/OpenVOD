package server

// play 响应 templates[] 单测（spec.md §11.1）：多模板排序 / 已删模板 name=null /
// 旧布局空数组 / 查表失败降级 / 与 template_id 选择一致性 / 候选过滤。

import (
	"reflect"
	"testing"

	"openvod/apps/delivery/internal/contracts"
	"openvod/apps/delivery/internal/store"
)

const (
	tplA = "caaaaaaaaaaaaaaaaaaaa" // 字典序最小
	tplB = "cbbbbbbbbbbbbbbbbbbbb"
	tplC = "cccccccccccccccccccc"
	tplD = "cdddddddddddddddddddd"
)

func strPtr(s string) *string { return &s }

func TestBuildPlaybackTemplatesSortingAndDefaults(t *testing.T) {
	candidates := []string{tplD, tplB, tplA, tplC}
	refs := map[string]store.TemplateRef{
		tplA: {ID: tplA, Name: "720p"},
		tplB: {ID: tplB, Name: "原画"}, // 有效默认（由 defaultID 传入）→ 即使 name 排序不占先也排第一
		tplC: {ID: tplC, Name: "1080p"},
		tplD: {ID: tplD, Name: "1080p"}, // 与 C 同名 → 按 id 字典序
	}
	got := buildPlaybackTemplates(candidates, refs, true, tplB)
	want := []contracts.PlaybackTemplate{
		{ID: tplB, Name: strPtr("原画"), IsDefault: true},
		{ID: tplC, Name: strPtr("1080p")},
		{ID: tplD, Name: strPtr("1080p")},
		{ID: tplA, Name: strPtr("720p")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("排序不符：got %+v，want %+v", dumpTemplates(got), dumpTemplates(want))
	}
}

func TestBuildPlaybackTemplatesDeletedRowIsNull(t *testing.T) {
	// tplC 无模板行（历史产物，模板已删）→ name=null、is_default=false，且 name 为 null 排在最后
	refs := map[string]store.TemplateRef{
		tplA: {ID: tplA, Name: "720p"},
		tplB: {ID: tplB, Name: "原画"},
	}
	got := buildPlaybackTemplates([]string{tplC, tplB, tplA}, refs, true, tplA)
	want := []contracts.PlaybackTemplate{
		{ID: tplA, Name: strPtr("720p"), IsDefault: true},
		{ID: tplB, Name: strPtr("原画")},
		{ID: tplC, Name: nil}, // 行缺失
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("已删模板降级不符：got %+v，want %+v", dumpTemplates(got), dumpTemplates(want))
	}
}

func TestBuildPlaybackTemplatesLookupFailureDegradesAll(t *testing.T) {
	// 查询失败（lookupOK=false）：全部 name=null、is_default=false，按 id 字典序稳定输出
	got := buildPlaybackTemplates([]string{tplC, tplA, tplB}, map[string]store.TemplateRef{
		tplA: {ID: tplA, Name: "720p"}, // 即便残留 refs 也不可使用
	}, false, "")
	want := []contracts.PlaybackTemplate{
		{ID: tplA, Name: nil},
		{ID: tplB, Name: nil},
		{ID: tplC, Name: nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("查表失败降级不符：got %+v，want %+v", dumpTemplates(got), dumpTemplates(want))
	}
}

func TestBuildPlaybackTemplatesEmptyCandidates(t *testing.T) {
	// 旧布局 / 无产物：恒为空数组（len=0，序列化为 []）
	got := buildPlaybackTemplates(nil, nil, true, "")
	if got == nil || len(got) != 0 {
		t.Fatalf("空候选应为空数组，got %+v", got)
	}
}

func TestTemplatesContainSelectedTemplate(t *testing.T) {
	// 与 template_id 选择一致性：resolveTemplate 只在候选内选择 → 响应 templates[] 必含所选 id
	candidates := filterTemplateCandidates([]string{"subtitles", tplA, tplB, "not-a-template"})
	b := buildPlaybackTemplates(candidates, nil, false, "")
	for _, id := range candidates {
		if !containsTemplate(b, id) {
			t.Fatalf("templates[] 缺少候选 %s", id)
		}
	}
	if containsTemplate(b, "subtitles") || containsTemplate(b, "not-a-template") {
		t.Fatalf("保留段 / 脏目录不应进入候选：%+v", dumpTemplates(b))
	}
}

func TestFilterTemplateCandidates(t *testing.T) {
	got := filterTemplateCandidates([]string{"subtitles", tplA, "cover", "cx", tplB + "/", tplB})
	want := []string{tplA, tplB}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("候选过滤不符：got %v，want %v", got, want)
	}
}

func containsTemplate(items []contracts.PlaybackTemplate, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

func dumpTemplates(items []contracts.PlaybackTemplate) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		name := "null"
		if it.Name != nil {
			name = *it.Name
		}
		out = append(out, it.ID+"|"+name)
	}
	return out
}

// ---- 未指定模板时的自动选择（spec.md §6.3 修订 2026-10-13：多套产物不再 409，自动播 templates[] 第一个）----

func TestSelectAutoTemplatePicksSortedFirst(t *testing.T) {
	// 无默认模板：须选「排序后第一个」（name 最小），而不是存储列举顺序第一个
	candidates := []string{tplD, tplC, tplB, tplA}
	refs := map[string]store.TemplateRef{
		tplA: {ID: tplA, Name: "原画"},
		tplB: {ID: tplB, Name: "720p"},
		tplC: {ID: tplC, Name: "1080p"},
		tplD: {ID: tplD, Name: "480p"},
	}
	items := buildPlaybackTemplates(candidates, refs, true, "")
	// 排序：1080p(C) → 480p(D) → 720p(B) → 原画(A)（字典序中数字先于中文）
	if got, want := selectAutoTemplate(items), tplC; got != want {
		t.Fatalf("自动选择不符：got %s（items %v），want 排序后第一个 %s", got, dumpTemplates(items), want)
	}
	if items[0].ID != tplC {
		t.Fatalf("自动选择与列表首项不一致：templates[0]=%s，want %s", items[0].ID, tplC)
	}
}

func TestSelectAutoTemplatePrefersDefault(t *testing.T) {
	// 有默认模板：默认优先（排序已保证默认在首位，选择直接取首项）
	candidates := []string{tplD, tplC, tplB}
	refs := map[string]store.TemplateRef{
		tplB: {ID: tplB, Name: "720p"},
		tplC: {ID: tplC, Name: "1080p"},
		tplD: {ID: tplD, Name: "480p"},
	}
	items := buildPlaybackTemplates(candidates, refs, true, tplD)
	if got, want := selectAutoTemplate(items), tplD; got != want {
		t.Fatalf("默认模板未优先：got %s（items %v），want %s", got, dumpTemplates(items), want)
	}
}

func TestSelectAutoTemplateLookupFailureFallsBackToID(t *testing.T) {
	// 模板表查询失败：全部 name=null → 排序退化为 id 字典序，选择仍与列表首项一致且不空
	candidates := []string{tplD, tplB, tplA}
	items := buildPlaybackTemplates(candidates, nil, false, "")
	if got, want := selectAutoTemplate(items), tplA; got != want {
		t.Fatalf("降级排序下自动选择不符：got %s（items %v），want %s", got, dumpTemplates(items), want)
	}
}

func TestSelectAutoTemplateEmpty(t *testing.T) {
	if got := selectAutoTemplate(nil); got != "" {
		t.Fatalf("空列表应返回空串，got %s", got)
	}
	if got := selectAutoTemplate([]contracts.PlaybackTemplate{}); got != "" {
		t.Fatalf("空列表应返回空串，got %s", got)
	}
}
