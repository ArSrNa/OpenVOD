package mk

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// fixtures 由 bun packages/crypto/scripts/gen-vectors.ts 生成（ADR-0001 互通门禁）
const fixturePath = "../../../../packages/crypto/fixtures/crypto-v1.json"

type fixture struct {
	Wrap struct {
		MkHex        string `json:"mk_hex"`
		PlaintextHex string `json:"plaintext_hex"`
		GcmIvHex     string `json:"gcm_iv_hex"`
		WrappedHex   string `json:"wrapped_hex"`
	} `json:"wrap"`
}

func loadFixture(t *testing.T) *fixture {
	t.Helper()
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skip("fixtures 缺失：先执行 `task vectors` 生成")
		}
		t.Fatal(err)
	}
	var fx fixture
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	return &fx
}

func hexBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TS wrap → Go Unwrap 互通（spec.md §4.1；ADR-0006 §1）
func TestUnwrapMatchesTSFixture(t *testing.T) {
	fx := loadFixture(t)
	plain, err := Unwrap(hexBytes(t, fx.Wrap.MkHex), hexBytes(t, fx.Wrap.WrappedHex))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(plain) != fx.Wrap.PlaintextHex {
		t.Fatalf("TS/Go MK 封装漂移：got=%x want=%s", plain, fx.Wrap.PlaintextHex)
	}
}

func TestUnwrapRejectsWrongKeyAndTamper(t *testing.T) {
	fx := loadFixture(t)
	wrong := make([]byte, 32) // 全 0 的假 MK
	if _, err := Unwrap(wrong, hexBytes(t, fx.Wrap.WrappedHex)); err == nil {
		t.Fatal("错误 MK 未报错（GCM 认证应失败）")
	}
	tampered := hexBytes(t, fx.Wrap.WrappedHex)
	tampered[len(tampered)-1] ^= 0x01
	if _, err := Unwrap(hexBytes(t, fx.Wrap.MkHex), tampered); err == nil {
		t.Fatal("篡改封装串未报错")
	}
}

// signing_keys 无 mk_ver 列：UnwrapAny 逐版本尝试（版本号大者优先）
func TestUnwrapAnyPicksCorrectVersion(t *testing.T) {
	fx := loadFixture(t)
	keys := map[int][]byte{1: make([]byte, 32), 2: hexBytes(t, fx.Wrap.MkHex)}
	plain, ver, err := UnwrapAny(keys, hexBytes(t, fx.Wrap.WrappedHex))
	if err != nil {
		t.Fatal(err)
	}
	if ver != 2 {
		t.Fatalf("应命中 v2，实际 v%d", ver)
	}
	if hex.EncodeToString(plain) != fx.Wrap.PlaintextHex {
		t.Fatal("解封内容不一致")
	}
}

func TestUnwrapHexRejectsGarbage(t *testing.T) {
	if _, err := UnwrapHex(make([]byte, 32), "not-hex"); err == nil {
		t.Fatal("非法 hex 未报错")
	}
	if _, err := UnwrapHex(make([]byte, 31), "00"); err == nil {
		t.Fatal("MK 长度非法未报错")
	}
}
