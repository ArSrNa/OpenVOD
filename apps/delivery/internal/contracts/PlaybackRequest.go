package contracts

type PlaybackRequest struct {
	ForceNew *bool `json:"force_new,omitempty"`
}
