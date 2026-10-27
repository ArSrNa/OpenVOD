package store

import (
	"fmt"
	"time"
)

// Time 方言无关的时间列（ADR-0011 2026-10-17 修订）。
//
// Prisma 的 DateTime 在两种库里的物理表示不同：
//   - MySQL：DATETIME（go-sql-driver parseTime=true 回读 time.Time）；
//   - SQLite：INTEGER 毫秒时间戳（实测 Prisma 6 的写入形态，非文本）。
//
// 写入侧统一走 Store.ts；读取侧由本类型识别驱动返回的实际 Go 类型，
// 避免 SQLite 下 integer → time.Time 的扫描失败。
type Time struct {
	time.Time
}

func (t *Time) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		t.Time = time.Time{}
	case time.Time:
		t.Time = v.UTC()
	case int64:
		t.Time = time.UnixMilli(v).UTC()
	case []byte:
		return t.parse(string(v))
	case string:
		return t.parse(v)
	default:
		return fmt.Errorf("store: 无法解析时间列类型 %T", src)
	}
	return nil
}

// parse 兼容文本时间形态：兜底处理手工写入 / 旧库（Prisma 的 SQLite 驱动不会产生文本）。
func (t *Time) parse(s string) error {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	} {
		if v, err := time.Parse(layout, s); err == nil {
			t.Time = v.UTC()
			return nil
		}
	}
	return fmt.Errorf("store: 无法解析时间值 %q", s)
}
