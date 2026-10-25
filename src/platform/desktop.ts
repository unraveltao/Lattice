/**
 * 棂 / Lattice —— 运行态控制（前端侧）
 *
 * 把画布上的 Placement 翻译成桌面窗口描述，交给 Rust 建窗口。
 * 坐标是画布的 CSS 像素，需要加上画布元素在屏幕上的偏移，
 * 否则组件会全部堆到左上角。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { normalizeAppearance, type Appearance } from "../runtime/appearance";
import { resolveConfig, type ConfigValues } from "../runtime/config";
import { lang } from "../runtime/i18n";
import type { Permission } from "../runtime/manifest";
import type { WidgetRecord } from "../runtime/registry";
import type { DesktopRect, Placement } from "./store";

export interface WidgetWindowSpec {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: Permission[];
  /**
   * 联网白名单，直接来自清单。Rust 侧按它逐条比对，组件改不了自己这份。
   *
   * 和 `permissions` 分开传而不是合并成一个对象：一个说"能不能联网"，
   * 一个说"能连哪儿"，两者的来源和变更频率都不同（前者用户授予，后者作者声明）。
   */
  network: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
  layer: "desktop" | "top";
  /** 组件要不要键盘焦点，见 manifest.interactive */
  interactive: boolean;
  /** 窗口轮廓来源：rect = 平台圆角，region = 组件上报（见 manifest.shape） */
  shape: "rect" | "region";
  clickThrough: boolean;
  pinned: boolean;
  /** 平台当前解析出的明暗，桌面窗口据此上色 */
  theme: "light" | "dark";
  /**
   * 平台当前生效的界面语言，桌面窗口拿它当提示语的初值。
   *
   * 为什么和 `theme` 一样走 spec 而不是让宿主页自己算：桌面窗口是另一个
   * webview，**不加载 store**，读不到设置里那档偏好（"跟随系统"还是"英文"）。
   * 自己用 `navigator.language` 猜一遍的话，用户把界面切成英文、桌面卡片上
   * 还是中文 —— 而后来的切换由 `lattice:language` 广播补上（和主题同一套）。
   */
  lang: "zh" | "en";
  /** 底板外观：实例覆盖优先，其次清单出厂值 */
  appearance: Appearance;
  /**
   * 这个实例的配置，**已经合并过出厂值**。
   *
   * 为什么在发出前就合并、而不是让宿主页自己补：合并规则只有一份
   * （`resolveConfig`），桌面窗口和画布必须拿到同一个结果 —— 否则同一个实例
   * 在两处显示得不一样，用户会以为是 bug。Rust 侧只负责透传。
   */
  config: ConfigValues;
}

/** 上一次算出来的、可信的画布原点 */
let cachedOrigin: { x: number; y: number } | null = null;

/** 画布左上角在屏幕坐标系里的位置 */
function canvasOrigin(): { x: number; y: number } {
  const rect = document.querySelector(".lattice-canvas")?.getBoundingClientRect();
  if (!rect) return cachedOrigin ?? { x: 0, y: 0 };

  const x = window.screenX + rect.left;
  const y = window.screenY + rect.top;

  // 投放之后主窗口会被最小化，此时 screenX/screenY 是 -32000 这类哨兵值。
  // 拿它算出来的坐标会把所有组件推出屏幕外，所以遇到就退回上一次的可见位置。
  if (x < -10000 || y < -10000) return cachedOrigin ?? { x: 0, y: 0 };

  cachedOrigin = { x, y };
  return cachedOrigin;
}

/** 直接读 <html data-theme>：App 的主题 effect 已经把它算好了，这里不用再猜一次 */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function buildSpecs(
  placements: Placement[],
  records: Map<string, WidgetRecord>,
  grants: Record<string, Permission[]>,
  desktopRects: Record<string, DesktopRect>,
  configs: Record<string, ConfigValues>,
): WidgetWindowSpec[] {
  const origin = canvasOrigin();
  const theme = currentTheme();
  const specs: WidgetWindowSpec[] = [];

  for (const placement of placements) {
    const record = records.get(placement.widgetId);
    if (!record) continue;
    // 入口是绝对地址：内置组件走应用源，用户组件走 lattice-widget://。
    // 宿主页拿到什么就加载什么，不再自己拼前缀（拼错就是白屏，且很难查）
    const entry = record.entryUrl;
    // 桌面上摆过就以那次为准 —— 用户拖到哪儿就该待在哪儿，
    // 画布坐标只在第一次投放时用来给个初始位置
    const placed = desktopRects[placement.instanceId];
    specs.push({
      instanceId: placement.instanceId,
      widgetId: placement.widgetId,
      entry,
      permissions: grants[placement.widgetId] ?? [],
      network: record.manifest.network.hosts,
      x: Math.round(placed ? placed.x : origin.x + placement.x),
      y: Math.round(placed ? placed.y : origin.y + placement.y),
      w: Math.round(placed ? placed.w : placement.w),
      h: Math.round(placed ? placed.h : placement.h),
      minW: record.manifest.size.minW,
      minH: record.manifest.size.minH,
      layer: placement.layer,
      interactive: record.manifest.interactive,
      shape: record.manifest.shape,
      clickThrough: placement.clickThrough,
      pinned: placement.pinned ?? false,
      theme,
      lang: lang(),
      appearance: normalizeAppearance(placement.appearance ?? record.manifest.appearance),
      config: resolveConfig(record.manifest.config, configs[placement.instanceId]),
    });
  }

  return specs;
}

/**
 * 同步请求串成一条链：同一时刻只允许一条在飞。
 *
 * 不串行会出真问题，而且症状很难认：
 *
 * 启动恢复和"120ms 防抖同步"会在开机那一刻同时触发。两个 `sync_widget_windows`
 * 并发跑，都先查 `get_webview_window(label)` 拿到 None，然后各自 `build()` 一遍 ——
 * 同一个实例被建出两个窗口，一个归 Tauri 管、另一个成了没人认领的孤儿：
 * 屏幕上看着是"一个"（位置尺寸完全一样），实际上两份 WebView2 在跑，
 * 点击被上面那份吃掉，卸载/收回也只关得掉一个。
 *
 * 更糟的是并发建窗口会让 WebView2 的创建排队到几十秒，IPC 那边先超时
 * （`Failed to fetch`），退到 postMessage 之后响应再也回不来 ——
 * 界面上的"投放到桌面"按钮从此永久变灰。
 *
 * 后来的请求不用合并：位置/层级是幂等的，前一条跑完再跑后一条即可，
 * 顺序天然正确。
 */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  // 前一条失败不能卡住后面：先 catch 掉再挂新的
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

export function syncDesktop(specs: WidgetWindowSpec[]): Promise<void> {
  return serial(() => invoke("sync_widget_windows", { specs }));
}

export function closeDesktop(): Promise<void> {
  return serial(() => invoke("close_widget_windows"));
}

export async function minimizeMain(): Promise<void> {
  await getCurrentWindow().minimize();
}
