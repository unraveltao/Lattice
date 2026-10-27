/**
 * 棂 / Lattice —— 桌面组件窗口的宿主页
 *
 * 每个桌面窗口加载这一个页面，它再套一层沙箱 iframe 装真正的组件。
 *
 * 为什么不直接在窗口里加载组件页面：那样 `parent` 就是它自己，
 * 桥请求会发给自己然后超时；更糟的是组件拿到了窗口的完整权限，
 * 沙箱就没了。多一层 iframe 之后，桌面窗口和主窗口里的预览
 * 跑的是同一套桥、同一套权限校验。
 *
 * 除了装组件，这一页还负责"窗饰"：右上角的拖动/层级/别针/收回，
 * 以及八条缩放手柄。组件不该操心自己怎么被搬动。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import "./styles.css";
import "./widgetHost.css";
import {
  APPEARANCE_TOKENS,
  DEFAULT_APPEARANCE,
  MAX_BLUR,
  appearanceTokenValues,
  isPlainAppearance,
  luminance,
  normalizeAppearance,
  type Appearance,
} from "./runtime/appearance";
import {
  ALIGN_THRESHOLD_PX,
  computeAlign,
  guideLines,
  type AlignRect,
  type AlignResult,
} from "./runtime/align-guides";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
} from "./runtime/bridge";
import { enableMirror, isWidgetLog, trace } from "./runtime/debug";
import { decideClose, type CloseDecision } from "./runtime/close-guard";
import {
  adoptLayer,
  adoptPinned,
  layerLook,
  nextLayer,
  nextPinned,
  pinLook,
  type WindowLayer,
} from "./runtime/chrome-state";
import { createScheduler, subscribeWindowVisible, windowVisibleNow } from "./runtime/schedule";
import { fitAnchor, type FitOptions, type ScreenBox } from "./runtime/screen-fit";
import type { ConfigValues } from "./runtime/config";
import {
  ERROR_KIND_LABEL,
  errorSignature,
  isWidgetErrorReport,
  pickPrimary,
  type WidgetErrorReport,
} from "./runtime/diagnostics";
import type { Permission } from "./runtime/manifest";
import { languagePayload, setLanguage, t } from "./runtime/i18n";
import type { TermEvent } from "./runtime/term";

interface HostConfig {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: string[];
  theme: "light" | "dark";
  /**
   * 平台当前生效的界面语言。这个 webview **不加载 store**，所以偏好读不到 ——
   * 建窗口时由 Rust 随配置带下来当初值，之后的切换走 `lattice:language` 广播。
   */
  lang?: "zh" | "en";
  pinned: boolean;
  minW: number;
  minH: number;
  layer: WindowLayer;
  clickThrough: boolean;
  /** `rect` = 平台圆角卡片；`region` = 组件上报轮廓（桌宠），不画底板与窗饰 */
  shape: "rect" | "region";
  appearance: Appearance;
  /** 已经合并过出厂值的实例配置（见 runtime/config.ts） */
  config: ConfigValues;
  /**
   * 清单里的联网白名单（`network.hosts`）。
   *
   * 桌面窗口这边 Rust 自己也记着一份、并且优先用它，所以这个字段在桌面
   * 路径上其实用不上 —— 带着它是为了让桥的上下文形状一致：画布上的实例
   * 没有窗口、没有注册表条目，只能靠这份名单出网。
   */
  network?: string[];
}

const win = getCurrentWindow();

const ICON = {
  grip: `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/>
    <circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/>
    <circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/>
  </svg>`,
  layerTop: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 12.5V4"/><path d="M4.4 7.6 8 4l3.6 3.6"/>
  </svg>`,
  layerDesktop: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 3.5V12"/><path d="M4.4 8.4 8 12l3.6-3.6"/>
  </svg>`,
  pin: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.9"/><path d="M8 8.6v4.1"/>
  </svg>`,
  pinned: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.9"/><rect x="7.2" y="8.2" width="1.6" height="4.6" rx="0.8"/>
  </svg>`,
  close: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>
  </svg>`,
  reload: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.7-3.8"/>
    <path d="M13.2 2.4v3.1h-3.1"/>
  </svg>`,
};

/** 明暗跟着平台走，不跟系统走 —— 平台切深色，桌面卡片也得是深色 */
function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
}

/**
 * 按住之后持续跟踪指针位移。
 *
 * 用 setPointerCapture：拖到窗口外面（甚至拖出屏幕）事件照样回到这个元素，
 * 不会因为指针离开 webview 就断线。
 */
function track(
  element: HTMLElement,
  event: PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  const startX = event.screenX;
  const startY = event.screenY;

  element.setPointerCapture(event.pointerId);
  document.body.classList.add("is-dragging");

  const move = (next: PointerEvent) => onMove(next.screenX - startX, next.screenY - startY);

  const finish = () => {
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", finish);
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-dragging");
    onEnd();
  };

  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}

/** 把窗口当前位置与尺寸写回主窗口，让 store 记住用户摆到哪儿了 */
async function reportRect() {
  const scale = await win.scaleFactor();
  const position = (await win.outerPosition()).toLogical(scale);
  const size = (await win.innerSize()).toLogical(scale);
  await invoke("widget_report_rect", {
    x: Math.round(position.x),
    y: Math.round(position.y),
    w: Math.round(size.width),
    h: Math.round(size.height),
  });
  // 窗口挪过地方，"我背后那块桌面"就变了，磨砂底得重截一张
  void refreshWallpaper();
}

/* ------------------------------------------------------------------ *
 * 桌面上的对齐参考线
 *
 * 画布那条路由 `Canvas.tsx` 自己画线，桌面上画不了：每个组件是一个独立窗口，
 * 而参考线要贯穿整个屏幕、压在窗口上面。所以这里只负责"吸到哪、线在哪"，
 * 画线交给 Rust 的两个 1px 叠层窗口（`src-tauri/src/guides_overlay.rs`）——
 * 不是透明 WebView2（那条路在软件渲染的机器上建不出窗口，见 desktop.rs）。
 *
 * 吸附用的是和画布**同一个** `computeAlign`：算法只有一份，两边手感不会漂。
 * 唯一的差别是坐标空间：桌面全是物理像素，阈值也要跟着 DPI 放大。
 * ------------------------------------------------------------------ */

interface AlignTargets {
  /** 当前显示器的工作区（物理像素） */
  bounds: { x: number; y: number; w: number; h: number };
  /** 其它可见组件窗口 */
  rects: AlignRect[];
}

/**
 * 邻居矩形。一次拖动只取一次 —— 拖动期间只有被拖的那扇窗口在动，
 * 别人是静止的。跨屏时缩放变了会重取（那时窗口会被系统重摆一遍）。
 */
async function alignTargets(): Promise<AlignTargets | null> {
  try {
    return await invoke<AlignTargets>("guide_targets");
  } catch {
    // 读不到邻居不影响拖动，只是没有参考线
    return null;
  }
}

let guideState: { x: GuideWire | null; y: GuideWire | null } = { x: null, y: null };
let guideTimer: number | null = null;
/** 松手之后还在飞的指针事件不该再画线（否则收线后又被推回来一条） */
let guidesActive = false;

/** 一条线在屏幕上的位置与长度，全是物理像素 */
interface GuideWire {
  /** 竖线是 x、横线是 y */
  at: number;
  from: number;
  len: number;
}

/** 线的颜色跟着主题走：宿主页上有平台令牌 */
function guideColor(): string {
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue("--lattice-accent")
    .trim();
  return accent.startsWith("#") ? accent : "#5dcaa5";
}

function sameWire(a: GuideWire | null, b: GuideWire | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.at === b.at && a.from === b.from && a.len === b.len;
}

function pushGuides(vertical: GuideWire | null, horizontal: GuideWire | null) {
  if (!guidesActive) return;
  if (sameWire(guideState.x, vertical) && sameWire(guideState.y, horizontal)) return;
  guideState = { x: vertical, y: horizontal };
  void invoke("guide_show", { vertical, horizontal, color: guideColor() });
}

/** 松手收线，并停掉心跳 */
function endGuides() {
  guidesActive = false;
  if (guideTimer !== null) {
    window.clearInterval(guideTimer);
    guideTimer = null;
  }
  guideState = { x: null, y: null };
  void invoke("guide_show", { vertical: null, horizontal: null });
}

/**
 * 指针停住不动时不会再有 `pointermove`，而 Rust 侧有一条"4 秒没有新坐标就
 * 收线"的兜底（防宿主页崩掉之后把线永远留在屏幕上）。拖动期间每秒补发一次，
 * 线就不会因为"停下来看一眼对齐"而消失。
 */
function startGuideHeartbeat() {
  guidesActive = true;
  if (guideTimer !== null) return;
  guideTimer = window.setInterval(() => {
    if (guideState.x === null && guideState.y === null) return;
    void invoke("guide_show", {
      vertical: guideState.x,
      horizontal: guideState.y,
      color: guideColor(),
    });
  }, 1000);
}

/* ------------------------------------------------------------------ *
 * 底板外观：底色 + 浓度 + 磨砂
 *
 * 三层叠起来就是一张卡片：
 *
 *   canvas  壁纸（按窗口位置从桌面截下来的一块），filter: blur(Npx)
 *   veil    底色，rgba(tint, alpha)
 *   iframe  组件内容
 *
 * 为什么要自己截壁纸：窗口是不透明的，系统 acrylic 的半径又写死，
 * 只有自己糊才能做出连续滑杆。代价是"透出来的"是壁纸而不是后面的窗口，
 * 这条取舍写在 src/runtime/appearance.ts 的注释里。
 * ------------------------------------------------------------------ */

/** 壁纸层要比卡片大一圈：模糊的边缘落在卡片外面，四条边才不会发黑 */
const WALLPAPER_PAD = MAX_BLUR * 2;

let appearance: Appearance = { ...DEFAULT_APPEARANCE };
let wallpaperCanvas: HTMLCanvasElement | null = null;
let wallpaperVeil: HTMLDivElement | null = null;
/** 壁纸的平均色，用来算"底色盖上去之后到底有多亮" */
let wallpaperAvg: [number, number, number] | null = null;
let wallpaperSeq = 0;
let wallpaperLoading = false;
/** 截图中途又有人要 —— 收工后再补一张，别丢最后一次位置 */
let wallpaperDirty = false;

let surfaceCache: { theme: string; value: string } | null = null;

/**
 * 读主题自己的 `--lattice-surface`。
 *
 * 直接 `getComputedStyle` 读到的是我们上一轮写进去的内联覆盖（也就是合成后的
 * 颜色），越读越偏。所以先把覆盖摘掉再读，读完放回去。
 */
function themeSurface(theme: string): string {
  if (surfaceCache?.theme === theme) return surfaceCache.value;
  const root = document.documentElement;
  const saved = root.style.getPropertyValue("--lattice-surface");
  root.style.removeProperty("--lattice-surface");
  const value = getComputedStyle(root).getPropertyValue("--lattice-surface").trim();
  if (saved) root.style.setProperty("--lattice-surface", saved);
  const resolved = value || (theme === "light" ? "#fbfaf8" : "#17171d");
  surfaceCache = { theme, value: resolved };
  return resolved;
}

function parseHex(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return [29, 29, 33];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 由 boot() 接上：把最新的令牌推给 iframe */
let pushTheme: (() => void) | null = null;

/** 由 boot() 接上：把当前语言推给 iframe（组件自己画的话要跟着换） */
let pushLanguage: (() => void) | null = null;

/** 由 buildChrome() 接上：界面语言变了以后重贴窗饰的提示语 */
let relabelChrome: (() => void) | null = null;

/**
 * 由 buildChrome() 接上：平台那边改了层级 / 别针，窗饰要跟着重画。
 *
 * 和 `relabelChrome` 分开是因为触发源不同（一个是语言，一个是布局事实），
 * 而且这一条**必须存在** —— 少了它，属性面板里点"置顶"之后那颗箭头按钮
 * 会一直停在旧状态，再点一下等于原地打转（见 `runtime/chrome-state.ts`）。
 */
let syncChrome: ((next: { layer?: WindowLayer; pinned?: boolean }) => void) | null = null;

function postTheme() {
  pushTheme?.();
}

/** 底色 / 磨砂一变，这里就把三层的样式和给组件的令牌一起重算 */
function applyAppearance(next: Appearance) {
  appearance = next;
  const theme = (document.documentElement.dataset.theme as string) || "dark";
  const tint = parseHex(next.tint === "auto" ? themeSurface(theme) : next.tint);
  const behind = wallpaperAvg ?? parseHex(themeSurface(theme));

  // 底色盖在"背后那一层"上，看起来是什么颜色 —— 字色和边框都按它定
  const composite: [number, number, number] = [
    tint[0] * next.alpha + behind[0] * (1 - next.alpha),
    tint[1] * next.alpha + behind[1] * (1 - next.alpha),
    tint[2] * next.alpha + behind[2] * (1 - next.alpha),
  ];
  const light = luminance(composite) > 0.55;

  const root = document.documentElement;
  if (isPlainAppearance(next)) {
    /*
     * 出厂外观：一个令牌都不改，让卡片跟没有这个功能时一模一样。
     * 覆盖值只是"近似"主题（比如描边更重一点、surface-2 差得多一档），
     * 没道理为了一个没人调过的底板把默认样子换掉。
     */
    for (const token of APPEARANCE_TOKENS) {
      root.style.removeProperty(token);
    }
  } else {
    for (const [token, value] of Object.entries(appearanceTokenValues(composite, light))) {
      root.style.setProperty(token, value);
    }
  }

  // 卡片本体（body 的底色）读的就是 --lattice-surface，上面已经改成合成色了。
  // 壁纸层到位时它被盖住，没到位时（blur=0 / 截失败）它就是兜底的那一层。

  if (wallpaperVeil && wallpaperCanvas) {
    const ready = wallpaperAvg !== null;
    wallpaperVeil.style.display = ready ? "block" : "none";
    wallpaperVeil.style.background = `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${next.alpha})`;
    wallpaperCanvas.style.filter = `blur(${next.blur}px)`;
    wallpaperCanvas.style.opacity = ready ? "1" : "0";
  }

  // 组件拿到的令牌变了，推一份过去（主题切换、拖滑杆都走这里）
  postTheme();
}

/** 底色 / 磨砂真的需要壁纸时才去截：纯色实心卡片不该为一张图付 500KB */
function needsWallpaper(): boolean {
  return appearance.blur > 0 || appearance.alpha < 1;
}

async function refreshWallpaper() {
  if (!needsWallpaper()) return;
  await loadWallpaper();
}

async function loadWallpaper() {
  if (!wallpaperCanvas) return;
  // 正在截的时候又来一次（拖窗口是高频的）：别排队，只记一个"还得再来一趟"，
  // 否则排十几张图等，拖完看到的还是最开始那一眼的桌面
  if (wallpaperLoading) {
    wallpaperDirty = true;
    return;
  }
  wallpaperLoading = true;
  const token = ++wallpaperSeq;
  try {
    const buffer = await invoke<ArrayBuffer>("widget_wallpaper", { pad: WALLPAPER_PAD });
    if (token !== wallpaperSeq) return;

    const view = new DataView(buffer);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    if (!width || !height) return;

    const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
    const context = wallpaperCanvas.getContext("2d");
    if (!context) return;
    wallpaperCanvas.width = width;
    wallpaperCanvas.height = height;
    context.putImageData(new ImageData(pixels, width, height), 0, 0);

    // 图是物理像素，CSS 盒子是逻辑像素：交给浏览器缩一次，顺带把 DPI 吃掉
    wallpaperCanvas.style.width = `${window.innerWidth + WALLPAPER_PAD * 2}px`;
    wallpaperCanvas.style.height = `${window.innerHeight + WALLPAPER_PAD * 2}px`;
    wallpaperCanvas.style.left = `${-WALLPAPER_PAD}px`;
    wallpaperCanvas.style.top = `${-WALLPAPER_PAD}px`;

    wallpaperAvg = averageColor(pixels, width * height);
    applyAppearance(appearance);
  } catch (error) {
    // 截不到桌面（远程桌面、权限、PrintWindow 失败）就退回纯色卡片
    wallpaperAvg = null;
    console.warn("[lattice] 拿不到桌面背景，底板退回纯色：", error);
    applyAppearance(appearance);
  } finally {
    wallpaperLoading = false;
    if (wallpaperDirty) {
      wallpaperDirty = false;
      void refreshWallpaper();
    }
  }
}

/** 平均色：每 64 个像素采一个就够，壁纸那么大，差不了几度 */
function averageColor(pixels: Uint8ClampedArray, count: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < count; i += 64) {
    const at = i * 4;
    r += pixels[at];
    g += pixels[at + 1];
    b += pixels[at + 2];
    n += 1;
  }
  if (!n) return [29, 29, 33];
  return [r / n, g / n, b / n];
}


/*
 * 拖动按钮在窗口右上角的落点：距右边 30px、距顶边 20px。
 * 窗口没有窗饰，用户唯一能抓的地方就是那颗按钮 —— 所以"别让它出界"
 * 就等于"别让组件拖出去回不来"。
 *
 * 这三个数是 **CSS 像素**（和窗饰的样式一致）。夹紧的算法跑在物理像素上
 * （见 runtime/screen-fit.ts 的注释），所以用之前乘一次当次的 `scaleFactor`。
 */
const ANCHOR_X = 30;
const ANCHOR_Y = 20;
/** 锚点至少要留在屏幕内这么多像素，否则点不准 */
const SCREEN_MARGIN = 24;

/**
 * 所有显示器的**工作区**矩形，**物理像素**。
 *
 * 不做任何折算：`availableMonitors()` 报的位置尺寸和 `outerPosition()` 一样
 * 是 PerMonitorV2 下的真实物理像素，跨屏连续，可以直接和窗口矩形比。
 *
 * 早先这里拿当前窗口的 `scaleFactor` 去折算每一块屏 —— 两块屏缩放不同时，
 * 折算结果不是任何一块屏的真实位置，夹紧就落在幻影位置上。
 */
async function screenBoxes(): Promise<ScreenBox[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map((monitor) => {
      // 用 workArea 而不是 size：否则组件能停在任务栏底下，按钮被任务栏压住
      const area = monitor.workArea;
      return {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width,
        h: area.size.height,
      };
    });
  } catch {
    // 拿不到显示器信息就别夹了：宁可能拖出去，也不要整个拖不动
    return [];
  }
}

/** 按当次缩放算出来的锚点参数（CSS px → 物理 px） */
function anchorOptions(scale: number): FitOptions {
  return {
    anchorX: ANCHOR_X * scale,
    anchorY: ANCHOR_Y * scale,
    margin: SCREEN_MARGIN * scale,
  };
}

/**
 * 夹一次。窗口矩形用物理像素，返回值也是物理像素。
 *
 * 包一层只是为了让四处调用点读起来是同一句话。
 */
function fit(
  x: number,
  y: number,
  w: number,
  h: number,
  screens: ScreenBox[],
  scale: number,
): { x: number; y: number } {
  return fitAnchor({ x, y, w, h }, screens, anchorOptions(scale));
}


/* ------------------------------------------------------------------ *
 * 组件自己挪窗口
 *
 * 桌宠走来走去、悬浮挂件被自己的指针拖着走 —— 这两件事都得让**组件**决定
 * 往哪挪，平台只负责把它夹回工作区里。
 *
 * 和窗饰那条拖动不是一回事：那条吃的是宿主页上的指针（窗口边框），而组件的
 * 指针在沙箱 iframe 里，宿主根本收不到。所以位移只能由组件按 `pointermove`
 * 算出来，再交给这里执行。
 *
 * 攒批是必须的：组件的 pointermove 比 IPC 快，一次拖动每秒能发几百条。
 * 每条都走一遍 `outerPosition()` + `setPosition()` 的话，超出去的那些会在
 * Rust 侧排队，手感变成"松手之后窗口还在动"。所以这里串成一条链，一次只
 * 读一次位置、改一次窗口；后到的调用发现累加值已经被前一次吃掉，直接回
 * 上一次的落点。
 * ------------------------------------------------------------------ */

/** 挪完之后安静这么久，就把位置写回主窗口（进 `desktopRects`） */
const MOVE_SETTLE_MS = 900;
/** 一直在挪（宠物散步）时，最多这么久落一次盘 */
const MOVE_PERSIST_MS = 3000;

function createMover() {
  let pendingX = 0;
  let pendingY = 0;
  /** 上一次成功落地的位置（物理像素）。null = 还没挪成过 */
  let at: { x: number; y: number } | null = null;
  let chain: Promise<{ x: number; y: number } | null> = Promise.resolve(null);
  let timer = 0;
  let lastPersist = 0;
  /**
   * 攒不起来的零头（物理像素）。
   *
   * 窗口位置是整数，而组件给的是浮点数：一只以 30 px/s 散步的宠物，每帧
   * 只走 0.5 像素 —— 直接四舍五入等于**永远不动**（每次都被舍回原地）。
   * 所以把舍掉的零头留到下一次，位置才会"过一会儿整跳一格"。
   *
   * 但撞到工作区边缘时零头必须清零：那是夹紧给出的落点，不是舍入的损失，
   * 攒着它就变成"顶着墙走十秒、回头要先还清十秒的债"，看起来像卡住了。
   */
  let carryX = 0;
  let carryY = 0;

  /**
   * 位置是要落盘的（`desktopRects` 决定下次启动摆哪儿），但**不能每帧落**：
   * 一次散步就是几百次 `state_write`，每次都在重写整份 `state.json`。
   * 所以"停下来 0.9 秒"落一次，一直在挪的话每 3 秒落一次。
   */
  const schedulePersist = () => {
    if (timer) window.clearTimeout(timer);
    const wait = Math.max(
      MOVE_SETTLE_MS,
      MOVE_PERSIST_MS - (Date.now() - lastPersist),
    );
    timer = window.setTimeout(() => {
      timer = 0;
      lastPersist = Date.now();
      void reportRect();
    }, wait);
  };

  const apply = async (dx: number, dy: number) => {
    try {
      const scale = await win.scaleFactor();
      const position = await win.outerPosition();
      const size = await win.innerSize();
      // 位移是 CSS px，窗口是物理 px：一步位移是 `dx * scale`（和窗饰拖动同一个口径）
      const wantX = position.x + carryX + dx * scale;
      const wantY = position.y + carryY + dy * scale;
      const target = fit(wantX, wantY, size.width, size.height, await screenBoxes(), scale);
      const x = Math.round(target.x);
      const y = Math.round(target.y);
      // 撞到边缘时夹紧会给出同一个点，这时不发请求：`SetWindowPos` 每次都带一次重绘
      if (x !== position.x || y !== position.y) {
        await win.setPosition(new PhysicalPosition(x, y));
      }
      const clamped = Math.abs(target.x - wantX) > 0.6 || Math.abs(target.y - wantY) > 0.6;
      carryX = clamped ? 0 : wantX - x;
      carryY = clamped ? 0 : wantY - y;
      at = { x, y };
      schedulePersist();
      return at;
    } catch {
      /*
       * 读不到窗口位置（窗口正在销毁、或这台机器上它根本不是窗口）就**停手**：
       * 回 null 让组件收到 `applied: false`，它不会每帧再试。抛出去反而更糟 ——
       * 那会让组件的每次 `pointermove` 都变成一条 `internal` 错误。
       */
      return at;
    }
  };

  return (dx: number, dy: number): Promise<{ x: number; y: number } | null> => {
    pendingX += dx;
    pendingY += dy;
    chain = chain.then(async () => {
      if (!pendingX && !pendingY) return at;
      const stepX = pendingX;
      const stepY = pendingY;
      pendingX = 0;
      pendingY = 0;
      return await apply(stepX, stepY);
    });
    return chain;
  };
}

/**
 * 一个宿主页只有一扇窗口，所以一份就够。
 *
 * 放在模块作用域（而不是 `boot()` 里）是因为 `reloadWidget()` 会重跑 `boot()`：
 * 每次重载都新建一份的话，上一份攒着的位移就跟着丢了 —— 宠物正在走的时候
 * 作者存一次盘，它会原地卡一下。
 */
const moveByWindow = createMover();

/* ------------------------------------------------------------------ *
 * 组件出错了怎么办
 *
 * 组件在沙箱 iframe 里，它的异常宿主看不见（不透明源）。协议层在发组件
 * HTML 时注了一段脚本，把 `error` / `unhandledrejection` 转成一条
 * postMessage 送过来 —— 见 src/runtime/diagnostics.ts。
 *
 * 拿到之后不整屏盖住组件：卡片贴着底边，上面还能看见组件坏成什么样。
 * 这是"排查"和"使用"之间唯一的折中 —— 全遮住就不知道是哪一块炸的，
 * 不显示就还是白屏。
 * ------------------------------------------------------------------ */

/** 组件 iframe。`reloadWidget` 要够得着它，所以在模块作用域里留一份 */
let widgetFrame: HTMLIFrameElement | null = null;
/**
 * 重载时要把调度器一起作废。
 *
 * `boot()` 里才建得出调度器（它要靠 `post` 往 iframe 发 tick），而
 * `reloadWidget` 在模块作用域，够不到局部变量 —— 所以留一个钩子。
 */
let resetScheduler: (() => void) | null = null;
let errorSheet: HTMLDivElement | null = null;
/** 报上来的错按到达顺序留着，显示哪一条由 `pickPrimary` 挑 */
let errorReports: WidgetErrorReport[] = [];

/** 一次最多记这么多条。再多就说明组件在循环里抛，列表救不了 */
const MAX_REPORTS = 6;

function clearWidgetError() {
  errorReports = [];
  errorSheet?.remove();
  errorSheet = null;
}

/**
 * 重新加载组件。
 *
 * 为什么是给 `src` 加一个时间戳，而不是 `contentWindow.location.reload()`：
 * 跨源（沙箱把源变成不透明）读不到 `contentWindow.location`，会直接抛。
 * 而把同样的 `src` 再赋一次不保证触发导航，加个每次不同的查询串最稳 ——
 * 协议层按 path 解析（`split_path` 只看 `uri().path()`），查询串会被忽略。
 */
function reloadWidget() {
  const frame = widgetFrame;
  if (!frame) return;
  clearWidgetError();
  // 旧文档的订阅全部作废：不然后台还在按老心跳往新文档里发 tick，
  // 组件收到一堆不认识的订阅号
  resetScheduler?.();
  const url = new URL(frame.src, window.location.href);
  url.searchParams.set("__lattice_reload", String(Date.now()));
  frame.src = url.href;
}

/** 收一条错误：去重、限量，然后重画 */
function showWidgetError(report: WidgetErrorReport) {
  // 组件可能在渲染循环里抛错，一秒六十条。同一个错只记一次
  const signature = errorSignature(report);
  if (errorReports.some((item) => errorSignature(item) === signature)) return;
  errorReports.push(report);
  if (errorReports.length > MAX_REPORTS) errorReports.shift();
  paintWidgetError();
}

function paintWidgetError() {
  const primary = pickPrimary(errorReports);
  if (!primary) return;

  // 主错误和条数都没变就别重建 DOM：卡片会跟着抖，按钮也点不中
  const key = `${errorSignature(primary)}#${errorReports.length}`;
  if (errorSheet?.dataset.key === key) return;

  if (!errorSheet) {
    errorSheet = document.createElement("div");
    errorSheet.className = "lw-error";
    errorSheet.setAttribute("role", "alert");
    document.body.appendChild(errorSheet);
  }
  errorSheet.dataset.key = key;
  // 错误消息是组件的字符串，永远走 textContent，别拼 innerHTML
  errorSheet.replaceChildren();

  const head = document.createElement("div");
  head.className = "lw-error-head";

  const kind = document.createElement("span");
  kind.className = "lw-error-kind";
  kind.textContent = t(ERROR_KIND_LABEL[primary.kind]);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lw-error-close";
  close.textContent = "×";
  close.title = t("Dismiss");
  close.setAttribute("aria-label", t("Dismiss error"));
  close.addEventListener("click", clearWidgetError);

  head.append(kind, close);

  // 还有别的错时给个计数，点开能看到全部 —— 不占地方，也不会让人以为只有这一条
  const rest = errorReports.filter((item) => item !== primary);
  if (rest.length > 0) {
    const more = document.createElement("span");
    more.className = "lw-error-more";
    more.textContent = `+${rest.length}`;
    more.title = rest.map((item) => `${t(ERROR_KIND_LABEL[item.kind])}: ${item.message}`).join("\n");
    head.insertBefore(more, close);
  }

  const message = document.createElement("p");
  message.className = "lw-error-message";
  message.textContent = primary.message;

  errorSheet.append(head, message);

  if (primary.where) {
    const where = document.createElement("p");
    where.className = "lw-error-where";
    where.textContent = primary.where;
    errorSheet.append(where);
  }

  if (primary.stack) {
    const details = document.createElement("details");
    details.className = "lw-error-details";
    const summary = document.createElement("summary");
    summary.textContent = t("Stack trace");
    const pre = document.createElement("pre");
    pre.textContent = primary.stack;
    details.append(summary, pre);
    errorSheet.append(details);
  }

  const actions = document.createElement("div");
  actions.className = "lw-error-actions";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "lw-error-action";
  reload.textContent = t("Reload");
  reload.addEventListener("click", reloadWidget);
  actions.append(reload);
  errorSheet.append(actions);
}

function buildChrome(config: HostConfig) {
  const chrome = document.createElement("div");  chrome.className = "lw-chrome";
  chrome.innerHTML = `
    <div class="lw-pill">
      <button type="button" class="lw-btn lw-grip" data-act="drag" title="${t("Drag to move")}" aria-label="${t("Drag to move")}">${ICON.grip}</button>
      <button type="button" class="lw-btn" data-act="layer" aria-label="${t("Toggle layer")}"></button>
      <button type="button" class="lw-btn" data-act="pin" aria-label="${t("Pin position")}"></button>
      <button type="button" class="lw-btn" data-act="reload" title="${t("Reload widget")}" aria-label="${t("Reload widget")}">${ICON.reload}</button>
      <button type="button" class="lw-btn" data-act="close" title="${t("Close widget")}" aria-label="${t("Close widget")}">${ICON.close}</button>
    </div>
    ${["n", "s", "w", "e", "nw", "ne", "sw", "se"]
      .map((dir) => `<div class="lw-edge" data-dir="${dir}"></div>`)
      .join("")}
  `;

  const grip = chrome.querySelector<HTMLButtonElement>('[data-act="drag"]')!;
  const layerBtn = chrome.querySelector<HTMLButtonElement>('[data-act="layer"]')!;
  const pinBtn = chrome.querySelector<HTMLButtonElement>('[data-act="pin"]')!;
  const reloadBtn = chrome.querySelector<HTMLButtonElement>('[data-act="reload"]')!;
  const closeBtn = chrome.querySelector<HTMLButtonElement>('[data-act="close"]')!;
  /** 整颗胶囊按钮组，✕ 的手滑保护要读它的当前透明度 */
  const pill = chrome.querySelector<HTMLDivElement>(".lw-pill");

  let pinned = config.pinned;
  let layer: WindowLayer = config.layer === "top" ? "top" : "desktop";

  const paint = () => {
    document.body.classList.toggle("is-pinned", pinned);

    const pin = pinLook(pinned);
    pinBtn.innerHTML = pin.icon === "pinned" ? ICON.pinned : ICON.pin;
    pinBtn.classList.toggle("is-on", pin.on);
    pinBtn.title = t(pin.title);
    pinBtn.setAttribute("aria-label", t(pin.aria));

    const at = layerLook(layer);
    layerBtn.innerHTML = at.icon === "layer-top" ? ICON.layerTop : ICON.layerDesktop;
    layerBtn.classList.toggle("is-on", at.on);
    layerBtn.title = t(at.title);
    layerBtn.setAttribute("aria-label", t(at.aria));
  };
  paint();

  /*
   * 平台推来的层级 / 别针。
   *
   * 这两条是"置顶按钮是死的"那个 bug 的另一半：平台改层级之后，窗口当场就
   * 换了层，但宿主页手里那份副本不会自己变。收下它、重画，按钮才和窗口说的
   * 是同一件事。
   *
   * 只认这两格：位置、尺寸、外观各有各的通道，混进来会让拖一次滑杆连带
   * 重画窗饰。
   */
  syncChrome = (next) => {
    if (next.layer !== undefined) layer = next.layer;
    if (next.pinned !== undefined) pinned = next.pinned;
    paint();
  };

  /*
   * 平台切了界面语言：胶囊上那几张牌子的提示语得跟着换。
   *
   * 只补 `paint()` 管不到的那几颗（拖动 / 重载 / 关闭是写死在 innerHTML 里的），
   * 然后让 `paint()` 顺手把别针和层级两颗刷一遍 —— 它们的文案取决于状态，
   * 在这里重算等于把那份判断抄第二遍。
   */
  relabelChrome = () => {
    grip.title = t("Drag to move");
    grip.setAttribute("aria-label", t("Drag to move"));
    reloadBtn.title = t("Reload widget");
    reloadBtn.setAttribute("aria-label", t("Reload widget"));
    closeBtn.setAttribute("aria-label", t("Close widget"));
    closeBtn.title = t("Close widget");
    paint();
  };

  // ---- 拖动 ----
  /*
   * **整颗胶囊都能拖，不只是最左边那 6 个点。**
   *
   * 用户反馈"这些组件都不好拖动"。原来唯一能抓的是那颗 22×22 的点阵，而且它
   * 只在鼠标进卡片之后才淡入 —— 要先发现它、再瞄准一个 22px 的靶子，手一抖
   * 就落空（落空的那一下什么都不会发生，看起来就是"拖不动"）。现在
   * `pointerdown` 挂在胶囊本身上：抓取面积 120×28，点阵退化成"这里能拖"的
   * 说明。另外四颗按钮照旧各管各的 —— 按它们不该把窗口拖走。
   *
   * 还有一处比面积更要命：`track()`（指针捕获 + move 监听）以前挂在五六个
   * `await` **之后**。那段空窗期里指针动了是没人接的，按一下就松手的快速拖动
   * 干脆什么都不发生。现在 `track()` 同步挂上，IPC 读数在后台跑，回来之后
   * 立刻把攒下的最新位移应用一次 —— 拖动第一帧不必等任何一次 IPC。
   */
  const surface: HTMLElement = pill ?? grip;

  surface.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    // 别针 / 层级 / 重载 / 关闭：按它们是在点按钮，不是要搬窗口
    if (target?.closest(".lw-btn") && !target.closest(".lw-grip")) return;
    if (pinned || event.button !== 0) return;
    event.preventDefault();

    const element = surface;

    /*
     * 一次拖动需要的"静止事实"：缩放、起点、尺寸、显示器工作区、邻居矩形。
     * 先给一组占位值，`ready` 翻真之后才会被真正使用 —— 读失败就整趟放弃，
     * 但监听已经挂上了，松手照样能正常收尾，不会留下半条 track。
     */
    let scale = 1;
    let start = new PhysicalPosition(0, 0);
    let size = new PhysicalSize(0, 0);
    let screens: ScreenBox[] = [];
    let targets: AlignTargets | null = null;
    let ready = false;

    /**
     * 跨到另一块屏时的重锚。
     *
     * 缩放一变，说明指针进了另一块屏，Windows 会按 `WM_DPICHANGED` 的建议
     * 矩形把窗口重摆一遍 —— 我们记的 `start` 就此作废。继续按老起点算，
     * 窗口会从光标底下"滑走"。所以重新读一次真实位置，并把当前的指针
     * 位移当成新起点。
     */
    let baseDx = 0;
    let baseDy = 0;

    // 指针事件比 IPC 快，攒到下一帧再发，避免把窗口位置请求堆成队列
    let pending: { dx: number; dy: number } | null = null;
    let busy = false;

    const pump = async () => {
      if (busy || !ready) return;
      busy = true;
      try {
        while (pending) {
          const step = pending;
          pending = null;

          const next = await win.scaleFactor();
          if (next !== scale) {
            scale = next;
            start = await win.outerPosition();
            baseDx = step.dx;
            baseDy = step.dy;
            screens = await screenBoxes();
            // 换了块屏，工作区（参考线的边界候选）也换了
            targets = await alignTargets();
          }

          // 指针走 CSS px，窗口走物理 px：一步位移是 `dx * scale`
          const target = fit(
            start.x + (step.dx - baseDx) * scale,
            start.y + (step.dy - baseDy) * scale,
            size.width,
            size.height,
            screens,
            scale,
          );

          /*
           * 先夹进屏幕、再吸到邻居。
           *
           * 和画布同一个顺序（先网格后对齐），理由也一样：夹紧给出一个合法落点，
           * 对齐再把它精确地拉到某个边上。反过来的话，吸附结果会被夹紧推走几像素，
           * 用户看到的是"明明对上了，松手却差一点"。
           */
          const aligned: AlignResult | null = targets
            ? computeAlign(target.x, target.y, size.width, size.height, targets.rects, {
                bounds: targets.bounds,
                // 阈值是 CSS 像素（8px 的手感），坐标全是物理像素
                threshold: ALIGN_THRESHOLD_PX * scale,
              })
            : null;

          const nx = Math.round(aligned ? aligned.x : target.x);
          const ny = Math.round(aligned ? aligned.y : target.y);
          await win.setPosition(new PhysicalPosition(nx, ny));

          /*
           * 线是**局部**的：以这扇窗口为中心、两端各伸出「半个窗口 + 48px」
           * （`guideLines` 和画布
           * 用的是同一个函数）。一条从屏幕顶画到底的线会像把桌面切成两半，
           * 而这里真正要说清的就是"我这条边和它那条边在同一个坐标"。
           */
          if (aligned && targets) {
            const lines = guideLines(
              aligned,
              { x: nx, y: ny, w: size.width, h: size.height },
              targets.bounds,
            );
            const vertical = lines.vertical[0];
            const horizontal = lines.horizontal[0];
            pushGuides(
              vertical
                ? { at: Math.round(vertical.at), from: vertical.from, len: vertical.length }
                : null,
              horizontal
                ? { at: Math.round(horizontal.at), from: horizontal.from, len: horizontal.length }
                : null,
            );
          } else {
            // 没有邻居数据（换屏时重取失败）就别把上一帧的线留在屏幕上
            pushGuides(null, null);
          }
        }
      } finally {
        busy = false;
      }
    };

    /*
     * 先把指针收下来，再去问 IPC 要那几个数。
     *
     * 顺序反过来就是"按下去到窗口开始动"之间有一段什么都不发生的空窗 ——
     * 机器越忙越长，而用户只会说"拖不动"。
     */
    track(
      element,
      event,
      (dx, dy) => {
        pending = { dx, dy };
        void pump();
      },
      () => {
        endGuides();
        void reportRect();
      },
    );

    void (async () => {
      /*
       * 全程物理像素。
       *
       * `outerPosition()` / `innerSize()` / `availableMonitors()` 报的都是
       * PerMonitorV2 下的真实物理像素，跨屏连续；只有指针位移是 CSS px，
       * 需要乘一次当次的 `scaleFactor` 才换过去。
       *
       * 为什么不用逻辑像素：两块屏缩放不同时，"逻辑像素"不是同一套空间 ——
       * 拿一个 scale 去折算所有屏，夹紧会落在幻影位置上（见 screen-fit.ts）。
       */
      try {
        scale = await win.scaleFactor();
        start = await win.outerPosition();
        size = await win.innerSize();
        // 显示器信息拖一次只取一次：拖拽期间显示器不会变（缩放变了会重取）
        screens = await screenBoxes();
        // 同理：邻居的矩形也在拖动期间静止。取不到就退化成"只有网格般的自由摆放"
        targets = await alignTargets();
      } catch {
        // 读不到就当这一下不是拖动：监听已经挂着，松手会自己收尾
        return;
      }
      startGuideHeartbeat();
      ready = true;
      // 空窗期攒下的位移，现在一次性补上（pending 里永远是"最新那一帧"）
      void pump();
    })();
  });

  // ---- 缩放 ----
  chrome.querySelectorAll<HTMLElement>(".lw-edge").forEach((edge) => {
    const dir = edge.dataset.dir ?? "";
    edge.addEventListener("pointerdown", (event) => {
      if (pinned || event.button !== 0) return;
      event.preventDefault();
      const element = event.currentTarget as HTMLElement;

      void (async () => {
        let scale = await win.scaleFactor();
        let startPos = await win.outerPosition();
        const startSize = await win.innerSize();
        let screens = await screenBoxes();

        // 同上：跨屏时缩放会变，`startPos` 会被 Windows 重摆作废
        let baseDx = 0;
        let baseDy = 0;

        const apply = async (dx: number, dy: number) => {
          const next = await win.scaleFactor();
          if (next !== scale) {
            scale = next;
            startPos = await win.outerPosition();
            baseDx = dx;
            baseDy = dy;
            screens = await screenBoxes();
          }

          // 位移和最小尺寸都是逻辑值，先换成物理
          const mx = (dx - baseDx) * scale;
          const my = (dy - baseDy) * scale;
          const minW = config.minW * scale;
          const minH = config.minH * scale;

          let x = startPos.x;
          let y = startPos.y;
          let w = startSize.width;
          let h = startSize.height;

          if (dir.includes("e")) w = Math.max(minW, startSize.width + mx);
          if (dir.includes("s")) h = Math.max(minH, startSize.height + my);
          if (dir.includes("w")) {
            w = Math.max(minW, startSize.width - mx);
            x = startPos.x + (startSize.width - w);
          }
          if (dir.includes("n")) {
            h = Math.max(minH, startSize.height - my);
            y = startPos.y + (startSize.height - h);
          }

          // 往右/往下拉大时按钮也会被推出屏幕，同样要夹回来
          const clamped = fit(x, y, w, h, screens, scale);

          await win.setSize(new PhysicalSize(Math.round(w), Math.round(h)));
          // 只有真的动了位置才 setPosition：从东/南边拉大时不该挪窗口
          const moved =
            dir.includes("w") ||
            dir.includes("n") ||
            Math.round(clamped.x) !== Math.round(x) ||
            Math.round(clamped.y) !== Math.round(y);
          if (moved) {
            await win.setPosition(new PhysicalPosition(Math.round(clamped.x), Math.round(clamped.y)));
          }
        };

        let pending: { dx: number; dy: number } | null = null;
        let busy = false;
        const pump = async () => {
          if (busy) return;
          busy = true;
          while (pending) {
            const step = pending;
            pending = null;
            await apply(step.dx, step.dy);
          }
          busy = false;
        };

        track(
          element,
          event,
          (dx, dy) => {
            pending = { dx, dy };
            void pump();
          },
          () => void reportRect(),
        );
      })();
    });
  });

  /*
   * 平台调用失败要留痕。
   *
   * 以前这两颗按钮是 `void invoke(...)` —— 一个没有 `.catch` 的 promise，
   * 被拒的时候什么都不会发生，控制台里也只有一条 unhandled rejection。
   * "点了没效果"就是这么被藏了整整几个版本的。现在失败至少进调试面板。
   */
  const reportFailure = (name: string, error: unknown) => {
    trace({
      kind: "call",
      widgetId: config.widgetId,
      instanceId: config.instanceId,
      name,
      ok: false,
      ms: 0,
      text: String(error),
    });
  };

  // ---- 层级 / 别针 / 重载 / 收回 ----
  layerBtn.addEventListener("click", () => {
    layer = nextLayer(layer);
    paint();
    void invoke("widget_set_layer", { layer }).catch((error) => reportFailure("widget_set_layer", error));
  });

  pinBtn.addEventListener("click", () => {
    pinned = nextPinned(pinned);
    paint();
    void invoke("widget_set_pinned", { pinned }).catch((error) =>
      reportFailure("widget_set_pinned", error),
    );
  });

  /*
   * 重载只给按钮，不绑快捷键。
   *
   * 组件 iframe 铺满整个窗口，键盘焦点几乎总在它里面 —— 宿主页收不到
   * keydown，绑了也按不着。真要做快捷键得由组件自己转告，那是另一件事。
   */
  reloadBtn.addEventListener("click", reloadWidget);

  /*
   * 关窗：从"点一下就算"改成"按下和松开都落在 ✕ 上才算"。
   *
   * 原来的写法只挂了一个 `click`，判断里只有"窗饰淡到几成了"。可日志里那几次
   * 幽灵关闭带着完整的指针特征（`isTrusted`、`detail: 1`、`pointer: mouse`），
   * 落点正好在 ✕ 中心 —— 光看 click 分不出它和真点击。现在把整段指针序列
   * 收下来交给 `decideClose`（runtime/close-guard.ts，22 条断言钉着）：
   * 没有 pointerdown 的点击一律不认，坐标已经不在按钮上的也不认。
   *
   * 键盘（Enter / 空格）走另一条：那类 `click` 的 `detail` 是 0，没有指针
   * 序列，用指针规则去卡它等于把键盘用户挡在门外。
   */
  let press: { id: number; x: number; y: number } | null = null;

  closeBtn.addEventListener("pointerdown", (event) => {
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });

  // 松手可能落在按钮外面（拖出去再松），所以监听挂在 window 上，
  // 用捕获阶段，免得被别的处理器 stopPropagation 掉
  window.addEventListener(
    "pointerup",
    (event) => {
      const started = press;
      press = null;
      if (!started || event.button !== 0) return;
      // 不是按在 ✕ 上开始的松开，和关窗无关（可能是拖窗、点组件）
      if (started.id !== event.pointerId) return;

      const decision = decideClose({
        opacity: chromeOpacity(),
        keyboard: false,
        downOnButton: true,
        upOnButton: closeBtn.contains(event.target as Node),
        hitAtRelease: closeBtn.contains(document.elementFromPoint(event.clientX, event.clientY)),
        samePointer: true,
        travel: Math.hypot(event.clientX - started.x, event.clientY - started.y),
      });
      if (!decision.accept) {
        console.info(`[lattice] close refused (${decision.reason}): ${decision.detail}`);
        return;
      }
      commitClose(decision, {
        trusted: event.isTrusted,
        detail: 0,
        pointer: event.pointerType ?? "",
        at: `${event.clientX},${event.clientY}`,
      });
    },
    true,
  );

  closeBtn.addEventListener("click", (event) => {
    // 有指针序列的点击已经在上面的 pointerup 里处理过了，别关两次
    if (event.detail > 0) return;

    const decision = decideClose({
      opacity: chromeOpacity(),
      keyboard: true,
      downOnButton: true,
      upOnButton: true,
      hitAtRelease: true,
      samePointer: true,
      travel: 0,
    });
    if (!decision.accept) {
      console.info(`[lattice] close refused (${decision.reason}): ${decision.detail}`);
      return;
    }
    commitClose(decision, {
      trusted: event.isTrusted,
      detail: event.detail,
      pointer: "",
      at: `${event.clientX},${event.clientY}`,
    });
  });

  /** 窗饰现在有多不透明。读不到就按 0 算 —— 宁可挡一次，也别误删布局 */
  function chromeOpacity(): number {
    if (!pill) return 1;
    const value = Number.parseFloat(getComputedStyle(pill).opacity);
    return Number.isFinite(value) ? value : 0;
  }

  function commitClose(decision: CloseDecision, input: { trusted: boolean; detail: number; pointer: string; at: string }) {
    /*
     * 点击特征跟着 IPC 一起走，**不再**用 console.info 打。
     *
     * 这条路径会动用户的布局，"组件自己从画布上消失"那件事查到今天还没结案，
     * 缺的就是"那一下是什么点击"。宿主页的 console 在 vite dev 下不会转发到
     * 终端，写了也看不见；塞进参数里，Rust 侧就能和 `widget_close` 打在同一行。
     *
     * `why` 是这一轮新加的判据：它等于 `ok` 说明这次是"按在 ✕ 上又松在 ✕ 上"
     * 的完整序列 —— 下次再复现，这一栏能直接告诉我们是哪条分支放过去的。
     */
    const origin = { ...input, why: decision.reason };

    // 先让窗口自己消失，再走 IPC 去真正销毁。
    // 只调 window.close() 的话，要等 WebView2 把渲染进程拆完（几百毫秒），
    // 这段时间窗口还完整地挂在屏幕上 —— 用户感受到的就是"点了没反应"。
    closeBtn.disabled = true;
    void win.hide().catch(() => {});
    // reason 是"谁要关"。只有用户按的 ✕ 才连 placement 一起删，
    // 别的来路只关窗口 —— 见 runner.rs 的 widget_close 注释
    void invoke("widget_close", { reason: "user", click: origin }).catch(() => {
      // 真失败了就把窗口放回来，不然它会变成一个看不见又关不掉的幽灵
      closeBtn.disabled = false;
      void win.show().catch(() => {});
    });
  }

  document.body.appendChild(chrome);
}

async function boot() {
  applyTheme("dark");

  // 卡片底色由 widget-host.html 的样式负责，这里不再动背景，
  // 否则会和 SetWindowRgn 裁出来的圆角打架
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  const config = await invoke<HostConfig>("widget_host_config");
  applyTheme(config.theme);
  /*
   * 先把语言定下来，再画任何带字的东西。`config.lang` 缺省（老前端 / 老 Rust）
   * 时不覆盖 —— 用 `navigator.language` 猜的那一档，总比固定成中文好。
   */
  if (config.lang === "zh" || config.lang === "en") setLanguage(config.lang);

  /*
   * 调试面板的供料端。
   *
   * 桌面窗口和主窗口是两个 webview：组件的日志、桥的每次调用都发生在这里，
   * 而面板画在主窗口里。`enableMirror()` 让之后的记录攒批 `emit` 出去，
   * 主窗口那边订阅同一个事件名收下。
   *
   * 必须在拿到 config 之后开 —— 记录里要带 widgetId / instanceId，面板靠它
   * 区分"这条是谁的"。开早了只能记成空字符串。
   */
  enableMirror();

  /*
   * `shape: region`：这块窗口不是卡片，是"只有宠物那几块像素存在"的一个洞。
   *
   * 所以底板三层一层都不画 —— 画了也是白画：区域外（包括整块底板）都被
   * `SetWindowRgn` 裁掉了，剩下的只有宠物身上那几块。背景改成透明，
   * 是为了让"还没上报区域"的那几百毫秒什么都不露（Rust 那边同时用空区域兜底）。
   */
  const regionShape = config.shape === "region";
  document.documentElement.dataset.shape = regionShape ? "region" : "rect";

  /*
   * 底板三层，从下往上：
   *   canvas  壁纸（模糊半径由 CSS filter 给，脚本只管截）
   *   veil    底色 rgba(tint, alpha)
   *   iframe  组件内容
   * 卡片本体（body 的底色、圆角、描边）还是由 widget-host.html 负责。
   */
  if (!regionShape) {
    wallpaperCanvas = document.createElement("canvas");
    wallpaperCanvas.className = "lw-wallpaper";
    wallpaperVeil = document.createElement("div");
    wallpaperVeil.className = "lw-veil";
    document.body.append(wallpaperCanvas, wallpaperVeil);
    applyAppearance(normalizeAppearance(config.appearance));
    // 上次退出时就是磨砂底的话，建窗口这一刻就得把壁纸补上
    void refreshWallpaper();

    /*
     * 尺寸变了要重铺壁纸：canvas 的 CSS 盒子是按窗口大小算的，缩小时它多出来
     * 一截（无所谓，被圆角裁掉），放大时就会露出没铺到的边 —— 得重新截一张，
     * 因为"窗口背后那块桌面"也跟着变大了。
     */
    window.addEventListener("resize", () => {
      if (!wallpaperCanvas) return;
      wallpaperCanvas.style.width = `${window.innerWidth + WALLPAPER_PAD * 2}px`;
      wallpaperCanvas.style.height = `${window.innerHeight + WALLPAPER_PAD * 2}px`;
      void refreshWallpaper();
    });
  }

  const granted = new Set<Permission>(config.permissions as Permission[]);

  /*
   * 实例配置。
   *
   * Rust 传下来的已经是**合并过出厂值**的完整对象（合并规则在
   * `runtime/config.ts`，主窗口那边算好）。所以这里不做归一化，只负责
   * 在两件事发生时把它交出去：组件问（`config.get`）、配置变了（推送）。
   *
   * 用一个可变的模块内变量而不是 const，是因为属性面板随时可能改它 ——
   * 桥的每次调用都要读最新值，跟 `granted` 那份集合是同一个道理。
   */
  let instanceConfig: ConfigValues = config.config ?? {};

  /*
   * 权限是活的。
   *
   * 以前这个集合在窗口启动时建一次就再也不动 —— 主窗口里撤销 `storage`，
   * 桌面上这个组件照样能写盘。撤销授权必须当场生效，所以就地换内容：
   * 桥每次调用都读这个集合，清掉之后下一次请求就会被拒。
   *
   * 换完还要重走一遍初始化。只换集合的话，组件在授权前可能已经把
   * "权限被拒"写进了自己的界面，它不会自己回头重试；画布那边是靠重挂
   * iframe 达到同样效果（WidgetFrame.tsx 的 reloadKey），行为对齐。
   *
   * 载荷里带 instanceId 是必须的：这条事件会送到**每个**窗口（`emit_to` 对
   * `Any` 监听器不过滤，见 runner.rs 的 PermissionsMessage 注释）。不比对的话，
   * 改 A 的权限会把 B 也重载一次，B 里没落盘的草稿当场丢。
   */
  void listen<{ instanceId: string; permissions: string[] }>(
    "lattice:widget-permissions",
    (event) => {
      if (event.payload.instanceId !== config.instanceId) return;
      granted.clear();
      for (const permission of event.payload.permissions) granted.add(permission as Permission);
      reloadWidget();
    },
  );

  const iframe = document.createElement("iframe");
  // allow-forms 不能省：沙箱里没有它，浏览器会把 <form> 的提交整条拦掉，
  // submit 事件根本不触发 —— 组件里"输入框 + 回车"这种最普通的写法会静默失效
  // （待办清单就是这么躺了一整版：字打进去了，回车没反应，列表永远是空的）。
  // 它不扩大权限面：不给 allow-same-origin 的话表单只能提交到自己的不透明源，
  // 而外发请求本来就能用 fetch 发，网络权限也不在这条路上。
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute(
    "style",
    "display:block;width:100vw;height:100vh;border:0;background:transparent;",
  );

  // entry 是主窗口算好的绝对地址：内置组件走应用源（dev 下是 vite，
  // 打包后是 tauri 协议），用户组件走 lattice-widget://。
  // 只有拿到老格式的相对路径时才退回按应用根解析。
  const base = window.location.href.replace(/[^/]*$/, "");
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(config.entry);
  iframe.src = absolute ? config.entry : base + config.entry;
  document.body.appendChild(iframe);
  widgetFrame = iframe;

  // 窗饰是画在卡片右上角的，`region` 形状下那块位置根本不存在（被裁掉了），
  // 留着只会让"✕ 消失了"变成一个谜。桌宠自己给退出口（右键 → window.close），
  // 真正的删除仍然在组件库 / 画布的"收回"里 —— 那是用户数据，不经组件。
  if (!regionShape) buildChrome(config);

  const post = (payload: unknown) => iframe.contentWindow?.postMessage(payload, "*");
  pushTheme = () => post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  pushLanguage = () => post({ [BRIDGE_TAG]: 1, type: "language", payload: languagePayload() });

  /*
   * 一个桌面窗口一条时间轴。组件所有的 `schedule.every` 都挂在这上面，
   * 窗口被最小化 / 藏起来时 `document.hidden` 变真，整条时间轴停摆。
   */
  const scheduler = createScheduler(post);
  resetScheduler = () => scheduler.reset();

  /*
   * 窗口看不看得见，推给组件。
   *
   * `schedule` 停的只是挂在时间轴上的定时器；组件自己开的
   * `requestAnimationFrame` 不在它管辖内 —— 桌面窗口被最小化 / 藏起来之后
   * 那条帧循环还在跑，实测一只桌宠空转就吃掉一整个核。
   *
   * 不带的身份这件事不用管：这条说的是"这个窗口"，而这个宿主页只有一个 iframe。
   */
  const stopVisibilityWatch = subscribeWindowVisible((visible) => {
    post({ [BRIDGE_TAG]: 1, type: "visible", payload: { visible } });
  });
  // 窗口关掉时退订：宿主页和窗口同生共死，退订只是不给"销毁中的文档"再推消息
  window.addEventListener("beforeunload", stopVisibilityWatch, { once: true });

  window.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow) return;

    const data = event.data as Record<string, unknown> | null;

    /*
     * 组件脚本自己抛的错，由协议层注进去的那段脚本转过来。
     * 它不带 `__lattice` 标记，所以必须排在前面的桥分支之前认掉 ——
     * 掉进桥分支只会被 `isBridgeRequest` 丢掉，错误就静默了。
     */
    if (isWidgetErrorReport(data)) {
      showWidgetError(data);
      return;
    }

    /*
     * 组件的 console（同一段注入脚本转发过来的）。同样排桥分支之前：
     * 它带 `__lattice` 标记，但不是请求。
     */
    if (isWidgetLog(data)) {
      const level = String((data.payload as { level?: unknown })?.level ?? "log");
      trace({
        kind: "log",
        widgetId: config.widgetId,
        instanceId: config.instanceId,
        name: level,
        ok: level !== "error",
        ms: 0,
        text: String((data.payload as { text?: unknown })?.text ?? ""),
      });
      return;
    }

    if (data && data[BRIDGE_TAG] === 1 && data.type === "ready") {
      post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
      post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config: instanceConfig } });
      post({ [BRIDGE_TAG]: 1, type: "language", payload: languagePayload() });
      post({ [BRIDGE_TAG]: 1, type: "visible", payload: { visible: windowVisibleNow() } });
      return;
    }
    if (!isBridgeRequest(data)) return;

    void handleBridgeRequest(data, {
      instanceId: config.instanceId,
      widgetId: config.widgetId,
      granted,
      config: instanceConfig,
      schedule: scheduler,
      egress: config.network ?? [],
      reply: post,
      close: () => {
        // 组件自己要退出：关窗口，但不删用户的 placement
        void invoke("widget_close", { reason: "widget" });
      },
      // 只有 `shape: region` 的窗口认这个；Rust 侧还会再核一遍清单
      setRegion: regionShape
        ? async (parts) => {
            await invoke("widget_set_region", { parts });
          }
        : undefined,
      // 桌宠走动 / 拖动自己。画布那边不传，于是回 `applied: false`
      moveBy: moveByWindow,
      trace: (entry) => {
        trace({
          kind: "call",
          widgetId: config.widgetId,
          instanceId: config.instanceId,
          name: entry.method,
          ok: entry.ok,
          ms: entry.ms,
          text: entry.text ?? entry.code ?? "",
        });
      },
    });
  });

  iframe.addEventListener("load", () => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
    post({ [BRIDGE_TAG]: 1, type: "language", payload: languagePayload() });
    post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config: instanceConfig } });
    post({ [BRIDGE_TAG]: 1, type: "visible", payload: { visible: windowVisibleNow() } });
  });

  /*
   * 属性面板改了配置。
   *
   * 不重载 iframe：配置是调参，不是换权限。重载会把组件里没落盘的草稿
   * （正在写的便签、还没提交的输入）一起冲掉，而改一个"显示秒"完全不该有
   * 这种代价。
   *
   * 载荷带 instanceId：`emit_to` 会送到每个窗口（见 runner.rs 的同名注释）。
   */
  void listen<{ instanceId: string; config: ConfigValues }>(
    "lattice:widget-config",
    (event) => {
      if (event.payload.instanceId !== config.instanceId) return;
      instanceConfig = event.payload.config ?? {};
      post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config: instanceConfig } });
    },
  );

  // 平台切明暗时跟着换，否则桌面上的组件会一直停在建窗口那一刻的主题
  void listen<string>("lattice:theme", (event) => {
    applyTheme(event.payload === "light" ? "light" : "dark");
    // 主题换了，"跟随主题"的底色和字色都得跟着重算
    applyAppearance(appearance);
  });

  /*
   * 平台切了界面语言（和上面那条主题广播同一套）。
   *
   * 两件事：平台自己写的字（窗饰按钮的悬停提示、"组件坏了"那张卡片）用 `t()` 重画一遍；
   * 再把新语言推给组件 —— 作者写的中英文要由组件自己挑（`lang.get` 拿初值、这条推送跟着变），
   * 平台不认识组件里的句子，也就没法替它翻。
   */
  void listen<string>("lattice:language", (event) => {
    setLanguage(event.payload === "zh" ? "zh" : "en");
    pushLanguage?.();
    relabelChrome?.();
    // 错误卡片是按"签名 + 条数"记 key 的，改语言不会让它重建 —— 手动作废一次
    if (errorSheet) errorSheet.dataset.key = "";
    paintWidgetError();
  });

  /*
   * 属性面板在拖滑杆。只换外观，不重建窗口 —— 这是三个滑杆能跟手的前提。
   *
   * 同样要认 instanceId：不认的话拖 A 的滑杆会把桌面上所有卡片的底板一起改掉
   * （`emit_to` 对 `Any` 监听器不过滤，见 runner.rs 的 AppearanceMessage 注释）。
   */
  void listen<{ instanceId: string; appearance: Appearance }>("lattice:appearance", (event) => {
    if (event.payload.instanceId !== config.instanceId) return;
    applyAppearance(normalizeAppearance(event.payload.appearance));
    void refreshWallpaper();
  });

  /*
   * 平台改了层级（属性面板 / 卡片右键菜单 / agent 的 `placement.front`）。
   *
   * 以前这里什么都没有：`sync_widget_windows` 只把新层级写进 Win32，窗饰那颗
   * 箭头按钮手里那份副本停在建窗口那一刻。于是用户点"置顶"，窗口真的上去了，
   * 按钮却还画着"贴桌面"的箭头 —— 再点一下，它是从旧副本算出 `top` 送回来，
   * 值没变，按钮看起来就是死的（`docs/PITFALLS.md`「层级、焦点与 z 序」）。
   *
   * 认 `instanceId`：`emit_to` 会送到每个窗口的 `Any` 监听器上，不认的话
   * 改一个组件的层级，桌面上所有组件的窗饰跟着重画。
   */
  void listen<{ instanceId: string; layer: WindowLayer }>("lattice:widget-layer", (event) => {
    const next = adoptLayer(config.instanceId, event.payload);
    if (next === null) return;
    syncChrome?.({ layer: next });
  });

  /*
   * 别针同理，只是改它的只有 agent（`placement.pin`）—— 用户自己点的时候
   * 走 `widget_set_pinned`，宿主页已经就地重画过了。
   */
  void listen<{ instanceId: string; pinned: boolean }>("lattice:widget-pinned", (event) => {
    const next = adoptPinned(config.instanceId, event.payload);
    if (next === null) return;
    syncChrome?.({ pinned: next });
  });

  /*
   * 组件存储被别的实例改了（画布上还有一份同款组件），转告 iframe 去重读。
   * 不转的话两边各持一份列表，谁后写谁把对方的新增抹掉。
   */
  void listen<{ widgetId: string; key: string }>("lattice:widget-store", (event) => {
    if (event.payload.widgetId !== config.widgetId) return;
    post({ [BRIDGE_TAG]: 1, type: "store-changed", payload: { key: event.payload.key } });
  });

  /*
   * 终端的输出流（`lattice.term`）。
   *
   * 桥是一问一答的，`ping -n 10` 那十行只能走事件。Rust 的 `emit` 到不了 iframe，
   * 所以宿主页认领（按 `instanceId`，不变量 9）再转进去。
   */
  void listen<TermEvent>("lattice:term", (event) => {
    if (event.payload.instanceId !== config.instanceId) return;
    post({ [BRIDGE_TAG]: 1, type: "term", payload: event.payload });
  });

  /*
   * 页面自己要走了：把这条 shell 收掉。
   *
   * 主路是 Rust 侧那个 `WindowEvent::Destroyed`（`runner.rs`），这一句补的是
   * "窗口还在、宿主页先被换掉"（重载入口页、组件被卸载）的那一段。
   */
  window.addEventListener("pagehide", () => {
    void invoke("term_dispose", { instanceId: config.instanceId }).catch(() => {
      /* 应用正在退出，没人接这条命令了 */
    });
  });

  /*
   * 组件目录里的文件变了（编辑器存盘、手工拷进去、脚本生成）。
   *
   * 载荷是**相对组件根目录**的路径，形如 `lattice.clock/widget.js` ——
   * 第一段就是组件 id（协议层 `resolve()` 和 `install_widget` 都按
   * `<id>/<相对路径>` 拼，目录名必须等于清单 id）。
   *
   * 所以这里按前缀筛：只有自己那份变了才重载。不筛的话，桌面上摆五个组件，
   * 改一个另外四个一起闪 —— 每次闪都意味着重建一次 iframe、重跑一遍组件
   * 脚本、丢掉它内存里的状态。
   */
  void listen<{ files: string[] }>("lattice:widgets-changed", (event) => {
    const prefix = `${config.widgetId}/`;
    const mine = event.payload.files.some(
      (file) => file === config.widgetId || file.startsWith(prefix),
    );
    if (mine) reloadWidget();
  });

  /*
   * 开机自我纠正。
   *
   * 老版本没有夹边界，可能已经把窗口摆到屏幕外了 —— 那种窗口拖不动，
   * 也没法点按钮收回。这里建窗口时校正一次，顺手把新位置报回去，
   * 用户升级之后不用手改 state.json 就能把它拉回视野。
   *
   * 位置本来就正常时什么也不做，不会看到跳动。
   */
  void (async () => {
    try {
      const scale = await win.scaleFactor();
      const position = await win.outerPosition();
      const size = await win.innerSize();
      const target = fit(position.x, position.y, size.width, size.height, await screenBoxes(), scale);
      if (Math.round(target.x) === Math.round(position.x) && Math.round(target.y) === Math.round(position.y)) {
        return;
      }
      await win.setPosition(new PhysicalPosition(Math.round(target.x), Math.round(target.y)));
      await reportRect();
    } catch {
      // 校正失败不影响正常使用，下次投放还会再试
    }
  })();
}

void boot();
