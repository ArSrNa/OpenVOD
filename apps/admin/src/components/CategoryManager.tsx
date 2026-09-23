"use client";

// 分类管理页（/categories，spec.md §8.1 / ADR-0016）：媒资分类的**独立模块**。
// 无限层级（邻接表 parent_id，客户端组树）；支持新建 / 新建子分类 / 编辑（改名 / 描述 / 移动 / 排序）/ 删除。
// 删除规则：有子分类 → 拒绝（先删 / 先移走）；该分类下的媒资只被置空引用（不删媒资），
// 并由服务端同步刷新这些媒资的自定义元数据投影（spec.md §8.3）。
import {
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  TreeSelect,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState, type Key } from "react";
import { buildCategoryTree, collectSubtreeIds, type CategoryTreeNode } from "@/lib/category-tree";
import { useTableBodyHeight } from "./tableScroll";

/** 与 contracts MediaCategoryDTO 对应的客户端形状（扁平列表，层级由 parent_id 表达） */
interface CategoryItem {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  /** 系统内置分类（默认分类「其他」）：不可删除 */
  is_system: boolean;
  media_count: number;
  descendant_media_count: number;
  created_at: string;
  updated_at: string;
}

/** 表格行 = 分类节点 + children（antd 树形表格） */
interface CategoryTreeRow extends CategoryItem {
  children?: CategoryTreeRow[];
}

interface CategoryFormValues {
  name: string;
  description?: string;
  /** undefined = 顶级（服务端 null） */
  parent_id?: string | null;
  sort_order: number;
}

/** TreeSelect 选项（标题带完整路径；编辑时自身与子孙禁选，避免环路） */
interface CategoryOption {
  value: string;
  title: string;
  disabled?: boolean;
  children?: CategoryOption[];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body?.error?.message ?? `请求失败（HTTP ${res.status}）`;
  } catch {
    return `请求失败（HTTP ${res.status}）`;
  }
}

/** 扁平列表 → antd 树形表格行（叶子不带 children，避免渲染无意义的展开箭头） */
function toTreeRows(items: CategoryItem[]): CategoryTreeRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const toRow = (node: CategoryTreeNode): CategoryTreeRow => ({
    ...(byId.get(node.id) as CategoryItem),
    children: node.children.length ? node.children.map(toRow) : undefined,
  });
  return buildCategoryTree(items.map((i) => ({
    id: i.id,
    name: i.name,
    parentId: i.parent_id,
    sortOrder: i.sort_order,
  }))).map(toRow);
}

export function CategoryManager() {
  const { message } = App.useApp();
  // 表格滚动约定（spec.md §3.0）：表体限高内部滚动、表头固定
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);

  const [items, setItems] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRowKeys, setExpandedRowKeys] = useState<Key[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CategoryFormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/categories", { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { items: CategoryItem[] };
      const list = data.items ?? [];
      setItems(list);
      setExpandedRowKeys(list.filter((i) => list.some((c) => c.parent_id === i.id)).map((i) => i.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const treeRows = useMemo(() => toTreeRows(items), [items]);

  /** TreeSelect 选项：顶级 + 全树（编辑时排除自身与子孙，避免环路） */
  const parentOptions = useMemo<CategoryOption[]>(() => {
    const nodes = items.map((i) => ({
      id: i.id,
      name: i.name,
      parentId: i.parent_id,
      sortOrder: i.sort_order,
    }));
    const excluded = editing ? new Set(collectSubtreeIds(nodes, editing.id)) : new Set<string>();
    const toOption = (node: CategoryTreeNode): CategoryOption => ({
      value: node.id,
      title: node.path,
      disabled: excluded.has(node.id),
      children: node.children.length ? node.children.map(toOption) : undefined,
    });
    return [
      { value: "", title: "顶级分类" },
      ...buildCategoryTree(nodes).map(toOption),
    ];
  }, [items, editing]);

  const openCreate = (parent: CategoryItem | null) => {
    setEditing(null);
    form.setFieldsValue({
      name: "",
      description: "",
      parent_id: parent?.id ?? "",
      sort_order: 0,
    });
    setModalOpen(true);
  };

  const openEdit = (item: CategoryItem) => {
    setEditing(item);
    form.setFieldsValue({
      name: item.name,
      description: item.description ?? "",
      parent_id: item.parent_id ?? "",
      sort_order: item.sort_order,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const body = {
        name: values.name,
        description: values.description?.trim() ? values.description.trim() : null,
        parent_id: values.parent_id ? values.parent_id : null,
        sort_order: values.sort_order ?? 0,
      };
      const res = await fetch(
        editing ? `/api/admin/categories/${editing.id}` : "/api/admin/categories",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { refreshed_media?: number };
      message.success(
        editing
          ? `分类已更新${data.refreshed_media ? `（${data.refreshed_media} 个媒资的自定义元数据已同步）` : ""}`
          : "分类已创建",
      );
      setModalOpen(false);
      setEditing(null);
      void load();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验失败
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // 确认交互由行内 Popconfirm 承担（不再叠加二次确认弹窗）
  const handleDelete = async (item: CategoryItem) => {
    try {
      const res = await fetch(`/api/admin/categories/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { affected_media?: number };
      message.success(
        `分类「${item.name}」已删除${data.affected_media ? `（${data.affected_media} 个媒资已变为未分类）` : ""}`,
      );
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const columns: ColumnsType<CategoryTreeRow> = [
    {
      title: "分类名",
      dataIndex: "name",
      ellipsis: true,
      render: (name: string, row) => (
        <Space size={6}>
          <Typography.Text strong>{name}</Typography.Text>
          {row.is_system && (
            <Tooltip title="系统默认分类：未设置分类的媒资默认归入它，且不可删除">
              <Tag color="blue">默认</Tag>
            </Tooltip>
          )}
          {row.descendant_media_count > row.media_count && (
            <Tooltip title={`含子孙分类共 ${row.descendant_media_count} 个媒资`}>
              <Tag color="default">+{row.descendant_media_count - row.media_count}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "描述",
      dataIndex: "description",
      ellipsis: true,
      render: (v: string | null) => v ?? "—",
    },
    { title: "直属媒资", dataIndex: "media_count", width: 90 },
    { title: "含子孙", dataIndex: "descendant_media_count", width: 90 },
    { title: "排序", dataIndex: "sort_order", width: 70 },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      width: 170,
      render: (iso: string) => <Typography.Text type="secondary">{formatTime(iso)}</Typography.Text>,
    },
    {
      title: "操作",
      key: "actions",
      width: 210,
      render: (_, row) => (
        <Space size={0}>
          <Tooltip title="新建子分类">
            <Button
              type="text"
              size="small"
              icon={<FolderAddOutlined />}
              onClick={() => openCreate(row)}
            />
          </Tooltip>
          <Tooltip title="编辑（改名 / 描述 / 移动 / 排序）">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          </Tooltip>
          {row.is_system ? (
            <Tooltip title="系统默认分类（未设置分类的媒资默认归入它），不可删除">
              <Button type="text" size="small" danger disabled icon={<DeleteOutlined />} />
            </Tooltip>
          ) : (
            <Popconfirm
              title={`确认删除分类「${row.name}」？`}
              description={
                <div style={{ maxWidth: 280 }}>
                  {row.media_count > 0
                    ? `${row.media_count} 个直属媒资会归入默认分类「其他」（媒资不会被删除，仅同步刷新自定义元数据里的分类投影）`
                    : "该分类下暂无直属媒资"}
                  <br />
                  含子孙分类共 {row.descendant_media_count} 个媒资；分类本身不可恢复。
                </div>
              }
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void handleDelete(row)}
            >
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <ProCard
      title="媒资分类"
      subTitle={`共 ${items.length} 个分类（无限层级；未设置分类的媒资归入默认分类「其他」；删除分类不会删除媒资）`}
      bordered={false}
      extra={
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(null)}>
            新建顶级分类
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="danger">分类列表获取失败：{error}</Typography.Text>{" "}
          <Button size="small" danger onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      <div ref={tableRef}>
        <Table<CategoryTreeRow>
          rowKey="id"
          columns={columns}
          dataSource={treeRows}
          loading={loading}
          pagination={false}
          size="middle"
          expandable={{
            expandedRowKeys,
            onExpandedRowsChange: (keys) => setExpandedRowKeys([...keys]),
            indentSize: 18,
          }}
          scroll={{ x: 1080, y: bodyHeight }}
          locale={{ emptyText: "暂无分类，点击右上角「新建顶级分类」开始（可逐级新建子分类）" }}
        />
      </div>

      <Modal
        open={modalOpen}
        title={editing ? `编辑分类：${editing.name}` : "新建分类"}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="parent_id"
            label="上级分类"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                上级可选任意层级（无限层级）；保存时会拒绝「把分类移动到自身或子孙之下」的环路操作
              </Typography.Text>
            }
          >
            <TreeSelect
              treeData={parentOptions}
              treeDefaultExpandAll
              allowClear
              placeholder="顶级分类"
              onChange={(v) => form.setFieldValue("parent_id", v ?? "")}
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="分类名"
            rules={[
              { required: true, message: "分类名不能为空" },
              { max: 64, message: "分类名最多 64 个字符" },
            ]}
          >
            <Input placeholder="如：电影 / 剧集 / 课程" />
          </Form.Item>
          <Form.Item
            name="description"
            label="描述（可选）"
            rules={[{ max: 191, message: "描述最多 191 个字符" }]}
          >
            <Input.TextArea rows={2} maxLength={191} showCount placeholder="分类说明（仅管理端展示）" />
          </Form.Item>
          <Form.Item
            name="sort_order"
            label="同级排序"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                数字越小越靠前（同级排序，默认 0）
              </Typography.Text>
            }
          >
            <InputNumber min={0} max={10000} style={{ width: 160 }} />
          </Form.Item>
        </Form>
      </Modal>
    </ProCard>
  );
}
