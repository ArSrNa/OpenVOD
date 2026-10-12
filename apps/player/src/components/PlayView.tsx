"use client";

// 播放页（spec.md §11.4）：GET /v1/media/{id}（标题 / probe / custom / 字幕元信息）
// → POST /v1/media/{id}/play（缺省自动选择）→ 播放器加载签名主清单 URL。
// 清晰度 = 该媒资实际存在的模板产物（play 响应 templates[]）；切换 = 指定 template_id 再次 play
// → 播放器换源 → 恢复播放进度（失败静默从头）。
import { ArrowLeftOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { PlayerStage } from "@/components/PlayerStage";
import { DeliveryError, mediaDetail, playMedia } from "@/lib/delivery";
import { formatBitrate, formatDateTime, formatDuration } from "@/lib/format";
import { parseCustom, type MediaDetailDTO, type PlaybackDTO, type PlaybackTemplate } from "@/lib/types";

function toDeliveryError(e: unknown): DeliveryError {
  return e instanceof DeliveryError ? e : new DeliveryError("internal", String(e), 0);
}

export function PlayView({ mediaId }: { mediaId: string }) {
  const { message } = App.useApp();
  const [detail, setDetail] = useState<MediaDetailDTO | null>(null);
  const [playback, setPlayback] = useState<PlaybackDTO | null>(null);
  const [error, setError] = useState<DeliveryError | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // 切换清晰度 / 重新播放进行中
  const [reloadToken, setReloadToken] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  /** 换源前的播放进度快照（onLoadedMetadata 时恢复；恢复失败静默从头） */
  const resumeRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);

  const boot = useCallback(async () => {
    setError(null);
    setDiagnostic(null);
    setBusy(false);
    setDetail(null);
    setPlayback(null);
    try {
      const d = await mediaDetail(mediaId);
      setDetail(d);
      // play 缺省自动选择模板产物；幂等复用未过期会话（spec.md §6.1，不带 force_new）
      const p = await playMedia(mediaId);
      setPlayback(p);
    } catch (e) {
      setError(toDeliveryError(e));
    }
  }, [mediaId]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const handleLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    const resume = resumeRef.current;
    resumeRef.current = null;
    if (!el || !resume) return;
    try {
      el.currentTime = resume.time;
      if (resume.wasPlaying) void el.play().catch(() => {});
    } catch {
      // 恢复失败静默从头，不阻塞播放
    }
  }, []);

  const switchTemplate = useCallback(
    async (templateId: string) => {
      if (!playback || busy || templateId === playback.template_id) return;
      const el = videoRef.current;
      resumeRef.current = el ? { time: el.currentTime, wasPlaying: !el.paused } : null;
      setBusy(true);
      try {
        const p = await playMedia(mediaId, templateId); // 复用会话，仅换模板产物
        setPlayback(p);
      } catch (e) {
        resumeRef.current = null; // 切换失败不打断当前播放：不换源、不恢复进度
        message.error(`切换清晰度失败：${toDeliveryError(e).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, mediaId, message, playback],
  );

  const reload = useCallback(async () => {
    resumeRef.current = null;
    setDiagnostic(null);
    setBusy(true);
    try {
      const p = await playMedia(mediaId); // 重新签发 token；URL 未变时靠 reloadToken 强制重载
      setPlayback(p);
      setReloadToken((n) => n + 1);
    } catch (e) {
      setError(toDeliveryError(e));
    } finally {
      setBusy(false);
    }
  }, [mediaId]);

  if (error) {
    return <PlayError error={error} onRetry={boot} />;
  }

  if (!detail || !playback) {
    return (
      <Card>
        <Flex justify="center" style={{ padding: "48px 0" }}>
          <Spin tip="正在获取播放会话…" size="large">
            <div style={{ width: 240, height: 60 }} />
          </Spin>
        </Flex>
      </Card>
    );
  }

  const custom = parseCustom(detail.custom);
  // 防御旧版分发端（升级前无 templates 字段；spec.md §11.1 向后兼容约定）：缺字段退化为空数组
  const templates = playback.templates ?? [];
  const subtitles = playback.subtitles ?? [];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Link href="/">
          <Button type="text" icon={<ArrowLeftOutlined />}>
            返回列表
          </Button>
        </Link>
      </div>

      <PlayerStage
        ref={videoRef}
        src={playback.manifest_url}
        subtitles={subtitles}
        reloadToken={reloadToken}
        onLoadedMetadata={handleLoadedMetadata}
        onDiagnostic={setDiagnostic}
      />

      {diagnostic ? (
        <Alert
          type="warning"
          showIcon
          closable
          message={diagnostic}
          onClose={() => setDiagnostic(null)}
          action={
            <Button size="small" onClick={reload} loading={busy}>
              重新播放
            </Button>
          }
        />
      ) : null}

      <Card size="small">
        <Flex justify="space-between" align="center" wrap gap={12}>
          <Space align="center" wrap>
            <Typography.Text strong>清晰度</Typography.Text>
            <QualitySwitch
              templates={templates}
              current={playback.template_id}
              switching={busy}
              onChange={switchTemplate}
            />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={reload} loading={busy}>
            重新播放
          </Button>
        </Flex>
      </Card>

      <Card
        title={<Typography.Text strong style={{ fontSize: 18 }}>{detail.title || mediaId}</Typography.Text>}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            媒资 ID {detail.id}
          </Typography.Text>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="分类">{custom.category?.path ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="时长">{formatDuration(detail.duration_ms)}</Descriptions.Item>
          <Descriptions.Item label="分辨率">
            {detail.probe?.width && detail.probe?.height
              ? `${detail.probe.width}×${detail.probe.height}`
              : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="码率">{formatBitrate(detail.probe?.bitrate_bps)}</Descriptions.Item>
          <Descriptions.Item label="视频编码">{detail.probe?.video_codec ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="音频编码">{detail.probe?.audio_codec ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="描述" span="filled">
            {custom.description ?? "—"}
          </Descriptions.Item>
          <Descriptions.Item label="标签" span="filled">
            {custom.tags?.length ? (
              <Space size={4} wrap>
                {custom.tags.map((t) => (
                  <Tag key={t} style={{ marginInlineEnd: 0 }}>
                    {t}
                  </Tag>
                ))}
              </Space>
            ) : (
              "—"
            )}
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          链路调试：sid={playback.sid} · template_id={playback.template_id || "（旧布局）"} · expires_at=
          {formatDateTime(playback.expires_at)}
        </Typography.Text>
      </Card>
    </Space>
  );
}

/**
 * 清晰度控件（spec.md §11.4）：像视频网站一样始终给出下拉——
 *   - 无论 1 套还是上百套产物都可切换（下拉自身可滚动，不挤占布局）；
 *   - 选中项 = 当前播放产物（进入播放页由分发端自动选 templates[] 第一项，见 §6.3）；
 *   - 旧布局（templates 为空）显示禁用的「默认产物」占位，保证控件位置一致。
 */
function QualitySwitch({
  templates,
  current,
  switching,
  onChange,
}: {
  templates: PlaybackTemplate[];
  current: string;
  switching: boolean;
  onChange: (templateId: string) => void;
}) {
  const empty = templates.length === 0;
  const options: { value: string; label: string; disabled?: boolean }[] = empty
    ? [{ value: "", label: "默认产物", disabled: true }]
    : templates.map((t) => ({
        value: t.id,
        label: `${templateLabel(t)}${t.is_default ? "（默认）" : ""}`,
      }));
  // 显式请求旧布局（current=""）而媒资同时有模板子树时——补占位项，避免下拉显示空白
  if (!empty && current && !templates.some((t) => t.id === current)) {
    options.unshift({ value: current, label: `模板 ${current.slice(0, 8)}` });
  }
  return (
    <Select
      size="small"
      style={{ minWidth: 180 }}
      value={empty ? "" : current || templates[0].id}
      options={options}
      loading={switching}
      disabled={switching || empty}
      popupMatchSelectWidth={false}
      onChange={(v) => onChange(v)}
    />
  );
}

function templateLabel(t: PlaybackTemplate): string {
  return t.name ?? `模板 ${t.id.slice(0, 8)}`;
}

function PlayError({ error, onRetry }: { error: DeliveryError; onRetry: () => void }) {
  const extra =
    error.status === 501
      ? "配置 PLAYER_PREVIEW_USERNAME / PLAYER_PREVIEW_PASSWORD（或回退 DELIVERY_PREVIEW_*）后重启 player；账号用 `bun apps/admin/scripts/bootstrap-playback.ts` 创建"
      : error.status === 409
        ? "媒资尚未就绪 / 无可用产物（409 not_playable）或并发会话已达上限（409 session_limit）；若提示「多套产物」，说明分发端尚未升级——新版会自动选择首个产物并给出切换菜单"
        : error.status === 0
          ? "请确认分发端已启动、浏览器可直连分发端（DELIVERY_CORS_ORIGINS 放行播放器源站）"
          : undefined;
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Link href="/">
        <Button type="text" icon={<ArrowLeftOutlined />}>
          返回列表
        </Button>
      </Link>
      <Alert
        type={error.status === 501 ? "warning" : "error"}
        showIcon
        message={`无法播放（${error.code}）`}
        description={
          <Space direction="vertical" size={4}>
            <span>{error.message}</span>
            {extra ? <span style={{ color: "rgba(0,0,0,0.45)" }}>{extra}</span> : null}
          </Space>
        }
        action={
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        }
      />
    </Space>
  );
}
