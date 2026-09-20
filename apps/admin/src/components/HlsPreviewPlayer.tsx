"use client";

// 产物解密播放器（Video.js v10 React；与「预览」共用同一套皮肤与控件，spec.md §6）
// 媒体元素换成 @videojs/hlsjs-video（hls.js / MSE；Safari 由 Video.js 自行回退原生 HLS）：
//   src = 分发端签名主清单 URL（token 已在 URL 上）→ 播放器自动取密钥（16B CEK）→ 浏览器本地解密。
// 管理端不接触任何密钥材料（P0，spec.md §4.3）。
// 卡顿诊断：分片由浏览器直连对象存储（s3 形态）或分发端（local 形态），
// 若对象桶未放行管理端源站的 CORS，会表现为「有总时长但一直转圈」——等待超时后给出明确提示。
import "@videojs/react/video/skin.css";
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video";
import { VideoPlayer, VideoSkin } from "@videojs/react/video";
import { useCallback, useEffect, useRef, type CSSProperties } from "react";

/** 皮肤尺寸与圆角：皮肤不带尺寸必须外部指定（与 preview 播放器同约定） */
const SKIN_STYLE = {
  width: "100%",
  aspectRatio: "16 / 9",
  maxHeight: "70vh",
  background: "#000",
  "--media-border-radius": "8px",
} as CSSProperties;

/** waiting 持续多久仍未出画面 → 视为分片受阻（默认 8s） */
const STALL_HINT_MS = 8000;

interface HlsPreviewPlayerProps {
  /** 签名主清单 URL（含播放 token） */
  src: string;
  /** 致命错误 / 卡顿诊断回调（在弹窗内展示） */
  onError?: (message: string) => void;
}

export function HlsPreviewPlayer({ src, onError }: HlsPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // 回调放 ref，避免父组件每次渲染都重挂定时器
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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
      // 用户暂停时不算卡顿
      if (videoRef.current?.paused) return;
      onErrorRef.current?.(
        "等待分片超时（已加载清单但拿不到画面）：请检查对象桶 CORS 是否放行管理端源站（浏览器直连分片被拦时即为该现象），以及产物是否完整、token 是否过期（过期后重新点击播放）",
      );
    }, STALL_HINT_MS);
  }, []);

  useEffect(() => clearStall, [clearStall]);

  return (
    <VideoPlayer>
      <VideoSkin style={SKIN_STYLE}>
        <HlsJsVideo
          ref={videoRef}
          src={src}
          autoPlay
          playsInline
          onWaiting={armStall}
          onStalled={armStall}
          onPlaying={clearStall}
          onError={() =>
            onErrorRef.current?.("媒体加载失败：检查分发端 / 对象桶 CORS、播放 token 是否过期（重新点击播放）")
          }
        />
      </VideoSkin>
    </VideoPlayer>
  );
}
