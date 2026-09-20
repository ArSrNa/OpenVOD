"use client";

// 字幕管理页（/subtitles，spec.md §7.6）：先选媒资，再管理该媒资的多轨 WebVTT 字幕。
// 数据来源：`GET /api/admin/media`（媒资列表 + `subtitleCount`）与
// `GET /api/admin/media/{id}/subtitles`（轨道列表）；轨道操作面板与媒资页抽屉共用
// `SubtitleTracksPanel`，避免两处实现漂移。
import { FontSizeOutlined } from "@ant-design/icons";
import { App, Empty, Select, Space, Tag, Typography } from "antd";
import { ProCard } from "@ant-design/pro-components";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SubtitleTracksPanel } from "./SubtitleManager";

interface MediaOption {
  id: string;
  title: string | null;
  subtitleCount: number;
}

export function SubtitleTracksPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [items, setItems] = useState<MediaOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/media", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { items?: MediaOption[]; error?: { message?: string } }
        | null;
      if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      const list = body?.items ?? [];
      setItems(list);
      // 默认选中「已有字幕」的第一个媒资；没有则选最新媒资
      setSelected((prev) => {
        if (prev && list.some((m) => m.id === prev)) return prev;
        return list.find((m) => m.subtitleCount > 0)?.id ?? list[0]?.id ?? null;
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "媒资列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = items.find((m) => m.id === selected) ?? null;

  return (
    <ProCard
      title="字幕"
      bordered={false}
      extra={
        <Space>
          <FontSizeOutlined />
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 360 }}
            placeholder={loading ? "加载媒资…" : "选择媒资（ID 或展示名）"}
            loading={loading}
            value={selected ?? undefined}
            onChange={(v: string) => setSelected(v)}
            notFoundContent={<Empty description="存储中暂无媒资" />}
            options={items.map((m) => ({
              value: m.id,
              label: `${m.id} · ${m.title ?? "（无展示名）"}${m.subtitleCount ? `（${m.subtitleCount} 条字幕）` : ""
                }`,
            }))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            一个媒资可挂多条字幕，按语言区分
          </Typography.Text>
        </Space>
      }
    >
      {!items.length && !loading ? (
        <Empty description="存储中暂无媒资（先到「媒资管理」上传视频）" />
      ) : current ? (
        <div className="flex flex-col">
          <Space size={6} style={{ marginBottom: 12 }} wrap>
            <Typography.Text strong>{current.title ?? "（无展示名）"}</Typography.Text>
            <Typography.Text code>{current.id}</Typography.Text>
            <Tag color={current.subtitleCount ? "geekblue" : "default"}>
              {current.subtitleCount ? `${current.subtitleCount} 条字幕` : "暂无字幕"}
            </Tag>
          </Space>
          <SubtitleTracksPanel
            key={current.id}
            mediaId={current.id}
            mediaTitle={current.title}
            onChanged={() => void load()}
          />
        </div>
      ) : (
        <Empty description="请选择要管理字幕的媒资" />
      )}
    </ProCard>
  );
}
