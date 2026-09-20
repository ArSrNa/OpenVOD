// Package mk MK（Master Key）解封：AES-256-GCM，与 packages/crypto 的 wrap 双端互通
// （向量：packages/crypto/fixtures/crypto-v1.json 的 wrap 段）。
// 封装格式（双端一致）：iv(12B) || ciphertext || tag(16B)；入库形态为整体 hex。
package mk

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"fmt"
	"sort"
)

const (
	ivLen  = 12
	tagLen = 16
)

// Unwrap 用 MK 解封；封装串损坏 / MK 不符时 GCM 认证失败报错（不返回半成品）
func Unwrap(masterKey, wrapped []byte) ([]byte, error) {
	if len(masterKey) != 32 {
		return nil, fmt.Errorf("MK 长度非法：%d（需 32B）", len(masterKey))
	}
	if len(wrapped) < ivLen+tagLen {
		return nil, fmt.Errorf("封装串长度非法：%d", len(wrapped))
	}
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("MK 非法: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("GCM 初始化失败: %w", err)
	}
	plain, err := gcm.Open(nil, wrapped[:ivLen], wrapped[ivLen:], nil)
	if err != nil {
		return nil, fmt.Errorf("解封失败（MK 不符或封装串损坏）: %w", err)
	}
	return plain, nil
}

// UnwrapHex 入库形态（hex）→ 明文
func UnwrapHex(masterKey []byte, wrappedHex string) ([]byte, error) {
	wrapped, err := hex.DecodeString(wrappedHex)
	if err != nil {
		return nil, fmt.Errorf("封装串非法 hex: %w", err)
	}
	return Unwrap(masterKey, wrapped)
}

// UnwrapAny 逐版本尝试解封（版本号大者优先）。
// 用于 signing_keys 这类无 mk_ver 列的材料（ADR-0004 的 SigningKey 没记录封装版本）；
// hls_keys 有 mk_ver，按行精确解封，不走这里。
func UnwrapAny(masterKeys map[int][]byte, wrapped []byte) ([]byte, int, error) {
	vers := make([]int, 0, len(masterKeys))
	for v := range masterKeys {
		vers = append(vers, v)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(vers)))
	for _, v := range vers {
		if plain, err := Unwrap(masterKeys[v], wrapped); err == nil {
			return plain, v, nil
		}
	}
	return nil, 0, fmt.Errorf("没有任何 MK 版本能解封该材料（轮换需保留旧版本）")
}
