// Package playback m3u8 行级改写（ADR-0006 §3 / ADR-0010）：
// 原始清单里的子清单 / 分片 / 密钥 URL 是相对路径或转码期占位 URL，
// 分发时必须整体替换为：
//   - 子清单：分发端 /manifest/... URL（typ=m token + tpl）
//   - 密钥：分发端 /key URL（typ=k token）——播放器据此拿到 16B CEK 本地解密
//   - 分片：local 驱动=分发端 /local/... URL（typ=s token）；s3 驱动=预签名直出 URL（字节不经过函数）
//
// 本包为纯函数（无 IO），URL 构造由调用方注入，便于单测。
package playback

import (
	"fmt"
	"strings"
)

// Rewriter 改写所需的三类 URL 构造器
type Rewriter struct {
	// KeyURL 密钥接口 URL（typ=k token）
	KeyURL string
	// Variant 子清单 URL（typ=m token）：入参为清单里的相对 URI（如 `720p/index.m3u8`）
	Variant func(name string) string
	// Segment 目标分片 URL：入参为清单里的相对文件名（如 `seg-00001.ts`）
	Segment func(name string) (string, error)
}

// RewriteMaster 主清单：改写全部变体行（非注释、非空行）
func (r Rewriter) RewriteMaster(text string) string {
	lines := splitLines(text)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		lines[i] = r.Variant(trimmed)
	}
	return joinLines(lines)
}

// RewriteVariant 子清单：改写 EXT-X-KEY / EXT-X-MAP 的 URI 与全部分片行
func (r Rewriter) RewriteVariant(text string) (string, error) {
	lines := splitLines(text)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		switch {
		case strings.HasPrefix(trimmed, "#EXT-X-KEY:"):
			rewritten, err := replaceAttrURI(trimmed, r.KeyURL)
			if err != nil {
				return "", err
			}
			lines[i] = rewritten
		case strings.HasPrefix(trimmed, "#EXT-X-MAP:"):
			// fMP4 演进路径（v1 输出 TS，不产生该标签）；存在则同样按媒体对象改写
			name := attrURI(trimmed)
			if name == "" {
				return "", fmt.Errorf("EXT-X-MAP 缺少 URI：%s", trimmed)
			}
			u, err := r.Segment(name)
			if err != nil {
				return "", err
			}
			lines[i] = strings.Replace(trimmed, `URI="`+name+`"`, `URI="`+u+`"`, 1)
		case strings.HasPrefix(trimmed, "#"):
			// 其它标签（EXTINF / EXT-X-ENDLIST / EXT-X-MEDIA 等）原样保留；字幕轨道属 M4
			continue
		default:
			url, err := r.Segment(trimmed)
			if err != nil {
				return "", err
			}
			lines[i] = url
		}
	}
	return joinLines(lines), nil
}

// attrURI 取 `URI="..."` 里的值；无该属性返回空串
func attrURI(line string) string {
	const marker = `URI="`
	start := strings.Index(line, marker)
	if start < 0 {
		return ""
	}
	rest := line[start+len(marker):]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// replaceAttrURI 替换 `URI="..."` 的值，保留其余属性（METHOD / IV 等）
func replaceAttrURI(line, newURI string) (string, error) {
	old := attrURI(line)
	if old == "" {
		return "", fmt.Errorf("标签缺少 URI 属性：%s", line)
	}
	return strings.Replace(line, `URI="`+old+`"`, `URI="`+newURI+`"`, 1), nil
}

func splitLines(text string) []string {
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") }
