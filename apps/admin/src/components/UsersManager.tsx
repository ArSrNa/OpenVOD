"use client";

// 播放端用户管理页（/users，ADR-0004 `users` 表；ADR-0007 账户域）：
//   列表 / 新建 / 编辑（展示名 / 状态 / 并发上限）/ 重置密码 / 吊销会话 / 删除。
// 与 admin_users（better-auth 控制台账号）是两套体系，本页只管播放端用户（App 登录账号）。
//
// 关键安全口径（ADR-0007，服务端强制，UI 只做提示）：
//   - 封禁（ACTIVE → DISABLED）立即吊销该用户全部未过期播放会话，分发端 login 直接拒绝；
//   - 重置密码同样吊销会话——否则旧凭据签发的 JWT 在 exp 前仍可播放；
//   - 已下发分片 token 在自身 exp 内仍有效（ADR-0006 已声明接受）；
//   - 口令只写不读：界面无任何查看口令 / 哈希的入口，DTO 也不返回 password_hash。
import {
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
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
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { generatePassword } from "@/lib/random-password";
import { useTableBodyHeight } from "./tableScroll";

// ---- 与 contracts UserDTO 对应的客户端形状 ----

type UserStatus = "ACTIVE" | "DISABLED";

interface UserItem {
  id: string;
  username: string;
  display_name: string | null;
  status: UserStatus;
  /** 单用户并发播放会话上限，0 = 不限（ADR-0007） */
  max_concurrent_sessions: number;
  /** 未过期且未吊销的播放会话数 */
  active_sessions: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 新建 / 编辑共用表单值（口令仅新建与重置时出现） */
interface UserFormValues {
  username?: string;
  display_name?: string;
  password?: string;
  max_concurrent_sessions: number;
  status: UserStatus;
}

const MAX_CONCURRENT_SESSIONS_MAX = 10_000;

function formatTime(iso: string | null): string {
  if (!iso) return "—";
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

export function UsersManager() {
  const { message } = App.useApp();
  const router = useRouter();
  // 表格滚动约定（spec.md §3）：表体限高内部滚动、表头固定，页面不随条目数增长
  const tableRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useTableBodyHeight(tableRef);
  const [form] = Form.useForm<UserFormValues>();
  const [items, setItems] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserItem | null>(null);
  const [saving, setSaving] = useState(false);
  /** 重置密码弹窗的目标用户 */
  const [pwdTarget, setPwdTarget] = useState<UserItem | null>(null);
  const [pwdTargetOpen, setPwdTargetOpen] = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdForm] = Form.useForm<{ password: string; confirm: string }>();
  /** 初始密码明文可见性：随机生成后自动展开，便于复制交付 */
  const [createPwdVisible, setCreatePwdVisible] = useState(false);
  /** 重置密码明文可见性（同上） */
  const [resetPwdVisible, setResetPwdVisible] = useState(false);
  /** 吊销会话进行中的用户 id */
  const [revokingId, setRevokingId] = useState<string | null>(null);

  /** 会话过期 / 未登录统一回登录页 */
  const handleUnauthorized = useCallback(() => {
    message.warning("登录已过期，请重新登录");
    router.push("/login");
  }, [message, router]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const data = (await res.json()) as { items: UserItem[] };
      setItems(data.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [handleUnauthorized, message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      username: "",
      display_name: "",
      password: "",
      max_concurrent_sessions: 0,
      status: "ACTIVE",
    });
    setCreatePwdVisible(false);
    setModalOpen(true);
  };

  const openEdit = (item: UserItem) => {
    setEditing(item);
    form.setFieldsValue({
      // 用户名 / 口令不在编辑弹窗内：改用户名等同换账号（历史会话 / 播放记录都归属旧身份），
      // 当前里程碑以「新建 + 删除」替代；口令走独立的「重置密码」动作。
      username: item.username,
      display_name: item.display_name ?? "",
      max_concurrent_sessions: item.max_concurrent_sessions,
      status: item.status,
    });
    setCreatePwdVisible(false);
    setModalOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const isCreate = !editing;
      const payload: Record<string, unknown> = {
        display_name: values.display_name?.trim() || null,
        max_concurrent_sessions: values.max_concurrent_sessions ?? 0,
        status: values.status,
      };
      if (isCreate) {
        payload.username = values.username?.trim();
        payload.password = values.password;
      }
      const res = await fetch(editing ? `/api/admin/users/${editing.id}` : "/api/admin/users", {
        method: isCreate ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const body = (await res.json()) as { revoked_sessions?: number };
      if (isCreate) {
        message.success("用户已创建");
      } else if (body.revoked_sessions) {
        // 封禁的会话侧效果：用户已下线，正在播放的会话立即失效
        message.success(`已保存，并吊销 ${body.revoked_sessions} 个进行中的播放会话`);
      } else {
        message.success("用户已更新");
      }
      setModalOpen(false);
      await reload();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验错误，弹窗内提示
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const openResetPassword = (item: UserItem) => {
    setPwdTarget(item);
    pwdForm.resetFields();
    setResetPwdVisible(false);
    setPwdTargetOpen(true);
  };

  /** 随机生成 12 位初始口令：填入「新建」表单并展开明文（仅用于复制交付，不落日志） */
  const fillRandomInitialPassword = () => {
    const generated = generatePassword(12);
    form.setFieldValue("password", generated);
    setCreatePwdVisible(true);
    void form.validateFields(["password"]).catch(() => {}); // 重新校验，清掉此前的校验红字
  };

  /** 随机生成 12 位新口令：填入「重置密码」表单（含确认框）并展开明文 */
  const fillRandomNewPassword = () => {
    const generated = generatePassword(12);
    pwdForm.setFieldValue("password", generated);
    pwdForm.setFieldValue("confirm", generated);
    setResetPwdVisible(true);
    void pwdForm.validateFields(["password", "confirm"]).catch(() => {});
  };

  const submitResetPassword = async () => {
    if (!pwdTarget) return;
    try {
      const values = await pwdForm.validateFields();
      setPwdSaving(true);
      const res = await fetch(`/api/admin/users/${pwdTarget.id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: values.password }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const body = (await res.json()) as { revoked_sessions?: number };
      message.success(
        `「${pwdTarget.username}」口令已重置` +
        (body.revoked_sessions ? `，${body.revoked_sessions} 个旧会话已吊销` : ""),
      );
      setPwdTargetOpen(false);
      setPwdTarget(null);
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return; // 表单校验错误，弹窗内提示
      message.error((e as Error).message);
    } finally {
      setPwdSaving(false);
    }
  };

  const revokeSessions = async (item: UserItem) => {
    setRevokingId(item.id);
    try {
      const res = await fetch(`/api/admin/users/${item.id}/revoke-sessions`, { method: "POST" });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const body = (await res.json()) as { revoked_sessions?: number };
      message.success(
        body.revoked_sessions
          ? `已吊销 ${body.revoked_sessions} 个进行中的播放会话（用户可重新登录）`
          : "没有需要吊销的会话",
      );
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRevokingId(null);
    }
  };

  /** 启停（PATCH status）：封禁的会话侧效果由服务端执行，响应带回吊销条数 */
  const toggleStatus = async (item: UserItem) => {
    const next = item.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      const res = await fetch(`/api/admin/users/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const body = (await res.json()) as { revoked_sessions?: number };
      if (next === "DISABLED") {
        message.warning(
          body.revoked_sessions
            ? `已封禁「${item.username}」，${body.revoked_sessions} 个进行中的播放会话已吊销`
            : `已封禁「${item.username}」`,
        );
      } else {
        message.success(`已启用「${item.username}」`);
      }
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (item: UserItem) => {
    try {
      const res = await fetch(`/api/admin/users/${item.id}`, { method: "DELETE" });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) throw new Error(await parseError(res));
      const body = (await res.json()) as { revoked_sessions?: number };
      message.success(
        `用户「${item.username}」已删除` +
        (body.revoked_sessions ? `（${body.revoked_sessions} 个会话随用户级联删除）` : ""),
      );
      await reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // 客户端过滤：用户量随运营增长后应改为服务端 keyword + 分页（同 /media 的处理时机再收敛）
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter(
      (u) =>
        u.username.toLowerCase().includes(kw) ||
        (u.display_name ?? "").toLowerCase().includes(kw),
    );
  }, [items, keyword]);

  const columns: ColumnsType<UserItem> = [
    {
      title: "用户名",
      dataIndex: "username",
      width: 180,
      render: (username: string, row) => (
        <Space size={6}>
          <Typography.Text strong>{username}</Typography.Text>
          {row.status === "DISABLED" && <Tag color="red">已封禁</Tag>}
        </Space>
      ),
    },
    {
      title: "展示名",
      dataIndex: "display_name",
      width: 160,
      ellipsis: true,
      render: (v: string | null) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (v: UserStatus) =>
        v === "ACTIVE" ? <Tag color="green">可用</Tag> : <Tag color="red">封禁</Tag>,
    },
    {
      title: "并发上限",
      dataIndex: "max_concurrent_sessions",
      width: 110,
      render: (v: number) =>
        v === 0 ? (
          <Tooltip title="0 = 不限制单用户并发播放会话数（ADR-0007）">
            <Typography.Text type="secondary">不限</Typography.Text>
          </Tooltip>
        ) : (
          v
        ),
    },
    {
      title: "进行中会话",
      dataIndex: "active_sessions",
      width: 110,
      render: (v: number) =>
        v > 0 ? (
          <Tag color="blue">{v}</Tag>
        ) : (
          <Typography.Text type="secondary">0</Typography.Text>
        ),
    },
    {
      title: "最近登录",
      dataIndex: "last_login_at",
      width: 160,
      render: (v: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatTime(v)}
        </Typography.Text>
      ),
    },
    {
      title: "注册时间",
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
      width: 260,
      fixed: "right",
      render: (_, row) => (
        <Space size={4} wrap>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            icon={<KeyOutlined />}
            onClick={() => openResetPassword(row)}
          >
            重置密码
          </Button>
          <Button
            type="link"
            size="small"
            loading={revokingId === row.id}
            disabled={row.active_sessions === 0}
            onClick={() => void revokeSessions(row)}
          >
            吊销会话
          </Button>
          <Button
            type="link"
            size="small"
            danger={row.status === "ACTIVE"}
            icon={<StopOutlined />}
            onClick={() => void toggleStatus(row)}
          >
            {row.status === "ACTIVE" ? "封禁" : "启用"}
          </Button>
          <Popconfirm
            title="删除用户"
            description={
              <>
                删除后该用户的播放会话与播放记录一并级联删除，无法恢复。
                <br />
                如只想阻止登录，请改用「封禁」。
              </>
            }
            okText="删除"
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
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建用户
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
          刷新
        </Button>
        <Input
          allowClear
          placeholder="搜索用户名 / 展示名"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ width: 240 }}
        />
      </Space>

      <div ref={tableRef}>
        <Table<UserItem>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个用户` }}
          size="middle"
          scroll={{ x: 1310, y: bodyHeight }}
          locale={{ emptyText: <Empty description="暂无用户，点击「新建用户」创建" /> }}
        />
      </div>

      <Modal
        title={editing ? `编辑用户：${editing.username}` : "新建播放端用户"}
        open={modalOpen}
        width={560}
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
        okText={editing ? "保存" : "创建"}
      >
        <Form<UserFormValues> form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="username"
            label="用户名"
            tooltip="播放端登录账号（App 登录口径），3–32 位字母、数字、`.`、`_` 或 `-`"
            rules={[
              { required: true, message: "请输入用户名" },
              { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: "3–32 位字母、数字、`.`、`_` 或 `-`" },
            ]}
          >
            {editing ? (
              <Input disabled placeholder="用户名创建后不可修改" />
            ) : (
              <Input placeholder="如：alice" maxLength={32} />
            )}
          </Form.Item>

          {!editing && (
            <Form.Item
              name="password"
              label="初始密码"
              tooltip="bcrypt（cost 12）哈希后入库，仅本次写入，后续不可查看"
              rules={[
                { required: true, message: "请输入初始密码" },
                { min: 8, message: "密码至少 8 位" },
                { max: 72, message: "密码最多 72 个字符" },
              ]}
            >
              <Input.Password
                placeholder="至少 8 位"
                maxLength={72}
                autoComplete="new-password"
                visibilityToggle={{
                  visible: createPwdVisible,
                  onVisibleChange: setCreatePwdVisible,
                }}
                addonAfter={
                  <Button icon={<ThunderboltOutlined />} onClick={fillRandomInitialPassword}>
                    随机生成
                  </Button>
                }
              />
            </Form.Item>
          )}

          <Form.Item
            name="display_name"
            label="展示名"
            tooltip="可选，留空默认与用户名一致，仅用于控制台展示"
          >
            <Input placeholder="可选，留空默认与用户名一致" maxLength={64} allowClear />
          </Form.Item>

          <Space size="large" wrap align="start">
            <Form.Item
              name="status"
              label="状态"
              tooltip="封禁后分发端 login 直接拒绝，并立即吊销该用户全部未过期播放会话"
            >
              <Switch
                checkedChildren="可用"
                unCheckedChildren="封禁"
                checked={Form.useWatch("status", form) === "ACTIVE"}
                onChange={(checked) => form.setFieldValue("status", checked ? "ACTIVE" : "DISABLED")}
              />
            </Form.Item>
            <Form.Item
              name="max_concurrent_sessions"
              label="并发播放上限"
              tooltip="单用户同时可用的播放会话数，0为不限"
              rules={[
                { required: true, message: "请填写并发上限" },
                {
                  type: "number",
                  min: 0,
                  max: MAX_CONCURRENT_SESSIONS_MAX,
                  message: `0 – ${MAX_CONCURRENT_SESSIONS_MAX}`,
                },
              ]}
            >
              <InputNumber min={0} max={MAX_CONCURRENT_SESSIONS_MAX} precision={0} style={{ width: 140 }} placeholder="0 = 不限" />
            </Form.Item>
          </Space>

          {editing && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              用户名与口令不在此处修改：改用户名等同更换账号身份（历史会话 / 播放记录均归属旧身份），
              请「新建 + 删除」；口令请用行内「重置密码」。
            </Typography.Paragraph>
          )}
        </Form>
      </Modal>

      <Modal
        title={`重置密码：${pwdTarget?.username ?? ""}`}
        open={pwdTargetOpen}
        width={460}
        confirmLoading={pwdSaving}
        onOk={() => void submitResetPassword()}
        onCancel={() => setPwdTargetOpen(false)}
        destroyOnHidden
        okText="重置"
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
          重置后该用户未过期的播放会话将全部吊销（旧凭据签发的 JWT 立即失效，ADR-0007）：
          正在播放的客户端会中断，需用新密码重新登录。
        </Typography.Paragraph>
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: "请输入新密码" },
              { min: 8, message: "密码至少 8 位" },
              { max: 72, message: "密码最多 72 个字符" },
            ]}
          >
            <Input.Password
              placeholder="至少 8 位"
              maxLength={72}
              autoComplete="new-password"
              visibilityToggle={{
                visible: resetPwdVisible,
                onVisibleChange: setResetPwdVisible,
              }}
              addonAfter={
                <Button icon={<ThunderboltOutlined />} onClick={fillRandomNewPassword}>
                  随机生成
                </Button>
              }
            />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={["password"]}
            rules={[
              { required: true, message: "请再次输入新密码" },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string) =>
                  !value || getFieldValue("password") === value
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次输入的密码不一致")),
              }),
            ]}
          >
            <Input.Password placeholder="再次输入" maxLength={72} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </ProCard>
  );
}
