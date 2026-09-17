package contracts

type MediaSubtitleDTO struct {
	ID        string `json:"id"`
	IsDefault bool   `json:"is_default"`
	Label     string `json:"label"`
	Lang      string `json:"lang"`
}
