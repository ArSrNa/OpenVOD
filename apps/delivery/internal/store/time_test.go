package store

import (
	"testing"
	"time"
)

func TestTimeScan(t *testing.T) {
	want := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name string
		src  any
	}{
		{"mysql time.Time", want},
		{"sqlite 整数毫秒", want.UnixMilli()},
		{"文本 RFC3339", want.Format(time.RFC3339Nano)},
		{"文本 DATETIME", want.Format("2006-01-02 15:04:05.999999999")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var ts Time
			if err := ts.Scan(c.src); err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if !ts.Equal(want) {
				t.Fatalf("got %s, want %s", ts.Time, want)
			}
		})
	}

	var zero Time
	if err := zero.Scan(nil); err != nil || !zero.IsZero() {
		t.Fatalf("nil → %s, %v", zero.Time, err)
	}
	if err := zero.Scan(struct{}{}); err == nil {
		t.Fatal("未知类型应报错")
	}
}
