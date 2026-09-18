"use client";

// 密钥管理页（/keys，spec.md §4.3；ADR-0006）：
// 列表（每媒资一份密钥）+ 详情 + 删除 + MK 轮换。
// 红线：页面**不展示任何明文 / 封装密钥**；这里只有 kid / method / iv / mk_ver 等元数据。
import {
  DeleteOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  ReloadOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { ProCard } from "@ant-design/pro-components";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Empty,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTableBodyHeight } from "./tableScroll";

// ---- 与 contracts MediaKeyListItem / MediaKeyDetail / MasterKeyStatus 对应的客户端形状 ----

interface KeyItem {
  media_id: string;
  title: string | null;
  media_status: string | null;
  kid: string;
  method: string;
  mk_ver: number;
  created_at: string;
  proceed_objects: number | null;
}

interface KeyDetail extends KeyItem {
  iv: string;
  active_sessions: number;
}

interface MkStatus {
  active_ver: number;
  versions: Array<{ ver: number; keys: number }>;
  total_keys: number;
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

export function KeysManager() {
  const { message, modal } = App.useApp();
  // 表格滚动约定（spec.md §3）：表体限高内部滚动、表头固定，页面不随条目数增长
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [items, setItems] = useState<KeyItem[]>([]);
  const [mk, setMk] = useState<MkStatus | null>(null);
  const [mkError, setMkError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { items: KeyItem[] };
      setItems(data.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // MK 状态单独取：MASTER_KEYS 未配置时不影响密钥列表展示
    try {
      const res = await fetch("/api/admin/keys/mk", { cache: "no-store" });
      if (!res.ok) throw new Error(await parseError(res));
      setMk((await res.json()) as MkStatus);
      setMkError(null);
    } catch (e) {
      setMk(null);
      setMkError((e as Error).message);
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDetail = async (item: KeyItem) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/keys/${item.media_id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { item: KeyDetail };
      setDetail(data.item);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const remove = async (item: KeyItem) => {
    try {
      const res = await fetch(`/api/admin/keys/${item.media_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await parseError(res));
      message.success("密钥已删除（该媒资加密产物需重转码才能重新可播）");
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      const res = await fetch("/api/admin/keys/rotate-mk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await parseError(res));
      const r = (await res.json()) as { rotated: number; failed: number; to_ver: number };
      if (r.failed > 0) {
        modal.warning({
          title: "MK 轮换部分失败",
          content: `成功 ${r.rotated} 条，失败 ${r.failed} 条（目标版本 v${r.to_ver}）。请检查 MASTER_KEYS 是否保留了旧版本，详见审计日志。`,
        });
      } else {
        message.success(`MK 轮换完成：${r.rotated} 条已重封装到 v${r.to_ver}（无需重转码）`);
      }
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRotating(false);
    }
  };

  const pendingCount = mk ? mk.versions.filter((v) => v.ver !== mk.active_ver).reduce((a, v) => a + v.keys, 0) : 0;

  const columns: ColumnsType<KeyItem> = [
    { title: "媒资 ID", dataIndex: "media_id", width: 120 },
    {
      title: "展示名",
      dataIndex: "title",
      width: 180,
      ellipsis: true,
      render: (v: string | null) => v || "—",
    },
    {
      title: "媒资状态",
      dataIndex: "media_status",
      width: 110,
      render: (v: string | null) => (v ? <Tag>{v}</Tag> : "—"),
    },
    {
      title: "kid",
      dataIndex: "kid",
      width: 200,
      ellipsis: true,
      render: (kid: string) => (
        <Tooltip title={kid}>
          <Typography.Text code style={{ fontSize: 12 }}>
            {kid.slice(0, 16)}…
          </Typography.Text>
        </Tooltip>
      ),
    },
    { title: "算法", dataIndex: "method", width: 100, render: (v: string) => <Tag color="red">{v}</Tag> },
    {
      title: "MK 版本",
      dataIndex: "mk_ver",
      width: 100,
      render: (ver: number, row) => (
        <Tag color={mk && ver !== mk.active_ver ? "orange" : "blue"}>
          v{ver}
          {mk && ver !== mk.active_ver ? "（待轮换）" : ""}
        </Tag>
      ),
    },
    {
      title: "加密产物对象",
      dataIndex: "proceed_objects",
      width: 120,
      render: (v: number | null) => (v == null ? <Typography.Text type="secondary">存储不可用</Typography.Text> : v),
    },
    {
      title: "生成时间",
      dataIndex: "created_at",
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
      width: 140,
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => void openDetail(row)}>
            详情
          </Button>
          <Popconfirm
            title="删除该媒资密钥"
            description="删除后该媒资的加密分片将无法解密（需重转码重新生成密钥）。确定删除？"
            okButtonProps={{ danger: true }}
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
      {mkError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="MASTER_KEYS 不可用"
          description={`${mkError}（密钥列表仍可查看，但 MK 轮换不可用；见 .env.example）`}
        />
      ) : (
        mk && (
          <Alert
            type={pendingCount > 0 ? "info" : "success"}
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <Space size={8} wrap>
                <span>
                  当前封装版本 <Tag color="blue">v{mk.active_ver}</Tag>
                </span>
                <span>
                  已配置版本：
                  {mk.versions.map((v) => (
                    <Tag key={v.ver}>
                      v{v.ver} · {v.keys} 个
                    </Tag>
                  ))}
                </span>
                <span>密钥总数 {mk.total_keys}</span>
              </Space>
            }
            description={
              pendingCount > 0
                ? `有 ${pendingCount} 条密钥仍封装在旧版本下，执行「轮换 MK」后即可收敛（不需要重转码，因此不会打断播放）。`
                : "所有密钥均封装在当前版本下，无需轮换。"
            }
          />
        )
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
        <Popconfirm
          title="轮换主密钥（MK）"
          description="将旧版本封装的全部 CEK 重新封装到当前版本，不重转码。轮换前请确认 MASTER_KEYS 已保留旧版本。"
          onConfirm={() => void rotate()}
          disabled={!mk || pendingCount === 0}
        >
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={rotating}
            disabled={!mk || pendingCount === 0}
          >
            轮换 MK
          </Button>
        </Popconfirm>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每媒资一份独立密钥（spec.md §4.1）；明文密钥不在此展示，仅由分发端鉴权后下发。
        </Typography.Text>
      </Space>

      <div ref={tableRef}>
        <Table<KeyItem>
          rowKey="media_id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个密钥` }}
          size="middle"
          scroll={{ x: 1240, y: bodyHeight }}
          locale={{
            emptyText: (
              <Empty
                description="暂无密钥：对媒资发起「加密」转码后，Worker 会为该媒资生成一份独立 CEK"
              />
            ),
          }}
        />
      </div>

      <Modal
        title={detail ? `密钥详情：${detail.media_id}` : "密钥详情"}
        open={Boolean(detail) || detailLoading}
        onCancel={() => setDetail(null)}
        footer={null}
        width={640}
      >
        {detail && (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 8 }}>
            <Descriptions.Item label="媒资 ID">{detail.media_id}</Descriptions.Item>
            <Descriptions.Item label="展示名">{detail.title ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="kid">
              <Typography.Text code copyable>
                {detail.kid}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="算法">{detail.method}</Descriptions.Item>
            <Descriptions.Item label="IV（公开值，清单可见）">
              <Typography.Text code>{detail.iv}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="MK 版本">v{detail.mk_ver}</Descriptions.Item>
            <Descriptions.Item label="生成时间">{formatTime(detail.created_at)}</Descriptions.Item>
            <Descriptions.Item label="加密产物对象">{detail.proceed_objects ?? "存储不可用"}</Descriptions.Item>
            <Descriptions.Item label="使用中的播放会话">{detail.active_sessions}</Descriptions.Item>
            <Descriptions.Item label="明文密钥">
              <Space size={6}>
                <KeyOutlined />
                <Typography.Text type="secondary">
                  不展示（P0 红线：明文 CEK 仅由分发端密钥接口在鉴权后下发，spec.md §4.3）
                </Typography.Text>
              </Space>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </ProCard>
  );
}
