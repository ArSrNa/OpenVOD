"use client";

import {
  FontSizeOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LogoutOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { PageContainer, ProCard, ProLayout } from "@ant-design/pro-components";
import { Dropdown, Empty, Typography } from "antd";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

// 模块骨架（ADR-0004 功能清单；模块路由随 specification 落地）
const MODULES = [
  { key: "/media", label: "媒资管理", icon: <VideoCameraOutlined /> },
  { key: "/subtitles", label: "字幕管理", icon: <FontSizeOutlined /> },
  { key: "/users", label: "用户管理", icon: <TeamOutlined /> },
  { key: "/keys", label: "密钥管理", icon: <KeyOutlined /> },
  { key: "/jobs", label: "转码任务", icon: <ThunderboltOutlined /> },
  { key: "/settings", label: "系统设置", icon: <SettingOutlined /> },
  { key: "/about", label: "关于", icon: <InfoCircleOutlined /> },
];

// 已实现的真实路由页：菜单点击直接跳转（其余模块仍是内容区占位）
const ROUTE_PAGES = new Set(["/media", "/about"]);

// ProLayout 的菜单与面包屑由 route + location 推导（图标必须挂在 route 上，MODULES 仅用于内容区）
const ROUTE = {
  path: "/",
  name: "控制台",
  routes: MODULES.map(({ key, label, icon }) => ({ path: key, name: label, icon })),
};

/** 品牌标识（远程 logo，域名白名单见 next.config.ts images.remotePatterns） */
function BrandLogo() {
  return (
    <Image
      src="https://www.arsrna.cn/logo.png"
      alt="OpenVOD"
      width={28}
      height={28}
      // 显式给宽高：ProLayout 的 .ant-pro-sider-logo img 只设 height，内联样式压过它才能避免
      // next/image 的 "width or height modified, but not the other" 警告与比例失真
      style={{ width: 28, height: 28, objectFit: "contain" }}
      priority
    />
  );
}

export function ConsoleShell({
  userName,
  version,
  initialPath,
  children,
}: {
  userName: string;
  version: string;
  /** 真实路由页（/about）传入：用于初始菜单选中与点击回跳控制 */
  initialPath?: string;
  /** 页面内容；缺省渲染 scaffold 占位 */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<string>(initialPath ?? MODULES[0].key);
  const active = MODULES.find((m) => m.key === current) ?? MODULES[0];
  const isRoutePage = initialPath !== undefined;

  const logout = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };

  // 菜单点击：真实路由页（/media、/about）直接跳转；真实路由页上点未实现的模块项
  // 回控制台首页；其余模块路由尚未实现，仅切换内容区（ProLayout 自身不做跳转）
  const handleMenuClick = (path?: string) => {
    if (!path) return;
    if (ROUTE_PAGES.has(path)) {
      if (path !== current) router.push(path);
      return;
    }
    if (isRoutePage) {
      router.push("/");
      return;
    }
    setCurrent(path);
  };

  return (
    <ProLayout
      title="OpenVOD 管理端"
      logo={<BrandLogo />}
      layout="side"
      navTheme="light"
      siderWidth={208}
      fixSiderbar
      fixedHeader
      route={ROUTE}
      location={{ pathname: current }}
      menuItemRender={(item, dom) => (
        <div onClick={() => handleMenuClick(item.path)}>{dom}</div>
      )}
      avatarProps={{
        icon: <UserOutlined />,
        size: "small",
        title: userName,
        render: (_props, dom) => (
          <Dropdown
            menu={{
              items: [{ key: "logout", icon: <LogoutOutlined />, label: "退出登录" }],
              onClick: logout,
            }}
          >
            {dom}
          </Dropdown>
        ),
      }}
      menuFooterRender={(props) =>
        props?.collapsed ? undefined : (
          <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, paddingInline: 8 }}>
            OpenVOD v{version}
          </Typography.Text>
        )
      }
    >
      <PageContainer
        title={active.label}
        subTitle={children ? undefined : "scaffold：功能页随 specification 实现"}
      >
        <ProCard bordered={false} style={{ minHeight: 320 }}>
          {children ?? <Empty description={`${active.label} — 暂未实现（ADR-0004 功能清单）`} />}
        </ProCard>
      </PageContainer>
    </ProLayout>
  );
}
