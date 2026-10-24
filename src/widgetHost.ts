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
  DEFAULT_APPEARANCE,
  MAX_BLUR,
  hexFromRgb,
  isPlainAppearance,
  luminance,
  normalizeAppearance,
  type Appearance,
} from "./runtime/appearance";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
} from "./runtime/bridge";
import { enableMirror, isWidgetLog, trace } from "./runtime/debug";
import { decideClose, type CloseDecision } from "./runtime/close-guard";
import { createScheduler } from "./runtime/schedule";
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

interface HostConfig {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: string[];
  theme: "light" | "dark";
  pinned: boolean;
  minW: number;
  minH: number;
  layer: "desktop" | "top";
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
  const resolved = value || (theme === "light" ? "#fbfaf8" : "#15151a");
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
    for (const token of [
      "--lattice-surface",
      "--lattice-surface-2",
      "--lattice-text",
      "--lattice-text-muted",
      "--lattice-border",
      "--lattice-accent",
      "--lattice-chrome",
      "--lattice-chrome-fg",
    ]) {
      root.style.removeProperty(token);
    }
  } else {
    root.style.setProperty("--lattice-surface", hexFromRgb(...composite));
    root.style.setProperty("--lattice-text", light ? "#141418" : "#ecebe6");
    root.style.setProperty("--lattice-text-muted", light ? "#5b5b55" : "#97978f");
    root.style.setProperty(
      "--lattice-border",
      light ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.12)",
    );
    /*
     * 强调色也得跟着翻。组件里的状态字（便签的 "Saved"、待办的计数）用的就是
     * 它：深色主题那支薄荷绿压在浅色底板上几乎看不见，反过来同理。
     * 两支都是主题里现成的值，不另造色。
     */
    root.style.setProperty("--lattice-accent", light ? "#0f6e56" : "#5dcaa5");

    /*
     * 窗饰那排按钮浮在底板上面，颜色不能跟着底板算。
     *
     * 底板是"底色盖在**壁纸平均色**上"，而按钮底下压着的是**那一小块**壁纸 ——
     * 绿底板上摆一枚按全局平均色算出来的橄榄色按钮，看着就像没对准。窗饰是
     * 平台的界面，不是用户调的底板，所以给它一对固定的中性色：卡片浅就白，
     * 卡片深就炭，图标永远压得住。
     */
    root.style.setProperty("--lattice-chrome", light ? "#f7f6f3" : "#23232a");
    root.style.setProperty("--lattice-chrome-fg", light ? "#141418" : "#ecebe6");
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
  kind.textContent = ERROR_KIND_LABEL[primary.kind];

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lw-error-close";
  close.textContent = "×";
  close.title = "Dismiss";
  close.setAttribute("aria-label", "Dismiss error");
  close.addEventListener("click", clearWidgetError);

  head.append(kind, close);

  // 还有别的错时给个计数，点开能看到全部 —— 不占地方，也不会让人以为只有这一条
  const rest = errorReports.filter((item) => item !== primary);
  if (rest.length > 0) {
    const more = document.createElement("span");
    more.className = "lw-error-more";
    more.textContent = `+${rest.length}`;
    more.title = rest.map((item) => `${ERROR_KIND_LABEL[item.kind]}: ${item.message}`).join("\n");
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
    summary.textContent = "Stack trace";
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
  reload.textContent = "Reload";
  reload.addEventListener("click", reloadWidget);
  actions.append(reload);
  errorSheet.append(actions);
}

function buildChrome(config: HostConfig) {
  const chrome = document.createElement("div");  chrome.className = "lw-chrome";
  chrome.innerHTML = `
    <div class="lw-pill">
      <button type="button" class="lw-btn lw-grip" data-act="drag" title="Drag to move" aria-label="Drag to move">${ICON.grip}</button>
      <button type="button" class="lw-btn" data-act="layer" aria-label="Toggle layer"></button>
      <button type="button" class="lw-btn" data-act="pin" aria-label="Pin position"></button>
      <button type="button" class="lw-btn" data-act="reload" title="Reload widget" aria-label="Reload widget">${ICON.reload}</button>
      <button type="button" class="lw-btn" data-act="close" title="Close widget" aria-label="Close widget">${ICON.close}</button>
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
  let layer = config.layer;

  const paint = () => {
    document.body.classList.toggle("is-pinned", pinned);
    pinBtn.innerHTML = pinned ? ICON.pinned : ICON.pin;
    pinBtn.classList.toggle("is-on", pinned);
    pinBtn.title = pinned ? "Position locked — click to unlock" : "Lock position and size";
    pinBtn.setAttribute("aria-label", pinned ? "Unlock position" : "Lock position");

    layerBtn.innerHTML = layer === "top" ? ICON.layerTop : ICON.layerDesktop;
    layerBtn.classList.toggle("is-on", layer === "top");
    layerBtn.title = layer === "top" ? "On top — click to pin to desktop" : "On desktop — click to keep on top";
    layerBtn.setAttribute("aria-label", layer === "top" ? "Send to desktop layer" : "Keep on top");
  };
  paint();

  // ---- 拖动 ----
  grip.addEventListener("pointerdown", (event) => {
    if (pinned || event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;

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
      let scale = await win.scaleFactor();
      let start = await win.outerPosition();
      const size = await win.innerSize();
      // 显示器信息拖一次只取一次：拖拽期间显示器不会变（缩放变了会重取）
      let screens = await screenBoxes();

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
        if (busy) return;
        busy = true;
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
          await win.setPosition(
            new PhysicalPosition(Math.round(target.x), Math.round(target.y)),
          );
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

  // ---- 层级 / 别针 / 重载 / 收回 ----
  layerBtn.addEventListener("click", () => {
    layer = layer === "top" ? "desktop" : "top";
    paint();
    void invoke("widget_set_layer", { layer });
  });

  pinBtn.addEventListener("click", () => {
    pinned = !pinned;
    paint();
    void invoke("widget_set_pinned", { pinned });
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
  // 留着只会让"✕ 消失了"变成一个谜。桌宠自己给退出口（双击 → window.close），
  // 真正的删除仍然在组件库 / 画布的"收回"里 —— 那是用户数据，不经组件。
  if (!regionShape) buildChrome(config);

  const post = (payload: unknown) => iframe.contentWindow?.postMessage(payload, "*");
  pushTheme = () => post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });

  /*
   * 一个桌面窗口一条时间轴。组件所有的 `schedule.every` 都挂在这上面，
   * 窗口被最小化 / 藏起来时 `document.hidden` 变真，整条时间轴停摆。
   */
  const scheduler = createScheduler(post);
  resetScheduler = () => scheduler.reset();

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
      setRegion:
        config.shape === "region"
          ? async (parts) => {
              await invoke("widget_set_region", { parts });
            }
          : undefined,
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
    post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config: instanceConfig } });
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
   * 组件存储被别的实例改了（画布上还有一份同款组件），转告 iframe 去重读。
   * 不转的话两边各持一份列表，谁后写谁把对方的新增抹掉。
   */
  void listen<{ widgetId: string; key: string }>("lattice:widget-store", (event) => {
    if (event.payload.widgetId !== config.widgetId) return;
    post({ [BRIDGE_TAG]: 1, type: "store-changed", payload: { key: event.payload.key } });
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
