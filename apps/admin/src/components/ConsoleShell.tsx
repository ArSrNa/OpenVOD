"use client";

import {
  ApartmentOutlined,
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
import { App, Badge, Dropdown, Empty, Spin, Typography } from "antd";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { configureUploadManager, uploadManager } from "@/lib/upload-manager";

// 模块骨架（ADR-0004 功能清单；模块路由随 specification 落地）
const MODULES = [
  { key: "/", label: "总览", icon: <DashboardOutlined /> },
  // 注意：父项 key 不能与子项「视频管理」（/media）相同，否则扁平化后 antd Menu 报
  // Duplicated key。父项只是分组（子菜单标题，点击仅展开、不导航），用非路由键。
  { key: "/media-group", label: "媒资管理", icon: <VideoCameraOutlined /> },
  { key: "/categories", label: "分类管理", icon: <ApartmentOutlined /> },
  { key: "/templates", label: "转码模板", icon: <SlidersOutlined /> },
  { key: "/subtitles", label: "字幕管理", icon: <FontSizeOutlined /> },
  { key: "/users", label: "用户管理", icon: <TeamOutlined /> },
  { key: "/keys", label: "密钥管理", icon: <KeyOutlined /> },
  { key: "/jobs", label: "转码任务", icon: <ThunderboltOutlined /> },
  { key: "/settings", label: "系统设置", icon: <SettingOutlined /> },
  { key: "/about", label: "关于", icon: <InfoCircleOutlined /> },
];

// 媒资管理二级菜单（2026-10-01 用户定，spec.md §9.1）：与系统设置同构，父项仅展开不导航
const MEDIA_CHILDREN = [
  { key: "/media", label: "视频管理" },
  { key: "/media/upload", label: "视频上传" },
];

// 系统设置二级菜单：设置项按域拆子页（/settings 本身只做重定向到首个子页）
const SETTINGS_CHILDREN = [
  { key: "/settings/playback", label: "播放设置" },
  { key: "/settings/storage", label: "存储设置" },
  { key: "/settings/login", label: "登录设置" },
  { key: "/settings/security", label: "安全设置" },
  { key: "/settings/worker", label: "任务设置" },
];

// 有二级菜单的模块：ROUTE 组装时展开为父子结构
const MODULE_CHILDREN: Record<string, { key: string; label: string }[]> = {
  "/media-group": MEDIA_CHILDREN,
  "/settings": SETTINGS_CHILDREN,
};

// 扁平查找表：内容区标题 / 占位判定用（含二级菜单项）
const ALL_ENTRIES = [...MODULES, ...MEDIA_CHILDREN, ...SETTINGS_CHILDREN];

// 已实现的真实路由页：菜单点击直接跳转（其余模块仍是内容区占位）
const ROUTE_PAGES = new Set([
  "/",
  "/media",
  "/media/upload",
  "/categories",
  "/templates",
  "/subtitles",
  "/users",
  "/keys",
  "/jobs",
  "/settings/playback",
  "/settings/storage",
  "/settings/login",
  "/settings/security",
  "/settings/worker",
  "/about",
]);

// ProLayout 的菜单与面包屑由 route + location 推导（图标必须挂在 route 上，MODULES 仅用于内容区）
const ROUTE = {
  path: "/",
  name: "控制台",
  routes: MODULES.map(({ key, label, icon }) => {
    const children = MODULE_CHILDREN[key];
    return children
      ? {
        path: key,
        name: label,
        icon,
        routes: children.map(({ key: k, label: l }) => ({ path: k, name: l })),
      }
      : { path: key, name: label, icon };
  }),
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

/**
 * 「视频上传」菜单项角标（spec.md §9.1，2026-10-01 用户定，替代原右上角全局入口）：
 * 存在进行中上传任务（UPLOADING / QUEUED）时显示数量，无任务不渲染（不显示 0）。
 */
function UploadMenuBadge() {
  const tasks = useSyncExternalStore(
    uploadManager.subscribe,
    uploadManager.getSnapshot,
    uploadManager.getServerSnapshot,
  );
  const count = tasks.filter((t) => t.status === "UPLOADING" || t.status === "QUEUED").length;
  if (count === 0) return null;
  return <Badge count={count} size="small" />;
}

export function ConsoleShell({
  userName,
  version,
  children,
}: {
  userName: string;
  version: string;
  /** 页面内容；未实现模块渲染 scaffold 占位 */
  children?: ReactNode;
}) {
  const router = useRouter();
  // 当前 URL 是菜单选中与内容区判定的唯一真相源
  const pathname = usePathname();
  // 未实现模块只切内容区、不产生 URL，因此单独记录；真实导航后失效（见下方 effect）
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  // ProLayout 内部的 useBreakpoint 在客户端首帧渲染期同步读取 window.matchMedia
  // （SSR 恒为 false）：视口 < 992px 时侧边栏初始即折叠（64px、logo 无 <h1>、根节点多
  // screen-* class），与服务端展开态形成结构性差异，必然触发 hydration mismatch。
  // 挂载完成后再渲染 ProLayout，保证水合首帧两端完全一致；内容区本就走客户端数据获取，
  // 仅壳层首帧短暂显示占位，无额外代价。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // 真实导航（含前进/后退）后占位态失效，菜单高亮与内容区重新跟随 URL
  useEffect(() => setPlaceholder(null), [pathname]);
  const current = placeholder ?? pathname;
  const active = ALL_ENTRIES.find((m) => m.key === current) ?? MODULES[0];
  // 精确选中当前叶子菜单：ProLayout 默认按前缀模糊匹配（getMatchMenu 未传 exact），
  // /media/upload 会同时命中 /media 与 /media/upload 两个叶子 → 双高亮；
  // 传受控 selectedKeys（BaseMenu useMergedState 的 value）只选中当前项，openKeys 仍自动推导、子菜单照常展开
  const selectedKeys = Array.from(
    new Set(ALL_ENTRIES.filter((m) => m.key === current).map((m) => m.key)),
  );
  // 当前内容区是否为未实现模块的占位页（真实路由页的 children 总是渲染）
  const showPlaceholder = !ROUTE_PAGES.has(current);

  const logout = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };

  // 上传队列接线（spec.md §9.4）：401 时用 SPA 跳转登录页（替代默认整页 location.assign）
  useEffect(() => {
    configureUploadManager({ onUnauthorized: () => router.push("/login") });
  }, [router]);

  // 上传任务终态全局提示（spec.md §9.3）：挂在壳层，切页后完成的任务提示也不丢；
  // 消息文案与上传页任务状态一致（DONE(ready) / DONE(timeout) / FAILED / 401 整队终止）
  const { message } = App.useApp();
  useEffect(() => {
    return uploadManager.onTerminal((task, kind) => {
      if (kind === "unauthorized") {
        message.error("登录已过期，上传任务已全部终止");
        return;
      }
      if (kind === "ready") {
        message.success(`媒资「${task.filename}」上传成功（ID ${task.mediaId}）`);
        return;
      }
      if (kind === "timeout") {
        message.warning(
          `媒资「${task.filename}」元数据仍在生成或已失败（ID ${task.mediaId}）：可在媒资页「更多 → 生成元数据」手动重跑`,
          8,
        );
        return;
      }
      message.error(`媒资「${task.filename}」上传失败：${task.error ?? "未知原因"}`);
    });
  }, [message]);

  // 菜单点击：已实现的真实路由页（/ 总览、/media、/about）直接跳转；
  // 未实现的模块仅切换内容区为占位（不走路由，ProLayout 高亮由 location 推导）
  const handleMenuClick = (path?: string) => {
    if (!path) return;
    if (ROUTE_PAGES.has(path)) {
      // 必须先清占位：从占位态点回「当前 URL 对应的页面」时 router.push 是空操作，
      // 组件不重挂载也不会重置状态，界面会卡在占位页（切页失效的根因）
      setPlaceholder(null);
      if (path !== pathname) router.push(path);
      return;
    }
    setPlaceholder(path);
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
      selectedKeys={selectedKeys}
      menuItemRender={(item, dom) => (
        <div
          onClick={(event) => {
            // dom 内层是链接，先掐掉默认的整页跳转，统一交给 router.push 走 SPA 导航
            event.preventDefault();
            handleMenuClick(item.path);
          }}
          style={{ display: "flex", alignItems: "center" }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{dom}</span>
          {/* 上传任务角标（spec.md §9.1，2026-10-01 用户定）：挂在「视频上传」菜单项上 */}
          {item.path === "/media/upload" ? <UploadMenuBadge /> : null}
        </div>
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
