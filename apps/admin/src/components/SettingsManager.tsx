"use client";

import { CopyOutlined, RobotOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildCustomSignerPrompt } from "@/lib/custom-signer-prompt";
import {
  SETTINGS_GROUPS,
  type SettingField,
  type SettingsEditorResponse,
  type SettingsGroup,
} from "@/lib/settings-fields";

type FormValues = Record<string, string | number | null | undefined>;
type Confirmation = { kind: "reload" } | { kind: "clear-secret"; field: SettingField } | null;

const SOURCE_LABELS = { db: "控制台设置", env: "环境变量", default: "默认值" };
const EFFECT_DESCRIPTION = "管理端最多 30 秒、分发端最多 60 秒内读取新配置；Worker 在下次空闲轮询时更新（缓存最多 30 秒）。执行中的转码任务继续使用原有配置。";

function changedValues(
  snapshot: SettingsEditorResponse | null,
  values: FormValues,
  clearedSecrets: Set<string>,
): Record<string, string> {
  if (!snapshot) return {};
  const changes: Record<string, string> = {};
  for (const field of snapshot.fields) {
    const value = String(values[field.key] ?? "");
    if (field.secret) {
      // 空密码输入框始终表示保持原值；只有单独确认清除后才发送空串。
      if (clearedSecrets.has(field.key)) changes[field.key] = "";
      else if (value !== "") changes[field.key] = value;
    } else if (value !== (field.value ?? "")) {
      changes[field.key] = value;
    }
  }
  return changes;
}

export function SettingsManager({ group = "playback" }: { group?: SettingsGroup }) {
  const definition = SETTINGS_GROUPS[group];
  const fields: SettingField[] = definition.fields;
  const [form] = Form.useForm<FormValues>();
  const [snapshot, setSnapshot] = useState<SettingsEditorResponse | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const loadController = useRef<AbortController | null>(null);
  // 自定义签名提供者（ADR-0019）：提示词弹窗（仅 storage 组）
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptProvider, setPromptProvider] = useState("custom");
  const [promptNotes, setPromptNotes] = useState("");

  const applySnapshot = useCallback((next: SettingsEditorResponse) => {
    const nextValues = Object.fromEntries(next.fields.map((field) => [field.key, field.secret ? "" : field.value ?? ""]));
    setSnapshot(next);
    setValues(nextValues);
    setClearedSecrets(new Set());
    setConflict(false);
    setSaveError("");
  }, []);

  useEffect(() => {
    // 首次加载完成后 Form 才挂载，避免向尚未连接的 useForm 实例写值。
    if (snapshot) form.setFieldsValue(Object.fromEntries(snapshot.fields.map((field) => [field.key, field.secret ? "" : field.value ?? ""])));
  }, [form, snapshot]);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/admin/settings?group=${group}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.group !== group || !Array.isArray(body.fields)) {
        throw new Error(body?.error?.message ?? "加载系统设置失败");
      }
      applySnapshot(body);
      setSaved(false);
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoadError(error instanceof Error ? error.message : "加载系统设置失败，请检查网络后重试");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applySnapshot, group]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  const changes = changedValues(snapshot, values, clearedSecrets);
  const changeCount = Object.keys(changes).length;
  const disabled = loading || saving;

  useEffect(() => {
    if (!changeCount) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [changeCount]);

  const reload = () => {
    if (changeCount) setConfirmation({ kind: "reload" });
    else void load();
  };

  const setFieldValue = (key: string, value: string) => {
    form.setFieldValue(key, value);
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async (submitted: FormValues) => {
    if (!snapshot || conflict) return;
    const updates = changedValues(snapshot, submitted, clearedSecrets);
    if (!Object.keys(updates).length) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group, revision: snapshot.revision, values: updates }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) {
        setConflict(true);
        setSaveError("设置已被其他管理员修改。你的草稿已保留，请重新加载最新配置后再编辑保存。");
        return;
      }
      if (!response.ok || !body || body.group !== group || !Array.isArray(body.fields)) {
        throw new Error(body?.error?.message ?? "保存系统设置失败");
      }
      applySnapshot(body);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请检查网络后重试");
    } finally {
      setSaving(false);
    }
  };

  const confirmAction = () => {
    if (confirmation?.kind === "reload") void load();
    if (confirmation?.kind === "clear-secret") {
      const key = confirmation.field.key;
      setFieldValue(key, "");
      setClearedSecrets((current) => new Set([...current, key]));
    }
    setConfirmation(null);
  };

  const renderInput = (field: SettingField) => {
    if (field.type === "secret") {
      return (
        <Input.Password
          autoComplete="new-password"
          placeholder="输入新值替换；留空保持不变"
          disabled={disabled || clearedSecrets.has(field.key)}
        />
      );
    }
    if (field.type === "number") {
      return <InputNumber min={field.min} max={field.max} precision={0} placeholder="留空使用环境变量或默认值" style={{ width: "100%" }} />;
    }
    if (field.type === "boolean") {
      return <Select options={[{ value: "true", label: "启用" }, { value: "false", label: "关闭" }, { value: "", label: "使用环境变量或默认值" }]} />;
    }
    if (field.type === "enum") {
      return (
        <Select
          options={[
            ...(field.options ?? []),
            { value: "", label: "使用环境变量或默认值" },
          ]}
        />
      );
    }
    return <Input placeholder={field.placeholder ?? "留空使用环境变量或默认值"} allowClear autoComplete="off" />;
  };

  return (
    <Card
      title={definition.title}
      loading={loading && !snapshot}
      extra={<Button icon={<ReloadOutlined />} onClick={reload} loading={loading} disabled={saving}>重新加载</Button>}
    >
      <div style={{ maxWidth: 720 }}>
        <Typography.Paragraph type="secondary">{definition.description}</Typography.Paragraph>
        {loadError && <Alert type="error" showIcon message={loadError} action={<Button size="small" onClick={reload} disabled={disabled}>重试</Button>} style={{ marginBottom: 24 }} />}
        {saveError && <Alert type={conflict ? "warning" : "error"} showIcon message={saveError} action={conflict ? <Button size="small" onClick={reload} disabled={disabled}>重新加载</Button> : undefined} style={{ marginBottom: 24 }} />}
        {saved && <Alert type="success" showIcon message="设置已保存" description={EFFECT_DESCRIPTION} style={{ marginBottom: 24 }} />}
        {group === "storage" && String(values["storage_sign_mode"] ?? "") === "custom" && (
          <Alert
            type="warning"
            showIcon
            message="已选择自定义签名提供者"
            description="自定义提供者需要先在代码中实现并注册（TS 与 Go 两侧），再重新构建部署；未注册时分发端与管理端的签名请求会直接报错。可以把下方提示词交给你的 AI 编码助手生成实现代码。"
            action={
              <Button size="small" icon={<RobotOutlined />} onClick={() => {
                setPromptProvider(String(values["storage_custom_signer"] ?? "") || "custom");
                setPromptOpen(true);
              }}>生成 Agent 提示词</Button>
            }
            style={{ marginBottom: 24 }}
          />
        )}
        {group === "storage" && String(values["storage_sign_mode"] ?? "") === "cdn_url_auth" && (
          <Alert
            type="info"
            showIcon
            message="CDN URL 鉴权模式的前置条件"
            description={<>切换前请在 CDN 控制台完成：① 私有回源（存储凭证配在 CDN 侧，不入库）；② Token 鉴权开启——鉴权方式与「CDN 鉴权方式」一致、密钥与「CDN 边缘鉴权密钥」一致、有效时长与「CDN 鉴权有效期」一致（方式 A 的鉴权参数名 sign）；③ 缓存键含 query、缓存 TTL ≤ 签名窗口（逐项清单见部署文档 deploy-delivery.md「CDN 加速域名与资产签名配置清单」）。切换后建议 CDN 全量刷新一次。</>}
            style={{ marginBottom: 24 }}
          />
        )}
        {snapshot && (
          <>
            <Alert
              type="info"
              showIcon
              message="配置来源与生效时间"
              description={<>输入框显示当前配置值。普通字段留空会恢复环境变量或默认值，密钥留空保持不变。<br />{EFFECT_DESCRIPTION}</>}
              style={{ marginBottom: 24 }}
            />
            <Form<FormValues>
              form={form}
              layout="vertical"
              disabled={disabled}
              onFinish={save}
              onValuesChange={(changed: FormValues, all: FormValues) => {
                setValues(all);
                setSaved(false);
                setClearedSecrets((current) => {
                  const next = new Set(current);
                  for (const [key, value] of Object.entries(changed)) {
                    if (String(value ?? "") !== "") next.delete(key);
                  }
                  return next;
                });
              }}
              requiredMark={false}
              scrollToFirstError
            >
              {fields.map((field) => {
                const current = snapshot.fields.find((entry) => entry.key === field.key);
                if (!current) return null;
                const changed = Object.hasOwn(changes, field.key);
                const clearing = clearedSecrets.has(field.key);
                return (
                  <Form.Item
                    key={field.key}
                    name={field.key}
                    label={<Space wrap><span>{field.label}</span><Tag color={current.source === "db" ? "blue" : undefined}>{SOURCE_LABELS[current.source]}</Tag>{current.secret && <Tag color={current.configured ? "green" : undefined}>{current.configured ? "已配置" : "未配置"}</Tag>}{changed && <Tag color="orange">{changes[field.key] === "" ? "待恢复默认来源" : "未保存"}</Tag>}</Space>}
                    rules={field.type === "number" ? [{
                      validator: (_, value) => {
                        if (value === "" || value === null || value === undefined) return Promise.resolve();
                        const number = Number(value);
                        return Number.isInteger(number) && (field.min === undefined || number >= field.min) && (field.max === undefined || number <= field.max)
                          ? Promise.resolve()
                          : Promise.reject(new Error(`请输入 ${field.min}–${field.max} 的整数`));
                      },
                    }] : undefined}
                    extra={
                      <>
                        {field.help && <div>{field.help}</div>}
                        {clearing ? (
                          <Space wrap><Typography.Text type="warning">保存后移除控制台中的密钥，回退环境变量。</Typography.Text><Button size="small" type="link" disabled={disabled} onClick={() => setClearedSecrets((previous) => { const next = new Set(previous); next.delete(field.key); return next; })}>取消清除</Button></Space>
                        ) : current.overridden ? (
                          <Button size="small" type="link" disabled={disabled} onClick={() => field.type === "secret" ? setConfirmation({ kind: "clear-secret", field }) : setFieldValue(field.key, "")}>移除控制台覆盖</Button>
                        ) : null}
                      </>
                    }
                  >
                    {renderInput(field)}
                  </Form.Item>
                );
              })}
              <Space wrap>
                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving} disabled={loading || !changeCount || conflict}>保存设置</Button>
                <Typography.Text type={changeCount ? "warning" : "secondary"}>{changeCount ? `${changeCount} 项修改尚未保存` : "暂无未保存修改"}</Typography.Text>
              </Space>
            </Form>
          </>
        )}
      </div>
      <Modal
        open={confirmation !== null}
        title={confirmation?.kind === "clear-secret" ? `移除${confirmation.field.label}的控制台配置？` : "重新加载并放弃草稿？"}
        onOk={confirmAction}
        onCancel={() => setConfirmation(null)}
        okText={confirmation?.kind === "clear-secret" ? "确认移除" : "放弃草稿并加载"}
        cancelText="保留当前内容"
        okButtonProps={{ danger: true }}
      >
        {confirmation?.kind === "clear-secret" ? "保存设置后将移除数据库中的密钥并回退环境变量。如果部署环境没有提供该密钥，对应功能可能不可用。" : "当前尚未保存的修改将被最新配置替换。"}
      </Modal>
      <Modal
        open={promptOpen}
        title="自定义签名提供者 · Agent 提示词"
        onCancel={() => setPromptOpen(false)}
        footer={
          <Space>
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                const prompt = buildCustomSignerPrompt({
                  providerName: promptProvider,
                  algorithmNotes: promptNotes,
                });
                void navigator.clipboard?.writeText(prompt);
              }}
            >复制提示词</Button>
            <Button type="primary" onClick={() => setPromptOpen(false)}>完成</Button>
          </Space>
        }
        width={860}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            补充你的 CDN 鉴权算法说明（可留空），提示词会包含双语言实现契约与测试要求；
            密钥等敏感信息不会进入提示词。粘贴给你的编码助手即可生成实现代码。
          </Typography.Paragraph>
          <Input
            value={promptProvider}
            onChange={(e) => setPromptProvider(e.target.value)}
            placeholder="custom"
            addonBefore="提供者名"
          />
          <Input.TextArea
            value={promptNotes}
            onChange={(e) => setPromptNotes(e.target.value)}
            placeholder="例如：我的 CDN 是 XXX，URL 形态 https://cdn/{路径}?token={md5(...)}，过期 1 小时；算法细节…"
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <Input.TextArea
            readOnly
            value={buildCustomSignerPrompt({ providerName: promptProvider, algorithmNotes: promptNotes })}
            autoSize={{ minRows: 10, maxRows: 22 }}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </Space>
      </Modal>
    </Card>
  );
}
