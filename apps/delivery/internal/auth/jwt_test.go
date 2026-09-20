package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func newTestSigner(t *testing.T) *Signer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &Signer{Kid: "jwt_test_01", Issuer: "openvod-delivery", Key: key}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	s := newTestSigner(t)
	now := time.Unix(1_900_000_000, 0)
	tok, err := s.Sign("user_01", 24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}

	pub := s.Key.Public().(*ecdsa.PublicKey)
	claims, err := Verify(tok, pub, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if claims.Sub != "user_01" || claims.Iss != "openvod-delivery" || claims.Kid != "jwt_test_01" {
		t.Fatalf("claims 不符：%+v", claims)
	}
	if claims.Exp != now.Add(24*time.Hour).Unix() || claims.Jti == "" {
		t.Fatalf("exp / jti 不符：%+v", claims)
	}

	// ES256 签名必须是 JWS raw R||S（64B），不是 ASN.1 DER
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("段数 = %d", len(parts))
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		t.Fatalf("签名长度 = %d, err=%v（应为 64B raw R||S）", len(sig), err)
	}
	var header map[string]any
	hb, _ := base64.RawURLEncoding.DecodeString(parts[0])
	_ = json.Unmarshal(hb, &header)
	if header["alg"] != "ES256" || header["kid"] != "jwt_test_01" {
		t.Fatalf("header 不符：%v", header)
	}
}

func TestVerifyRejectsTamperAndExpiry(t *testing.T) {
	s := newTestSigner(t)
	now := time.Unix(1_900_000_000, 0)
	tok, err := s.Sign("user_01", time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	pub := s.Key.Public().(*ecdsa.PublicKey)

	if _, err := Verify(tok+"x", pub, now); err == nil {
		t.Fatal("篡改签名未检出")
	}
	if _, err := Verify(tok, pub, now.Add(2*time.Hour)); err == nil {
		t.Fatal("过期未检出")
	}

	// 换一把密钥验签必须失败
	other := newTestSigner(t)
	if _, err := Verify(tok, other.Key.Public().(*ecdsa.PublicKey), now); err == nil {
		t.Fatal("异钥验签未失败")
	}
}

// 入库形态：hex(PKCS#8 DER)（bootstrap 脚本写入 signing_keys.private_enc）
func TestParsePrivateKeyHex(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParsePrivateKeyHex(hex.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.Equal(key) {
		t.Fatal("PKCS#8 往返不一致")
	}

	if _, err := ParsePrivateKeyHex("zz"); err == nil {
		t.Fatal("非法 hex 未报错")
	}
	if _, err := ParsePrivateKey([]byte("not-der")); err == nil {
		t.Fatal("非法 DER 未报错")
	}
}
