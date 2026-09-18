"use client";

// 封面设置 · 模式 B：视频截帧（spec.md §2.3 / intent.md「设置封面」）。
// 弹窗内播放 original 原视频，拖拽进度条选择目标时间点，取当前帧画面作为封面；
// 截帧在浏览器侧完成（<video> 当前帧 → canvas → JPEG），不依赖 ffmpeg / Worker，服务端零新增负载；
// 产物以 poster.jpg 字节走与手动上传相同的封面端点（POST /api/admin/media/{id}/cover），服务端逻辑无差别。
// 导出约束（spec.md §2.3）：JPEG 质量 0.9；帧分辨率超过 1280px 最长边时等比缩小。
// 跨域前置（关键）：媒体元素默认以 no-cors 模式拉流——即使对象桶 CORS 配置正确，
// 画布也会被标记污染、导出抛 SecurityError。因此 <video> 必须显式 crossOrigin="anonymous"，
// 让浏览器以 cors 模式请求（重定向到预签名 URL 后携带 Origin、校验 ACAO 响应头）。
// 若桶未放行（或 Origin / Method / Header 不匹配），cors 模式下视频将直接加载失败——
// onError 捕获后给出桶 CORS 排查项（Origin 精确匹配 / GET+OPTIONS / Range 头）并提示回退手动上传。
import { CameraOutlined } from "@ant-design/icons";
import { App, Button, Slider, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

const JPEG_QUALITY = 0.9;
const MAX_EDGE = 1280;

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

interface CoverFrameCaptureProps {
  /** original 预览地址（同源 /api/admin/media/{id}/original；s3 形态为预签名 302） */
  src: string;
  uploading: boolean;
  /** 截帧产物（JPEG Blob）回调：父组件统一走 handleCoverUpload 的端点调用与刷新逻辑 */
  onCapture: (blob: Blob) => void;
}

export function CoverFrameCapture({ src, uploading, onCapture }: CoverFrameCaptureProps) {
  const { message } = App.useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  // 拖拽进度条期间挂起 onTimeUpdate 回写，避免滑块与播放进度互相打架
  const draggingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // src 变化（弹窗重开 / 换媒资）时重置进度状态；destroyOnHidden 下组件随弹窗销毁重建
    setDuration(0);
    setTime(0);
    setReady(false);
    setLoadError(null);
  }, [src]);

  const seek = (sec: number) => {
    setTime(sec);
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration)) v.currentTime = sec;
  };

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    v.pause();
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(1, Math.round(v.videoWidth * scale));
      const h = Math.max(1, Math.round(v.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建画布上下文");
      ctx.drawImage(v, 0, 0, w, h);
      // 被污染的 canvas 在 toBlob 同步抛 SecurityError（对象桶未放行 CORS 时）
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            message.error("帧导出失败，请重试或改用手动上传");
            return;
          }
          onCapture(blob);
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    } catch (e) {
      if ((e as DOMException)?.name === "SecurityError") {
        message.error(
          "浏览器跨域策略阻止了帧导出：对象桶需放行管理端源站的 CORS（Origin 含本页源站、Method GET、Header *），或改用手动上传",
        );
      } else {
        message.error(e instanceof Error ? e.message : "截帧失败");
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <video
        ref={videoRef}
        src={src}
        crossOrigin="anonymous"
        controls
        playsInline
        preload="metadata"
        style={{ width: "100%", maxHeight: "50vh", background: "#000", borderRadius: 8 }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(Number.isFinite(v.duration) ? v.duration : 0);
          setReady(true);
          setLoadError(null);
        }}
        onTimeUpdate={(e) => {
          if (!draggingRef.current) setTime(e.currentTarget.currentTime);
        }}
        onError={() => {
          // crossOrigin="anonymous" 下对象桶 CORS 未放行时视频加载直接失败（而非截帧时才失败）
          setReady(false);
          setLoadError(
            "原视频加载失败：多为对象桶 CORS 未放行当前管理端源站，或 Origin / Method / Header 不匹配。请检查桶 CORS 配置后重试，或改用「手动上传」Tab。",
          );
        }}
      />
      {loadError && (
        <Typography.Paragraph type="warning" style={{ marginBottom: 0, fontSize: 12 }}>
          {loadError}
          <br />
          排查项：AllowedOrigin 与本页源站**完全一致**（含协议与端口，如 http://localhost:8787）；AllowedMethod
          需含 **GET 与 OPTIONS**（Range 头会触发预检）；AllowedHeader 用 `*` 或至少含 Range。
        </Typography.Paragraph>
      )}
      <div>
        <Slider
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || time)}
          disabled={!ready || uploading}
          tooltip={{ formatter: (sec) => formatClock(Number(sec)) }}
          onChange={(sec) => {
            draggingRef.current = true;
            seek(sec as number);
          }}
          onChangeComplete={() => {
            draggingRef.current = false;
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ready
              ? `${formatClock(time)} / ${formatClock(duration)} · 拖动进度条选好时间点后截取当前帧`
              : "加载原视频中…"}
          </Typography.Text>
          <Button
            type="primary"
            icon={<CameraOutlined />}
            loading={uploading}
            disabled={!ready}
            onClick={capture}
          >
            截取当前帧为封面
          </Button>
        </div>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        截帧在浏览器侧完成（视频当前帧 → canvas → JPEG），以 poster.jpg 走与手动上传相同的封面端点；
        帧分辨率超过 1280px 最长边时等比缩小。s3 存储形态下视频以 CORS 模式加载（crossOrigin=anonymous），
        要求对象桶放行管理端源站，否则视频无法加载、无法截帧（回退手动上传）。
      </Typography.Paragraph>
    </div>
  );
}
