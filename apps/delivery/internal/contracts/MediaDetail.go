package contracts

type MediaDetail struct {
	Custom     map[string]interface{} `json:"custom"`
	DurationMS *int64                 `json:"duration_ms"`
	ID         string                 `json:"id"`
	Playable   bool                   `json:"playable"`
	PosterURL  *string                `json:"poster_url"`
	Probe      *Probe                 `json:"probe"`
	Status     string                 `json:"status"`
	Subtitles  []Subtitle             `json:"subtitles"`
	Title      string                 `json:"title"`
}

type Probe struct {
	AudioCodec *string `json:"audio_codec"`
	BitrateBps *int64  `json:"bitrate_bps"`
	Height     *int64  `json:"height"`
	VideoCodec *string `json:"video_codec"`
	Width      *int64  `json:"width"`
}

type Subtitle struct {
	ID        string `json:"id"`
	IsDefault bool   `json:"is_default"`
	Label     string `json:"label"`
	Lang      string `json:"lang"`
}
