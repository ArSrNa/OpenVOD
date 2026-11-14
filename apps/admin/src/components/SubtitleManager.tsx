"use client";

// 字幕轨道管理（spec.md §7；ADR-0009）：一个媒资的多条 WebVTT 字幕轨道增删改查。
//   - 上传 / 覆盖文本走**原始字节流**（octet-stream）——支持 `.vtt` 与 `.srt`（SRT 由服务端
//     自动转 WebVTT 后存储，对象键恒为 `.vtt`），服务端结构化校验：UTF-8 / WEBVTT 头 / cue 时间轴；
//   - 语言输入兼容 `zh_CN` 写法，服务端归一化为 BCP-47（`zh-CN`）后存储与返回；
//   - 同一媒资内语言唯一；每媒资至多一条默认轨（换默认在服务端事务内互斥）；
//   - 落键 proceed/{mediaId}/subtitles/{trackId}.vtt（trackId 由服务端生成，即 media_subtitles.id）。
//
// 两个出口：
//   - `SubtitleTracksPanel`：轨道面板（工具栏 + 表格 + 弹窗），供字幕管理页与媒资页抽屉复用；
//   - `SubtitleManager`：媒资页「更多 → 字幕管理」用的抽屉壳。
import {
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FontSizeOutlined,
  FormOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  App,
  AutoComplete,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSubtitleVtt } from "@/lib/subtitle-client";
import { parseVttDocument } from "@/lib/vtt-cues";
import { SubtitleContentEditor } from "./SubtitleContentEditor";
import { useTableBodyHeight } from "./tableScroll";
import { VideoPreviewPlayer } from "./VideoPreviewPlayer";
import type { PreviewTimelineCue } from "./PreviewTimeline";

interface SubtitleTrack {
  id: string;
  lang: string;
  label: string;
  is_default: boolean;
  status: string;
  bytes: number;
  storage_key: string;
  storage_ok: boolean | null;
  created_at: string;
  updated_at: string;
}

/** 语言预置项（允许自由输入；服务端归一化后再校验 BCP-47，spec.md §7.1） */
const LANG_OPTIONS = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"].map((value) => ({ value }));

const STATUS_META: Record<string, { color: string; label: string }> = {
  PROCESSING: { color: "processing", label: "处理中" },
  READY: { color: "success", label: "就绪" },
  FAILED: { color: "error", label: "失败" },
};

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** VTT 字节流上传（POST 新建 / PUT 覆盖文本共用；服务端按 octet-stream 读原始字节） */
async function sendVtt(method: "POST" | "PUT", url: string, file: File): Promise<void> {
  const res = await fetch(url, {
    method,
    body: file,
    cache: "no-store",
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
  }
}

export interface SubtitleTracksPanelProps {
  mediaId: string;
  mediaTitle: string | null;
  /** 列表变化回调（页面侧据此刷新媒资字幕数等） */
  onChanged?: () => void;
}

/**
 * 字幕轨道面板：工具栏（上传 / 刷新）+ 轨道表格 + 上传 / 编辑弹窗。
 * 页面（/subtitles）与媒资页抽屉共用；`key={mediaId}` 切换媒资时整块重挂载。
 */
export function SubtitleTracksPanel({ mediaId, mediaTitle, onChanged }: SubtitleTracksPanelProps) {
  const { message, modal } = App.useApp();
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);

  const [items, setItems] = useState<SubtitleTrack[]>([]);
  const [loading, setLoading] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForm] = Form.useForm();
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editTarget, setEditTarget] = useState<SubtitleTrack | null>(null);
  const [editForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // 字幕预览：original 原视频 + 该轨道字幕（Video.js 原生外挂 track；与媒资预览同一皮肤）
  const [preview, setPreview] = useState<SubtitleTrack | null>(null);
  // 预览时间轴的条目（随预览一起取该轨道 VTT 解析；取不到时时间轴只有标尺与游标）
  const [previewCues, setPreviewCues] = useState<PreviewTimelineCue[]>([]);

  // 字幕文本编辑弹窗（spec.md §7.6）
  const [contentTarget, setContentTarget] = useState<SubtitleTrack | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/media/${mediaId}/subtitles`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | { items?: SubtitleTrack[]; error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      setItems(body?.items ?? []);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "字幕列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [mediaId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 预览（原视频 + 该轨字幕 + 时间轴） ----
  // 连点不同轨道时只采用最后一次请求的结果
  const previewSeq = useRef(0);
  const openPreview = useCallback(
    async (track: SubtitleTrack) => {
      const seq = (previewSeq.current += 1);
      setPreview(track);
      setPreviewCues([]);
      try {
        const doc = parseVttDocument(await fetchSubtitleVtt(mediaId, track.id));
        if (previewSeq.current === seq) setPreviewCues(doc.cues);
      } catch {
        // 字幕取不到时播放器仍可预览原视频（<track> 自己会报错）；时间轴退化为空
      }
    },
    [mediaId],
  );

  // ---- 上传（POST，spec.md §7.4） ----
  const handleUpload = async () => {
    if (!uploadFile) {
      message.warning("请选择 .vtt 字幕文件");
      return;
    }
    setSubmitting(true);
    try {
      const values = (await uploadForm.validateFields()) as {
        lang: string;
        label: string;
        is_default?: boolean;
      };
      const params = new URLSearchParams({
        lang: values.lang.trim(),
        label: values.label.trim(),
        is_default: values.is_default ? "true" : "false",
      });
      await sendVtt("POST", `/api/admin/media/${mediaId}/subtitles?${params.toString()}`, uploadFile);
      // SRT 由服务端自动转 VTT 存储；按扩展名给出提示（转换结果以 storage_key 的 .vtt 为准）
      message.success(
        /\.srt$/i.test(uploadFile.name) ? "SRT 已自动转换为 VTT 并上传" : "字幕已上传",
      );
      setUploadOpen(false);
      setUploadFile(null);
      uploadForm.resetFields();
      void load();
      onChanged?.();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验失败
      message.error(e instanceof Error ? e.message : "字幕上传失败");
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 编辑元信息（PATCH） ----
  const openEdit = (track: SubtitleTrack) => {
    setEditTarget(track);
    editForm.setFieldsValue({
      lang: track.lang,
      label: track.label,
      is_default: track.is_default,
    });
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const values = (await editForm.validateFields()) as {
        lang: string;
        label: string;
        is_default?: boolean;
      };
      const res = await fetch(`/api/admin/media/${mediaId}/subtitles/${editTarget.id}`, {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang: values.lang.trim(),
          label: values.label.trim(),
          is_default: Boolean(values.is_default),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      }
      message.success("字幕轨道已更新");
      setEditTarget(null);
      void load();
      onChanged?.();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(e instanceof Error ? e.message : "更新失败");
    } finally {
      setSaving(false);
    }
  };

  // ---- 替换文本（PUT；就地覆盖同一对象，trackId 不变） ----
  const handleReplace = (track: SubtitleTrack, file: File) => {
    modal.confirm({
      title: `替换「${track.label}」的字幕文本？`,
      content: (
        <Typography.Text type="secondary">
          将覆盖 <Typography.Text code>{track.storage_key}</Typography.Text>（轨道 ID{" "}
          <Typography.Text code>{track.id}</Typography.Text> 与播放地址均不变）。分发端字幕响应
          不缓存，播放端下一次请求即取到新文本。
        </Typography.Text>
      ),
      okText: "替换",
      cancelText: "取消",
      onOk: async () => {
        try {
          await sendVtt("PUT", `/api/admin/media/${mediaId}/subtitles/${track.id}/content`, file);
          message.success("字幕文本已替换");
          void load();
          onChanged?.();
        } catch (e) {
          message.error(e instanceof Error ? e.message : "替换失败");
        }
      },
    });
  };

  // ---- 删除 ----
  const handleDelete = async (track: SubtitleTrack) => {
    try {
      const res = await fetch(`/api/admin/media/${mediaId}/subtitles/${track.id}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      }
      message.success(`字幕轨道「${track.label}」已删除`);
      void load();
      onChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  const copyTrackId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      message.success(`轨道 ID 已复制：${id}`);
    } catch {
      message.error("复制失败（浏览器未授权剪贴板），请手动选择复制");
    }
  };

  const columns: ColumnsType<SubtitleTrack> = [
    {
      title: "语言 / 展示名",
      key: "lang",
      width: 200,
      render: (_, t) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Space size={6}>
            <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
              {t.lang}
            </Tag>
            {t.is_default ? <Tag color="green">默认</Tag> : null}
          </Space>
          <Typography.Text ellipsis={{ tooltip: t.label }}>{t.label}</Typography.Text>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (status: string) => (
        <Tag color={STATUS_META[status]?.color ?? "default"}>{STATUS_META[status]?.label ?? status}</Tag>
      ),
    },
    { title: "大小", dataIndex: "bytes", width: 90, render: (bytes: number) => formatSize(bytes) },
    {
      title: "轨道 ID",
      dataIndex: "id",
      width: 140,
      render: (id: string, t) => (
        <Space size={0}>
          <Tooltip title={t.storage_key}>
            <Typography.Text code style={{ fontSize: 12 }}>
              {id.slice(0, 10)}…
            </Typography.Text>
          </Tooltip>
          <Tooltip title="复制轨道 ID">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copyTrackId(id)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "对象",
      dataIndex: "storage_ok",
      width: 90,
      render: (ok: boolean | null) =>
        ok === null ? (
          <Tooltip title="存储不可用，无法确认对象状态">
            <Tag>未知</Tag>
          </Tooltip>
        ) : ok ? (
          <Tag color="success">正常</Tag>
        ) : (
          <Tooltip title="存储中缺少该字幕对象，请删除后重新上传">
            <Tag color="error">缺失</Tag>
          </Tooltip>
        ),
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      width: 165,
      render: (iso: string) => <Typography.Text type="secondary">{formatTime(iso)}</Typography.Text>,
    },
    {
      title: "操作",
      key: "ops",
      width: 400,
      render: (_, t) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            icon={<PlayCircleOutlined />}
            disabled={t.storage_ok === false}
            onClick={() => void openPreview(t)}
          >
            预览
          </Button>
          <Tooltip title={t.storage_ok === false ? "字幕对象缺失，无法按条目编辑" : "逐条改时间轴与正文"}>
            <span>
              <Button
                type="link"
                size="small"
                icon={<FormOutlined />}
                disabled={t.storage_ok === false}
                onClick={() => setContentTarget(t)}
              >
                编辑字幕
              </Button>
            </span>
          </Tooltip>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(t)}>
            编辑
          </Button>
          <Upload
            accept=".vtt,.srt,text/vtt"
            showUploadList={false}
            beforeUpload={(file) => {
              handleReplace(t, file as File);
              return false;
            }}
          >
            <Button type="link" size="small" icon={<SyncOutlined />}>
              替换内容
            </Button>
          </Upload>
          <Popconfirm
            title={`删除「${t.label}」？`}
            description={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                将同时删除存储对象与数据库记录，不可恢复；删除默认轨后不会自动改派。
              </Typography.Text>
            }
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(t)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
          上传字幕
        </Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </Space>

      <div ref={tableRef}>
        <Table<SubtitleTrack>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1175, y: bodyHeight }}
          locale={{
            emptyText: (
              <Typography.Text type="secondary">
                暂无字幕（点击「上传字幕」添加）
              </Typography.Text>
            ),
          }}
        />
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        字幕位置：<Typography.Text code>proceed/{mediaId}/subtitles/&#123;trackId&#125;.vtt</Typography.Text>
      </Typography.Paragraph>

      {/* 字幕预览（spec.md §7.6）：播放 original 原视频，并挂上该轨道的 WebVTT（Video.js 原生 <track>）。
          与媒资预览同源（GET /media/{id}/original，支持 Range 拖动），字幕文本走
          GET /media/{id}/subtitles/{trackId}/content（no-store，编辑后重新打开即最新）。 */}
      <Modal
        open={preview !== null}
        title={`字幕预览：${preview?.label ?? ""}${preview ? `（${preview.lang}）` : ""}`}
        width={960}
        footer={null}
        onCancel={() => setPreview(null)}
        destroyOnHidden
      >
        {preview && (
          <VideoPreviewPlayer
            src={`/api/admin/media/${mediaId}/original`}
            cues={previewCues}
            subtitles={[
              {
                src: `/api/admin/media/${mediaId}/subtitles/${preview.id}/content`,
                lang: preview.lang,
                label: preview.label,
                default: true,
              },
            ]}
          />
        )}
      </Modal>

      {/* 字幕文本编辑（spec.md §7.6）：按条目改时间轴与正文，保存即就地覆盖同一对象 */}
      <SubtitleContentEditor
        mediaId={mediaId}
        target={contentTarget}
        onClose={() => setContentTarget(null)}
        onSaved={() => {
          void load();
          onChanged?.();
        }}
      />

      {/* 上传：选文件 + 语言 + 展示名 + 是否默认 */}
      <Modal
        open={uploadOpen}
        title={`上传字幕：${mediaTitle ?? mediaId}`}
        okText="上传"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={() => void handleUpload()}
        onCancel={() => {
          setUploadOpen(false);
          setUploadFile(null);
          uploadForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form
          form={uploadForm}
          layout="vertical"
          style={{ marginTop: 8 }}
          initialValues={{ is_default: false }}
        >
          <Form.Item
            name="lang"
            label="语言"
            rules={[{ required: true, message: "请填写语言标签（如 zh-CN / en-US）" }]}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按 BCP-47 归一化存储；兼容下划线写法（zh_CN → zh-CN）
              </Typography.Text>
            }
          >
            <AutoComplete options={LANG_OPTIONS} placeholder="zh-CN" filterOption />
          </Form.Item>
          <Form.Item
            name="label"
            label="展示名"
            rules={[
              { required: true, message: "展示名不能为空" },
              { max: 64, message: "展示名过长（≤64 字符）" },
            ]}
          >
            <Input placeholder="如：简体中文 / English" />
          </Form.Item>
          <Form.Item name="is_default" label="设为默认轨" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Upload.Dragger
            accept=".vtt,.srt,text/vtt"
            multiple={false}
            maxCount={1}
            showUploadList={false}
            beforeUpload={(file) => {
              setUploadFile(file as File);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <FontSizeOutlined />
            </p>
            <p className="ant-upload-text">
              {uploadFile ? `已选择：${uploadFile.name}` : "点击或拖拽 .vtt / .srt 字幕文件到此区域"}
            </p>
            <p className="ant-upload-hint">
              支持 WebVTT（.vtt）与 SubRip（.srt，自动转为 VTT 存储）；服务端校验 UTF-8 /
              时间轴（只校验不重排），上限 5 MiB
            </p>
          </Upload.Dragger>
        </Form>
      </Modal>

      {/* 编辑：展示名 / 语言 / 设为默认（不重传文件） */}
      <Modal
        open={editTarget !== null}
        title={`编辑字幕轨道：${editTarget?.lang ?? ""}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void handleEdit()}
        onCancel={() => setEditTarget(null)}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="lang"
            label="语言"
            rules={[{ required: true, message: "请填写语言标签（如 zh-CN / en-US）" }]}
          >
            <AutoComplete options={LANG_OPTIONS} placeholder="zh-CN" filterOption />
          </Form.Item>
          <Form.Item
            name="label"
            label="展示名"
            rules={[
              { required: true, message: "展示名不能为空" },
              { max: 64, message: "展示名过长（≤64 字符）" },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="is_default"
            label="设为默认轨"
            valuePropName="checked"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                开启后该媒资其它轨道自动取消默认；关闭则不指定默认轨
              </Typography.Text>
            }
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export interface SubtitleManagerProps {
  /** 目标媒资；null = 抽屉关闭 */
  mediaId: string | null;
  mediaTitle: string | null;
  onClose: () => void;
}

/** 媒资页「更多 → 字幕管理」抽屉：轨道面板的抽屉壳（spec.md §7.6） */
export function SubtitleManager({ mediaId, mediaTitle, onClose }: SubtitleManagerProps) {
  return (
    <Drawer
      open={mediaId !== null}
      width={860}
      title={`字幕管理：${mediaTitle ?? mediaId ?? ""}`}
      onClose={onClose}
      destroyOnHidden
    >
      {mediaId ? (
        <SubtitleTracksPanel key={mediaId} mediaId={mediaId} mediaTitle={mediaTitle} />
      ) : null}
    </Drawer>
  );
}
