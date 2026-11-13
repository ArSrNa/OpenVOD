// Package server HTTP 路由（ADR-0010 API 面）
//
// 播放链路（ADR-0006 §3）：login(JWT) → play(建会话, 返回签名主清单 URL)
// → 主清单改写（子清单 URL 注入 typ=m token）→ 子清单改写（EXT-X-KEY URI 注入 typ=k token、
// 分片改写为 S3 预签名直出 URL，字节不经过分发端）→ 播放器凭 token 取密钥（16B CEK）本地解密。
//
// token 传递方式：URL query `?t=` 优先，其次 header `X-Playback-Token`
// （App / hls.js 可带头；Safari 原生 HLS 的密钥与分片请求无法带自定义头，因此 query 是必须形态）。
package server

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/crypto/bcrypt"

	"openvod/apps/delivery/internal/auth"
	"openvod/apps/delivery/internal/blob"
	"openvod/apps/delivery/internal/config"
	"openvod/apps/delivery/internal/contracts"
	"openvod/apps/delivery/internal/mk"
	"openvod/apps/delivery/internal/playback"
	"openvod/apps/delivery/internal/store"
	"openvod/apps/delivery/internal/token"
)

// templateIDPattern 模板 ID（cuid 形状；spec.md §1.3），用于从产物前缀里识别模板子树
var templateIDPattern = regexp.MustCompile(`^c[a-z0-9]{20,}$`)

// subtitleTrackIDPattern 字幕轨道 ID（spec.md §7.1：与模板 ID 同形），路由层白名单（防路径注入）
var subtitleTrackIDPattern = regexp.MustCompile(`^c[a-z0-9]{20,}$`)

// reservedSubtitles `proceed/{id}/subtitles/` 保留段，不是模板产物
const reservedSubtitles = "subtitles"

const defaultListLimit = 50

type Options struct {
	Cfg     *config.Config
	DB      *store.Store
	Blob    blob.Store
	Logger  *slog.Logger
	JWTKeys []*auth.Signer // 启动时从 signing_keys 解封加载（首把用于签发）
	Now     func() time.Time
}

type api struct {
	o         Options
	signer    *auth.Signer
	urlKeys   []token.SigningKey
	startedAt time.Time // GET /v1/meta 的 started_at / uptime_sec
}

// publicBase 使用当前 handler 的配置快照；app 每 60 秒整体刷新配置与存储，避免混用不同版本。
func (a *api) publicBase(_ context.Context) string { return a.o.Cfg.PublicBaseURL }

func New(o Options) http.Handler {
	if o.Now == nil {
		o.Now = time.Now
	}
	a := &api{
		o:         o,
		urlKeys:   []token.SigningKey{{Kid: o.Cfg.URLSignKeyKid, Key: o.Cfg.URLSignKey}},
		startedAt: o.Now(),
	}
	if len(o.JWTKeys) > 0 {
		a.signer = o.JWTKeys[0]
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	// P0 缓存纪律（ADR-0006 §5）：分发端**所有**响应一律不缓存。放在路由前统一兜底，
	// 而不是逐个 handler 设置——历史上清单 / key / 字幕 / meta 设了，login、media 列表 / 详情、
	// play 以及全部错误响应都漏了（无 Cache-Control 的 2xx 允许中间层按启发式规则缓存）。
	r.Use(noStoreResponses)
	r.Use(requestLogger(o.Logger))
	r.Use(corsMiddleware(o.Cfg.CORSOrigins))

	// 探活
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "app": "delivery"})
	})

	r.Route("/v1", func(r chi.Router) {
		// 运行信息（公开，无鉴权）：版本 / 提交 / 驱动 / 发布基址，运维排障用
		r.Get("/meta", a.handleMeta)

		// ---- 业务 API（JWT，ADR-0007/0010） ----
		r.Post("/auth/login", a.handleLogin)

		r.Group(func(r chi.Router) {
			r.Use(a.requireJWT)
			r.Get("/media", a.handleMediaList)
			r.Get("/media/{id}", a.handleMediaDetail)
			r.Post("/media/{id}/play", a.handlePlay)
		})

		// ---- 播放链路（会话 + 签名 token，ADR-0006） ----
		r.Get("/media/{id}/manifest/master.m3u8", a.handleManifestMaster)
		// 子清单：`{variant}/index.m3u8` 可能含子目录（如 720p/index.m3u8），故用通配
		r.Get("/media/{id}/manifest/*", a.handleManifestVariant)
		r.Get("/media/{id}/key", a.handleKey)
		// 字幕 VTT（token(v)；spec.md §7.5）：未带 / 非法 / 已吊销 token 一律 403（P0 门禁）
		r.Get("/media/{id}/subtitles/{trackId}.vtt", a.handleSubtitle)

		// 兜底
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, contracts.NotFound, "路由不存在")
		})
	})

	return r
}

// ---- 登录（ADR-0007：分发端签发 ES256 JWT） ----

func (a *api) handleLogin(w http.ResponseWriter, r *http.Request) {
	if a.signer == nil {
		writeError(w, http.StatusServiceUnavailable, contracts.Internal,
			"未配置 JWT 签名密钥（signing_keys 缺少 ACTIVE 的 JWT 行，见 scripts/bootstrap-playback）")
		return
	}
	var req contracts.LoginRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, contracts.BadRequest, err.Error())
		return
	}
	// specification：登录限频（ADR-0010「按 IP + 用户维度简单限频」）待补
	now := a.o.Now()
	user, err := a.o.DB.UserByUsername(r.Context(), req.Username)
	if err != nil || user.Status != "ACTIVE" ||
		bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		// 用户不存在 / 密码错误 / 被禁用统一提示（不泄露账号状态）
		writeError(w, http.StatusUnauthorized, contracts.InvalidCredentials, "用户名或密码错误")
		return
	}
	ttl := time.Duration(a.o.Cfg.JWTTTLSec) * time.Second
	accessToken, err := a.signer.Sign(user.ID, ttl, now)
	if err != nil {
		a.o.Logger.Error("签发 JWT 失败", "err", err)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "签发凭证失败")
		return
	}
	if err := a.o.DB.TouchLastLogin(r.Context(), user.ID, now); err != nil {
		a.o.Logger.Warn("更新 last_login_at 失败", "err", err, "user_id", user.ID)
	}
	writeJSON(w, http.StatusOK, contracts.LoginResponse{
		AccessToken: accessToken,
		TokenType:   contracts.Bearer,
		ExpiresIn:   int64(a.o.Cfg.JWTTTLSec),
		Kid:         a.signer.Kid,
	})
}

// ---- 媒资（JWT） ----

func (a *api) handleMediaList(w http.ResponseWriter, r *http.Request) {
	limit := defaultListLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := parseInt(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	rows, err := a.o.DB.ListReady(r.Context(), limit)
	if err != nil {
		a.o.Logger.Error("查询媒资列表失败", "err", err)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询媒资失败")
		return
	}
	items := make([]contracts.Item, 0, len(rows))
	for i := range rows {
		items = append(items, a.mediaListItem(r.Context(), &rows[i]))
	}
	writeJSON(w, http.StatusOK, contracts.PageResponse{Items: items, NextCursor: nil})
}

func (a *api) handleMediaDetail(w http.ResponseWriter, r *http.Request) {
	mediaID := chi.URLParam(r, "id")
	media, err := a.o.DB.MediaByID(r.Context(), mediaID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, contracts.NotFound, "媒资不存在")
		return
	}
	if err != nil {
		a.o.Logger.Error("查询媒资失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询媒资失败")
		return
	}
	subs, err := a.o.DB.ReadySubtitles(r.Context(), mediaID)
	if err != nil {
		a.o.Logger.Warn("查询字幕失败", "err", err, "media_id", mediaID)
	}
	detail := contracts.MediaDetail{
		ID:         media.ID,
		Title:      media.Title,
		Status:     media.Status,
		Playable:   media.Status == "READY",
		DurationMS: nullableInt(media.DurationMs),
		Probe:      parseProbe(media.Probe),
		Subtitles:  make([]contracts.Subtitle, 0, len(subs)),
		// 自定义元数据按**公开白名单**输出（category / description / tags，spec.md §8.4）
		Custom:    parseCustomMetadata(media.CustomData),
		PosterURL: a.posterURL(r.Context(), media.PosterKey.String),
	}
	for _, s := range subs {
		detail.Subtitles = append(detail.Subtitles, contracts.Subtitle{
			ID: s.ID, Lang: s.Lang, Label: s.Label, IsDefault: s.IsDefault,
		})
	}
	writeJSON(w, http.StatusOK, detail)
}

func (a *api) mediaListItem(ctx context.Context, m *store.Media) contracts.Item {
	return contracts.Item{
		ID:         m.ID,
		Title:      m.Title,
		DurationMS: nullableInt(m.DurationMs),
		PosterURL:  a.posterURL(ctx, m.PosterKey.String),
		// 自定义元数据按公开白名单输出（与详情一致，spec.md §8.4）
		Custom: parseCustomMetadata(m.CustomData),
	}
}

/** posterURL：S3 预签名直出（可经 STORAGE_CDN_BASE_URL 换加速域名） */
func (a *api) posterURL(ctx context.Context, posterKey string) *string {
	if posterKey == "" {
		return nil
	}
	u, err := a.o.Blob.PresignGet(ctx, posterKey, time.Duration(a.o.Cfg.ManifestTTLSec)*time.Second)
	if err != nil {
		return nil
	}
	return &u
}

// ---- play（建会话 + 返回签名主清单 URL） ----

func (a *api) handlePlay(w http.ResponseWriter, r *http.Request) {
	uid := userIDFrom(r.Context())
	mediaID := chi.URLParam(r, "id")
	ctx := r.Context()

	var req contracts.PlaybackRequest
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, contracts.BadRequest, err.Error())
			return
		}
	}

	media, err := a.o.DB.MediaByID(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, contracts.NotFound, "媒资不存在")
		return
	}
	if err != nil {
		a.o.Logger.Error("查询媒资失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询媒资失败")
		return
	}
	if media.Status != "READY" {
		writeError(w, http.StatusConflict, contracts.NotPlayable, "媒资尚未就绪（转码中或失败）")
		return
	}

	requestedTpl := ""
	explicitTpl := req.TemplateID != nil
	if explicitTpl {
		requestedTpl = *req.TemplateID // 显式指定；空串 = 显式请求旧布局产物（无模板段）
	}
	resolution, err := a.resolveTemplate(ctx, mediaID, requestedTpl, explicitTpl)
	if err != nil {
		var npe *notPlayableError
		if errors.As(err, &npe) {
			writeError(w, http.StatusConflict, contracts.NotPlayable, npe.Error())
			return
		}
		a.o.Logger.Error("产物探测失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "产物探测失败")
		return
	}
	tpl := resolution.selected
	templates := resolution.items
	if templates == nil {
		templates = []contracts.PlaybackTemplate{} // 旧布局：恒为空数组，不外泄 null（契约约定）
	}

	now := a.o.Now()
	forceNew := req.ForceNew != nil && *req.ForceNew
	var sid string
	var expiresAt time.Time
	if !forceNew {
		if existing, err := a.o.DB.ActiveSession(ctx, uid, mediaID, now); err == nil {
			sid, expiresAt = existing.ID, existing.ExpiresAt.Time // play 幂等：复用未过期会话（ADR-0010）
		} else if !errors.Is(err, store.ErrNotFound) {
			a.o.Logger.Error("查询播放会话失败", "err", err)
			writeError(w, http.StatusInternalServerError, contracts.Internal, "查询播放会话失败")
			return
		}
	}
	if sid == "" {
		if user, err := a.o.DB.UserByID(ctx, uid); err == nil && user.MaxConcurrentSessions > 0 {
			n, err := a.o.DB.CountActiveSessions(ctx, uid, now)
			if err != nil {
				a.o.Logger.Error("统计播放会话失败", "err", err)
				writeError(w, http.StatusInternalServerError, contracts.Internal, "统计播放会话失败")
				return
			}
			if n >= user.MaxConcurrentSessions {
				writeError(w, http.StatusConflict, contracts.SessionLimit,
					fmt.Sprintf("并发播放会话已达上限（%d）", user.MaxConcurrentSessions))
				return
			}
		}
		sid = newSessionID()
		expiresAt = now.Add(time.Duration(a.o.Cfg.SessionTTLSec) * time.Second)
		if err := a.o.DB.CreateSession(ctx, sid, uid, mediaID, clientIP(r), r.UserAgent(), expiresAt, now); err != nil {
			a.o.Logger.Error("创建播放会话失败", "err", err)
			writeError(w, http.StatusInternalServerError, contracts.Internal, "创建播放会话失败")
			return
		}
	}

	// token exp ≤ 会话 exp（ADR-0006 §6：吊销 ≤60s 收敛，已下发分片在 token exp 内仍可播）
	exp := expiresAt
	if limit := now.Add(time.Duration(a.o.Cfg.ManifestTTLSec) * time.Second); exp.After(limit) {
		exp = limit
	}
	tok, err := a.signToken(token.TypeManifest, mediaID, sid, exp)
	if err != nil {
		a.o.Logger.Error("签发清单 token 失败", "err", err)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "签发播放凭证失败")
		return
	}
	manifestURL := fmt.Sprintf("%s/v1/media/%s/manifest/master.m3u8?t=%s&tpl=%s",
		a.publicBase(ctx), url.PathEscape(mediaID), url.QueryEscape(tok), url.QueryEscape(tpl))

	subtitles, err := a.signSubtitleURLs(ctx, mediaID, now)
	if err != nil {
		a.o.Logger.Error("签发字幕凭证失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "签发播放凭证失败")
		return
	}

	writeJSON(w, http.StatusOK, contracts.PlaybackResponse{
		Sid:         sid,
		ManifestURL: manifestURL,
		ExpiresAt:   expiresAt.UTC().Format(time.RFC3339),
		TemplateID:  tpl,
		Subtitles:   subtitles,
		Templates:   templates,
	})
}

/**
 * playbackTemplates 构造 play 响应 templates[]（spec.md §11.1）：
 * 候选 = resolveTemplate 举出的存储实际模板子树（「有什么放什么」），名称 / 默认标记批量查
 * transcode_templates；查询失败**不致命**——全部降级 name=null（播放链路不因模板表查询失败中断，
 * 同 §8.4 容错口径）。
 */
func (a *api) playbackTemplates(ctx context.Context, candidates []string) []contracts.PlaybackTemplate {
	if len(candidates) == 0 {
		return []contracts.PlaybackTemplate{} // 旧布局 / 无产物：恒为空数组
	}
	rows, err := a.o.DB.TemplateRefs(ctx, candidates)
	if err != nil {
		a.o.Logger.Warn("查询转码模板失败，templates[].name 降级为 null", "err", err)
		return buildPlaybackTemplates(candidates, nil, false)
	}
	refs := make(map[string]store.TemplateRef, len(rows))
	for _, r := range rows {
		refs[r.ID] = r
	}
	return buildPlaybackTemplates(candidates, refs, true)
}

/**
 * buildPlaybackTemplates 由候选列表 + 模板行（id -> TemplateRef）构造响应数组（纯函数，便于单测）：
 *   - lookupOK=false（查表失败）或行缺失（模板已删的历史产物）→ name=null、is_default=false；
 *   - 排序：默认模板优先；其余按 name（null 排最后）再按 id 字典序，保证稳定输出。
 */
func buildPlaybackTemplates(candidates []string, refs map[string]store.TemplateRef, lookupOK bool) []contracts.PlaybackTemplate {
	out := make([]contracts.PlaybackTemplate, 0, len(candidates))
	for _, id := range candidates {
		ref, found := refs[id]
		if !lookupOK || !found {
			out = append(out, contracts.PlaybackTemplate{ID: id})
			continue
		}
		name := ref.Name
		out = append(out, contracts.PlaybackTemplate{ID: id, Name: &name, IsDefault: ref.IsDefault})
	}
	slices.SortStableFunc(out, func(x, y contracts.PlaybackTemplate) int {
		if x.IsDefault != y.IsDefault { // 默认模板优先
			if x.IsDefault {
				return -1
			}
			return 1
		}
		xNil, yNil := x.Name == nil, y.Name == nil
		if xNil != yNil { // name 为 null 排最后
			if xNil {
				return 1
			}
			return -1
		}
		if !xNil {
			if c := strings.Compare(*x.Name, *y.Name); c != 0 {
				return c
			}
		}
		return strings.Compare(x.ID, y.ID)
	})
	return out
}

/**
 * signSubtitleURLs 随 play 下发字幕轨道与签名 URL（spec.md §7.5）。
 *
 * 共享 token 形态（ADR-0009 2026-11-13 修订）：token 不绑会话（sid 省略），
 * exp 取 PLAYBACK_SUBTITLE_TTL_SEC 的**窗口对齐**值（当前窗口末端，见 subtitleSharedExp）——
 * 同一窗口内任意一次 play 产出**逐字相同**的 URL（跨会话 / 跨用户一致），CDN 缓存键因此稳定；
 * URL 携带字幕内容版本 `?v=`（覆盖文本时 +1），版本变 = URL 变 → 缓存键隔离。
 * 会话吊销不再即时收回字幕 URL，收敛依赖版本推进 + TTL 窗口：字幕是低敏公开文本，
 * 分片 / 密钥仍逐会话签发（P0 纪律不动）。
 * 查询失败不致命：返回空列表（字幕是附加能力，不应让播放失败）。
 */
func (a *api) signSubtitleURLs(ctx context.Context, mediaID string, now time.Time) ([]contracts.PlaybackSubtitle, error) {
	rows, err := a.o.DB.ReadySubtitles(ctx, mediaID)
	if err != nil {
		a.o.Logger.Warn("查询字幕轨道失败", "err", err, "media_id", mediaID)
		return []contracts.PlaybackSubtitle{}, nil
	}
	out := make([]contracts.PlaybackSubtitle, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	exp := subtitleSharedExp(now, a.o.Cfg.SubtitleTTLSec)
	tok, err := a.signToken(token.TypeSubtitle, mediaID, "", exp)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		out = append(out, contracts.PlaybackSubtitle{
			ID:        rows[i].ID,
			Lang:      rows[i].Lang,
			Label:     rows[i].Label,
			IsDefault: rows[i].IsDefault,
			URL: fmt.Sprintf("%s/v1/media/%s/subtitles/%s.vtt?v=%d&t=%s",
				a.publicBase(ctx), url.PathEscape(mediaID),
				url.PathEscape(rows[i].ID), rows[i].ContentVersion, url.QueryEscape(tok)),
		})
	}
	return out, nil
}

/**
 * subtitleSharedExp 共享字幕 token 的窗口对齐 exp（纯函数，便于单测；ADR-0009 2026-11-13 修订）：
 *   exp = now 向下对齐到 TTL 窗口起点 + 一个窗口（= 当前窗口末端）
 * 恒有 exp > now（不会签出已过期 token）；同一窗口内任意时刻签发的 exp 逐字相同，
 * token 与 URL 因此跨会话稳定 —— 这是 CDN 缓存命中的前提（形态同 ADR-0005 TypeA 的
 * 缓存友好窗口对齐 / ADR-0019 url-sign 的 window_alignment）。
 */
func subtitleSharedExp(now time.Time, ttlSec int) time.Time {
	if ttlSec <= 0 {
		ttlSec = 1
	}
	window := time.Duration(ttlSec) * time.Second
	return now.Truncate(window).Add(window)
}

/**
 * subtitleCacheControl 字幕响应的缓存策略（纯函数，便于单测；ADR-0009 2026-11-13 修订）：
 *   - 共享 token（URL 跨会话稳定）→ `public, max-age=<N>`（可进 CDN / 浏览器缓存）；
 *   - 会话 token（URL 含逐会话 sid）→ `no-store`（缓存无意义且扩大暴露面）；
 *   - maxAgeSec <= 0 = 显式关闭缓存（回退 no-store）。
 * 错误响应不经过本函数，恒由 noStoreResponses 兜底 no-store。
 */
func subtitleCacheControl(shared bool, maxAgeSec int) string {
	if !shared || maxAgeSec <= 0 {
		return "no-store"
	}
	return fmt.Sprintf("public, max-age=%d", maxAgeSec)
}

/**
 * templateResolution 模板产物解析结果（spec.md §6.3 / §11.1）：
 * 选择（selected）与响应 templates[]（items）共用同一次模板表查询，且保证
 * 「未指定时自动播放的那套 = 客户端列表里的第一项」。
 */
type templateResolution struct {
	selected   string                       // 选中模板 id（"" = 旧布局产物，无模板段）
	candidates []string                     // 存储实际存在的模板子树（供响应 / 排障）
	items      []contracts.PlaybackTemplate // 排序后的 templates[]（旧布局为空数组）
}

/**
 * resolveTemplate 选择播放哪套模板产物（`proceed/{id}/{templateId}/`）：
 *   - 显式指定 → 必须存在（否则 not_playable，消息里列出可选值）
 *   - 唯一产物 → 直接使用
 *   - 多套产物 → 默认模板（transcode_templates.is_default）优先；无默认模板 → **自动选
 *     templates[] 的第一个**（2026-10-13 修订：原先 409 会把选择成本推给每个客户端，
 *     播放端呈现为清晰度切换而不是报错；客户端可用同一响应 `templates[]` 随时切换）
 *   - 无模板子树 → 旧布局（M2 之前的 `proceed/{id}/{variant}/`），模板段为空
 * 候选 = 存储实际存在的模板子树。模板表不可用时退化为列举顺序第一个（可用性优先，不阻断播放）。
 */
func (a *api) resolveTemplate(ctx context.Context, mediaID, requested string, explicit bool) (templateResolution, error) {
	prefixes, err := a.o.Blob.ListPrefixes(ctx, proceedKey(mediaID, "", ""))
	if err != nil {
		return templateResolution{}, err
	}
	candidates := filterTemplateCandidates(prefixes)
	if explicit {
		if requested == "" {
			// 显式请求旧布局产物（直接挂在 proceed/{id}/ 下，无模板段）
			if _, err := a.o.Blob.Get(ctx, proceedKey(mediaID, "", "master.m3u8")); err != nil {
				return templateResolution{}, &notPlayableError{"该媒资没有旧布局产物"}
			}
			return templateResolution{items: a.playbackTemplates(ctx, candidates)}, nil
		}
		if !slices.Contains(candidates, requested) {
			return templateResolution{}, &notPlayableError{fmt.Sprintf("指定的模板产物不存在（可选：%s）", strings.Join(candidates, ", "))}
		}
		return templateResolution{selected: requested, candidates: candidates, items: a.playbackTemplates(ctx, candidates)}, nil
	}
	if len(candidates) == 0 {
		if _, err := a.o.Blob.Get(ctx, proceedKey(mediaID, "", "master.m3u8")); err != nil {
			return templateResolution{}, &notPlayableError{"该媒资没有可播放的转码产物"}
		}
		return templateResolution{}, nil // 旧布局：产物直接挂在 proceed/{id}/ 下
	}
	items := a.playbackTemplates(ctx, candidates)
	if len(candidates) == 1 {
		return templateResolution{selected: candidates[0], candidates: candidates, items: items}, nil
	}
	if def, err := a.o.DB.DefaultTemplateID(ctx); err == nil && slices.Contains(candidates, def) {
		return templateResolution{selected: def, candidates: candidates, items: items}, nil
	}
	if auto := selectAutoTemplate(items); auto != "" {
		return templateResolution{selected: auto, candidates: candidates, items: items}, nil
	}
	// templates[] 为空只可能来自候选列举异常：退化为列举顺序第一个，播放优先
	return templateResolution{selected: candidates[0], candidates: candidates}, nil
}

/**
 * selectAutoTemplate 未指定模板且无默认模板时的自动选择（纯函数，便于单测）：
 * 取排序后 templates[] 的第一个——排序已保证「默认模板优先 → name（null 最后）→ id」，
 * 因此选中项与客户端看到的首项一致（spec.md §11.1）。
 */
func selectAutoTemplate(items []contracts.PlaybackTemplate) string {
	if len(items) == 0 {
		return ""
	}
	return items[0].ID
}

/**
 * filterTemplateCandidates 从 `proceed/{id}/` 下的一级前缀中筛出模板子树候选（纯函数，便于单测）：
 * 排除 `subtitles` 保留段，只认 cuid 形状（脏目录不参与选择与切换，spec.md §11.1）。
 */
func filterTemplateCandidates(prefixes []string) []string {
	candidates := make([]string, 0, len(prefixes))
	for _, p := range prefixes {
		if p != reservedSubtitles && templateIDPattern.MatchString(p) {
			candidates = append(candidates, p)
		}
	}
	return candidates
}

// ---- 主清单改写 ----

func (a *api) handleManifestMaster(w http.ResponseWriter, r *http.Request) {
	mediaID := chi.URLParam(r, "id")
	p, ok := a.authorize(w, r, token.TypeManifest, mediaID)
	if !ok {
		return
	}
	tpl, ok := a.templateParam(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	text, err := a.o.Blob.Get(ctx, proceedKey(mediaID, tpl, "master.m3u8"))
	if err != nil {
		writeError(w, http.StatusNotFound, contracts.NotFound, "主清单不存在（产物可能已被清理）")
		return
	}

	var signErr error
	rw := playback.Rewriter{
		Variant: func(name string) string {
			tok, err := a.signToken(token.TypeManifest, mediaID, p.Sid, time.Unix(p.Exp, 0))
			if err != nil {
				signErr = err
				return name
			}
			return fmt.Sprintf("%s/v1/media/%s/manifest/%s?t=%s&tpl=%s",
				a.publicBase(ctx), url.PathEscape(mediaID), path.Clean(name), url.QueryEscape(tok), url.QueryEscape(tpl))
		},
	}
	out := rw.RewriteMaster(string(text))
	if signErr != nil {
		a.o.Logger.Error("签发子清单 token 失败", "err", signErr)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "签发播放凭证失败")
		return
	}
	writePlaylist(w, out)
}

// ---- 子清单改写（EXT-X-KEY / 分片） ----

func (a *api) handleManifestVariant(w http.ResponseWriter, r *http.Request) {
	mediaID := chi.URLParam(r, "id")
	rest := chi.URLParam(r, "*")
	if !validRelativeMediaPath(rest) || !strings.HasSuffix(rest, ".m3u8") {
		writeError(w, http.StatusNotFound, contracts.NotFound, "子清单不存在")
		return
	}
	p, ok := a.authorize(w, r, token.TypeManifest, mediaID)
	if !ok {
		return
	}
	tpl, ok := a.templateParam(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	text, err := a.o.Blob.Get(ctx, proceedKey(mediaID, tpl, rest))
	if err != nil {
		writeError(w, http.StatusNotFound, contracts.NotFound, "子清单不存在（产物可能已被清理）")
		return
	}

	exp := time.Unix(p.Exp, 0)
	keyTok, err := a.signToken(token.TypeKey, mediaID, p.Sid, exp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, contracts.Internal, "签发播放凭证失败")
		return
	}
	variantDir := path.Dir(rest)

	var segErr error
	rw := playback.Rewriter{
		KeyURL: fmt.Sprintf("%s/v1/media/%s/key?t=%s",
			a.publicBase(ctx), url.PathEscape(mediaID), url.QueryEscape(keyTok)),
		Segment: func(name string) (string, error) {
			if segErr != nil {
				return "", segErr
			}
			if !validRelativeMediaPath(name) {
				segErr = fmt.Errorf("非法分片路径 %q", name)
				return "", segErr
			}
			// 分片服务（ADR-0005）：S3 预签名直出（字节不经过分发端，P0；
			// 可经 STORAGE_CDN_BASE_URL 换加速域名）
			storageKey := proceedKey(mediaID, tpl, path.Join(variantDir, name))
			u, err := a.o.Blob.PresignGet(ctx, storageKey, time.Duration(a.o.Cfg.ManifestTTLSec)*time.Second)
			if err != nil {
				segErr = err
				return "", err
			}
			return u, nil
		},
	}
	out, err := rw.RewriteVariant(string(text))
	if err != nil {
		a.o.Logger.Error("改写子清单失败", "err", err, "media_id", mediaID, "variant", rest)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "改写清单失败")
		return
	}
	writePlaylist(w, out)
}

// ---- 密钥接口（token(k) → 16B CEK，no-store；ADR-0006 §3） ----

func (a *api) handleKey(w http.ResponseWriter, r *http.Request) {
	mediaID := chi.URLParam(r, "id")
	p, ok := a.authorize(w, r, token.TypeKey, mediaID)
	if !ok {
		return
	}
	_ = p
	row, err := a.o.DB.HlsKeyByMedia(r.Context(), mediaID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, contracts.NotFound, "该媒资没有密钥（未加密或产物未就绪）")
		return
	}
	if err != nil {
		a.o.Logger.Error("查询密钥失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询密钥失败")
		return
	}
	masterKey, ok2 := a.o.Cfg.MasterKeys[row.MkVer]
	if !ok2 {
		a.o.Logger.Error("MASTER_KEYS 缺少封装版本", "mk_ver", row.MkVer, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal,
			fmt.Sprintf("MASTER_KEYS 缺少版本 v%d（轮换需保留旧版本）", row.MkVer))
		return
	}
	cek, err := mk.UnwrapHex(masterKey, row.WrappedCek)
	if err != nil {
		// 绝不把密钥材料写进日志 / 响应
		a.o.Logger.Error("解封 CEK 失败", "err", err, "media_id", mediaID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "密钥不可用")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(cek)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(cek)
}

// ---- 字幕（token(v)；spec.md §7.5 / ADR-0009） ----

/**
 * handleSubtitle 输出某条字幕轨道的 WebVTT 文本。
 *
 * 校验顺序（顺序即安全边界）：
 *   1. trackId 形状白名单（路由层，防路径注入）→ 不符 404；
 *   2. token(v) + mid 绑定；共享 token（sid 省略）到此为止，会话 token 再查会话未吊销未过期
 *      → 未带 / 非法 / 已吊销 403（P0 门禁 assert-unsigned-403）；
 *   3. DB 轨道（id + media_id + status=READY）→ 不存在 404；
 *   4. 内容版本校验：URL `?v=` 必须等于当前 content_version（共享 token 强制携带，
 *      会话 token 携带时校验）→ 不符 403（版本过期的旧 URL 立即失效，spec.md §7.5）；
 *   5. 按行内 storage_key 读对象（不按 URL 拼键，键可迁移）→ 缺失 404。
 *
 * 输出：两种驱动都由分发端代理输出。s3 若改走预签名 302，对象响应头（Cache-Control）
 * 与跨域策略都不受分发端控制。字幕 ≤5 MiB（管理端上限），低于 P0 的 6MB 响应体约束。
 * 缓存策略见 subtitleCacheControl：共享 token 可缓存（max-age，ADR-0009 2026-11-13 修订），
 * 会话 token 沿用 no-store；覆盖文本后旧 ?v= URL 在缓存 TTL 内可能返回旧文本
 * （上限 = max-age，默认 600s）——需要立即生效以新 URL 重签（play / refresh）。
 */
func (a *api) handleSubtitle(w http.ResponseWriter, r *http.Request) {
	mediaID := chi.URLParam(r, "id")
	trackID := chi.URLParam(r, "trackId")
	if !subtitleTrackIDPattern.MatchString(trackID) {
		writeError(w, http.StatusNotFound, contracts.NotFound, "字幕轨道不存在")
		return
	}
	p, ok := a.authorize(w, r, token.TypeSubtitle, mediaID)
	if !ok {
		return
	}
	ctx := r.Context()
	row, err := a.o.DB.SubtitleByTrackID(ctx, mediaID, trackID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, contracts.NotFound, "字幕轨道不存在（未就绪或已删除）")
		return
	}
	if err != nil {
		a.o.Logger.Error("查询字幕轨道失败", "err", err, "media_id", mediaID, "track_id", trackID)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询字幕失败")
		return
	}
	// 内容版本校验（ADR-0009 2026-11-13 修订）：共享 URL 的缓存键含 ?v=，
	// 版本不符 → 旧地址立即 403，播放端经重签（play / refresh）拿到新版本地址
	if vRaw := r.URL.Query().Get("v"); vRaw == "" && p.Sid == "" {
		writeError(w, http.StatusForbidden, contracts.BadToken, "共享 token 必须携带字幕内容版本参数 v")
		return
	} else if vRaw != "" {
		if v, err := strconv.Atoi(vRaw); err != nil || v != row.ContentVersion {
			writeError(w, http.StatusForbidden, contracts.BadToken, "字幕内容版本已更新，请重新播放获取新地址")
			return
		}
	}
	body, err := a.o.Blob.Get(ctx, row.StorageKey)
	if err != nil {
		writeError(w, http.StatusNotFound, contracts.NotFound, "字幕文件不存在（可能已被清理）")
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	// 共享 token 的 URL 跨会话稳定 → 可缓存；会话 token 沿用 no-store（ADR-0006 §5 原纪律）
	w.Header().Set("Cache-Control", subtitleCacheControl(p.Sid == "", a.o.Cfg.SubtitleCacheMaxAgeSec))
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// ---- 鉴权 / 校验辅助 ----

/**
 * authorize 校验播放 token 与会话：
 *   - token：query `t` 优先，其次 header X-Playback-Token（用户诉求；Safari 原生只能走 query）
 *   - typ / mid 绑定（防跨媒资与跨用途重放，ADR-0006 §4）
 *   - 会话：未撤销且未过期（≤60s 收敛；v1 每请求查库）——仅对绑 sid 的 token；
 *     共享 token（sid 省略）不查会话，且仅限 typ=v 字幕（ADR-0009 2026-11-13 修订）
 */
func (a *api) authorize(w http.ResponseWriter, r *http.Request, typ, mediaID string) (token.Payload, bool) {
	raw := r.URL.Query().Get("t")
	if raw == "" {
		raw = strings.TrimSpace(r.Header.Get("X-Playback-Token"))
	}
	if raw == "" {
		writeError(w, http.StatusForbidden, contracts.BadToken, "缺少播放 token（query t 或 header X-Playback-Token）")
		return token.Payload{}, false
	}
	p, err := token.Verify(raw, a.urlKeys, token.VerifyOptions{Typ: typ, Mid: mediaID})
	if err != nil {
		writeError(w, http.StatusForbidden, contracts.BadToken, err.Error())
		return token.Payload{}, false
	}
	// 共享 token（sid 省略，ADR-0009 2026-11-13 修订）：不绑会话，验签即信任（typ+mid+exp），
	// 仅限 typ=v 字幕 —— URL 跨会话稳定是 CDN 缓存的前提，吊销收敛于版本推进 + TTL 窗口。
	if p.Sid == "" {
		if typ != token.TypeSubtitle {
			writeError(w, http.StatusForbidden, contracts.BadToken, "共享 token 仅限字幕资源")
			return token.Payload{}, false
		}
		return p, true
	}
	alive, err := a.o.DB.SessionAlive(r.Context(), p.Sid, mediaID, a.o.Now())
	if err != nil {
		a.o.Logger.Error("查询播放会话失败", "err", err)
		writeError(w, http.StatusInternalServerError, contracts.Internal, "查询播放会话失败")
		return token.Payload{}, false
	}
	if !alive {
		writeError(w, http.StatusForbidden, contracts.BadToken, "播放会话已过期或被吊销")
		return token.Payload{}, false
	}
	return p, true
}

/** templateParam `tpl` 参数：空 = 旧布局；非空必须是 cuid 形状（模板 ID），防止路径注入 */
func (a *api) templateParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	tpl := r.URL.Query().Get("tpl")
	if tpl != "" && !templateIDPattern.MatchString(tpl) {
		writeError(w, http.StatusBadRequest, contracts.BadRequest, "tpl 非法（模板 ID 形状不符）")
		return "", false
	}
	return tpl, true
}

func (a *api) requireJWT(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, err := a.bearerUser(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, contracts.Unauthorized, "未登录或凭证无效")
			return
		}
		next.ServeHTTP(w, r.WithContext(withUserID(r.Context(), uid)))
	})
}

func (a *api) bearerUser(r *http.Request) (string, error) {
	if a.signer == nil {
		return "", errors.New("签名密钥未配置")
	}
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", errors.New("缺少 Bearer 凭证")
	}
	pub, ok := a.signer.Key.Public().(*ecdsa.PublicKey)
	if !ok {
		return "", errors.New("签名密钥类型异常")
	}
	claims, err := auth.Verify(strings.TrimSpace(header[len(prefix):]), pub, a.o.Now())
	if err != nil {
		return "", err
	}
	return claims.Sub, nil
}

func (a *api) signToken(typ, mid, sid string, exp time.Time) (string, error) {
	return token.Sign(token.Payload{
		Typ: typ, Mid: mid, Sid: sid, Exp: exp.Unix(), Kid: a.o.Cfg.URLSignKeyKid,
	}, a.o.Cfg.URLSignKey)
}

// ---- 键 / 路径 ----

/** proceedKey 存储键：proceed/{id}/{tpl}/{rest}；tpl 为空 = 旧布局（proceed/{id}/{rest}） */
func proceedKey(mediaID, tpl, rest string) string {
	parts := []string{"proceed", mediaID}
	if tpl != "" {
		parts = append(parts, tpl)
	}
	if rest != "" {
		parts = append(parts, strings.TrimLeft(rest, "/"))
	}
	return strings.Join(parts, "/")
}

var relativeMediaPathPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

/** validRelativeMediaPath 相对媒体路径白名单校验（防路径穿越 / 绝对 URL 注入） */
func validRelativeMediaPath(p string) bool {
	if p == "" || strings.Contains(p, "..") || strings.HasPrefix(p, "/") {
		return false
	}
	return relativeMediaPathPattern.MatchString(p)
}

type notPlayableError struct{ msg string }

func (e *notPlayableError) Error() string { return e.msg }

// ---- 响应封装（ADR-0010 envelope） ----

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code contracts.Code, message string) {
	writeJSON(w, status, contracts.ErrorEnvelope{Error: contracts.Error{Code: code, Message: message}})
}

/**
 * noStoreResponses P0 缓存纪律（ADR-0006 §5）的**唯一兜底**：进入路由前就给响应头写好
 * `Cache-Control: no-store`，因此成功 / 错误 / 404 / 探活 / CORS 预检全部覆盖。
 * 个别 handler 仍保留显式设置（清单 / key / 字幕 / meta），那是给读代码的人的就地提示，
 * 与本中间件重复无害（同值 set 是幂等的）。
 *
 * 注意：分发端没有「需要缓存」的响应——分片与视频字节由对象存储 / CDN 直出、不经过本进程，
 * 所以这里不做按路径放行。
 */
func noStoreResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func writePlaylist(w http.ResponseWriter, text string) {
	// P0 缓存纪律（ADR-0006 §5）：改写后的清单绝不缓存
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(text))
}

/**
 * corsMiddleware 跨域支持（管理端产物预览的 hls.js 需要）。
 * 播放鉴权全走 URL token（不使用 Cookie / 凭证），因此允许 `*` 不引入凭证泄露面；
 * 可用 DELIVERY_CORS_ORIGINS 收敛到管理端源站（逗号分隔）。
 */
func corsMiddleware(origins []string) func(http.Handler) http.Handler {
	allowAll := slices.Contains(origins, "*") || len(origins) == 0
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if allowAll {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else if slices.Contains(origins, origin) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Playback-Token, Range")
			// Range / 长度对分片（浏览器直连对象存储）必需（hls.js 会读）
			w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			logger.Info("http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"request_id", middleware.GetReqID(r.Context()),
			)
		})
	}
}
