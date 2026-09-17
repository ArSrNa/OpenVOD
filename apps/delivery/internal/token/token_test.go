package token

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
	Token struct {
		KeyHex  string `json:"key_hex"`
		Payload Payload `json:"payload"`
		Token   string `json:"token"`
	} `json:"token"`
	TypeA struct {
		Key       string `json:"key"`
		URI       string `json:"uri"`
		Timestamp int64  `json:"timestamp"`
		Rand      string `json:"rand"`
		UID       string `json:"uid"`
		Sign      string `json:"sign"`
	} `json:"typea"`
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

func TestTokenSignMatchesFixture(t *testing.T) {
	fx := loadFixture(t)
	got, err := Sign(fx.Token.Payload, mustHex(t, fx.Token.KeyHex))
	if err != nil {
		t.Fatal(err)
	}
	if got != fx.Token.Token {
		t.Fatalf("TS/Go token 漂移：\n got=%s\nwant=%s", got, fx.Token.Token)
	}
}

func TestTokenVerify(t *testing.T) {
	fx := loadFixture(t)
	keys := []SigningKey{{Kid: fx.Token.Payload.Kid, Key: mustHex(t, fx.Token.KeyHex)}}
	p, err := Verify(fx.Token.Token, keys, VerifyOptions{
		Typ:   TypeKey,
		Mid:   fx.Token.Payload.Mid,
		NowSec: fx.Token.Payload.Exp - 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Sid != fx.Token.Payload.Sid {
		t.Fatalf("sid = %s, want %s", p.Sid, fx.Token.Payload.Sid)
	}

	// 篡改 payload 必须失败
	if _, err := Verify(fx.Token.Token+"x", keys, VerifyOptions{NowSec: fx.Token.Payload.Exp - 1}); err == nil {
		t.Fatal("篡改签名未检出")
	}
	if _, err := Verify(fx.Token.Token, keys, VerifyOptions{NowSec: fx.Token.Payload.Exp + 1}); err == nil {
		t.Fatal("过期未检出")
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
