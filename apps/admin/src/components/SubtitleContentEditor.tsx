"use client";

// 字幕文本在线编辑（spec.md §7.6）：把轨道对象（WebVTT）拆成条目，逐条改时间轴与正文后
// 走 `PUT /api/admin/media/{id}/subtitles/{trackId}/content` 就地覆盖同一对象
// （trackId 与存储键不变，内容版本 +1，ADR-0009 2026-11-13 修订）。
// 只编辑条目：NOTE / STYLE / REGION 块、cue 标识行与时间轴行尾设置由 lib/vtt-cues.ts 原样带回。
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SortAscendingOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Input, Modal, Space, Spin, Tooltip, Typography } from "antd";
import { memo, useCallback, useEffect, useState, type CSSProperties } from "react";
import { fetchSubtitleVtt, putSubtitleVtt } from "@/lib/subtitle-client";
import {
  parseVttDocument,
  serializeVttDocument,
  validateVttCues,
  type VttCue,
  type VttDocument,
} from "@/lib/vtt-cues";
import { VttError, formatVttTimestamp, parseVttTimestamp } from "@/lib/vtt";

/** 编辑目标（面板传入的轨道即可，只取用到的字段） */
export interface SubtitleContentTarget {
  id: string;
  label: string;
  lang: string;
}

/** 一行可编辑条目（时间为字符串，便于原样展示用户输入，保存时统一解析） */
interface CueRow {
  key: string;
  id?: string;
  settings?: string;
  start: string;
  end: string;
  text: string;
}

/** 新条目的默认时长（毫秒） */
const DEFAULT_CUE_MS = 2000;

const TIME_INPUT_STYLE: CSSProperties = {
  width: 118,
  fontVariantNumeric: "tabular-nums",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

let rowSeq = 0;
const nextKey = () => `cue-${(rowSeq += 1)}`;

function toRow(cue: VttCue): CueRow {
  return {
    key: nextKey(),
    id: cue.id,
    settings: cue.settings,
    start: formatVttTimestamp(cue.start),
    end: formatVttTimestamp(cue.end),
    text: cue.text,
  };
}

/** 行 → 条目；时间格式非法时抛错并指出第几条 */
function toCue(row: CueRow, index: number): VttCue {
  const start = parseVttTimestamp(row.start);
  const end = parseVttTimestamp(row.end);
  const hint = "应形如 00:00:01.000";
  if (start == null) throw new VttError(`第 ${index + 1} 条的开始时间格式不对（${hint}）`);
  if (end == null) throw new VttError(`第 ${index + 1} 条的结束时间格式不对（${hint}）`);
  return {
    ...(row.id ? { id: row.id } : {}),
    ...(row.settings ? { settings: row.settings } : {}),
    start,
    end,
    text: row.text.replace(/\r\n?/g, "\n").replace(/\s+$/, ""),
  };
}

interface CueRowEditorProps {
  order: number;
  row: CueRow;
  onChange: (key: string, patch: Partial<CueRow>) => void;
  onDelete: (key: string) => void;
}

/** 单条编辑行（memo：只有被改的那一行重渲染，长字幕文件输入不卡） */
const CueRowEditor = memo(function CueRowEditor({
  order,
  row,
  onChange,
  onDelete,
}: CueRowEditorProps) {
  const start = parseVttTimestamp(row.start);
  const end = parseVttTimestamp(row.end);
  const duration = start != null && end != null && end > start ? end - start : null;

  // 失焦时把可解析的时间规范化成 HH:MM:SS.mmm，避免 00:01.5 这类写法留在库里
  const normalize = (field: "start" | "end") => {
    const ms = parseVttTimestamp(row[field]);
    if (ms != null) onChange(row.key, { [field]: formatVttTimestamp(ms) });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 0",
        borderBottom: "1px solid rgba(5, 5, 5, 0.06)",
      }}
    >
      <Typography.Text
        type="secondary"
        style={{ width: 28, textAlign: "right", lineHeight: "24px", flexShrink: 0 }}
      >
        {order}
      </Typography.Text>
      <Input
        size="small"
        value={row.start}
        aria-label={`第 ${order} 条开始时间`}
        style={TIME_INPUT_STYLE}
        placeholder="00:00:01.000"
        onChange={(e) => onChange(row.key, { start: e.target.value })}
        onBlur={() => normalize("start")}
      />
      <Typography.Text type="secondary" style={{ lineHeight: "24px", flexShrink: 0 }}>
        →
      </Typography.Text>
      <Input
        size="small"
        value={row.end}
        aria-label={`第 ${order} 条结束时间`}
        style={TIME_INPUT_STYLE}
        placeholder="00:00:03.000"
        onChange={(e) => onChange(row.key, { end: e.target.value })}
        onBlur={() => normalize("end")}
      />
      <Typography.Text
        type="secondary"
        style={{ width: 74, lineHeight: "24px", fontSize: 12, flexShrink: 0 }}
      >
        {duration == null ? "—" : `${(duration / 1000).toFixed(1)}s`}
      </Typography.Text>
      <Input.TextArea
        size="small"
        value={row.text}
        aria-label={`第 ${order} 条正文`}
        placeholder="字幕正文（换行 = 多行字幕）"
        autoSize={{ minRows: 1, maxRows: 4 }}
        onChange={(e) => onChange(row.key, { text: e.target.value })}
        style={{ flex: 1, minWidth: 200 }}
      />
      <Tooltip title="删除该条">
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          aria-label={`删除第 ${order} 条`}
          onClick={() => onDelete(row.key)}
        />
      </Tooltip>
    </div>
  );
});

export interface SubtitleContentEditorProps {
  mediaId: string;
  /** 编辑目标；null = 弹窗关闭 */
  target: SubtitleContentTarget | null;
  onClose: () => void;
  /** 保存成功回调（面板据此刷新列表） */
  onSaved?: () => void;
}

/** 字幕文本编辑弹窗（按条目编辑，保存即覆盖同一对象） */
export function SubtitleContentEditor({
  mediaId,
  target,
  onClose,
  onSaved,
}: SubtitleContentEditorProps) {
  const { message, modal } = App.useApp();
  const [doc, setDoc] = useState<VttDocument | null>(null);
  const [rows, setRows] = useState<CueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const trackId = target?.id ?? null;

  const load = useCallback(async () => {
    if (!trackId) return;
    setLoading(true);
    setError(null);
    setDirty(false);
    try {
      const parsed = parseVttDocument(await fetchSubtitleVtt(mediaId, trackId));
      setDoc(parsed);
      setRows(parsed.cues.map(toRow));
    } catch (e) {
      setDoc(null);
      setRows([]);
      setError(e instanceof Error ? e.message : "字幕文本加载失败");
    } finally {
      setLoading(false);
    }
  }, [mediaId, trackId]);

  useEffect(() => {
    if (!target) {
      setDoc(null);
      setRows([]);
      setError(null);
      setDirty(false);
      return;
    }
    void load();
  }, [target, load]);

  const updateRow = useCallback((key: string, patch: Partial<CueRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setDirty(true);
  }, []);

  const deleteRow = useCallback((key: string) => {
    setRows((prev) => prev.filter((row) => row.key !== key));
    setDirty(true);
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const start = last ? (parseVttTimestamp(last.end) ?? 0) : 0;
      return [
        ...prev,
        {
          key: nextKey(),
          start: formatVttTimestamp(start),
          end: formatVttTimestamp(start + DEFAULT_CUE_MS),
          text: "",
        },
      ];
    });
    setDirty(true);
  }, []);

  const sortRows = useCallback(() => {
    const at = (row: CueRow) => parseVttTimestamp(row.start) ?? Number.MAX_SAFE_INTEGER;
    setRows((prev) => [...prev].sort((a, b) => at(a) - at(b)));
    setDirty(true);
  }, []);

  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: "放弃未保存的修改？",
      okText: "放弃",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: onClose,
    });
  }, [dirty, modal, onClose]);

  const save = useCallback(async () => {
    if (!trackId || !doc) return;
    setSaving(true);
    try {
      const cues = rows.map(toCue);
      validateVttCues(cues);
      await putSubtitleVtt(mediaId, trackId, serializeVttDocument({ ...doc, cues }));
      message.success("字幕文本已保存");
      setDirty(false);
      onSaved?.();
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [doc, mediaId, message, onClose, onSaved, rows, trackId]);

  const lastEnd = rows.reduce((max, row) => Math.max(max, parseVttTimestamp(row.end) ?? 0), 0);

  return (
    <Modal
      open={target !== null}
      title={`编辑字幕文本：${target?.label ?? ""}${target ? `（${target.lang}）` : ""}`}
      width={1000}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: loading || error !== null || rows.length === 0 }}
      onOk={() => void save()}
      onCancel={requestClose}
      destroyOnHidden
    >
      {loading ? (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <Spin />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            读取字幕条目…
          </Typography.Paragraph>
        </div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Space wrap>
            <Button icon={<PlusOutlined />} onClick={addRow}>
              添加条目
            </Button>
            <Button
              icon={<SortAscendingOutlined />}
              disabled={rows.length < 2}
              onClick={sortRows}
            >
              按开始时间排序
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              结束时间必须晚于开始时间
            </Typography.Text>
          </Space>
          <div style={{ maxHeight: "52vh", overflowY: "auto", paddingRight: 4 }}>
            {rows.length ? (
              rows.map((row, index) => (
                <CueRowEditor
                  key={row.key}
                  order={index + 1}
                  row={row}
                  onChange={updateRow}
                  onDelete={deleteRow}
                />
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有条目，点击「添加条目」"
              />
            )}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {rows.length} 条 · 末条结束于 {formatVttTimestamp(lastEnd)}
          </Typography.Text>
        </div>
      )}
    </Modal>
  );
}
