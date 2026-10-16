package contracts

type PlaybackResponse struct {
	ExpiresAt   string             `json:"expires_at"`
	ManifestURL string             `json:"manifest_url"`
	Sid         string             `json:"sid"`
	Subtitles   []PlaybackSubtitle `json:"subtitles"`
	TemplateID  string             `json:"template_id"`
	Templates   []PlaybackTemplate `json:"templates"`
}

type PlaybackSubtitle struct {
	ID        string `json:"id"`
	IsDefault bool   `json:"is_default"`
	Label     string `json:"label"`
	Lang      string `json:"lang"`
	URL       string `json:"url"`
}

type PlaybackTemplate struct {
	ID        string  `json:"id"`
	IsDefault bool    `json:"is_default"`
	Name      *string `json:"name"`
}
