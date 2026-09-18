"use client";

// 媒资管理页（/media，intent.md 媒资管理操作）：
// 上传原视频 / 预览（弹窗播放 original）/ 详情 / 重命名 / 删除 / 上传封面 / 生成元数据（ffprobe）；
// 「更多 → 转码」已实现（M2：选转码模板入队 transcode_jobs，Worker 认领执行，进度见「转码任务」页）；
// 「更多 → 字幕管理」仍为 TODO（M4，接口 501 占位）。
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  FontSizeOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  MoreOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import {
  App,
  Button,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useTableBodyHeight } from "./tableScroll";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

/** 一份模板产物（spec.md §1.3：proceed/{媒资id}/{模板id}/…） */
interface MediaProduct {
  /** 模板 ID（cuid）；空串 = 旧布局产物 */
  templateId: string;
  /** 模板展示名（模板已删为 null） */
  templateName: string | null;
  objects: number;
  bytes: number;
  variants: string[];
}

interface MediaListItem {
  id: string;
  title: string | null;
  status: string | null;
  ext: string;
  key: string;
  size: number;
  lastModified?: string;
  assets: { proceed: number; cover: number; metadata: number };
  products: MediaProduct[];
}

interface MediaDetail {
  id: string;
  title: string | null;
  status: string | null;
  ext: string | null;
  size: number | null;
  lastModified: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  probe: ProbeSummary | null;
  customData: unknown;
  durationMs: number | null;
  posterKey: string | null;
  sourceKey: string | null;
  assets: { proceed: number; cover: number; metadata: number };
  products: MediaProduct[];
}

// ffprobe 归一化摘要（服务端 @openvod/transcode summarizeProbe 落库 media.probe 的形状）
interface ProbeVideoSummary {
  codec: string | null;
  profile: string | null;
  pixFmt: string | null;
  bitDepth: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameRate: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorRange: string | null;
  bitrate: number | null;
  frameCount: number | null;
}

interface ProbeSummary {
  container: string | null;
  durationMs: number | null;
  bitrate: number | null;
  sizeBytes: number | null;
  streamCount: number | null;
  video: ProbeVideoSummary | null;
  audio: Array<{
    codec: string | null;
    profile: string | null;
    sampleRate: number | null;
    channels: number | null;
    channelLayout: string | null;
    bitrate: number | null;
  }>;
  subtitleCount: number;
}

/** 转码模板选项（/api/admin/templates DTO 的子集，转码弹窗用） */
interface TemplateOption {
  id: string;
  name: string;
  keep_original: boolean;
  encrypt: boolean;
  format: string;
  is_default: boolean;
}

// 存储布局分区（spec.md §1；列展示与 API 响应字段一一对应）
// 转码产物单独成列（按模板分组展示，见下方 products 列）；这里只放简单计数的分区
const ASSET_COLUMNS: { key: keyof MediaListItem["assets"]; label: string }[] = [
  { key: "cover", label: "封面图片" },
];

const STATUS_META: Record<string, { color: string; label: string }> = {
  UPLOADED: { color: "default", label: "已上传" },
  PROBING: { color: "processing", label: "探测中" },
  TRANSCODING: { color: "processing", label: "转码中" },
  READY: { color: "success", label: "就绪" },
  FAILED: { color: "error", label: "失败" },
  ARCHIVED: { color: "warning", label: "已下架" },
};

/** 产物归属展示名：模板名 → 模板已删除（id 前缀）→ 旧布局 */
function productLabel(p: MediaProduct): string {
  if (!p.templateId) return p.templateName ?? "未分组（旧布局）";
  return p.templateName ?? `模板已删除（${p.templateId.slice(0, 8)}…）`;
}

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** XHR 流式上传（File 直接作请求体，服务端按 octet-stream 流式接收；带进度回调） */
function uploadTo(url: string, file: File, onProgress?: (pct: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as { error?: { message?: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error?.message ?? `上传失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(file);
  });
}

// 表格不随条目数无限增高：表体限高后内部纵向滚动、表头固定（列宽合计见下方 columns）。
// 滚动实现抽至 tableScroll.ts（管理端所有表格共用约定，spec.md §3）。
const TABLE_MIN_WIDTH = 1260; // 固定列 1070 + 展示名最小可读宽度

/** 码率（bps）→ 可读字符串 */
function formatBitrate(bps: number | null | undefined): string {
  if (bps == null) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1000)} kbps`;
  return `${bps} bps`;
}

function fmt(v: string | number | null | undefined, suffix = ""): string {
  return v == null || v === "" ? "—" : `${v}${suffix}`;
}

const CELL: CSSProperties = { fontSize: 13, wordBreak: "break-all" };

/** 媒资 ID 点击复制（列表列与详情弹窗共用；stopPropagation 防止触发行内其他交互） */
function CopyableId({ id }: { id: string }) {
  const { message } = App.useApp();
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      message.success(`媒资 ID 已复制：${id}`);
    } catch {
      message.error("复制失败（浏览器未授权剪贴板），请手动选择复制");
    }
  };
  return (
    <Tooltip title="点击复制媒资 ID">
      <Typography.Text code onClick={(e) => void copy(e)} style={{ cursor: "pointer" }}>
        {id}
      </Typography.Text>
    </Tooltip>
  );
}

/** ffprobe 摘要结构化展示（宽高 / 帧率 / 色彩空间 / 编码等），附原始 JSON 折叠块 */
function ProbeSummaryView({ probe }: { probe: ProbeSummary }) {
  const v = probe.video;
  const a = probe.audio[0];
  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "6px 16px",
        }}
      >
        <div style={CELL}>
          <Typography.Text type="secondary">容器：</Typography.Text>
          {fmt(probe.container)}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">分辨率：</Typography.Text>
          {v?.width != null && v?.height != null ? `${v.width}×${v.height}` : "—"}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">帧率：</Typography.Text>
          {v?.fps != null ? `${v.fps} fps` : "—"}
          {v?.frameRate && v.frameRate.includes("/") ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{v.frameRate}）</Typography.Text>
          ) : null}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">视频编码：</Typography.Text>
          {fmt(v?.codec)}
          {v?.profile ? `（${v.profile}）` : ""}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">像素格式：</Typography.Text>
          {fmt(v?.pixFmt)}
          {v?.bitDepth ? ` / ${v.bitDepth}bit` : ""}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">码率：</Typography.Text>
          {formatBitrate(probe.bitrate)}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">色彩空间：</Typography.Text>
          {fmt(v?.colorSpace)}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">传输 / 原色：</Typography.Text>
          {fmt(v?.colorTransfer)} / {fmt(v?.colorPrimaries)}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">量化范围：</Typography.Text>
          {fmt(v?.colorRange)}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">音频：</Typography.Text>
          {a ? `${fmt(a.codec)} / ${fmt(a.sampleRate)} Hz / ${fmt(a.channels)} 声道` : "无音轨"}
          {probe.audio.length > 1 ? `（共 ${probe.audio.length} 轨）` : ""}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">流数：</Typography.Text>
          {fmt(probe.streamCount)}
          {probe.subtitleCount > 0 ? `（含字幕流 ${probe.subtitleCount}）` : ""}
        </div>
        <div style={CELL}>
          <Typography.Text type="secondary">时长：</Typography.Text>
          {probe.durationMs != null ? `${(probe.durationMs / 1000).toFixed(2)} s` : "—"}
        </div>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12 }}>
          <Typography.Text type="secondary">探测摘要 JSON（原始 ffprobe 输出见 metadata/{'{'}id{'}'}/probe.json）</Typography.Text>
        </summary>
        <pre style={{ margin: "4px 0 0", fontSize: 12, maxHeight: 220, overflow: "auto" }}>
          {JSON.stringify(probe, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function MediaList() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);

  const [items, setItems] = useState<MediaListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);

  const [preview, setPreview] = useState<MediaListItem | null>(null);
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const [renameTarget, setRenameTarget] = useState<MediaListItem | null>(null);
  const [renameForm] = Form.useForm();
  const [renaming, setRenaming] = useState(false);

  const [coverTarget, setCoverTarget] = useState<MediaListItem | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);

  const [metadataBusyId, setMetadataBusyId] = useState<string | null>(null);

  // 转码（M2）：选模板发起 → transcode_jobs 入队，Worker 认领执行
  const [transcodeTarget, setTranscodeTarget] = useState<MediaListItem | null>(null);
  const [transcodeTemplates, setTranscodeTemplates] = useState<TemplateOption[]>([]);
  const [transcodeTemplatesLoading, setTranscodeTemplatesLoading] = useState(false);
  const [transcodeTemplateId, setTranscodeTemplateId] = useState<string | undefined>(undefined);
  const [transcodeSubmitting, setTranscodeSubmitting] = useState(false);

  const fetchJson = useCallback(
    async (url: string, init?: RequestInit) => {
      const res = await fetch(url, { cache: "no-store", ...init });
      if (res.status === 401) {
        router.push("/login");
        throw new Error("未登录");
      }
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      return body;
    },
    [router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetchJson("/api/admin/media")) as { total: number; items: MediaListItem[] };
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 上传原视频 ----
  const handleUpload = async (file: File) => {
    setUploadingName(file.name);
    setUploadPct(0);
    try {
      const result = (await uploadTo(
        `/api/admin/media/upload?filename=${encodeURIComponent(file.name)}`,
        file,
        setUploadPct,
      )) as { id?: string };
      message.success(`媒资「${file.name}」上传成功（ID ${result?.id ?? "—"}）`);
      void load();
    } catch (e) {
      if ((e as Error).message === "未登录") return;
      message.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploadingName(null);
    }
  };

  // ---- 详情 ----
  const openDetail = async (record: MediaListItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const data = (await fetchJson(`/api/admin/media/${record.id}`)) as MediaDetail;
      setDetail(data);
    } catch (e) {
      setDetailOpen(false);
      if ((e as Error).message !== "未登录") {
        message.error(e instanceof Error ? e.message : "详情获取失败");
      }
    } finally {
      setDetailLoading(false);
    }
  };

  // ---- 重命名 ----
  const openRename = (record: MediaListItem) => {
    setRenameTarget(record);
    renameForm.setFieldsValue({ title: record.title ?? "" });
  };
  const handleRename = async () => {
    if (!renameTarget) return;
    setRenaming(true);
    try {
      const { title } = (await renameForm.validateFields()) as { title: string };
      await fetchJson(`/api/admin/media/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      message.success("重命名成功");
      setRenameTarget(null);
      void load();
    } catch (e) {
      if ((e as Error).message !== "未登录") {
        message.error(e instanceof Error ? e.message : "重命名失败");
      }
    } finally {
      setRenaming(false);
    }
  };

  // ---- 删除 ----
  const handleDelete = (record: MediaListItem) => {
    modal.confirm({
      title: `确认删除媒资 ${record.id}？`,
      content: (
        <Typography.Text type="danger">
          将删除存储中的原视频与全部关联资产（转码产物 / 封面 / 元数据）及数据库记录，不可恢复。
        </Typography.Text>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await fetchJson(`/api/admin/media/${record.id}`, { method: "DELETE" });
          message.success(`媒资 ${record.id} 已删除`);
          void load();
        } catch (e) {
          if ((e as Error).message !== "未登录") {
            message.error(e instanceof Error ? e.message : "删除失败");
          }
        }
      },
    });
  };

  // ---- 「更多」菜单：TODO 项点击提示里程碑归属 ----
  const todoHint = (label: string, milestone: string) => () =>
    message.info(`${label}功能尚未实现（随${milestone}里程碑落地），接口已预留 501 占位`);

  // ---- 生成元数据（ffprobe → metadata/{id}/probe.json + media.probe / duration_ms） ----
  const handleGenerateMetadata = async (record: MediaListItem) => {
    if (metadataBusyId) return;
    setMetadataBusyId(record.id);
    try {
      message.loading({ content: `正在探测媒资 ${record.id}（ffprobe）…`, key: `probe-${record.id}`, duration: 0 });
      await fetchJson(`/api/admin/media/${record.id}/metadata`, { method: "POST" });
      message.success({
        content: `媒资 ${record.id} 元数据已生成`,
        key: `probe-${record.id}`,
      });
      void load();
      void openDetail(record);
    } catch (e) {
      message.error({ content: e instanceof Error ? e.message : "生成元数据失败", key: `probe-${record.id}` });
      if ((e as Error).message === "未登录") return;
    } finally {
      setMetadataBusyId(null);
    }
  };

  // ---- 转码（M2）：选模板发起 → transcode_jobs 入队（Worker 认领执行） ----
  const openTranscode = async (record: MediaListItem) => {
    setTranscodeTarget(record);
    setTranscodeTemplateId(undefined);
    setTranscodeTemplatesLoading(true);
    try {
      const data = (await fetchJson("/api/admin/templates")) as { items: TemplateOption[] };
      const list = data.items ?? [];
      setTranscodeTemplates(list);
      const preferred = list.find((t) => t.is_default) ?? list[0];
      if (preferred) setTranscodeTemplateId(preferred.id);
    } catch (e) {
      if ((e as Error).message === "未登录") return;
      message.error(e instanceof Error ? e.message : "加载转码模板失败");
    } finally {
      setTranscodeTemplatesLoading(false);
    }
  };

  const handleTranscodeSubmit = async () => {
    if (!transcodeTarget || !transcodeTemplateId) return;
    setTranscodeSubmitting(true);
    try {
      const res = (await fetchJson(`/api/admin/media/${transcodeTarget.id}/transcode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: transcodeTemplateId }),
      })) as { job_id: string };
      message.success(`转码任务已入队（${res.job_id}），可在「转码任务」页查看进度`);
      setTranscodeTarget(null);
      void load();
    } catch (e) {
      if ((e as Error).message === "未登录") return;
      message.error(e instanceof Error ? e.message : "发起转码失败");
    } finally {
      setTranscodeSubmitting(false);
    }
  };

  const selectedTemplate = transcodeTemplates.find((t) => t.id === transcodeTemplateId);

  const moreMenu = (record: MediaListItem) => ({
    items: [
      { key: "transcode", icon: <ThunderboltOutlined />, label: "转码" },
      { key: "subtitle", icon: <FontSizeOutlined />, label: "字幕管理" },
      {
        key: "metadata",
        icon: <FileTextOutlined />,
        label: "生成元数据",
        disabled: metadataBusyId !== null,
      },
      { type: "divider" as const },
      { key: "cover", icon: <PictureOutlined />, label: "上传封面" },
    ],
    onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
      domEvent.stopPropagation();
      if (key === "cover") setCoverTarget(record);
      else if (key === "transcode") void openTranscode(record);
      else if (key === "subtitle") todoHint("字幕管理", "M4 字幕与元数据")();
      else if (key === "metadata") void handleGenerateMetadata(record);
    },
  });

  const handleCoverUpload = async (file: File) => {
    if (!coverTarget) return;
    setCoverUploading(true);
    try {
      await uploadTo(
        `/api/admin/media/${coverTarget.id}/cover?filename=${encodeURIComponent(file.name)}`,
        file,
      );
      message.success("封面上传成功");
      setCoverTarget(null);
      void load();
    } catch (e) {
      if ((e as Error).message !== "未登录") {
        message.error(e instanceof Error ? e.message : "封面上传失败");
      }
    } finally {
      setCoverUploading(false);
    }
  };

  const columns: ColumnsType<MediaListItem> = [
    {
      title: "媒资 ID",
      dataIndex: "id",
      width: 110,
      render: (id: string) => <CopyableId id={id} />,
    },
    {
      title: "展示名",
      dataIndex: "title",
      ellipsis: true,
      render: (title: string | null, record) =>
        title ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            <Typography.Text style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: title }}>
              {title}
            </Typography.Text>
            <Tooltip title="重命名">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  openRename(record);
                }}
              />
            </Tooltip>
          </div>
        ) : (
          <Tooltip title="数据库无该媒资记录（存储孤儿对象）">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: string | null) =>
        status ? (
          <Tag color={STATUS_META[status]?.color ?? "default"}>{STATUS_META[status]?.label ?? status}</Tag>
        ) : (
          <Tag color="default">未入库</Tag>
        ),
    },
    {
      title: "原始文件",
      dataIndex: "ext",
      width: 110,
      render: (ext: string, record) => (
        <Tooltip title={record.key}>
          <Tag>{ext.toUpperCase()}</Tag>
        </Tooltip>
      ),
    },
    {
      title: "大小",
      dataIndex: "size",
      width: 100,
      render: (size: number) => formatSize(size),
    },
    {
      title: "上传时间",
      dataIndex: "lastModified",
      width: 170,
      render: (iso?: string) => (
        <Typography.Text type="secondary">{formatTime(iso)}</Typography.Text>
      ),
    },
    {
      title: "转码产物",
      key: "products",
      width: 200,
      render: (_, row) =>
        row.products.length ? (
          <Tooltip
            title={
              <div style={{ fontSize: 12 }}>
                {row.products.map((p) => (
                  <div key={p.templateId || "legacy"}>
                    {productLabel(p)}：{p.objects} 个对象
                    {p.variants.length > 0 ? `（${p.variants.join(" / ")}）` : ""}
                  </div>
                ))}
              </div>
            }
          >
            <span style={{ cursor: "help" }}>
              {row.products.length} 组产物 · {row.assets.proceed} 个对象
            </span>
          </Tooltip>
        ) : (
          <Tag color="default">无</Tag>
        ),
    },
    ...ASSET_COLUMNS.map(({ key, label }) => ({
      title: label,
      dataIndex: ["assets", key],
      width: 100,
      render: (n: number) =>
        n > 0 ? <Tag color="green">{n} 个对象</Tag> : <Tag color="default">无</Tag>,
    })),
    {
      title: "操作",
      key: "actions",
      width: 180,
      render: (_, record) => (
        <Space size={0}>
          <Tooltip title="预览">
            <Button
              type="text"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={() => setPreview(record)}
            />
          </Tooltip>
          <Tooltip title="详情">
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined />}
              onClick={() => void openDetail(record)}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDelete(record)}
            />
          </Tooltip>
          <Dropdown menu={moreMenu(record)} trigger={["click"]}>
            <Button type="text" size="small" icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <ProCard
      title="存储媒资列表"
      subTitle={`共 ${items.length} 个视频`}
      bordered={false}
      extra={
        <Space>
          <Upload
            accept="video/*"
            showUploadList={false}
            disabled={uploadingName !== null}
            beforeUpload={(file) => {
              void handleUpload(file as File);
              return false; // 关闭 antd 默认 POST，走自定义流式上传
            }}
          >
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={uploadingName !== null}
            >
              {uploadingName
                ? `上传中 ${uploadPct}%${uploadPct >= 100 ? "（处理中）" : ""}`
                : "上传视频"}
            </Button>
          </Upload>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="danger">媒资列表获取失败：{error}</Typography.Text>{" "}
          <Button size="small" danger onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      <div ref={tableRef}>
        <Table<MediaListItem>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个媒资` }}
          size="middle"
          scroll={{ x: TABLE_MIN_WIDTH, y: bodyHeight }}
          locale={{ emptyText: "存储中暂无媒资（original/ 分区为空，点击右上角「上传视频」开始）" }}
        />
      </div>

      {/* 预览：弹窗直接播放 original 原视频（intent.md；同源 video 自动带会话 Cookie） */}
      {preview && (
        <Modal
          open
          title={`预览：${preview.title ?? preview.id}`}
          width={880}
          footer={null}
          onCancel={() => setPreview(null)}
          destroyOnHidden
        >
          <video
            src={`/api/admin/media/${preview.id}/original`}
            controls
            autoPlay
            style={{ width: "100%", maxHeight: "70vh", background: "#000" }}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            {preview.key} · {formatSize(preview.size)}
          </Typography.Paragraph>
        </Modal>
      )}

      {/* 详情：弹窗展示媒资元数据（intent.md；probe 随转码流水线 M2 落地） */}
      <Modal
        open={detailOpen}
        title={`媒资详情：${detail?.title ?? ""}`}
        width={720}
        footer={null}
        onCancel={() => setDetailOpen(false)}
        loading={detailLoading}
      >
        {detail && (
          <Descriptions bordered column={2} size="small">
            <Descriptions.Item label="媒资 ID" span={1}>
              <CopyableId id={detail.id} />
            </Descriptions.Item>
            <Descriptions.Item label="展示名" span={1}>
              {detail.title ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label="状态" span={1}>
              {detail.status
                ? (STATUS_META[detail.status]?.label ?? detail.status)
                : "未入库"}
            </Descriptions.Item>
            <Descriptions.Item label="格式" span={1}>
              {detail.ext ? detail.ext.toUpperCase() : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="大小" span={1}>
              {formatSize(detail.size)}
            </Descriptions.Item>
            <Descriptions.Item label="时长" span={1}>
              {detail.durationMs != null ? `${(detail.durationMs / 1000).toFixed(1)} s` : "—"}
            </Descriptions.Item>
            <Descriptions.Item label="上传时间" span={1}>
              {formatTime(detail.lastModified ?? detail.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="original 键" span={2}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {detail.sourceKey ?? "—"}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="转码产物" span={2}>
              {detail.products.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {detail.products.map((p) => (
                    <Space key={p.templateId || "legacy"} size={6} wrap>
                      <Tag color={p.templateId ? "geekblue" : "default"}>{productLabel(p)}</Tag>
                      {p.variants.length > 0 && <Tag>{p.variants.join(" / ")}</Tag>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {p.objects} 个对象 · {formatSize(p.bytes)}
                      </Typography.Text>
                      {p.templateId && (
                        <Tooltip title={`proceed/${detail.id}/${p.templateId}/`}>
                          <Typography.Text code style={{ fontSize: 11 }}>
                            {p.templateId}
                          </Typography.Text>
                        </Tooltip>
                      )}
                    </Space>
                  ))}
                </div>
              ) : (
                <Typography.Text type="secondary">
                  尚无转码产物（「更多 → 转码」发起，产物按模板落在 proceed/{detail.id}/{"{模板id}"}/）
                </Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="封面" span={1}>
              {detail.assets.cover} 个对象{detail.posterKey ? "（已设 poster）" : ""}
            </Descriptions.Item>
            <Descriptions.Item label="系统元数据（probe）" span={2}>
              {detail.probe ? (
                <ProbeSummaryView probe={detail.probe} />
              ) : (
                <Typography.Text type="secondary">
                  未探测（通过「更多 → 生成元数据」执行 ffprobe 生成）
                </Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="业务自定义数据" span={2}>
              {detail.customData != null ? JSON.stringify(detail.customData) : "—"}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      {/* 重命名：仅修改数据库展示名，original 文件名与媒资 ID 永不改变（intent.md） */}
      <Modal
        open={renameTarget !== null}
        title={`重命名：${renameTarget?.id ?? ""}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        onOk={() => void handleRename()}
        onCancel={() => setRenameTarget(null)}
        destroyOnHidden
      >
        <Form form={renameForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="title"
            label="展示名"
            rules={[
              { required: true, message: "展示名不能为空" },
              { max: 191, message: "展示名过长（≤191 字符）" },
            ]}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                仅修改展示名；媒资 ID（{renameTarget?.id}）与 original 文件名保持不变
              </Typography.Text>
            }
          >
            <Input placeholder="媒资展示名" onPressEnter={() => void handleRename()} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 转码：选模板发起（M2，ADR-0008/0014）；源片规格不足的档位由 Worker 在探测后自动跳过 */}
      <Modal
        open={transcodeTarget !== null}
        title={`发起转码：${transcodeTarget?.title ?? transcodeTarget?.id ?? ""}`}
        okText="发起转码"
        cancelText="取消"
        confirmLoading={transcodeSubmitting}
        okButtonProps={{ disabled: !transcodeTemplateId }}
        onOk={() => void handleTranscodeSubmit()}
        onCancel={() => setTranscodeTarget(null)}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ display: "flex", marginTop: 8 }}>
          <div>
            <Typography.Text type="secondary">转码模板</Typography.Text>
            <Select
              style={{ width: "100%", marginTop: 4 }}
              placeholder={transcodeTemplatesLoading ? "加载模板…" : "请选择模板"}
              loading={transcodeTemplatesLoading}
              value={transcodeTemplateId}
              onChange={(v: string) => setTranscodeTemplateId(v)}
              notFoundContent={<Empty description="暂无模板，请先到「转码模板」页创建" />}
              options={transcodeTemplates.map((t) => ({
                value: t.id,
                label: `${t.name}${t.is_default ? "（默认）" : ""}`,
              }))}
            />
          </div>
          {selectedTemplate && (
            <Space size={6} wrap>
              <Tag color={selectedTemplate.keep_original ? "purple" : "geekblue"}>
                {selectedTemplate.keep_original ? "保持原视频（仅封装 + 可选加密）" : "转码"}
              </Tag>
              <Tag color={selectedTemplate.encrypt ? "red" : "default"}>
                {selectedTemplate.encrypt ? "AES-128 加密" : "不加密"}
              </Tag>
              <Tag>{selectedTemplate.format}</Tag>
            </Space>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            发起后由 Worker 认领执行：ffprobe 探测 → 按模板逐档转码（升格 / 与源持平的档位自动跳过）
            {selectedTemplate?.encrypt ? " → 为该媒资生成独立 CEK 并加密分片" : ""} → 上传 proceed/
            {transcodeTarget?.id ?? "{id}"}/。进度与失败原因见「转码任务」页。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 上传封面：落 cover/{id}/poster.{ext}（intent.md「更多」菜单） */}
      <Modal
        open={coverTarget !== null}
        title={`上传封面：${coverTarget?.title ?? coverTarget?.id ?? ""}`}
        footer={null}
        onCancel={() => setCoverTarget(null)}
        destroyOnHidden
      >
        {coverTarget && (
          <Upload.Dragger
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            multiple={false}
            showUploadList={false}
            disabled={coverUploading}
            beforeUpload={(file) => {
              void handleCoverUpload(file as File);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <PictureOutlined />
            </p>
            <p className="ant-upload-text">
              {coverUploading ? "上传中…" : "点击或拖拽图片到此区域上传"}
            </p>
            <p className="ant-upload-hint">
              支持 jpg / png / webp / gif / avif，将覆盖为该媒资的 poster（cover/{coverTarget.id}/）
            </p>
          </Upload.Dragger>
        )}
      </Modal>
    </ProCard>
  );
}
