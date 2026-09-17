// Package token 分发端签名 token（ADR-0006 §4）
//   token  = b64url(JSON(payload)) + "." + b64url(HMAC-SHA256(key, payload))
//   payload = {ver, typ, mid, sid, exp, kid}（字段顺序即规范）
// 与 packages/crypto/src/token.ts 互通，向量见 packages/crypto/fixtures/crypto-v1.json。
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// typ：m 清单 / s 分片 / k 密钥 / v 字幕（与 @openvod/shared TOKEN_TYPES 一致）
const (
	TypeManifest = "m"
	TypeSegment  = "s"
	TypeKey      = "k"
	TypeSubtitle = "v"
)

const Version = 1

type Payload struct {
	Ver int    `json:"ver"`
	Typ string `json:"typ"`
	Mid string `json:"mid"`
	Sid string `json:"sid"`
	Exp int64  `json:"exp"`
	Kid string `json:"kid"`
}

type SigningKey struct {
	Kid string
	Key []byte
}

func Sign(p Payload, key []byte) (string, error) {
	p.Ver = Version
	payloadBytes, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	enc := base64.RawURLEncoding
	mac := hmacSHA256(payloadBytes, key)
	return enc.EncodeToString(payloadBytes) + "." + enc.EncodeToString(mac), nil
}

type VerifyOptions struct {
	Typ   string // 校验 typ（key 接口必须 typ=k）
	Mid   string // 校验媒资绑定，防跨媒资重放
	NowSec int64 // 缺省取当前时间
}

func Verify(token string, keys []SigningKey, opts VerifyOptions) (Payload, error) {
	var zero Payload
	enc := base64.RawURLEncoding
	dot := -1
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			dot = i
			break
		}
	}
	if dot <= 0 {
		return zero, fmt.Errorf("bad_token: 格式非法")
	}
	payloadBytes, err := enc.DecodeString(token[:dot])
	if err != nil {
		return zero, fmt.Errorf("bad_token: payload 解码失败")
	}
	sig, err := enc.DecodeString(token[dot+1:])
	if err != nil {
		return zero, fmt.Errorf("bad_token: 签名解码失败")
	}

	var p Payload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return zero, fmt.Errorf("bad_token: payload 非法")
	}

	var key []byte
	for _, k := range keys {
		if k.Kid == p.Kid {
			key = k.Key
			break
		}
	}
	if key == nil {
		return zero, fmt.Errorf("bad_token: 未知 kid=%s", p.Kid)
	}
	expect := hmacSHA256(payloadBytes, key)
	if len(sig) != len(expect) || subtle.ConstantTimeCompare(sig, expect) != 1 {
		return zero, fmt.Errorf("bad_token: 签名不匹配")
	}

	now := opts.NowSec
	if now == 0 {
		now = time.Now().Unix()
	}
	if p.Exp <= now {
		return zero, fmt.Errorf("bad_token: 已过期")
	}
	if opts.Typ != "" && p.Typ != opts.Typ {
		return zero, fmt.Errorf("bad_token: typ 应为 %s", opts.Typ)
	}
	if opts.Mid != "" && p.Mid != opts.Mid {
		return zero, fmt.Errorf("bad_token: 媒资绑定不匹配")
	}
	return p, nil
}

func hmacSHA256(payload, key []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(payload)
	return m.Sum(nil)
}
