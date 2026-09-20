"use client";

// 媒资管理页（/media，intent.md 媒资管理操作）：
// 上传原视频 / 预览（弹窗播放 original）/ 详情 / 重命名 / 删除 / 设置封面（双模式：手动上传 / 视频截帧，spec.md §2.3） / 生成元数据（ffprobe）；
// 「更多 → 转码」已实现（M2：选转码模板入队 transcode_jobs，Worker 认领执行，进度见「转码任务」页）；
// 转码产物：按模板的产物列表（抽屉）→ **解密播放**（走分发端签名链路，管理端不出密钥，spec.md §6）
// 与**按模板删除**（只删该模板子树，spec.md §5.5）；
// 「更多 → 字幕管理」仍为 TODO（M4，接口 501 占位）。
import {
  CloudUploadOutlined,
  CopyOutlined,
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
  Drawer,
  Dropdown,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { PRODUCT_LEGACY_ID } from "@/lib/media-products";
import { CoverFrameCapture } from "./CoverFrameCapture";
import { HlsPreviewPlayer } from "./HlsPreviewPlayer";
import { useTableBodyHeight } from "./tableScroll";
import { VideoPreviewPlayer } from "./VideoPreviewPlayer";
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
  posterKey: string | null;
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
const TABLE_MIN_WIDTH = 1260; // 固定列 970（含首列封面缩略图） + 展示名最小可读宽度

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

  // 转码（M2）：**多选**模板发起 → 每个模板各入队一条 transcode_jobs，Worker 认领执行
  const [transcodeTarget, setTranscodeTarget] = useState<MediaListItem | null>(null);
  const [transcodeTemplates, setTranscodeTemplates] = useState<TemplateOption[]>([]);
  const [transcodeTemplatesLoading, setTranscodeTemplatesLoading] = useState(false);
  const [transcodeTemplateIds, setTranscodeTemplateIds] = useState<string[]>([]);
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

  // ---- 转码（M2）：多选模板发起 → 每个模板各入队一条 transcode_jobs（Worker 认领执行） ----
  const openTranscode = async (record: MediaListItem) => {
    setTranscodeTarget(record);
    setTranscodeTemplateIds([]);
    setTranscodeTemplatesLoading(true);
    try {
      const data = (await fetchJson("/api/admin/templates")) as { items: TemplateOption[] };
      const list = data.items ?? [];
      setTranscodeTemplates(list);
      // 默认勾选「默认模板」（可多选；无默认则勾首个，无模板则留空）
      const defaults = list.filter((t) => t.is_default);
      setTranscodeTemplateIds(defaults.length ? defaults.map((t) => t.id) : list[0] ? [list[0].id] : []);
    } catch (e) {
      if ((e as Error).message === "未登录") return;
      message.error(e instanceof Error ? e.message : "加载转码模板失败");
    } finally {
      setTranscodeTemplatesLoading(false);
    }
  };

  const handleTranscodeSubmit = async () => {
    if (!transcodeTarget || !transcodeTemplateIds.length) return;
    setTranscodeSubmitting(true);
    try {
      const res = (await fetchJson(`/api/admin/media/${transcodeTarget.id}/transcode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_ids: transcodeTemplateIds }),
      })) as { jobs: Array<{ job_id: string }> };
      const count = res.jobs?.length ?? 0;
      message.success(`已入队 ${count} 个转码任务，可在「转码任务」页查看进度`);
      setTranscodeTarget(null);
      void load();
    } catch (e) {
      if ((e as Error).message === "未登录") return;
      message.error(e instanceof Error ? e.message : "发起转码失败");
    } finally {
      setTranscodeSubmitting(false);
    }
  };

  const selectedTemplates = transcodeTemplates.filter((t) => transcodeTemplateIds.includes(t.id));

  // ---- 转码产物列表（按模板）：抽屉展示 + 解密播放 + 按模板删除（spec.md §1.3/§5.5/§6） ----
  // 播放纪律：管理端只向分发端换一个签名主清单 URL（预览账号），清单 / 密钥 / 分片直达浏览器；
  // 明文 CEK 只由分发端 key 接口下发（P0，spec.md §4.3），管理端不接触密钥材料。
  const [productsTarget, setProductsTarget] = useState<{ id: string; title: string | null } | null>(null);
  const [productsDetail, setProductsDetail] = useState<MediaDetail | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [playLoadingKey, setPlayLoadingKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{
    title: string;
    manifestUrl: string;
    encrypted: boolean;
    templateId: string;
    /** 浏览器能否直连分片（对象桶 CORS 探测；false 时弹窗内立即给出根因提示） */
    corsOk: boolean | null;
  } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  const loadProducts = useCallback(
    async (id: string) => {
      setProductsLoading(true);
      try {
        setProductsDetail((await fetchJson(`/api/admin/media/${id}`)) as MediaDetail);
      } catch (e) {
        if ((e as Error).message !== "未登录") {
          message.error(e instanceof Error ? e.message : "产物列表加载失败");
        }
      } finally {
        setProductsLoading(false);
      }
    },
    [fetchJson, message],
  );

  const openProducts = (record: { id: string; title: string | null }) => {
    setProductsTarget(record);
    setProductsDetail(null);
    void loadProducts(record.id);
  };

  const handleDeleteProduct = (p: MediaProduct) => {
    const target = productsTarget;
    if (!target) return;
    const label = productLabel(p);
    const prefix = p.templateId
      ? `proceed/${target.id}/${p.templateId}/`
      : `proceed/${target.id}/（旧布局顶层）`;
    modal.confirm({
      title: `确认删除「${label}」这套产物？`,
      content: (
        <div>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            将删除 <Typography.Text code>{prefix}</Typography.Text> 下 {p.objects} 个对象（
            {formatSize(p.bytes)}）。
          </Typography.Paragraph>
          <Typography.Text type="danger">
            不可恢复；该产物的播放会立即失效。加密密钥（hls_keys）与转码任务历史保留（密钥可能被其它模板产物共用）。
          </Typography.Text>
        </div>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const res = (await fetchJson(
            `/api/admin/media/${target.id}/products/${p.templateId || PRODUCT_LEGACY_ID}`,
            { method: "DELETE" },
          )) as { deleted: number };
          message.success(`已删除「${label}」产物（${res.deleted} 个对象）`);
          void load();
          void loadProducts(target.id);
        } catch (e) {
          if ((e as Error).message !== "未登录") {
            message.error(e instanceof Error ? e.message : "删除产物失败");
          }
        }
      },
    });
  };

  const handlePlayProduct = async (p: MediaProduct) => {
    const target = productsTarget;
    if (!target) return;
    const key = p.templateId || PRODUCT_LEGACY_ID;
    setPlayLoadingKey(key);
    try {
      const res = (await fetchJson(`/api/admin/media/${target.id}/preview-play`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 空串 = 显式请求旧布局产物（proceed/{id}/ 顶层清单，spec.md §6.3）
        body: JSON.stringify({ template_id: p.templateId }),
      })) as {
        manifest_url: string;
        template_id: string;
        encrypted: boolean;
        browser_cors_ok: boolean | null;
      };
      setPlayError(null);
      setPlaying({
        title: `${productLabel(p)} · ${target.title ?? target.id}`,
        manifestUrl: res.manifest_url,
        encrypted: res.encrypted,
        templateId: res.template_id,
        corsOk: res.browser_cors_ok,
      });
    } catch (e) {
      if ((e as Error).message !== "未登录") {
        message.error(e instanceof Error ? e.message : "播放准备失败");
      }
    } finally {
      setPlayLoadingKey(null);
    }
  };

  const productColumns: ColumnsType<MediaProduct> = [
    {
      title: "模板",
      dataIndex: "templateId",
      render: (templateId: string, p) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Tag color={templateId ? "geekblue" : "default"} style={{ width: "fit-content", marginInlineEnd: 0 }}>
            {productLabel(p)}
          </Tag>
          <Typography.Text code style={{ fontSize: 11, wordBreak: "break-all" }}>
            {templateId
              ? `proceed/${productsTarget?.id ?? "{id}"}/${templateId}/`
              : `proceed/${productsTarget?.id ?? "{id}"}/（旧布局）`}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "变体",
      dataIndex: "variants",
      width: 100,
      render: (variants: string[]) => (variants.length ? variants.join(" / ") : "—"),
    },
    { title: "对象数", dataIndex: "objects", width: 80 },
    { title: "体积", dataIndex: "bytes", width: 110, render: (bytes: number) => formatSize(bytes) },
    {
      title: "操作",
      key: "ops",
      width: 160,
      render: (_, p) => {
        const key = p.templateId || PRODUCT_LEGACY_ID;
        return (
          <Space size={0}>
            <Button
              type="link"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={playLoadingKey === key}
              onClick={() => void handlePlayProduct(p)}
            >
              播放
            </Button>
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDeleteProduct(p)}
            >
              删除
            </Button>
          </Space>
        );
      },
    },
  ];

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
      { key: "cover", icon: <PictureOutlined />, label: "设置封面" },
    ],
    onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
      domEvent.stopPropagation();
      if (key === "cover") setCoverTarget(record);
      else if (key === "transcode") void openTranscode(record);
      else if (key === "subtitle") todoHint("字幕管理", "M4 字幕与元数据")();
      else if (key === "metadata") void handleGenerateMetadata(record);
    },
  });

  // 封面上传（双模式共用，spec.md §2.3）：手动上传的 File 与截帧导出的 JPEG Blob（包装成 File）
  // 都走同一端点 POST /api/admin/media/{id}/cover?filename=…，服务端逻辑无差别
  const handleCoverUpload = async (file: File) => {
    if (!coverTarget) return;
    setCoverUploading(true);
    try {
      await uploadTo(
        `/api/admin/media/${coverTarget.id}/cover?filename=${encodeURIComponent(file.name)}`,
        file,
      );
      message.success("封面设置成功");
      setCoverTarget(null);
      void load();
    } catch (e) {
      if ((e as Error).message !== "未登录") {
        message.error(e instanceof Error ? e.message : "封面设置失败");
      }
    } finally {
      setCoverUploading(false);
    }
  };

  // 复制媒资 ID（列表展示名列与详情弹窗共用；stopPropagation 防止触发行点击）
  const copyId = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      message.success(`媒资 ID 已复制：${id}`);
    } catch {
      message.error("复制失败（浏览器未授权剪贴板），请手动选择复制");
    }
  };

  const columns: ColumnsType<MediaListItem> = [
    {
      // 封面（首列缩略图，spec.md §3.1）：经 GET /api/admin/media/{id}/cover 读取，antd Image 点击预览大图
      title: "封面",
      dataIndex: "posterKey",
      width: 110,
      render: (posterKey: string | null, record) =>
        posterKey ? (
          <Image
            src={`/api/admin/media/${record.id}/cover`}
            alt={`封面：${record.title ?? record.id}`}
            width={84}
            height={48}
            style={{ objectFit: "cover", borderRadius: 4, background: "#f5f5f5" }}
          />
        ) : (
          <Tag color="default">未设置</Tag>
        ),
    },
    {
      // 展示名（第二行放媒资 ID，右侧复制按钮；ID 与 original 文件名永不改变，intent.md）
      title: "展示名",
      dataIndex: "title",
      ellipsis: true,
      render: (title: string | null, record) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <Typography.Text ellipsis={{ tooltip: title ?? "媒资数据库内无该记录（存储孤儿对象）" }}>
              {title ?? "—"}
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

          <div className="flex items-center">
            {record.id}
            <Tooltip title="复制媒资 ID">
              <Button
                color="default"
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={(e) => void copyId(e, record.id)}
              />
            </Tooltip>
          </div>
        </div>
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
                <div style={{ marginBottom: 4 }}>点击查看产物列表（播放 / 删除）</div>
                {row.products.map((p) => (
                  <div key={p.templateId || "legacy"}>
                    {productLabel(p)}：{p.objects} 个对象
                    {p.variants.length > 0 ? `（${p.variants.join(" / ")}）` : ""}
                  </div>
                ))}
              </div>
            }
          >
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openProducts(row)}>
              {row.products.length} 组产物 · {row.assets.proceed} 个对象
            </Button>
          </Tooltip>
        ) : (
          <Tag color="default">无</Tag>
        ),
    },
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

      {/* 预览：弹窗用 Video.js 播放 original 原视频（intent.md；同源请求自动带会话 Cookie） */}
      {preview && (
        <Modal
          open
          title={`预览：${preview.title ?? preview.id}`}
          width={880}
          footer={null}
          onCancel={() => setPreview(null)}
          destroyOnHidden
        >
          <VideoPreviewPlayer src={`/api/admin/media/${preview.id}/original`} />
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
                <Space size={8} wrap>
                  <Typography.Text>
                    {detail.products.length} 组产物 · {detail.assets.proceed} 个对象
                  </Typography.Text>
                  <Button
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={() => {
                      setDetailOpen(false);
                      openProducts({ id: detail.id, title: detail.title });
                    }}
                  >
                    产物列表（播放 / 删除）
                  </Button>
                </Space>
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

      {/* 转码：**多选**模板发起（M2，ADR-0008/0014）；每个模板各出一套产物，
          分辨率 / 帧率 / 码率均不低于源的档位由 Worker 在探测后自动跳过，全档跳过则按源规格兜底出一档 */}
      <Modal
        open={transcodeTarget !== null}
        title={`发起转码：${transcodeTarget?.title ?? transcodeTarget?.id ?? ""}`}
        okText={transcodeTemplateIds.length > 1 ? `发起 ${transcodeTemplateIds.length} 个转码任务` : "发起转码"}
        cancelText="取消"
        confirmLoading={transcodeSubmitting}
        okButtonProps={{ disabled: !transcodeTemplateIds.length }}
        onOk={() => void handleTranscodeSubmit()}
        onCancel={() => setTranscodeTarget(null)}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ display: "flex", marginTop: 8 }}>
          <div>
            <Typography.Text type="secondary">转码模板（可多选，每个模板各出一套产物）</Typography.Text>
            <Select
              mode="multiple"
              optionFilterProp="label"
              style={{ width: "100%", marginTop: 4 }}
              placeholder={transcodeTemplatesLoading ? "加载模板…" : "请选择一个或多个模板"}
              loading={transcodeTemplatesLoading}
              value={transcodeTemplateIds}
              onChange={(v: string[]) => setTranscodeTemplateIds(v)}
              notFoundContent={<Empty description="暂无模板，请先到「转码模板」页创建" />}
              options={transcodeTemplates.map((t) => ({
                value: t.id,
                label: `${t.name}${t.is_default ? "（默认）" : ""}`,
              }))}
            />
          </div>
          {selectedTemplates.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {selectedTemplates.map((t) => (
                <Space key={t.id} size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    {t.name}
                  </Typography.Text>
                  <Tag color={t.keep_original ? "purple" : "geekblue"}>
                    {t.keep_original ? "保持原视频（仅封装 + 可选加密）" : "转码"}
                  </Tag>
                  <Tag color={t.encrypt ? "red" : "default"}>
                    {t.encrypt ? "AES-128 加密" : "不加密"}
                  </Tag>
                  <Tag>{t.format}</Tag>
                </Space>
              ))}
            </div>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            发起后每个模板各入队一条任务，由 Worker 认领执行：ffprobe 探测 → 按模板逐档转码（分辨率 / 帧率 / 码率均不低于源的档位自动跳过；
            全部档位都无降级时按源规格兜底产出一档）→ 上传 proceed/{transcodeTarget?.id ?? "{id}"}/{"{模板id}"}/。进度与失败原因见「转码任务」页。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 设置封面（双模式，spec.md §2.3 / intent.md「更多」菜单）：
          模式 A 手动上传（拖拽图片）；模式 B 视频截帧（浏览器侧 video → canvas → JPEG，
          以 poster.jpg 走同一端点，服务端落键 cover/{id}/poster.{ext} 并回写 posterKey） */}
      <Modal
        open={coverTarget !== null}
        title={`设置封面：${coverTarget?.title ?? coverTarget?.id ?? ""}`}
        footer={null}
        onCancel={() => setCoverTarget(null)}
        destroyOnHidden
      >
        {coverTarget && (
          <Tabs
            defaultActiveKey="upload"
            items={[
              {
                key: "upload",
                label: "手动上传",
                children: (
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
                ),
              },
              {
                key: "capture",
                label: "视频截帧",
                children: (
                  <CoverFrameCapture
                    src={`/api/admin/media/${coverTarget.id}/original`}
                    uploading={coverUploading}
                    onCapture={(blob) =>
                      void handleCoverUpload(
                        new File([blob], "poster.jpg", { type: "image/jpeg" }),
                      )
                    }
                  />
                ),
              },
            ]}
          />
        )}
      </Modal>

      {/* 转码产物列表（按模板）：播放（分发端签名链路，浏览器本地解密）/ 按模板删除（spec.md §1.3/§5.5/§6） */}
      <Drawer
        open={productsTarget !== null}
        width={780}
        title={`转码产物：${productsTarget?.title ?? productsTarget?.id ?? ""}`}
        onClose={() => setProductsTarget(null)}
        destroyOnHidden
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={productsLoading}
            onClick={() => productsTarget && void loadProducts(productsTarget.id)}
          >
            刷新
          </Button>
        }
      >
        <Table<MediaProduct>
          rowKey={(p) => p.templateId || PRODUCT_LEGACY_ID}
          columns={productColumns}
          dataSource={productsDetail?.products ?? []}
          loading={productsLoading}
          size="small"
          pagination={false}
          scroll={{ y: "calc(100vh - 320px)" }}
          locale={{ emptyText: <Empty description="尚无转码产物（「更多 → 转码」发起，按模板落在 proceed/{id}/{模板id}/）" /> }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          播放：管理端只向分发端换一个签名主清单 URL，清单 / 密钥 / 分片直达浏览器——
          明文密钥（CEK）只由分发端下发、浏览器本地解密。若画面不加载：多为分发端 CORS
          （<Typography.Text code>DELIVERY_CORS_ORIGINS</Typography.Text>）或对象桶 CORS 未放行管理端源站；
          预览账号未配置时接口返回 501（见 dev-workflow §5.3）。
          删除：仅移除该模板子树的存储对象；加密密钥与转码任务历史保留。存在进行中的同模板任务时拒绝删除。
        </Typography.Paragraph>
      </Drawer>

      {/* 解密播放：HLS 直连分发端（hls.js；Safari 走原生 HLS），密钥由分发端下发后浏览器本地解密 */}
      <Modal
        open={playing !== null}
        title={`播放：${playing?.title ?? ""}`}
        width={880}
        footer={null}
        onCancel={() => setPlaying(null)}
        destroyOnHidden
      >
        {playing && (
          <>
            <HlsPreviewPlayer src={playing.manifestUrl} onError={(m) => setPlayError(m)} />
            <Space size={6} style={{ marginTop: 8 }} wrap>
              <Tag color={playing.encrypted ? "red" : "default"}>
                {playing.encrypted ? "AES-128 加密（浏览器本地解密）" : "未加密"}
              </Tag>
              {playing.templateId ? (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {playing.templateId}
                </Typography.Text>
              ) : (
                <Tag>旧布局产物</Tag>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                签名清单 / 密钥 / 分片由分发端与对象存储直达浏览器（不经管理端）
              </Typography.Text>
            </Space>
            {playing.corsOk === false && (
              <Typography.Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                对象桶未放行当前管理端源站的 CORS：浏览器直连分片会被拦，表现为「有总时长但一直转圈」。
                请在对象桶加 CORS 规则（Origin 含本页源站、Method GET/HEAD、Header *），或把 STORAGE_DRIVER 临时切 local
                验证（见 dev-workflow §8）。
              </Typography.Paragraph>
            )}
            {playError && (
              <Typography.Paragraph type="danger" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
                {playError}
              </Typography.Paragraph>
            )}
          </>
        )}
      </Modal>
    </ProCard>
  );
}
