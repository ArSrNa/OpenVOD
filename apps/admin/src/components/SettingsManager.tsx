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

const SOURCE_LABELS = { db: "控制台", env: "环境变量", default: "默认值" };
const EFFECT_DESCRIPTION = "保存后 30 秒内管理端生效、60 秒内分发端生效；Worker 会在下一次空闲轮询时更新（最多 30 秒）。正在执行的转码任务继续按旧配置跑完。";

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
          placeholder="留空表示不修改；输入新值即替换"
          disabled={disabled || clearedSecrets.has(field.key)}
        />
      );
    }
    if (field.type === "number") {
      return <InputNumber min={field.min} max={field.max} precision={0} placeholder="留空则使用环境变量或默认值" style={{ width: "100%" }} />;
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
    return <Input placeholder={field.placeholder ?? "留空则使用环境变量或默认值"} allowClear autoComplete="off" />;
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
        {group === "delivery" && String(values["storage_sign_mode"] ?? "") === "custom" && (
          <Alert
            type="warning"
            showIcon
            message="已选择自定义签名提供者"
            description="这种模式需要先在代码里实现并注册签名算法（TS 和 Go 各一份），再重新构建部署。没注册就切换，管理端和分发端的签名请求会直接报错。可以把下面的提示词交给 AI 编码助手生成实现代码。"
            action={
              <Button size="small" icon={<RobotOutlined />} onClick={() => {
                setPromptProvider(String(values["storage_custom_signer"] ?? "") || "custom");
                setPromptOpen(true);
              }}>生成 Agent 提示词</Button>
            }
            style={{ marginBottom: 24 }}
          />
        )}
        {group === "delivery" && String(values["storage_sign_mode"] ?? "") === "cdn_url_auth" && (
          <Alert
            type="info"
            showIcon
            message="CDN URL 鉴权模式的前置条件"
            description={<>切换前先到 CDN 控制台完成三件事：① 私有回源（存储凭证配在 CDN 侧，不存进本系统）；② 开启 Token 鉴权，鉴权方式、密钥、有效时长要和本页对应三项完全一致（方式 A 还要对上鉴权参数名，默认 sign）；③ 缓存键包含 query，缓存时间不超过签名窗口。逐项清单见部署文档 deploy-delivery.md「CDN 加速域名与资产签名配置清单」。切换完成后建议在 CDN 全量刷新一次。</>}
            style={{ marginBottom: 24 }}
          />
        )}
        {snapshot && (
          <>
            <Alert
              type="info"
              showIcon
              message="配置来源与生效时间"
              description={<>输入框里显示的就是当前生效的值。普通字段清空后会退回环境变量或默认值；密钥框留空表示不修改。<br />{EFFECT_DESCRIPTION}</>}
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
                    label={<Space wrap><span>{field.label}</span><Tag color={current.source === "db" ? "blue" : undefined}>{SOURCE_LABELS[current.source]}</Tag>{current.secret && <Tag color={current.configured ? "green" : undefined}>{current.configured ? "已配置" : "未配置"}</Tag>}{changed && <Tag color="orange">{changes[field.key] === "" ? "保存后回退" : "未保存"}</Tag>}</Space>}
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
                          <Space wrap><Typography.Text type="warning">保存后会删掉控制台里的密钥，改用环境变量。</Typography.Text><Button size="small" type="link" disabled={disabled} onClick={() => setClearedSecrets((previous) => { const next = new Set(previous); next.delete(field.key); return next; })}>取消清除</Button></Space>
                        ) : current.overridden ? (
                          <Button size="small" type="link" disabled={disabled} onClick={() => field.type === "secret" ? setConfirmation({ kind: "clear-secret", field }) : setFieldValue(field.key, "")}>移除控制台配置</Button>
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
        {confirmation?.kind === "clear-secret" ? "保存后会删掉数据库里的这个密钥，改用环境变量里的值。如果环境变量也没配，依赖它的功能会不可用。" : "未保存的修改会被最新配置覆盖。"}
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
            可以补充你的 CDN 鉴权算法说明，留空也行。提示词里写明了 TS 与 Go 两侧的实现契约和测试要求，
            不包含密钥等敏感信息；复制给编码助手即可生成实现代码。
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
