package settings

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"testing"
)

type rowsSource map[string]string

func (s rowsSource) AllSettings(context.Context) (map[string]string, error) { return s, nil }

func TestLoadIgnoresUnrelatedCorruptSecrets(t *testing.T) {
	snap, err := Load(context.Background(), rowsSource{
		"better_auth_secret": "broken-auth-secret", KeyOIDCClientSecret: "broken-oidc-secret",
		KeyDeliveryPreviewPwd: "broken-preview-secret", KeyS3Bucket: "media-bucket",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Values) != 1 || snap.Get(KeyS3Bucket) != "media-bucket" {
		t.Fatal("snapshot must only contain settings consumed by delivery")
	}
}

func TestLoadUnwrapsOnlyDeliverySecrets(t *testing.T) {
	key := bytes.Repeat([]byte{9}, 32)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{1}, gcm.NonceSize())
	wrapped := hex.EncodeToString(gcm.Seal(nonce, nonce, []byte("stored-s3-secret"), nil))
	snap, err := Load(context.Background(), rowsSource{KeyS3SecretAccessKey: wrapped}, map[int][]byte{1: key})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Get(KeyS3SecretAccessKey) != "stored-s3-secret" {
		t.Fatal("delivery S3 secret was not unwrapped")
	}
	if _, err := Load(context.Background(), rowsSource{KeyURLSignKeyHex: "broken"}, map[int][]byte{1: key}); err == nil {
		t.Fatal("corrupt delivery secret must fail the entire snapshot")
	}
}
