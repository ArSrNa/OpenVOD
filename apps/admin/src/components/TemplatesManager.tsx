"use client";

// 转码模板管理页（/templates，ADR-0014；intent.md「转码模板管理」）：
// 列表 / 新建 / 编辑 / 删除。模板字段与校验对应 contracts 的 TranscodeTemplateParams；
// keep_original = 保持原视频配置（只加密流程，无重编码参数）；encrypt = 加密开关（必须 HLS）；
// watermark_id = 关联的水印模板（spec.md §10.4 / ADR-0018）——转码时由 Worker 烧录进画面。
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTableBodyHeight } from "./tableScroll";
import Link from "next/link";

// ---- 与 contracts TranscodeTemplateDTO 对应的客户端形状 ----

interface Resolution {
  /** source = 保持原分辨率（不缩放，仍重编码；2026-10-05 增） */
  mode: "fixed" | "adaptive" | "source";
  width?: number;
  height?: number;
  max_width?: number;
  max_height?: number;
}

interface TemplateParams {
  codec: "libx264" | "libx265";
  bitrate_kbps?: number;
  crf?: number;
  fps?: number;
  preset?: string;
  resolutions: Resolution[];
  audio_bitrate_kbps?: number;
}

interface TemplateItem {
  id: string;
  name: string;
  description: string | null;
  keep_original: boolean;
  encrypt: boolean;
  format: "HLS";
  params: TemplateParams | null;
  is_default: boolean;
  watermark_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 水印模板下拉的最小形状（对应 contracts WatermarkTemplateDTO 只需这几项） */
interface WatermarkOption {
  id: string;
  name: string;
  type: "image" | "text";
  image_status: "ready" | "missing";
}

// ---- 弹窗表单值（params 拆平便于编辑；提交时再组装） ----

interface TemplateFormValues {
  name: string;
  description?: string;
  keep_original: boolean;
  encrypt: boolean;
  codec: "libx264" | "libx265";
  bitrate_mode: "bitrate" | "crf";
  bitrate_kbps?: number;
  crf?: number;
  fps?: number;
  preset?: string;
  audio_bitrate_kbps?: number;
  resolutions?: Resolution[];
  is_default: boolean;
  /** 关联水印模板 ID；undefined = 不变（PATCH），null = 解除关联 */
  watermark_id?: string | null;
}

const PRESET_OPTIONS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
].map((p) => ({ value: p, label: p }));

const CODEC_OPTIONS = [
  { value: "libx264", label: "H.264（libx264）" },
  { value: "libx265", label: "H.265（libx265）" },
];

/** 分辨率档位摘要（列表列展示） */
function resolutionSummary(r: Resolution): string {
  if (r.mode === "source") return "保持原分辨率";
  if (r.mode === "fixed") return `${r.width}×${r.height}`;
  const parts: string[] = [];
  if (r.max_width != null) parts.push(`宽≤${r.max_width}`);
  if (r.max_height != null) parts.push(`高≤${r.max_height}`);
  return `自适应（${parts.join("，")}）`;
}

function paramsSummary(p: TemplateParams): string[] {
  const rate = p.crf != null ? `CRF ${p.crf}` : `${p.bitrate_kbps} kbps`;
  const lines = [
    `${p.codec} · ${rate}`,
    p.resolutions.map(resolutionSummary).join("；"),
  ];
  if (p.fps != null) lines.push(`帧率 ${p.fps} fps`);
  if (p.preset) lines.push(`preset ${p.preset}`);
  return lines;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** 统一错误信封取消息 */
async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message ?? `请求失败（HTTP ${res.status}）`;
  } catch {
    return `请求失败（HTTP ${res.status}）`;
  }
}

export function TemplatesManager() {
  const { message } = App.useApp();
  // 表格滚动约定（spec.md §3）：表体限高内部滚动、表头固定，页面不随条目数增长
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [form] = Form.useForm<TemplateFormValues>();
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [watermarks, setWatermarks] = useState<WatermarkOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateItem | null>(null);
  const [saving, setSaving] = useState(false);

  const keepOriginal = Form.useWatch("keep_original", form);
  const bitrateMode = Form.useWatch("bitrate_mode", form);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/templates", { cache: "no-store" });
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { items: TemplateItem[] };
      setItems(data.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  // 水印下拉数据源（关联列展示与弹窗选择共用；失败不阻塞模板管理）
  const loadWatermarks = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/watermarks", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: WatermarkOption[] };
      setWatermarks(data.items);
    } catch {
      // 忽略：水印模块不可用时模板管理仍可用
    }
  }, []);

  useEffect(() => {
    void reload();
    void loadWatermarks();
  }, [reload, loadWatermarks]);

  const watermarkName = useCallback(
    (id: string | null) => watermarks.find((w) => w.id === id)?.name ?? null,
    [watermarks],
  );

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: "",
      description: "",
      keep_original: false,
      encrypt: true,
      codec: "libx264",
      bitrate_mode: "bitrate",
      bitrate_kbps: 5000,
      crf: 23,
      fps: undefined,
      preset: "veryfast",
      audio_bitrate_kbps: 128,
      resolutions: [{ mode: "adaptive", max_width: 1920 }],
      is_default: false,
      watermark_id: null,
    });
    setModalOpen(true);
  };

  const openEdit = (item: TemplateItem) => {
    setEditing(item);
    const p = item.params;
    form.setFieldsValue({
      name: item.name,
      description: item.description ?? "",
      keep_original: item.keep_original,
      encrypt: item.encrypt,
      codec: p?.codec ?? "libx264",
      bitrate_mode: p?.crf != null ? "crf" : "bitrate",
      bitrate_kbps: p?.bitrate_kbps,
      crf: p?.crf,
      fps: p?.fps,
      preset: p?.preset,
      audio_bitrate_kbps: p?.audio_bitrate_kbps ?? 128,
      resolutions: p?.resolutions ?? [{ mode: "adaptive", max_width: 1920 }],
      is_default: item.is_default,
      watermark_id: item.watermark_id,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload: Record<string, unknown> = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        keep_original: values.keep_original,
        encrypt: values.encrypt,
        format: "HLS",
        is_default: values.is_default,
        // keep_original 不重编码，水印关联必须显式清空（否则服务端 400：不可携带水印）
        watermark_id: values.keep_original ? null : (values.watermark_id ?? null),
      };
      if (!values.keep_original) {
        const raw = (values.resolutions ?? []).filter((r) => r != null);
        for (const r of raw) {
          if (r.mode === "fixed" && (r.width == null || r.height == null)) {
            message.error("固定分辨率档位必须填写宽和高");
            return;
          }
          if (r.mode === "adaptive" && r.max_width == null && r.max_height == null) {
            message.error("自适应档位至少填写一个上限（宽或高）");
            return;
          }
        }
        const resolutions = raw.map((r) => {
          if (r.mode === "source") return { mode: "source" };
          if (r.mode === "fixed") return { mode: "fixed", width: r.width, height: r.height };
          return {
            mode: "adaptive",
            ...(r.max_width != null ? { max_width: r.max_width } : {}),
            ...(r.max_height != null ? { max_height: r.max_height } : {}),
          };
        });
        payload.params = {
          codec: values.codec,
          ...(values.bitrate_mode === "crf"
            ? { crf: values.crf }
            : { bitrate_kbps: values.bitrate_kbps }),
          ...(values.fps != null ? { fps: values.fps } : {}),
          ...(values.preset ? { preset: values.preset } : {}),
          audio_bitrate_kbps: values.audio_bitrate_kbps ?? 128,
          resolutions,
        };
      }
      const res = await fetch(
        editing ? `/api/admin/templates/${editing.id}` : "/api/admin/templates",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error(await parseError(res));
      message.success(editing ? "模板已更新" : "模板已创建");
      setModalOpen(false);
      await reload();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验错误，弹窗内提示
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: TemplateItem) => {
    try {
      const res = await fetch(`/api/admin/templates/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await parseError(res));
      message.success("模板已删除");
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<TemplateItem> = [
    {
      title: "模板名",
      dataIndex: "name",
      width: 180,
      render: (name: string, row) => (
        <Space size={6}>
          <Typography.Text strong>{name}</Typography.Text>
          {row.is_default && <Tag color="blue">默认</Tag>}
        </Space>
      ),
    },
    { title: "描述", dataIndex: "description", width: 200, ellipsis: true, render: (v) => v || "—" },
    {
      title: "模式",
      dataIndex: "keep_original",
      width: 110,
      render: (keep: boolean) =>
        keep ? <Tag color="purple">保持原视频</Tag> : <Tag color="geekblue">转码</Tag>,
    },
    {
      title: "加密",
      dataIndex: "encrypt",
      width: 90,
      render: (encrypt: boolean) =>
        encrypt ? <Tag color="red">AES-128</Tag> : <Tag>不加密</Tag>,
    },
    { title: "格式", dataIndex: "format", width: 80, render: () => <Tag>M3U8</Tag> },
    {
      title: "水印",
      dataIndex: "watermark_id",
      width: 130,
      render: (id: string | null) =>
        id ? (
          <Tag color="cyan">{watermarkName(id) ?? "已关联水印"}</Tag>
        ) : (
          <Typography.Text type="secondary">无</Typography.Text>
        ),
    },
    {
      title: "参数",
      dataIndex: "params",
      render: (p: TemplateParams | null, row) =>
        row.keep_original ? (
          <Typography.Text type="secondary">源参数直出（仅封装 + 可选加密）</Typography.Text>
        ) : p ? (
          <div style={{ lineHeight: 1.7 }}>
            {paramsSummary(p).map((line, i) => (
              <div key={i}>
                <Typography.Text style={{ fontSize: 12 }}>{line}</Typography.Text>
              </div>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      width: 160,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatTime(v)}
        </Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 130,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除模板"
            description="已发起的转码任务不受影响（提交时已快照模板）"
            onConfirm={() => void remove(row)}
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
    <ProCard bordered={false}>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建模板
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
      </Space>
      <div ref={tableRef}>
        <Table<TemplateItem>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个模板` }}
          size="middle"
          scroll={{ x: 1080, y: bodyHeight }}
          locale={{ emptyText: <Empty description="暂无模板，点击「新建模板」创建" /> }}
        />
      </div>

      <Modal
        title={editing ? `编辑模板：${editing.name}` : "新建转码模板"}
        open={modalOpen}
        width={720}
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
        okText={editing ? "保存" : "创建"}
      >
        <Form<TemplateFormValues> form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Space size="middle" style={{ display: "flex" }} align="start">
            <Form.Item
              name="name"
              label="模板名"
              rules={[
                { required: true, message: "请输入模板名" },
                { max: 100, message: "≤100 字符" },
              ]}
              style={{ flex: 1, minWidth: 240 }}
            >
              <Input placeholder="如：1080p H.264 加密" />
            </Form.Item>
            <Form.Item name="description" label="描述" style={{ flex: 1, minWidth: 240 }}>
              <Input placeholder="可选" maxLength={500} />
            </Form.Item>
          </Space>

          <Space size="middle" wrap>
            <Form.Item
              name="keep_original"
              label="保持原视频配置"
              valuePropName="checked"
              tooltip="不重编码，仅封装为 HLS + 可选加密（只加密流程）"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="encrypt"
              label="加密（AES-128）"
              valuePropName="checked"
              tooltip="开启后走密钥管理流程：生成媒资 CEK 并加密分片；输出必须为 HLS"
            >
              <Switch />
            </Form.Item>
            <Form.Item name="is_default" label="设为默认" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="输出格式">
              <Tag>M3U8（HLS）</Tag>
            </Form.Item>
          </Space>

          {!keepOriginal && (
            <>
              <Form.Item
                name="watermark_id"
                label="水印"
                tooltip={
                  <>前往<Link href="/watermarks">水印管理</Link>设置模板，如更新水印需重新转码才生效</>
                }
              >
                <Select
                  allowClear
                  placeholder="选择水印模板"
                  style={{ width: 260 }}
                  options={watermarks.map((w) => ({
                    value: w.id,
                    label: `${w.name}（${w.type === "image" ? "图片" : "文字"}${w.image_status === "missing" ? " · 待上传图片" : ""
                      }）`,
                    disabled: w.image_status === "missing",
                  }))}
                  notFoundContent={
                    <Typography.Text type="secondary">暂无水印模板，请先到「水印管理」新建</Typography.Text>
                  }
                />
              </Form.Item>

              <Typography.Title level={5} style={{ marginTop: 8 }}>
                视频参数
              </Typography.Title>
              <Space size="middle" wrap>
                <Form.Item name="codec" label="编码器" rules={[{ required: true }]}>
                  <Select options={CODEC_OPTIONS} style={{ width: 180 }} />
                </Form.Item>
                <Form.Item name="preset" label="速度档 preset">
                  <Select options={PRESET_OPTIONS} allowClear style={{ width: 140 }} />
                </Form.Item>
                <Form.Item
                  name="fps"
                  label="目标帧率"
                  tooltip="留空保持源帧率，低于源帧率时会执行，高于则保持源帧率"
                >
                  <InputNumber min={1} max={240} precision={0} placeholder="保持源" style={{ width: 120 }} />
                </Form.Item>
                <Form.Item
                  name="audio_bitrate_kbps"
                  label="音频码率 (kbps)"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={32} max={320} precision={0} style={{ width: 120 }} />
                </Form.Item>
              </Space>

              <Form.Item name="bitrate_mode" label="码率控制">
                <Radio.Group
                  options={[
                    { value: "bitrate", label: "目标码率" },
                    { value: "crf", label: "CRF 恒定质量" },
                  ]}
                  optionType="button"
                  buttonStyle="solid"
                />
              </Form.Item>
              {bitrateMode === "crf" ? (
                <Form.Item
                  name="crf"
                  label="CRF 值"
                  rules={[{ required: true, message: "请输入 CRF" }]}
                  tooltip="越小质量越高：18–28 常用，默认 23"
                >
                  <InputNumber min={0} max={51} precision={0} style={{ width: 120 }} />
                </Form.Item>
              ) : (
                <Form.Item
                  name="bitrate_kbps"
                  label="视频码率 (kbps)"
                  rules={[{ required: true, message: "请输入码率" }]}
                >
                  <InputNumber min={100} max={200000} precision={0} style={{ width: 160 }} />
                </Form.Item>
              )}

              <Typography.Title level={5}>分辨率</Typography.Title>
              <Form.List name="resolutions">
                {(fields, { add, remove }) => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {fields.map((field) => (
                      <ResolutionRow key={field.key} fieldKey={field.key} onRemove={() => remove(field.name)} removable={fields.length > 1} />
                    ))}
                    <Button
                      type="dashed"
                      icon={<PlusOutlined />}
                      onClick={() => add({ mode: "fixed", width: 1920, height: 1080 })}
                      style={{ width: 200 }}
                    >
                      添加档位
                    </Button>
                  </div>
                )}
              </Form.List>
            </>
          )}
          {keepOriginal && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              「保持原视频配置」不重编码：源视频直接封装为 HLS 并按上方开关决定是否加密，
              无需配置编码 / 码率 / 分辨率参数；因不重编码，**不能关联水印**（烧录必须重新编码画面）。
            </Typography.Paragraph>
          )}
        </Form>
      </Modal>
    </ProCard>
  );
}

/** 单条分辨率档位行：固定（宽×高）或自适应（宽/高上限约束） */
function ResolutionRow({
  fieldKey,
  onRemove,
  removable,
}: {
  fieldKey: number;
  onRemove: () => void;
  removable: boolean;
}) {
  const form = Form.useFormInstance<TemplateFormValues>();
  const mode = Form.useWatch(["resolutions", fieldKey, "mode"], form);
  return (
    <Space size="small" wrap align="baseline">
      <Form.Item name={[fieldKey, "mode"]} noStyle>
        <Select
          style={{ width: 130 }}
          options={[
            { value: "fixed", label: "固定" },
            { value: "adaptive", label: "自适应" },
            { value: "source", label: "保持原分辨率" },
          ]}
        />
      </Form.Item>
      {mode === "source" ? (
        <Tooltip title="分辨率跟随源视频（不缩放），仍重编码；是否执行由帧率 / 码率维度判定——三维度均不低于源时该档跳过。需完全不重编码请用模板级「保持原视频配置」">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            分辨率取源视频（不缩放）
          </Typography.Text>
        </Tooltip>
      ) : mode === "adaptive" ? (
        <>
          <Form.Item name={[fieldKey, "max_width"]} noStyle>
            <InputNumber min={16} max={7680} precision={0} placeholder="宽度上限" style={{ width: 130 }} />
          </Form.Item>
          <Typography.Text type="secondary">/</Typography.Text>
          <Form.Item name={[fieldKey, "max_height"]} noStyle>
            <InputNumber min={16} max={4320} precision={0} placeholder="高度上限" style={{ width: 130 }} />
          </Form.Item>
          <Tooltip title="等比缩放至约束内；源已在约束内则分辨率取源值，是否执行按分辨率 / 帧率 / 码率三维度合并判定（intent 规则 4）">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              上限约束（至少填一项）
            </Typography.Text>
          </Tooltip>
        </>
      ) : (
        <>
          <Form.Item name={[fieldKey, "width"]} noStyle rules={[{ required: true, message: "宽" }]}>
            <InputNumber min={16} max={7680} precision={0} placeholder="宽" style={{ width: 110 }} />
          </Form.Item>
          <Typography.Text type="secondary">×</Typography.Text>
          <Form.Item name={[fieldKey, "height"]} noStyle rules={[{ required: true, message: "高" }]}>
            <InputNumber min={16} max={4320} precision={0} placeholder="高" style={{ width: 110 }} />
          </Form.Item>
        </>
      )}
      {removable && (
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={onRemove} />
      )}
    </Space>
  );
}
