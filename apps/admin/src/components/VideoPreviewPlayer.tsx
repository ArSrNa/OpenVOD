"use client";

// 管理端视频预览播放器（Video.js v10 React，@videojs/react/video）：
// VideoPlayer（状态容器）→ VideoSkin（控制层皮肤）→ Video（原生媒体元素，src 走同源 /api/admin/media/[id]/original）。
// skin.css 由皮肤包提供，必须随组件一并导入。
// 注意：皮肤自身不带尺寸（官方文档），必须由外部给定宽高比，否则容器高度塌陷；这里按 16:9 铺满弹窗并限制不超过 70vh。
// 皮肤下方挂预览时间轴（react-av-timeline，见 PreviewTimeline.tsx）：时间轴自己用 rAF 读媒体元素进度，
// 因此本组件不订阅 timeupdate，避免逐帧渲染播放器与贴图。
import "@videojs/react/video/skin.css";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { useRef, type CSSProperties } from "react";
import { PreviewTimeline, type PreviewTimelineCue } from "./PreviewTimeline";

/** 皮肤尺寸与圆角：皮肤不带尺寸必须外部指定；--media-border-radius 为官方公开变量（默认 28px），弹窗内收紧到 8px */
const SKIN_STYLE = {
  width: "100%",
  aspectRatio: "16 / 9",
  maxHeight: "70vh",
  background: "#000",
  "--media-border-radius": "8px",
} as CSSProperties;

/** 外挂字幕轨道（原生 `<track>`；Video.js 的字幕菜单可切换 / 关闭） */
export interface VideoPreviewSubtitle {
  /** WebVTT 地址（`text/vtt`；管理端同源走 /api/admin/media/[id]/subtitles/[trackId]/content） */
  src: string;
  /** BCP-47 语言标签（track 的 srclang） */
  lang: string;
  /** 展示名（字幕菜单项） */
  label: string;
  /** 是否默认开启 */
  default?: boolean;
}

interface VideoPreviewPlayerProps {
  /** 媒体地址（管理端同源预览流，Range 由 /api/admin/media/[id]/original 处理） */
  src: string;
  /** 字幕轨道（字幕预览：原视频 + 该轨字幕） */
  subtitles?: VideoPreviewSubtitle[];
  /** 时间轴上的字幕条目（字幕预览传入；不传则时间轴只有标尺与游标） */
  cues?: PreviewTimelineCue[];
}

export function VideoPreviewPlayer({ src, subtitles, cues }: VideoPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <VideoPlayer>
      <div>
        <VideoSkin style={SKIN_STYLE}>
          <Video ref={videoRef} src={src} autoPlay playsInline>
            {subtitles?.map((t) => (
              <track
                key={t.src}
                kind="subtitles"
                src={t.src}
                srcLang={t.lang}
                label={t.label}
                default={t.default}
              />
            ))}
          </Video>
        </VideoSkin>
        <PreviewTimeline cues={cues ?? []} videoRef={videoRef} />
      </div>
    </VideoPlayer>
  );
}
