"use client";

import {
  DashboardOutlined,
  FontSizeOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LogoutOutlined,
  SettingOutlined,
  SlidersOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { PageContainer, ProCard, ProLayout } from "@ant-design/pro-components";
import { Dropdown, Empty, Spin, Typography } from "antd";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

// 模块骨架（ADR-0004 功能清单；模块路由随 specification 落地）
const MODULES = [
  { key: "/", label: "总览", icon: <DashboardOutlined /> },
  { key: "/media", label: "媒资管理", icon: <VideoCameraOutlined /> },
  { key: "/templates", label: "转码模板", icon: <SlidersOutlined /> },
  { key: "/subtitles", label: "字幕管理", icon: <FontSizeOutlined /> },
  { key: "/users", label: "用户管理", icon: <TeamOutlined /> },
  { key: "/keys", label: "密钥管理", icon: <KeyOutlined /> },
  { key: "/jobs", label: "转码任务", icon: <ThunderboltOutlined /> },
  { key: "/settings", label: "系统设置", icon: <SettingOutlined /> },
  { key: "/about", label: "关于", icon: <InfoCircleOutlined /> },
];

// 已实现的真实路由页：菜单点击直接跳转（其余模块仍是内容区占位）
const ROUTE_PAGES = new Set(["/", "/media", "/templates", "/keys", "/jobs", "/about"]);

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
  /** 真实路由页（/、/media、/about）传入：用于初始菜单选中 */
  initialPath?: string;
  /** 页面内容；未实现模块渲染 scaffold 占位 */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<string>(initialPath ?? MODULES[0].key);
  // ProLayout 内部的 useBreakpoint 在客户端首帧渲染期同步读取 window.matchMedia
  // （SSR 恒为 false）：视口 < 992px 时侧边栏初始即折叠（64px、logo 无 <h1>、根节点多
  // screen-* class），与服务端展开态形成结构性差异，必然触发 hydration mismatch。
  // 挂载完成后再渲染 ProLayout，保证水合首帧两端完全一致；内容区本就走客户端数据获取，
  // 仅壳层首帧短暂显示占位，无额外代价。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = MODULES.find((m) => m.key === current) ?? MODULES[0];
  // 当前内容区是否为未实现模块的占位页（真实路由页的 children 总是渲染）
  const showPlaceholder = !ROUTE_PAGES.has(current);

  const logout = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };

  // 菜单点击：已实现的真实路由页（/ 总览、/media、/about）直接跳转；
  // 未实现的模块仅切换内容区为占位（不走路由，ProLayout 高亮由 location 推导）
  const handleMenuClick = (path?: string) => {
    if (!path) return;
    if (ROUTE_PAGES.has(path)) {
      if (path !== current) router.push(path);
      return;
    }
    setCurrent(path);
  };

  if (!mounted) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <ProLayout
      title="OpenVOD 管理端"
      logo={<BrandLogo />}
      layout="side"
      navTheme="light"
      siderWidth={208}
      // 挂载后渲染已无水合比对，这里再显式固定初始展开、禁用 Sider 自身的 lg 媒体查询，
      // 折叠只由底部 trigger 手动触发，首帧渲染不再依赖视口宽度
      breakpoint={false}
      defaultCollapsed={false}
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
            <br />
            Powered by Ar-Sr-Na
          </Typography.Text>
        )
      }
    >

      <PageContainer
        title={active.label}
        subTitle={showPlaceholder ? "scaffold：功能页随 specification 实现" : undefined}
        token={{
          paddingInlinePageContainerContent: 16,
          paddingBlockPageContainerContent: 16,
        }}
      >
        {showPlaceholder ? (
          <ProCard bordered={false} style={{ minHeight: 320 }}>
            <Empty description={`${active.label} — 暂未实现（ADR-0004 功能清单）`} />
          </ProCard>
        ) : (
          children
        )}
      </PageContainer>
    </ProLayout>
  );
}
