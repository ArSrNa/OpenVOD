"use client";

import { ProCard } from "@ant-design/pro-components";
import { Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";

type OssItem = {
  name: string;
  homepage: string;
  version: string;
  license: string;
  usage: string;
};

// 依赖清单与各 package.json / go.mod 的声明保持一致（版本为声明范围）。
// 协议为摘要性描述，最终以各上游项目仓库中的 LICENSE 原文为准。
const GROUPS: { key: string; title: string; items: OssItem[] }[] = [
  {
    key: "admin",
    title: "管理端（apps/admin · Next.js）",
    items: [
      { name: "Next.js", homepage: "https://github.com/vercel/next.js", version: "^16.3.5", license: "MIT", usage: "全栈框架（App Router / SSR）" },
      { name: "React / React DOM", homepage: "https://github.com/facebook/react", version: "^19.0.0", license: "MIT", usage: "UI 运行时" },
      { name: "Ant Design (antd)", homepage: "https://github.com/ant-design/ant-design", version: "^5.22.0", license: "MIT", usage: "UI 组件库" },
      { name: "@ant-design/icons", homepage: "https://github.com/ant-design/ant-design-icons", version: "^5.6.1", license: "MIT", usage: "图标" },
      { name: "@ant-design/pro-components", homepage: "https://github.com/ant-design/pro-components", version: "^2.8.10", license: "MIT", usage: "ProLayout / 业务组件" },
      { name: "@ant-design/nextjs-registry", homepage: "https://github.com/ant-design/ant-design", version: "^1.1.0", license: "MIT", usage: "antd 的 App Router SSR 注册表" },
      { name: "@ant-design/v5-patch-for-react-19", homepage: "https://github.com/ant-design/ant-design", version: "^1.0.3", license: "MIT", usage: "antd v5 适配 React 19 的兼容补丁" },
      { name: "@tanstack/react-query", homepage: "https://github.com/TanStack/query", version: "^5.62.0", license: "MIT", usage: "服务端状态与数据请求" },
      { name: "better-auth", homepage: "https://github.com/better-auth/better-auth", version: "^1.2.0", license: "MIT", usage: "管理端鉴权（OIDC + 邮箱密码，ADR-0013）" },
    ],
  },
  {
    key: "data",
    title: "数据层与契约（packages/*）",
    items: [
      { name: "Prisma / @prisma/client", homepage: "https://github.com/prisma/prisma", version: "^6.10.0", license: "Apache-2.0", usage: "ORM / 迁移 / 双方言 schema" },
      { name: "Zod", homepage: "https://github.com/colinhacks/zod", version: "^4.0.0", license: "MIT", usage: "API 契约 schema 唯一真相源" },
      { name: "AWS SDK for JavaScript v3", homepage: "https://github.com/aws/aws-sdk-js-v3", version: "^3.700.0", license: "Apache-2.0", usage: "S3 兼容存储客户端（COS / MinIO）" },
      { name: "SQLite", homepage: "https://www.sqlite.org/", version: "3.x", license: "Public Domain", usage: "本地开发库引擎" },
    ],
  },
  {
    key: "delivery",
    title: "分发端（apps/delivery · Go）",
    items: [
      { name: "Go", homepage: "https://go.dev/", version: "1.26", license: "BSD-3-Clause", usage: "运行时与标准库" },
      { name: "go-chi/chi", homepage: "https://github.com/go-chi/chi", version: "v5.2.3", license: "MIT", usage: "HTTP 路由" },
    ],
  },
  {
    key: "runtime",
    title: "运行时与媒体工具链",
    items: [
      { name: "Node.js", homepage: "https://github.com/nodejs/node", version: "22+", license: "MIT（内含 V8 / OpenSSL 等 BSD、Apache-2.0 组件）", usage: "管理端生产运行时（ADR-0013 单容器）" },
      { name: "Bun", homepage: "https://github.com/oven-sh/bun", version: "≥1.4", license: "MIT（捆绑 JavaScriptCore / WebKit 等 LGPL-2.1、BSD 组件）", usage: "转码 Worker 运行时 / 仓库脚本" },
      { name: "FFmpeg（ffmpeg / ffprobe）", homepage: "https://ffmpeg.org/", version: "6.x", license: "LGPL-2.1+（启用 GPL 组件的构建为 GPL）", usage: "HLS 转码加密与媒体信息探测" },
    ],
  },
];

const COLUMNS: ColumnsType<OssItem> = [
  {
    title: "组件",
    dataIndex: "name",
    render: (name: string, record) => (
      <Typography.Link href={record.homepage} target="_blank" rel="noreferrer">
        {name}
      </Typography.Link>
    ),
  },
  { title: "版本", dataIndex: "version", width: 120 },
  { title: "协议", dataIndex: "license" },
  { title: "用途", dataIndex: "usage" },
];

export function AboutContent({ version }: { version: string }) {
  return (
    <div>
      <Typography.Paragraph type="secondary">
        OpenVOD v{version}. Powered by Ar-Sr-Na
      </Typography.Paragraph>
      {GROUPS.map((group) => (
        <ProCard key={group.key} title={group.title} bordered style={{ marginBottom: 16 }}>
          <Table<OssItem> rowKey="name" columns={COLUMNS} dataSource={group.items} pagination={false} size="small" />
        </ProCard>
      ))}
    </div>
  );
}
