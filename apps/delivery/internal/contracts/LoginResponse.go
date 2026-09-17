package contracts

type LoginResponse struct {
	AccessToken string    `json:"access_token"`
	ExpiresIn   int64     `json:"expires_in"`
	Kid         string    `json:"kid"`
	TokenType   TokenType `json:"token_type"`
}

type TokenType string

const (
	Bearer TokenType = "Bearer"
)
