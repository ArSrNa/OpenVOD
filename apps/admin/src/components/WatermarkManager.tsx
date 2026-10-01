"use client";

// 水印管理页（/watermarks，spec.md §10.5 / ADR-0018）：模板列表 / 新建 / 编辑 / 删除 + 图片上传。
// 图片型两步创建（POST JSON → PUT 图片字节，spec.md §10.2）；弹窗内以浏览器侧 CSS / DOM
// 按 §10.4 定位换算表实时预览（服务端不渲染预览图）。
import { DeleteOutlined, EditOutlined, PictureOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import {
  App,
  Button,
  ColorPicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Slider,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  type UploadFile,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTableBodyHeight } from "./tableScroll";
import {
  WATERMARK_ANCHORS,
  WATERMARK_BLEND_MODES,
  WATERMARK_FONTS,
  type WatermarkParamsValue,
} from "@openvod/contracts";
import { WATERMARK_FONT_LABELS, type WatermarkAnchor, type WatermarkFont } from "@openvod/shared";
import {
  anchorCss,
  blendCss,
  WATERMARK_ANCHOR_LABELS,
  WATERMARK_BLEND_LABELS,
  WATERMARK_FONT_CSS,
  watermarkParamsSummary,
} from "@/lib/watermark-preview";

// ---- 与 contracts WatermarkTemplateDTO 对应的客户端形状 ----

interface WatermarkItem {
  id: string;
  name: string;
  description: string | null;
  type: "image" | "text";
  params: WatermarkParamsValue;
  image_ext: string | null;
  image_key: string | null;
  image_bytes: number | null;
  image_width: number | null;
  image_height: number | null;
  image_status: "ready" | "missing";
  referenced_by: number;
  created_at: string;
  updated_at: string;
}

// ---- 弹窗表单值（params 拆平便于编辑；提交时再组装） ----

interface WatermarkFormValues {
  name: string;
  description?: string;
  type: "image" | "text";
  anchor: WatermarkAnchor;
  offset_x: number;
  offset_y: number;
  opacity: number;
  blend: "normal" | "overlay";
  // 图片型尺寸
  image_size_mode: "pixels" | "percent";
  px_width?: number;
  px_height?: number;
  pct_width?: number;
  pct_height?: number;
  // 文字型专属
  text?: string;
  font?: WatermarkFont;
  color?: string;
  shadow_enabled?: boolean;
  shadow_color?: string;
  shadow_offset_x?: number;
  shadow_offset_y?: number;
  text_size_mode?: "pixels" | "percent";
  text_px?: number;
  text_pct?: number;
}

const ANCHOR_CELL_LABELS: Record<WatermarkAnchor, string> = {
  top_left: "↖",
  top_center: "↑",
  top_right: "↗",
  middle_left: "←",
  center: "✛",
  middle_right: "→",
  bottom_left: "↙",
  bottom_center: "↓",
  bottom_right: "↘",
};

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";

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

/** antd ColorPicker 值 → #RRGGBB（disabledAlpha 下 toHexString 恒 7 位，此处再兜底截断） */
function colorToHex(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 7);
  const hex = (value as { toHexString?: () => string })?.toHexString?.() ?? "#ffffff";
  return hex.length > 7 ? hex.slice(0, 7) : hex;
}

export function WatermarkManager() {
  const { message } = App.useApp();
  // 表格滚动约定（spec.md §3.0）：表体限高内部滚动、表头固定，页面不随条目数增长
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [form] = Form.useForm<WatermarkFormValues>();
  const [items, setItems] = useState<WatermarkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WatermarkItem | null>(null);
  const [saving, setSaving] = useState(false);
  // 待上传图片（create 必选 / edit 可选替换）：beforeUpload 返回 false，仅存本地 File
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<UploadFile[]>([]);

  const type = Form.useWatch("type", form);
  const shadowEnabled = Form.useWatch("shadow_enabled", form);
  const imageSizeMode = Form.useWatch("image_size_mode", form);
  const textSizeMode = Form.useWatch("text_size_mode", form);
  const anchor = Form.useWatch("anchor", form);
  const offsetX = Form.useWatch("offset_x", form);
  const offsetY = Form.useWatch("offset_y", form);
  const opacity = Form.useWatch("opacity", form);
  const blend = Form.useWatch("blend", form);
  const color = Form.useWatch("color", form);
  const font = Form.useWatch("font", form);
  const shadowColor = Form.useWatch("shadow_color", form);
  const shadowOffsetX = Form.useWatch("shadow_offset_x", form);
  const shadowOffsetY = Form.useWatch("shadow_offset_y", form);
  const text = Form.useWatch("text", form);
  const textPx = Form.useWatch("text_px", form);
  const textPct = Form.useWatch("text_pct", form);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/watermarks", { cache: "no-store" });
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { items: WatermarkItem[] };
      setItems(data.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setEditing(null);
    setPendingFile(null);
    setFileList([]);
    form.setFieldsValue({
      name: "",
      description: "",
      type: "text",
      anchor: "bottom_right",
      offset_x: -24,
      offset_y: -24,
      opacity: 100,
      blend: "normal",
      image_size_mode: "pixels",
      px_width: 160,
      px_height: undefined,
      pct_width: undefined,
      pct_height: 10,
      text: "OpenVOD",
      font: "sans_bold",
      color: "#ffffff",
      shadow_enabled: true,
      shadow_color: "#000000",
      shadow_offset_x: 2,
      shadow_offset_y: 2,
      text_size_mode: "pixels",
      text_px: 32,
      text_pct: 5,
    });
    setModalOpen(true);
  };

  const openEdit = (item: WatermarkItem) => {
    setEditing(item);
    setPendingFile(null);
    setFileList([]);
    const p = item.params;
    const common = {
      name: item.name,
      description: item.description ?? "",
      type: item.type,
      anchor: p.anchor,
      offset_x: p.offset_x,
      offset_y: p.offset_y,
      opacity: p.opacity,
      blend: p.blend,
    };
    if (p.type === "image") {
      form.setFieldsValue({
        ...common,
        image_size_mode: p.size.mode,
        px_width: p.size.mode === "pixels" ? p.size.width : undefined,
        px_height: p.size.mode === "pixels" ? p.size.height : undefined,
        pct_width: p.size.mode === "percent" ? p.size.width : undefined,
        pct_height: p.size.mode === "percent" ? p.size.height : undefined,
      });
    } else {
      form.setFieldsValue({
        ...common,
        text: p.text,
        font: p.font,
        color: p.color,
        shadow_enabled: p.shadow != null,
        shadow_color: p.shadow?.color ?? "#000000",
        shadow_offset_x: p.shadow?.offset_x ?? 2,
        shadow_offset_y: p.shadow?.offset_y ?? 2,
        text_size_mode: p.size.mode,
        text_px: p.size.mode === "pixels" ? p.size.size : 32,
        text_pct: p.size.mode === "percent" ? p.size.size : 5,
      });
    }
    setModalOpen(true);
  };

  /** 表单值 → contracts WatermarkParams（按类型组装；尺寸单边留空即「至少一项」交给服务端校验兜底） */
  const buildParams = (values: WatermarkFormValues): Record<string, unknown> | null => {
    const common = {
      type: values.type,
      anchor: values.anchor,
      offset_x: values.offset_x ?? 0,
      offset_y: values.offset_y ?? 0,
      opacity: values.opacity ?? 100,
      blend: values.blend ?? "normal",
    };
    if (values.type === "image") {
      const size =
        values.image_size_mode === "pixels"
          ? {
            mode: "pixels",
            ...(values.px_width != null ? { width: values.px_width } : {}),
            ...(values.px_height != null ? { height: values.px_height } : {}),
          }
          : {
            mode: "percent",
            ...(values.pct_width != null ? { width: values.pct_width } : {}),
            ...(values.pct_height != null ? { height: values.pct_height } : {}),
          };
      return { ...common, size };
    }
    const size =
      values.text_size_mode === "percent"
        ? { mode: "percent", size: values.text_pct }
        : { mode: "pixels", size: values.text_px };
    return {
      ...common,
      text: (values.text ?? "").trim(),
      font: values.font,
      color: colorToHex(values.color),
      shadow: values.shadow_enabled
        ? {
          color: colorToHex(values.shadow_color),
          offset_x: values.shadow_offset_x ?? 2,
          offset_y: values.shadow_offset_y ?? 2,
        }
        : null,
      size,
    };
  };

  /** 上传图片字节（octet-stream，spec.md §10.2）；失败返回错误消息 */
  const uploadImage = async (id: string, file: File): Promise<void> => {
    const res = await fetch(`/api/admin/watermarks/${id}/image`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(await parseError(res));
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (values.type === "image" && !editing && !pendingFile) {
        message.error("图片水印模板需要先选择一张水印图片");
        return;
      }
      setSaving(true);
      const payload = {
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        params: buildParams(values),
      };
      const res = await fetch(
        editing ? `/api/admin/watermarks/${editing.id}` : "/api/admin/watermarks",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { item: WatermarkItem };
      // 图片上传：create 必传（前面已拦）；edit 仅在选择了新文件时替换（spec.md §10.2 覆盖式 PUT）
      if (values.type === "image" && pendingFile) {
        try {
          await uploadImage(data.item.id, pendingFile);
        } catch (e) {
          message.warning(
            `${editing ? "模板已保存，但" : "模板已创建，但"}图片上传失败：${(e as Error).message}；请在列表中重新上传`,
            6,
          );
          setModalOpen(false);
          await reload();
          return;
        }
      }
      message.success(editing ? "水印模板已更新" : "水印模板已创建");
      setModalOpen(false);
      await reload();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验错误，弹窗内提示
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: WatermarkItem) => {
    try {
      const res = await fetch(`/api/admin/watermarks/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await parseError(res));
      message.success("水印模板已删除");
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<WatermarkItem> = [
    {
      title: "预览",
      key: "preview",
      width: 96,
      render: (_, row) =>
        row.type === "text" ? (
          <span
            style={{
              ...WATERMARK_FONT_CSS[row.params.type === "text" ? row.params.font : "sans"],
              color: row.params.type === "text" ? row.params.color : undefined,
              fontSize: 16,
              textShadow: row.params.type === "text" && row.params.shadow
                ? `${row.params.shadow.offset_x}px ${row.params.shadow.offset_y}px 0 ${row.params.shadow.color}`
                : undefined,
            }}
          >
            {row.params.type === "text" ? row.params.text : ""}
          </span>
        ) : row.image_status === "ready" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/admin/watermarks/${row.id}/image`}
            alt={row.name}
            style={{ maxHeight: 40, maxWidth: 88, objectFit: "contain", display: "block" }}
          />
        ) : (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            待上传
          </Typography.Text>
        ),
    },
    {
      title: "名称",
      dataIndex: "name",
      width: 170,
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    { title: "描述", dataIndex: "description", width: 160, ellipsis: true, render: (v) => v || "—" },
    {
      title: "类型",
      dataIndex: "type",
      width: 90,
      render: (t: "image" | "text", row) =>
        t === "text" ? (
          <Tag color="geekblue">文字</Tag>
        ) : (
          <Space size={4}>
            <Tag color="purple">图片</Tag>
            {row.image_status === "missing" && <Tag color="orange">缺图</Tag>}
          </Space>
        ),
    },
    {
      title: "参数",
      key: "params",
      render: (_, row) => (
        <div style={{ lineHeight: 1.7 }}>
          {watermarkParamsSummary(row.params).map((line, i) => (
            <div key={i}>
              <Typography.Text style={{ fontSize: 12 }}>{line}</Typography.Text>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: "被引用",
      dataIndex: "referenced_by",
      width: 80,
      render: (n: number) => (n > 0 ? <Tag color="blue">{n} 个模板</Tag> : "—"),
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
      width: 150,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.type === "image" && row.image_status === "missing" && (
            <Button
              type="link"
              size="small"
              icon={<PictureOutlined />}
              onClick={() => {
                openEdit(row);
                message.info("请选择水印图片后保存");
              }}
            >
              传图
            </Button>
          )}
          <Popconfirm
            title="删除水印模板"
            description="已产出的视频不受影响；被转码模板引用时需先解除引用"
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
          新建水印模板
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
      </Space>
      <div ref={tableRef}>
        <Table<WatermarkItem>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个水印模板` }}
          size="middle"
          scroll={{ x: 1080, y: bodyHeight }}
          locale={{ emptyText: <Empty description="暂无水印模板，点击「新建水印模板」创建" /> }}
        />
      </div>

      <Modal
        title={editing ? `编辑水印模板：${editing.name}` : "新建水印模板"}
        open={modalOpen}
        width={860}
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
        okText={editing ? "保存" : "创建"}
      >
        <Space size="large" align="start" style={{ display: "flex", marginTop: 8 }}>
          <Form<WatermarkFormValues> form={form} layout="vertical" style={{ flex: 1, minWidth: 440 }}>
            <Space size="middle" style={{ display: "flex" }}>
              <Form.Item
                name="name"
                label="模板名"
                rules={[
                  { required: true, message: "请输入模板名" },
                  { max: 64, message: "≤64 字符" },
                ]}
                style={{ flex: 1, minWidth: 200 }}
              >
                <Input placeholder="如：右下角 LOGO" />
              </Form.Item>
              <Form.Item name="description" label="描述" style={{ flex: 1, minWidth: 200 }}>
                <Input placeholder="可选" maxLength={191} />
              </Form.Item>
            </Space>

            <Form.Item name="type" label="水印类型" tooltip="创建后不可更改">
              <Radio.Group
                disabled={Boolean(editing)}
                options={[
                  { value: "text", label: "文字水印" },
                  { value: "image", label: "图片水印" },
                ]}
                optionType="button"
                buttonStyle="solid"
              />
            </Form.Item>

            {type === "text" && (
              <>
                <Space size="middle" style={{ display: "flex" }} align="baseline">
                  <Form.Item
                    name="text"
                    label="文字内容"
                    rules={[
                      { required: true, message: "请输入文字内容" },
                      { max: 64, message: "≤64 字符" },
                    ]}
                    style={{ minWidth: 220 }}
                  >
                    <Input placeholder="如：OpenVOD·试看" maxLength={64} showCount />
                  </Form.Item>
                  <Form.Item name="font" label="字体" rules={[{ required: true }]}>
                    <Select
                      style={{ width: 200 }}
                      options={WATERMARK_FONTS.map((f) => ({ value: f, label: WATERMARK_FONT_LABELS[f] }))}
                    />
                  </Form.Item>
                </Space>
                {/* 颜色单独一行：与文字 / 字体同排时被 flex 压缩到约 1 字符宽，hex 文本竖排换行 */}
                <Form.Item name="color" label="颜色" rules={[{ required: true }]} style={{ width: 200, minWidth: 200 }}>
                  <ColorPicker
                    disabledAlpha
                    format="hex"
                    showText={(c) => <Typography.Text style={{ fontSize: 12, whiteSpace: "nowrap" }}>{c.toHexString()}</Typography.Text>}
                  />
                </Form.Item>
                <Form.Item name="text_size_mode" label="字号">
                  <Radio.Group
                    options={[
                      { value: "pixels", label: "像素" },
                      { value: "percent", label: "占画面高比例" },
                    ]}
                    optionType="button"
                  />
                </Form.Item>
                {textSizeMode === "pixels" ? (
                  <Form.Item name="text_px" label="字号（px）" rules={[{ required: true, message: "请输入字号" }]}>
                    <InputNumber min={4} max={512} precision={0} style={{ width: 140 }} />
                  </Form.Item>
                ) : (
                  <Form.Item name="text_pct" label="字号 = 画面高 ×" rules={[{ required: true, message: "请输入百分比" }]}>
                    <InputNumber min={1} max={100} precision={0} addonAfter="%" style={{ width: 140 }} />
                  </Form.Item>
                )}
                <Space size="middle" style={{ display: "flex" }} align="baseline">
                  <Form.Item name="shadow_enabled" label="阴影" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  {shadowEnabled && (
                    <>
                      <Form.Item name="shadow_color" label="阴影颜色" rules={[{ required: true }]}>
                        <ColorPicker disabledAlpha format="hex" />
                      </Form.Item>
                      <Form.Item name="shadow_offset_x" label="阴影 X 偏移">
                        <InputNumber min={-100} max={100} precision={0} style={{ width: 110 }} />
                      </Form.Item>
                      <Form.Item name="shadow_offset_y" label="阴影 Y 偏移">
                        <InputNumber min={-100} max={100} precision={0} style={{ width: 110 }} />
                      </Form.Item>
                    </>
                  )}
                </Space>
              </>
            )}

            {type === "image" && (
              <>
                <Form.Item
                  label={editing ? "水印图片（选择即替换）" : "水印图片"}
                  required={!editing}
                  tooltip="PNG / JPG / WebP，≤2 MiB；按文件内容识别格式（透明底请用 PNG / WebP）"
                >
                  <Upload
                    accept={IMAGE_ACCEPT}
                    maxCount={1}
                    fileList={fileList}
                    beforeUpload={() => false}
                    onChange={({ fileList: fl }) => {
                      setFileList(fl);
                      setPendingFile((fl[0]?.originFileObj as File | undefined) ?? null);
                    }}
                    onRemove={() => {
                      setFileList([]);
                      setPendingFile(null);
                    }}
                  >
                    <Button icon={<PictureOutlined />}>选择图片</Button>
                  </Upload>
                  {!editing && (
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                      创建时必须选择图片；模板创建成功后图片随之上传
                    </Typography.Text>
                  )}
                </Form.Item>
                <Form.Item name="image_size_mode" label="尺寸">
                  <Radio.Group
                    options={[
                      { value: "pixels", label: "像素" },
                      { value: "percent", label: "占画面比例" },
                    ]}
                    optionType="button"
                  />
                </Form.Item>
                {imageSizeMode === "pixels" ? (
                  <Space size="middle" style={{ display: "flex" }} align="baseline">
                    <Form.Item name="px_width" label="宽（px）" tooltip="宽高至少填一项；仅填一项时按原图宽高比等比缩放">
                      <InputNumber min={1} max={7680} precision={0} style={{ width: 130 }} />
                    </Form.Item>
                    <Form.Item name="px_height" label="高（px）">
                      <InputNumber min={1} max={7680} precision={0} style={{ width: 130 }} />
                    </Form.Item>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      至少填一项；两项同时填写按精确尺寸缩放（允许变形）
                    </Typography.Text>
                  </Space>
                ) : (
                  <Space size="middle" style={{ display: "flex" }} align="baseline">
                    <Form.Item name="pct_width" label="宽 = 画面宽 ×" tooltip="宽高至少填一项；仅填一项时按原图宽高比等比缩放">
                      <InputNumber min={1} max={100} precision={0} addonAfter="%" style={{ width: 130 }} />
                    </Form.Item>
                    <Form.Item name="pct_height" label="高 = 画面高 ×">
                      <InputNumber min={1} max={100} precision={0} addonAfter="%" style={{ width: 130 }} />
                    </Form.Item>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      两项同时填写按对应边分别缩放（允许变形）
                    </Typography.Text>
                  </Space>
                )}
              </>
            )}

            <Typography.Title level={5} style={{ marginTop: 8 }}>
              位置与合成
            </Typography.Title>
            <Space size="middle" style={{ display: "flex" }} align="baseline">
              <Form.Item name="anchor" label="位置" rules={[{ required: true }]}>
                <AnchorPicker />
              </Form.Item>
              <Form.Item name="offset_x" label="X 偏移（px）" tooltip="锚点对齐后的位移：正 = 右移，负 = 左移；右 / 下锚点常用负值做内边距">
                <InputNumber min={-4096} max={4096} precision={0} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="offset_y" label="Y 偏移（px）" tooltip="锚点对齐后的位移：正 = 下移，负 = 上移">
                <InputNumber min={-4096} max={4096} precision={0} style={{ width: 120 }} />
              </Form.Item>
            </Space>
            <Space size="large" style={{ display: "flex" }} align="baseline">
              <Form.Item name="opacity" label="透明度（%）">
                <Slider min={0} max={100} style={{ width: 160 }} />
              </Form.Item>
              <Form.Item name="blend" label="混合方式" tooltip="正常 = 标准 alpha 叠加；叠加 = Overlay 混合模式（逐像素混合，转码更耗时）">
                <Radio.Group
                  options={WATERMARK_BLEND_MODES.map((b) => ({ value: b, label: WATERMARK_BLEND_LABELS[b] }))}
                  optionType="button"
                  buttonStyle="solid"
                />
              </Form.Item>
            </Space>
          </Form>

          <WatermarkPreview
            form={form}
            editing={editing}
            pendingFile={pendingFile}
            type={type}
            anchor={anchor}
            offsetX={offsetX}
            offsetY={offsetY}
            opacity={opacity}
            blend={blend}
            color={color}
            font={font}
            shadowColor={shadowColor}
            shadowOffsetX={shadowOffsetX}
            shadowOffsetY={shadowOffsetY}
            text={text}
            textSizeMode={textSizeMode}
            textPx={textPx}
            textPct={textPct}
            shadowEnabled={shadowEnabled}
          />
        </Space>
      </Modal>
    </ProCard>
  );
}

/** 九宫格位置选择器（spec.md §10.5）：3×3 网格点选锚点 */
function AnchorPicker({ value, onChange }: { value?: WatermarkAnchor; onChange?: (v: WatermarkAnchor) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 36px)",
        gap: 4,
      }}
    >
      {WATERMARK_ANCHORS.map((a) => (
        <Tooltip key={a} title={WATERMARK_ANCHOR_LABELS[a]}>
          <Button
            size="small"
            type={value === a ? "primary" : "default"}
            onClick={() => onChange?.(a)}
            style={{ paddingInline: 0 }}
          >
            {ANCHOR_CELL_LABELS[a]}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

/** 实时预览（浏览器侧 CSS / DOM，spec.md §10.5）：16:9 样板画面 + 当前参数的水印元素 */
function WatermarkPreview(props: {
  form: ReturnType<typeof Form.useForm<WatermarkFormValues>>[0];
  editing: WatermarkItem | null;
  pendingFile: File | null;
  type?: "image" | "text";
  anchor?: WatermarkAnchor;
  offsetX?: number;
  offsetY?: number;
  opacity?: number;
  blend?: "normal" | "overlay";
  color?: string;
  font?: WatermarkFont;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  text?: string;
  textSizeMode?: "pixels" | "percent";
  textPx?: number;
  textPct?: number;
  shadowEnabled?: boolean;
}) {
  const {
    editing, pendingFile, type = "text", anchor = "bottom_right", offsetX = 0, offsetY = 0,
    opacity = 100, blend = "normal", color = "#ffffff", font = "sans", shadowColor = "#000000",
    shadowOffsetX = 2, shadowOffsetY = 2, text = "", textSizeMode = "pixels", textPx = 32,
    textPct = 5, shadowEnabled = false,
  } = props;
  void props.form; // 参数经 Form.useWatch 传入，form 仅用于未来扩展
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (pendingFile) {
      const url = URL.createObjectURL(pendingFile);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    if (editing?.type === "image" && editing.image_status === "ready") {
      setPreviewUrl(`/api/admin/watermarks/${editing.id}/image?v=${encodeURIComponent(editing.updated_at)}`);
      return undefined;
    }
    setPreviewUrl(null);
    return undefined;
  }, [pendingFile, editing]);

  // 文字预览字号：按 16:9 样板（宽 100% 计）近似换算，仅示意
  const textFontSize = textSizeMode === "percent" ? `clamp(8px, ${textPct}%, 96px)` : `${textPx}px`;
  return (
    <div style={{ width: 300, flexShrink: 0 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
        预览（示意；成像以 ffmpeg 编译为准）
      </Typography.Text>
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          borderRadius: 8,
          overflow: "hidden",
          background:
            "linear-gradient(135deg,#37474f 0%,#546e7a 45%,#78909c 100%)",
        }}
      >
        <div
          style={{
            ...anchorCss(anchor, offsetX ?? 0, offsetY ?? 0),
            opacity: (opacity ?? 100) / 100,
            mixBlendMode: blendCss(blend),
            maxWidth: "60%",
            pointerEvents: "none",
          }}
        >
          {type === "text" ? (
            <span
              style={{
                ...WATERMARK_FONT_CSS[font],
                color: colorToHex(color),
                fontSize: textFontSize,
                whiteSpace: "nowrap",
                textShadow: shadowEnabled
                  ? `${shadowOffsetX ?? 2}px ${shadowOffsetY ?? 2}px 0 ${colorToHex(shadowColor)}`
                  : undefined,
              }}
            >
              {text || "文字水印"}
            </span>
          ) : previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="水印预览" style={{ maxWidth: "100%", display: "block" }} />
          ) : (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              选择图片后预览
            </Typography.Text>
          )}
        </div>
      </div>
    </div>
  );
}
