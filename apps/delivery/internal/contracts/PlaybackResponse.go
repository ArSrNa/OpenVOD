package contracts

type PlaybackResponse struct {
	ExpiresAt   string `json:"expires_at"`
	ManifestURL string `json:"manifest_url"`
	Sid         string `json:"sid"`
}
