package contracts

type PageResponse struct {
	Items      []Item  `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type Item struct {
	Custom     map[string]interface{} `json:"custom"`
	DurationMS *int64                 `json:"duration_ms"`
	ID         string                 `json:"id"`
	PosterURL  *string                `json:"poster_url"`
	Title      string                 `json:"title"`
}
