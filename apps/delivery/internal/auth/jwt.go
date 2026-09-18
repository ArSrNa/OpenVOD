// Package auth 播放端 JWT（ES256 / P-256，ADR-0007）：
//   - 签发方是分发端（登录接口）；claims = iss/sub/iat/exp/jti/kid；
//   - 私钥以 MK 封装存 `signing_keys.private_enc`（格式：hex(MK(PKCS#8 DER))），child 版本化（kid）；
//   - ES256 签名必须是 JWS 规范的 raw R||S（各 32B），不是 ASN.1 DER。
package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"
)

type Signer struct {
	Kid    string
	Issuer string
	Key    *ecdsa.PrivateKey
}

type Claims struct {
	Iss string `json:"iss"`
	Sub string `json:"sub"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
	Jti string `json:"jti"`
	Kid string `json:"kid"`
}

// ParsePrivateKey 解析私钥明文（signing_keys.private_enc 经 MK 解封后的字节）：
//   - 32B：P-256 标量（v1 入库形态；bootstrap 脚本产出，VARCHAR(191) 放得下）
//   - 其它：按 PKCS#8 DER 解析（兼容外部工具生成的密钥）
func ParsePrivateKey(plain []byte) (*ecdsa.PrivateKey, error) {
	if len(plain) == 32 {
		// SEC1 raw 私钥（大端定长）；越界 / 为零直接报错
		key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), plain)
		if err != nil {
			return nil, fmt.Errorf("私钥标量非法: %w", err)
		}
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(plain)
	if err != nil {
		return nil, fmt.Errorf("私钥 PKCS#8 解析失败: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("私钥不是 EC 类型：%T", parsed)
	}
	if key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("私钥曲线必须为 P-256（ES256）")
	}
	return key, nil
}

// ParsePrivateKeyHex 入库形态：hex(PKCS#8 DER)
func ParsePrivateKeyHex(derHex string) (*ecdsa.PrivateKey, error) {
	der, err := hex.DecodeString(strings.TrimSpace(derHex))
	if err != nil {
		return nil, fmt.Errorf("私钥 hex 非法: %w", err)
	}
	return ParsePrivateKey(der)
}

// Sign 签发 ES256 JWT（compact JWS）
func (s *Signer) Sign(sub string, ttl time.Duration, now time.Time) (string, error) {
	header := map[string]any{"alg": "ES256", "typ": "JWT", "kid": s.Kid}
	claims := Claims{
		Iss: s.Issuer,
		Sub: sub,
		Iat: now.Unix(),
		Exp: now.Add(ttl).Unix(),
		Jti: randomID(16),
		Kid: s.Kid,
	}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signing := b64(hb) + "." + b64(cb)

	digest := sha256.Sum256([]byte(signing))
	r, sv, err := ecdsa.Sign(rand.Reader, s.Key, digest[:])
	if err != nil {
		return "", fmt.Errorf("ES256 签名失败: %w", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	sv.FillBytes(sig[32:])
	return signing + "." + b64(sig), nil
}

// Verify 验签（单测与未来跨服务验签用）：校验 alg 白名单 / 签名 / exp
func Verify(token string, pub *ecdsa.PublicKey, now time.Time) (Claims, error) {
	var zero Claims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return zero, fmt.Errorf("jwt: 段数非法")
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return zero, fmt.Errorf("jwt: header 解码失败")
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(hb, &header); err != nil || header.Alg != "ES256" {
		return zero, fmt.Errorf("jwt: alg 必须为 ES256")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return zero, fmt.Errorf("jwt: 签名格式非法")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	sv := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pub, digest[:], r, sv) {
		return zero, fmt.Errorf("jwt: 签名不匹配")
	}
	cb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return zero, fmt.Errorf("jwt: claims 解码失败")
	}
	var claims Claims
	if err := json.Unmarshal(cb, &claims); err != nil {
		return zero, fmt.Errorf("jwt: claims 非法")
	}
	if claims.Exp <= now.Unix() {
		return zero, fmt.Errorf("jwt: 已过期")
	}
	return claims, nil
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func randomID(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
