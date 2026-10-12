"use client";

// 播放器舞台（Video.js v10 React，与管理端「产物解密播放」同一路线，spec.md §11.5）：
//   VideoPlayer（状态容器）→ VideoSkin（控制层皮肤，内置字幕菜单）→ HlsJsVideo（hls.js / MSE，Safari 由 Video.js 回退原生 HLS）。
// src = 分发端签名主清单 URL（token 已在 URL 上）→ 播放器自动取密钥（16B CEK）→ 浏览器本地 AES-128 解密，业务侧零解密代码。
// 字幕：play 下发的签名 URL（typ=v）以原生 <track> 挂载，皮肤 CaptionsButton / 菜单负责选轨与关闭。
// 卡顿诊断：分片浏览器直连对象存储，桶未放行播放器源站 CORS 时表现为「有画面迟迟不出 / 一直转圈」，等待超时给出提示。
import "@videojs/react/video/skin.css";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { VideoPlayer, VideoSkin } from "@videojs/react/video";
import { forwardRef, useCallback, useEffect, useRef, type CSSProperties } from "react";

import type { PlaybackSubtitle } from "@/lib/types";

/** 皮肤尺寸与圆角：皮肤不带尺寸，必须外部指定（16:9 + maxHeight 70vh，与管理端皮肤约定一致） */
const SKIN_STYLE = {
  width: "100%",
  aspectRatio: "16 / 9",
  maxHeight: "70vh",
  background: "#000",
  "--media-border-radius": "8px",
} as CSSProperties;

/** waiting 持续多久仍未出画面 → 视为分片受阻（默认 8s，同管理端 HlsPreviewPlayer） */
const STALL_HINT_MS = 8000;

interface PlayerStageProps {
  /** 签名主清单 URL（切换模板产物时换源；token 已带在 URL 上） */
  src: string;
  /** 字幕轨道（play 响应 subtitles[]，url 为 typ=v 签名地址） */
  subtitles: PlaybackSubtitle[];
  /** 换源后元数据就绪（父组件在此恢复进度） */
  onLoadedMetadata?: () => void;
  /** 卡顿诊断 / 媒体错误回调（页面内以 Alert 展示） */
  onDiagnostic?: (message: string) => void;
  /** 递增该值强制重建播放器（「重新播放」：token / URL 未变时也要重载，spec.md §11.4） */
  reloadToken?: number;
}

export const PlayerStage = forwardRef<HTMLVideoElement, PlayerStageProps>(function PlayerStage(
  { src, subtitles, onLoadedMetadata, onDiagnostic, reloadToken = 0 },
  ref,
) {
  const onDiagnosticRef = useRef(onDiagnostic);
  onDiagnosticRef.current = onDiagnostic;
  const onLoadedMetadataRef = useRef(onLoadedMetadata);
  onLoadedMetadataRef.current = onLoadedMetadata;
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStall = useCallback(() => {
    if (stallTimer.current) {
      clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
  }, []);
  const armStall = useCallback(() => {
    if (stallTimer.current) return;
    stallTimer.current = setTimeout(() => {
      stallTimer.current = null;
      if (videoRef.current?.paused) return; // 用户暂停时不算卡顿
      onDiagnosticRef.current?.(
        "等待分片超时（已加载清单但拿不到画面）：请检查对象桶 CORS 是否放行播放器源站、产物是否完整、token 是否过期（可点「重新播放」）",
      );
    }, STALL_HINT_MS);
  }, []);

  useEffect(() => clearStall, [clearStall]);

  return (
    <VideoPlayer>
      <VideoSkin style={SKIN_STYLE}>
        <HlsJsVideo
          // key 含 src 与 reloadToken：换源 / 重新播放即重建媒体元素（受控 src 变更与 key 重建
          // 两种换源方式 spec.md §11.5 均接受；重建可保证 hls.js 内部状态彻底重置）
          key={`${src}#${reloadToken}`}
          ref={(node: HTMLVideoElement | null) => {
            videoRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          src={src}
          crossOrigin="anonymous" // 字幕轨道跨域读取所需（分发端 CORS 已具备）
          autoPlay
          playsInline
          onLoadedMetadata={() => onLoadedMetadataRef.current?.()}
          onWaiting={armStall}
          onStalled={armStall}
          onPlaying={clearStall}
          onError={() =>
            onDiagnosticRef.current?.(
              "媒体加载失败：检查分发端 / 对象桶 CORS、播放 token 是否过期（可点「重新播放」）",
            )
          }
        >
          {subtitles.map((s) => (
            // key 含 URL：换源 / 重新 play 后 token 变化，强制重建 <track>（原生 track 的 src 属性变更不会自动重载）
            <track
              key={`${s.id}:${s.url}`}
              kind="subtitles"
              src={s.url}
              srcLang={s.lang}
              label={s.label}
              default={s.is_default}
            />
          ))}
        </HlsJsVideo>
      </VideoSkin>
    </VideoPlayer>
  );
});
