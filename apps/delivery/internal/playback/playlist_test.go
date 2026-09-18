package playback

import (
	"errors"
	"strings"
	"testing"
)

const masterIn = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
1080p/index.m3u8
`

const variantIn = "#EXTM3U\r\n" +
	"#EXT-X-VERSION:3\n" +
	"#EXT-X-TARGETDURATION:6\n" +
	"#EXT-X-PLAYLIST-TYPE:VOD\n" +
	"#EXT-X-KEY:METHOD=AES-128,URI=\"https://delivery.openvod.invalid/v1/media/00000042/key\",IV=0x00112233445566778899aabbccddeeff\n" +
	"#EXTINF:6.000,\n" +
	"seg-00001.ts\n" +
	"#EXTINF:6.000,\n" +
	"seg-00002.ts\n" +
	"#EXT-X-ENDLIST\n"

func TestRewriteMaster(t *testing.T) {
	rw := Rewriter{Variant: func(name string) string {
		return "https://d.example/v1/media/00000042/manifest/" + name + "?t=TOK&tpl=cABC"
	}}
	out := rw.RewriteMaster(masterIn)

	if !strings.Contains(out, "https://d.example/v1/media/00000042/manifest/360p/index.m3u8?t=TOK&tpl=cABC") {
		t.Fatalf("变体行未改写：\n%s", out)
	}
	if !strings.Contains(out, "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080") {
		t.Fatal("标签行被破坏")
	}
	if strings.Contains(out, "\n360p/index.m3u8") {
		t.Fatal("原始相对 URI 仍然存在")
	}
}

func TestRewriteVariant(t *testing.T) {
	rw := Rewriter{
		KeyURL: "https://d.example/v1/media/00000042/key?t=KEYTOK",
		Segment: func(name string) (string, error) {
			return "https://d.example/v1/media/00000042/local/cTpl/1080p/" + name + "?t=SEGTOK", nil
		},
	}
	out, err := rw.RewriteVariant(variantIn)
	if err != nil {
		t.Fatal(err)
	}

	// EXT-X-KEY：URI 换成带 token 的密钥 URL，METHOD / IV 原样保留
	if !strings.Contains(out, `#EXT-X-KEY:METHOD=AES-128,URI="https://d.example/v1/media/00000042/key?t=KEYTOK",IV=0x00112233445566778899aabbccddeeff`) {
		t.Fatalf("EXT-X-KEY 未正确改写：\n%s", out)
	}
	if strings.Contains(out, "openvod.invalid") {
		t.Fatal("转码期占位 URI 仍残留")
	}
	// 分片：
	if !strings.Contains(out, "https://d.example/v1/media/00000042/local/cTpl/1080p/seg-00001.ts?t=SEGTOK") ||
		!strings.Contains(out, "seg-00002.ts?t=SEGTOK") {
		t.Fatalf("分片行未改写：\n%s", out)
	}
	// 其它标签与 CRLF 归一
	if !strings.Contains(out, "#EXT-X-ENDLIST") || strings.Contains(out, "\r") {
		t.Fatal("标签保留 / 换行归一失败")
	}
}

func TestRewriteVariantHandlesExtXMap(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nseg-00001.m4s\n"
	rw := Rewriter{
		KeyURL:  "k",
		Segment: func(name string) (string, error) { return "https://d.example/media/" + name, nil },
	}
	out, err := rw.RewriteVariant(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `#EXT-X-MAP:URI="https://d.example/media/init.mp4"`) {
		t.Fatalf("EXT-X-MAP 未改写：\n%s", out)
	}
}

func TestRewriteVariantErrors(t *testing.T) {
	// 密钥标签缺 URI → 报错（避免产出无法解密的清单）
	if _, err := (Rewriter{KeyURL: "k"}).RewriteVariant("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n"); err == nil {
		t.Fatal("缺 URI 未报错")
	}
	// 分片 URL 构造失败 → 整体失败（不返回半成品清单）
	want := errors.New("presign 失败")
	_, err := (Rewriter{
		KeyURL:  "k",
		Segment: func(string) (string, error) { return "", want },
	}).RewriteVariant("#EXTM3U\nseg-00001.ts\n")
	if !errors.Is(err, want) {
		t.Fatalf("分片错误未透出：%v", err)
	}
}

// 未加密产物（没有 EXT-X-KEY）也必须能改写分片
func TestRewriteVariantWithoutKeyTag(t *testing.T) {
	out, err := (Rewriter{Segment: func(name string) (string, error) { return "u/" + name, nil }}).
		RewriteVariant("#EXTM3U\nseg-00001.ts\n")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "u/seg-00001.ts") {
		t.Fatalf("未改写：%s", out)
	}
}
