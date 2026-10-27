/**
 * 窗口层级：只有三个值，只有这一个家。
 *
 * # 为什么单独一个文件
 *
 * 这个联合类型曾经在三处各写一遍（清单解析、宿主页窗饰、平台桌面同步），
 * 加第三档的时候必然漏掉一处 —— 而漏掉的那一处**不会报错**，只会把
 * `"normal"` 悄悄当成 `"desktop"`。所以它搬进一个零依赖的模块：
 * 谁要这个类型就 import，别再自己抄一份。
 *
 * 顺序有意义：**从 z 序最下到最上**。宿主页那颗箭头按这个顺序循环，
 * 检查器那排分段按钮也按这个顺序排。别重排。
 *
 * # 一个语义陷阱，写在这里免得每处各踩一遍
 *
 * `desktop` 在 Win32 里是**两种东西**：纯展示组件真的挂进 WorkerW
 * （壁纸那一层），可输入的组件只能退成 `HWND_BOTTOM` 的普通窗口。
 * 也就是说"贴在桌面上"这句话，对便签来说是假的 —— 它只是"压在所有
 * 普通窗口下面"。界面上要不要这么写，看 `interactive`（见
 * `InspectorPanel` 的分档文案），别统一成一句。
 */

/** 组件窗口的层级。和 `src-tauri/src/desktop.rs::WindowLayer` 一一对应 */
export type WindowLayer = "desktop" | "normal" | "top";

/** 三个层级，从下到上。循环、分段按钮、测试都用这一份顺序 */
export const WINDOW_LAYERS = ["desktop", "normal", "top"] as const;

/**
 * 把任意来源的值收成层级。
 *
 * 存档是用户手改过的、清单是第三方写的、事件是别的版本推来的 ——
 * 全都可能不是这三个值。认不出来就当 `fallback`（清单的默认值是
 * `desktop`，和 `WIDGET_SPEC` 里写的一致）。
 */
export function asLayer(value: unknown, fallback: WindowLayer = "desktop"): WindowLayer {
  return value === "desktop" || value === "normal" || value === "top" ? value : fallback;
}

/** 是这三个值之一吗。给"认不出来就拒绝"的场景用（比如跨窗口事件） */
export function isLayer(value: unknown): value is WindowLayer {
  return value === "desktop" || value === "normal" || value === "top";
}

/** 分段按钮上的字。i18n 的 key，不是最终文案 */
export function layerNameKey(layer: WindowLayer): string {
  if (layer === "top") return "On top";
  if (layer === "normal") return "Normal";
  return "Desktop";
}

/**
 * 这一档**实际会怎样**。i18n 的 key，不是最终文案。
 *
 * 为什么要带 `interactive`：`desktop` 这一档在 Win32 里是两种东西 ——
 * 纯展示组件真的挂进 WorkerW（壁纸那一层），可输入的组件只能退成
 * `HWND_BOTTOM`。写成同一句话，便签那一份就是假话，而"界面说的和窗口做的
 * 不是一件事"正是用户报的那个 bug 的原话。
 */
export function layerHintKey(layer: WindowLayer, interactive: boolean): string {
  if (layer === "top") {
    return "Floats above every window — good for monitors and readouts.";
  }
  if (layer === "normal") {
    return "A plain window — other windows can cover it, and it can cover them. It stays where you put it.";
  }
  if (interactive) {
    return "Always at the bottom of the window stack, but you can still click and type into it.";
  }
  return "Sits above the wallpaper and below your windows, so switching apps never covers it.";
}

/**
 * Win32 眼里这个窗口**实际**落在哪儿。和 `src-tauri/src/desktop.rs::LayerProbe`
 * 的 `actual` 字段一一对应。
 *
 * `workerw` 和 `bottom` 是同一个"桌面层"的两种落法 —— 前者是真挂进壁纸那一层，
 * 后者是拿不到 WorkerW 时的降级。读数要分开报，否则"降级了"和"成功了"
 * 在界面上长得一模一样。
 */
export type ProbeState = "workerw" | "bottom" | "normal" | "topmost" | "unknown";

/** 用户要的那一档，换算成"系统应该报什么" */
export function expectedProbe(layer: WindowLayer, interactive: boolean): ProbeState {
  if (layer === "top") return "topmost";
  if (layer === "normal") return "normal";
  return interactive ? "bottom" : "workerw";
}

/** 收一个来路不明的字符串。读不出来就是 `unknown`，别猜 */
export function asProbeState(value: unknown): ProbeState {
  return value === "workerw" ||
    value === "bottom" ||
    value === "normal" ||
    value === "topmost"
    ? value
    : "unknown";
}

/** 读数那行显示什么。i18n 的 key */
export function probeLabelKey(actual: ProbeState): string {
  if (actual === "workerw") return "On the desktop";
  if (actual === "bottom") return "Bottom of the stack";
  if (actual === "normal") return "Plain window";
  if (actual === "topmost") return "On top";
  return "Unknown";
}
