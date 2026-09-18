package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"openvod/apps/delivery/internal/contracts"
)

const maxBodyBytes = 64 << 10

/** decodeJSON 限制请求体体积并解析（容忍未知字段，便于契约向后兼容演进） */
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		if err == io.EOF {
			return fmt.Errorf("请求体为空")
		}
		return fmt.Errorf("请求体不是合法 JSON")
	}
	return nil
}

func parseInt(v string) (int, error) { return strconv.Atoi(v) }

func nullableInt(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

// ---- media.probe（ProbeSummary JSON）→ 契约 Probe 子集 ----

type probeVideoSummary struct {
	Codec  *string `json:"codec"`
	Width  *int64  `json:"width"`
	Height *int64  `json:"height"`
}

type probeAudioSummary struct {
	Codec *string `json:"codec"`
}

type probeSummaryJSON struct {
	Bitrate *int64              `json:"bitrate"`
	Video   *probeVideoSummary  `json:"video"`
	Audio   []probeAudioSummary `json:"audio"`
}

func parseProbe(raw sql.NullString) *contracts.Probe {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	var s probeSummaryJSON
	if err := json.Unmarshal([]byte(raw.String), &s); err != nil {
		return nil
	}
	p := &contracts.Probe{BitrateBps: s.Bitrate}
	if s.Video != nil {
		p.VideoCodec = s.Video.Codec
		p.Width = s.Video.Width
		p.Height = s.Video.Height
	}
	if len(s.Audio) > 0 {
		p.AudioCodec = s.Audio[0].Codec
	}
	return p
}

/** newSessionID 播放会话 ID（playback_sessions.id）；token 的 sid 即此值 */
func newSessionID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("ps_%d", time.Now().UnixNano())
	}
	return "ps_" + hex.EncodeToString(buf)
}

/** clientIP 已由 middleware.RealIP 归一 RemoteAddr */
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- 请求上下文携带已鉴权用户 ----

type ctxKey int

const userIDKey ctxKey = iota

func withUserID(ctx context.Context, uid string) context.Context {
	return context.WithValue(ctx, userIDKey, uid)
}

func userIDFrom(ctx context.Context) string {
	v, _ := ctx.Value(userIDKey).(string)
	return v
}
