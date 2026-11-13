// 字幕共享 token 与缓存策略的单测（ADR-0009 2026-11-13 修订；spec.md §7.5）。
package server

import (
	"testing"
	"time"
)

func TestSubtitleSharedExp(t *testing.T) {
	// 恒有 exp > now（不签出已过期 token）
	now := time.Date(2026, 11, 13, 10, 30, 15, 0, time.UTC)
	exp := subtitleSharedExp(now, 24*3600)
	if !exp.After(now) {
		t.Fatalf("exp=%v 必须晚于 now=%v", exp, now)
	}

	// 同一窗口内任意时刻签发的 exp 逐字相同（CDN 缓存键稳定的前提）
	base := time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)
	window := 24 * 3600
	want := subtitleSharedExp(base.Add(time.Minute), window)
	for _, m := range []int{0, 1, 60, 3600, 12 * 3600, 23 * 3600, 86399} {
		got := subtitleSharedExp(base.Add(time.Duration(m)*time.Second), window)
		if !got.Equal(want) {
			t.Fatalf("同窗口 exp 漂移：+%ds → %v，want %v", m, got, want)
		}
	}

	// 跨窗口则变化（旧 URL 的 token 到期收敛）
	next := subtitleSharedExp(base.Add(24*3600*time.Second), window)
	if next.Equal(want) {
		t.Fatal("跨窗口 exp 未推进")
	}

	// 非法 ttl 兜底（不 panic、恒有效）
	if !subtitleSharedExp(now, 0).After(now) || !subtitleSharedExp(now, -5).After(now) {
		t.Fatal("非法 ttl 应兜底为恒有效窗口")
	}
}

func TestSubtitleCacheControl(t *testing.T) {
	cases := []struct {
		name   string
		shared bool
		maxAge int
		want   string
	}{
		{"共享 token 可缓存", true, 600, "public, max-age=600"},
		{"max-age=0 关闭缓存", true, 0, "no-store"},
		{"负值关闭缓存", true, -1, "no-store"},
		{"会话 token 恒 no-store", false, 600, "no-store"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := subtitleCacheControl(c.shared, c.maxAge); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
