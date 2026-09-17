package contracts

type ErrorEnvelope struct {
	Error Error `json:"error"`
}

type Error struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

type Code string

const (
	BadToken           Code = "bad_token"
	Forbidden          Code = "forbidden"
	Internal           Code = "internal"
	InvalidCredentials Code = "invalid_credentials"
	NotFound           Code = "not_found"
	NotImplemented     Code = "not_implemented"
	NotPlayable        Code = "not_playable"
	RateLimited        Code = "rate_limited"
	SessionLimit       Code = "session_limit"
	Unauthorized       Code = "unauthorized"
)
