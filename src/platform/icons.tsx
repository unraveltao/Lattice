/**
 * 图标
 *
 * 统一 16px 视窗、1.4 描边、round 端点 —— 顶栏、设置菜单里的图标都从这里取，
 * 免得每处各画一套，粗细对不上。
 *
 * 需要实心块（比如"跟随系统"那半圆）时用 children 传，不要为了一个图标
 * 另开一套 fill 规则。
 */

import type { CSSProperties, ReactNode } from "react";

export function Glyph({
  d,
  children,
  size = 16,
}: {
  /** 单条路径的图标用这个 */
  d?: string;
  /** 多段 / 需要实心的图标用这个 */
  children?: ReactNode;
  size?: number;
}) {
  return (
    <svg
      className="lattice-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

/**
 * 三态外观各自的图标：浅色 = 太阳、跟随系统 = 半明半暗、深色 = 月亮。
 * 顶栏那颗按钮和设置菜单里的分段控件共用它，保证同一状态在哪儿都长一样。
 */
export function ThemeGlyph({
  mode,
  size = 16,
}: {
  mode: "light" | "dark" | "system";
  size?: number;
}) {
  if (mode === "light") return <Glyph d={ICON.sun} size={size} />;
  if (mode === "dark") return <Glyph d={ICON.moon} size={size} />;
  return (
    <Glyph size={size}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * 面板开合图标：一个圆角方框，内侧贴一条竖杠。
 *
 * 竖杠在左 = 左侧面板，在右 = 右侧面板。两侧用**镜像**而不是旋转：
 * 旋转 180° 会连圆角一起转过去，看起来像另一个图标。
 */
export function PanelGlyph({ side, size = 16 }: { side: "left" | "right"; size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="2.4" />
      <rect
        x={side === "left" ? 4.6 : 10}
        y="5.2"
        width="1.4"
        height="5.6"
        rx="0.7"
        fill="currentColor"
        stroke="none"
      />
    </Glyph>
  );
}

/**
 * 组件自己的图标（清单里声明的那个文件）。
 *
 * 用 mask 而不是 `<img>`：SVG 只提供形状，颜色取 `currentColor`，于是
 * 明暗主题、悬停态全自动跟着走，第三方给的彩色图标也会被压成单色剪影 ——
 * 在 30px 的色块里，单色永远比彩色整齐。
 *
 * 也因此绝不能把 SVG 内容直接塞进 DOM（那是第三方内容，`<script>` 会跟着跑），
 * 只能让它以图片的身份参与遮罩。
 */
export function WidgetIconMark({ url, size }: { url: string; size: number }) {
  return (
    <span
      className="lattice-icon-mask"
      style={{ width: size, height: size, "--widget-icon": `url("${url}")` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

export const ICON = {
  /** 太阳：浅色 */
  sun: "M8 10.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M12.4 3.6l-.9.9M4.5 11.5l-.9.9",
  /** 月亮：深色 */
  moon: "M13.2 9.5A5.6 5.6 0 0 1 6.5 2.8a5.6 5.6 0 1 0 6.7 6.7Z",
  /** 半明半暗的圆：跟随系统 */
  contrast: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z",
  /** 刷新：一圈带箭头的弧 */
  refresh: "M13 8a5 5 0 1 1-1.7-3.8M13.2 2.4v3.1h-3.1",
  /** 滑杆：设置项里的"外观"。别用半明半暗的圆——那会和"跟随系统"那格撞脸 */
  appearance: "M2.8 5.4h10.4M2.8 10.6h10.4M5.9 3.5v3.8M10.1 8.7v3.8",
  user: "M13.2 14v-1.2A2.8 2.8 0 0 0 10.4 10H5.6a2.8 2.8 0 0 0-2.8 2.8V14M8 7.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z",
  grid: "M3 6h10M3 10h10M6 3v10M10 3v10",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0-8.6v.1M8 7.4V11",
  logout: "M6.4 13.4H4a1.4 1.4 0 0 1-1.4-1.4V4A1.4 1.4 0 0 1 4 2.6h2.4M10.2 10.8 12.8 8l-2.6-2.8M12.6 8H6.4",
  chevron: "m6.4 4.6 3.4 3.4-3.4 3.4",
  back: "M9.6 4.6 6.2 8l3.4 3.4",
  /** 文件夹：打开组件目录 */
  folder: "M13.4 12.4H2.6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1h3.2l1.5 1.7h5.1a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1Z",
  /** 显示器：启动时把组件放回桌面 */
  monitor: "M2.4 3.4h11.2v6.8H2.4zM6.3 13.4h3.4M8 10.2v3.2",
  /** 电源：真的退出应用 */
  power: "M8 2.2v5.4M12.3 4.4a5.8 5.8 0 1 1-8.6 0",
  /** 四角星：agent 接入。别用机器人头像，那会让人以为平台自带一个 AI */
  agent: "M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6Z",
  /** 对话气泡：助手密钥。和 agent 那颗星分开 —— 一个是"外面能动我桌面"，一个是"我替你说话" */
  chat: "M13.4 9.4a1.6 1.6 0 0 1-1.6 1.6H4.6L2.6 13V4a1.6 1.6 0 0 1 1.6-1.6h7.6A1.6 1.6 0 0 1 13.4 4v5.4Z",
  /** 放大镜：组件库搜索 */
  search: "M7.1 12.2a5.1 5.1 0 1 0 0-10.2 5.1 5.1 0 0 0 0 10.2ZM10.9 10.9l3 3",
  /** 叉：清空搜索 / 关提示 */
  close: "M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8",
  /** 向上射出的箭头 + 托盘：开机自启。别用 power，那是"退出" */
  startup: "M8 9.6V2.2M5.2 5 8 2.2 10.8 5M3.4 9.4v2.2a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V9.4",
  /** 两条竖线：暂停全部组件 */
  pause: "M6.2 3.6v8.8M9.8 3.6v8.8",
  /** 店铺：组件目录（商店）。一个带雨棚的小店面，别用 folder —— 那是"打开目录" */
  store:
    "M2.6 6.4V4.2a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1v2.2M2.6 6.4a1.9 1.9 0 0 0 3.8 0 1.9 1.9 0 0 0 3.8 0 1.9 1.9 0 0 0 3.8 0M3.6 8.2v4.4a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V8.2M6.6 13.6v-3h2.8v3",
  /** 终端窗口 + 提示符：调试面板。别用 info，那是"关于" */
  terminal:
    "M2.6 3.4h10.8a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1ZM4.8 6.5 6.6 8l-1.8 1.5M8.6 9.5h3",
};
