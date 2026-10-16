package contracts

type PlaybackTemplateDTO struct {
	ID        string  `json:"id"`
	IsDefault bool    `json:"is_default"`
	Name      *string `json:"name"`
}
