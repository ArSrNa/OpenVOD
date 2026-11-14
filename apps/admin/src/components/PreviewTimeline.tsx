"use client";

// 预览时间轴（spec.md §7.6）：统一用 react-av-timeline 的 TraceWaterfall，靠 layout 切形态。
//   - 默认垂直（layout="sequence"）：每条 cue 一行、左列显示该条正文，游标固定在前 20%，
//     行跟随播放上滚并保留上方 2 条（followMode="scroll" + keepRowsAbove=2）；
//   - 水平（layout="lanes"）：一条轨道一行，游标停在中间（fixedPlayhead + playheadPosition 0.5）；
//   - 「固定游标」默认开：游标不动，只横向滚动时间轴；
//   - 逐帧跟随：requestAnimationFrame 读 `<video>.currentTime`（timeupdate 只有 ~4Hz，游标一跳一跳），
//     状态只存在本组件里，播放器与皮肤不参与逐帧渲染；
//   - 缩放：Slider 控制 zoom（默认 10×，最高 30×），关掉组件自带档位按钮；
//   - 配色跟随管理端主题：antd token → 组件 CSS 变量（`--wf-*`）。
// 组件来源：https://cnb.cool/arsrna/os/react-timeline （包里未注入样式，需手动引入 CSS）
import "react-av-timeline/dist/index.css";
import { TraceWaterfall, type TimelineClip } from "react-av-timeline";
import { Segmented, Slider, Space, Switch, Typography, theme } from "antd";
import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";
import { useResolvedTheme } from "@/lib/theme";

/** 时间轴上的字幕条目（毫秒） */
export interface PreviewTimelineCue {
  start: number;
  end: number;
  text: string;
}

interface PreviewTimelineProps {
  cues: PreviewTimelineCue[];
  /** 被观察的媒体元素（由 VideoPreviewPlayer 持有） */
  videoRef: RefObject<HTMLVideoElement | null>;
}

type Orientation = "horizontal" | "vertical";

/** 缩放范围：默认 10×（字幕条目肉眼可辨），最高 30× */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 30;
const ZOOM_STEP = 0.5;
const ZOOM_DEFAULT = 10;

/** 游标刷新上限（≈30fps）：比这更快只是多渲染，看不出差别 */
const FRAME_INTERVAL_MS = 1000 / 30;

/** 垂直形态：游标位置（容器宽度百分比）、上方保留条数、容器高度 */
const VERTICAL_PLAYHEAD = 0.2;
const VERTICAL_KEEP_ABOVE = 2;
const VERTICAL_HEIGHT = 240;
/** 垂直形态只渲染当前附近的一段（每行 1 条，几十行足够铺满可视区） */
const VERTICAL_WINDOW = 60;

const SOURCE_URL = "https://cnb.cool/arsrna/os/react-timeline";

export function PreviewTimeline({ cues, videoRef }: PreviewTimelineProps) {
  const { token } = theme.useToken();
  const isDark = useResolvedTheme() === "dark";

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [fixedPlayhead, setFixedPlayhead] = useState(true);
  const [orientation, setOrientation] = useState<Orientation>("vertical");

  const vertical = orientation === "vertical";

  // requestAnimationFrame 读播放进度：暂停时值不变即不触发渲染
  useEffect(() => {
    let frame = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastPaint < FRAME_INTERVAL_MS) return;
      lastPaint = now;
      const video = videoRef.current;
      if (!video) return;
      const time = video.currentTime;
      setCurrentTime((prev) => (Math.round(prev * 1000) === Math.round(time * 1000) ? prev : time));
      const total = video.duration;
      if (Number.isFinite(total) && total > 0) {
        setDuration((prev) => (Math.abs(prev - total) < 0.01 ? prev : total));
      }
      const nextPlaying = !video.paused && !video.ended;
      setPlaying((prev) => (prev === nextPlaying ? prev : nextPlaying));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef]);

  // 跳转只改媒体元素时间，游标由上面的帧循环带回（暂停时同样生效）
  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
  };

  const clips = useMemo<TimelineClip[]>(
    () =>
      cues.map((cue, index) => {
        const start = Math.max(0, cue.start / 1000);
        const end = Math.max(start + 0.001, cue.end / 1000);
        const name = cue.text.replace(/\s+/g, " ").trim() || `第 ${index + 1} 条`;
        return {
          id: `cue-${index}`,
          name,
          index: 0,
          start,
          duration: end - start,
          meta: { 序号: index + 1 },
        };
      }),
    [cues],
  );

  // 垂直形态每行一条，全量渲染会把逐帧刷新拖垮：只留当前条之前 2 条往后的 60 条
  const visibleClips = useMemo(() => {
    if (!vertical) return clips;
    const nextIndex = cues.findIndex((cue) => cue.start / 1000 > currentTime);
    const active = nextIndex < 0 ? cues.length - 1 : nextIndex - 1;
    const start = Math.max(0, active - VERTICAL_KEEP_ABOVE);
    return clips.slice(start, start + VERTICAL_WINDOW);
  }, [clips, cues, vertical, currentTime]);

  // 总时长未知（元数据未就绪）时按字幕末条兜底，避免时间轴塌成 0
  const lastEnd = clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
  const viewDuration = duration > 0 ? duration : lastEnd > 0 ? lastEnd : 1;

  // 主题变量：--wf-* 由组件样式消费，注入后深浅色随 antd 算法切换
  const themeVars = useMemo(
    () =>
      ({
        "--wf-bg": token.colorBgContainer,
        "--wf-sub": token.colorFillTertiary,
        "--wf-hover": token.colorFillSecondary,
        "--wf-border": token.colorBorderSecondary,
        "--wf-text": token.colorText,
        "--wf-muted": token.colorTextSecondary,
        "--wf-grid": token.colorSplit,
        "--wf-clip-1": token.colorPrimary,
        "--wf-active": token.colorPrimary,
        "--wf-cursor": token.colorError,
        // 下面几项是半透明遮罩，antd token 无对应值：按明暗各给一组
        "--wf-dim": isDark ? "rgba(0, 0, 0, 0.45)" : "rgba(31, 36, 48, 0.28)",
        "--wf-scroll": isDark ? "rgba(231, 234, 243, 0.2)" : "rgba(31, 36, 48, 0.22)",
        "--wf-scroll-hover": isDark ? "rgba(231, 234, 243, 0.38)" : "rgba(31, 36, 48, 0.4)",
      }) as CSSProperties,
    [token, isDark],
  );

  return (
    <div style={{ marginTop: 8 }}>
      <Space size={16} wrap style={{ marginBottom: 8 }}>
        <Segmented
          size="small"
          value={orientation}
          onChange={(value) => setOrientation(value as Orientation)}
          options={[
            { label: "水平", value: "horizontal" },
            { label: "垂直", value: "vertical" },
          ]}
        />
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            固定游标
          </Typography.Text>
          <Switch size="small" checked={fixedPlayhead} onChange={setFixedPlayhead} />
        </Space>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            缩放
          </Typography.Text>
          <Slider
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            value={zoom}
            onChange={setZoom}
            tooltip={{ formatter: (value) => `${value ?? 1}×` }}
            style={{ width: 180, margin: "0 4px" }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, width: 34 }}>
            {zoom}×
          </Typography.Text>
        </Space>
      </Space>

      <TraceWaterfall
        clips={visibleClips}
        tracks={[{ index: 0, name: "字幕" }]}
        layout={vertical ? "sequence" : "lanes"}
        followMode={vertical ? "scroll" : "off"}
        keepRowsAbove={VERTICAL_KEEP_ABOVE}
        viewStart={0}
        viewDuration={viewDuration}
        currentTime={currentTime}
        onCurrentTimeChange={seek}
        formatTime={{ type: "clock", millisecond: true }}
        fixedPlayhead={fixedPlayhead}
        playheadPosition={vertical ? VERTICAL_PLAYHEAD : 0.5}
        playing={playing}
        zoom={zoom}
        labelWidth={vertical ? 260 : 68}
        resizableLabel={vertical}
        rowHeight={36}
        height={vertical ? VERTICAL_HEIGHT : 168}
        showSearch={false}
        showZoom={false}
        showDetail
        emptyText="暂无字幕条目"
        labels={{
          empty: "暂无字幕条目",
          track: "字幕",
          lanesColumn: "字幕",
          sequenceColumn: "字幕",
        }}
        onClipClick={(clip) => seek(clip.start)}
        style={themeVars}
      />

      <Typography.Paragraph
        type="secondary"
        style={{ margin: "6px 0 0", fontSize: 12, textAlign: "right" }}
      >
        时间线组件来自{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          {SOURCE_URL}
        </a>
      </Typography.Paragraph>
    </div>
  );
}
