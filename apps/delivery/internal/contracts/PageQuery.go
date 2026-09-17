package contracts

type PageQuery struct {
	Cursor *string `json:"cursor,omitempty"`
	Limit  *int64  `json:"limit,omitempty"`
}
