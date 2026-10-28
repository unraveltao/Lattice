/**
 * assistant 窗口的**纯逻辑**这一半（`0007`）：模式、位置尺寸、底板、锁。
 *
 * 不碰 `invoke`、不碰 DOM：窗口那一半在 `platform/AssistantWindow.tsx` 里，
 * 这样 `tests/assistant-window.html` 能把"v1 怎么升级""拖到屏外怎么夹回来"
 * "0 宽会不会变成看不见"全跑一遍，而不需要真的开一个窗口。
 *
 * # 为什么位置尺寸自己算一遍
 *
 * Rust 那边也判（它是唯一真源，写盘前再夹一次）。两边都判不是冗余：
 * 前端要的是"拖动时别让它跑出屏幕"，后端要的是"文件里存的东西永远可用" ——
 * 一个管手感，一个管正确性。**上限与最小尺寸必须一致**，所以那几个数只写在这里
 * 和 `assistant_window_policy.rs` 两处，别在组件里再抄一遍。
 */

import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type Appearance,
} from "./appearance";

/** 两个模式。和 Rust 的 `Mode` 一字不差 */
export const ASSISTANT_WINDOW_MODES = ["floating", "desktop"] as const;
export type AssistantWindowMode = (typeof ASSISTANT_WINDOW_MODES)[number];

/** 再小两栏就挤在一起了（和 `assistant_window_policy.rs` 同一个数，改一处必须改另一处） */
export const MIN_ASSISTANT_W = 560;
export const MIN_ASSISTANT_H = 420;

/** 出厂尺寸 800×600（0035：用户要"对话框小一点"） */
export const DEFAULT_ASSISTANT_W = 800;
export const DEFAULT_ASSISTANT_H = 600;

/** 默认落点离屏幕边缘的余量（下边留两份，一份给任务栏） */
export const ASSISTANT_MARGIN = 28;

/**
 * 面板缩放的五档（0036）。**和 `assistant_window_policy.rs::ZOOM_STEPS`
 * 一字不差** —— 两边对同一份文件给出不同的档位，会让"存进去的"和"读出来的"
 * 不是同一个数，下一次滚轮就从别的档位起跳。
 *
 * 界面要"立刻变大"，不能等 IPC 回来再变，所以前端也存一份表：先本地走一档、
 * 再 invoke 落盘。落盘失败只意味着"下次打开回到上一个档"，不影响这一次。
 */
export const ZOOM_STEPS = [0.85, 1, 1.15, 1.3, 1.5] as const;

/** 认不出来 / 不在档位表上 → 最近的档位；坏值（NaN / 无穷 / ≤ 0）→ 1。
 *  两个"最近的"一样近时取小的那个（1.4 → 1.3），和 Rust 同一判据 */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  let best: number = ZOOM_STEPS[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const step of ZOOM_STEPS) {
    const gap = Math.abs(step - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = step;
    }
  }
  return best;
}

/** `dir > 0` 放大一档，`dir < 0` 缩小一档；到顶到底原地不动（不循环） */
export function stepZoom(current: unknown, dir: number): number {
  const at = normalizeZoom(current);
  const index = ZOOM_STEPS.indexOf(at as (typeof ZOOM_STEPS)[number]);
  const start = index < 0 ? 1 : index;
  const next = Math.min(Math.max(start + Math.sign(dir), 0), ZOOM_STEPS.length - 1);
  return ZOOM_STEPS[next];
}

export interface AssistantRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一块屏或一个工作区，逻辑像素 */
export interface AssistantWorkArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `assistant-window.json` v4 的全量形状 */
export interface AssistantWindowState {
  version: 4;
  mode: AssistantWindowMode;
  rect: AssistantRect;
  appearance: Appearance;
  locked: boolean;
  /** 左栏收没收起（0035）。v2 文件里没有这个字段 = 展开 */
  sidebar: boolean;
  /** 面板整体缩放（0036）。v3 文件里没有这个字段 = 1 倍。**不是字号** */
  fontScale: number;
}

/** 认不出来一律退回 `floating`：**不是** `desktop`。
 *
 * 桌面模式的窗口沉在底下、被应用盖住（那正是它的用途），一个坏值让它
 * "看起来消失了"；浮窗至少还能 `Ctrl+K` 找回来。坏值不许扩大影响。
 */
export function normalizeAssistantMode(raw: unknown): AssistantWindowMode {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (ASSISTANT_WINDOW_MODES as readonly string[]).includes(text)
    ? (text as AssistantWindowMode)
    : "floating";
}

/**
 * 尺寸夹进 `MIN..`；坏值（NaN / 0 / 负数）落回出厂，不然会变成一个看不见的窗口。
 *
 * `width < MIN` 时**整份取出厂，不是抬到 560**：560 宽是"两栏刚放得下"，
 * 但比它还窄的记录只可能出自 0034 之前（那时候出厂就是 400 宽）—— 那是老用户
 * 从没调过尺寸，不是他想要一个 560 的窗。真把窗口拖到过 560 以上的人，
 * 记录里的宽度就在 560 以上，这条分支碰不到他（`min_inner_size` 拦着拖动）。
 *
 * 判据必须和 `assistant_window_policy.rs::migrate_size` 一字不差：两边对同一份
 * 文件给出不同尺寸，会让"看得见的窗口"和"记着的窗口"差一截，下一次拖动就把
 * 它缩回去。
 */
export function clampAssistantSize(width: unknown, height: unknown): [number, number] {
  const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : DEFAULT_ASSISTANT_W;
  const h =
    typeof height === "number" && Number.isFinite(height) && height > 0 ? height : DEFAULT_ASSISTANT_H;
  if (w < MIN_ASSISTANT_W) return [DEFAULT_ASSISTANT_W, DEFAULT_ASSISTANT_H];
  return [Math.max(MIN_ASSISTANT_W, w), Math.max(MIN_ASSISTANT_H, h)];
}

/** 把窗口整个夹进工作区。窗口比工作区还大时贴左上角 ——
 * 宁可右边溢出，也不让它跑到屏幕外（跑到屏幕外 = 用户找不回来） */
export function clampAssistantRect(rect: AssistantRect, work: AssistantWorkArea): AssistantRect {
  const [width, height] = clampAssistantSize(rect.width, rect.height);
  const maxX = Math.max(work.left, work.left + work.width - width);
  const maxY = Math.max(work.top, work.top + work.height - height);
  const x = Number.isFinite(rect.x) ? Math.min(Math.max(rect.x, work.left), maxX) : work.left;
  const y = Number.isFinite(rect.y) ? Math.min(Math.max(rect.y, work.top), maxY) : work.top;
  return { x, y, width, height };
}

/** 没有记录时的落点：右下角，留出任务栏和一圈余量 */
export function defaultAssistantRect(work: AssistantWorkArea): AssistantRect {
  return clampAssistantRect(
    {
      x: work.left + work.width - DEFAULT_ASSISTANT_W - ASSISTANT_MARGIN,
      y: work.top + work.height - DEFAULT_ASSISTANT_H - ASSISTANT_MARGIN * 2,
      width: DEFAULT_ASSISTANT_W,
      height: DEFAULT_ASSISTANT_H,
    },
    work,
  );
}

/**
 * 把磁盘上读到的东西变成一份可用状态。
 *
 * 三种输入都要接住，**一个都不能让它拦住窗口**：
 *   - v4 / v3 / v2（带 `version`）：逐字段归一化，v2 缺的 `sidebar` 当展开，
 *     v3 缺的 `fontScale` 当 1 倍；
 *   - v1（只有 `{x, y}`）：位置照用，尺寸取默认、底板出厂、不锁 —— 就地升级；
 *   - 别的（坏文件 / 空 / 不是对象）：整份出厂，落右下角。
 */
export function migrateAssistantWindow(
  raw: unknown,
  work: AssistantWorkArea,
): AssistantWindowState {
  const fallback: AssistantWindowState = {
    version: 4,
    mode: "floating",
    rect: defaultAssistantRect(work),
    appearance: { ...DEFAULT_APPEARANCE },
    locked: false,
    sidebar: true,
    fontScale: 1,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const input = raw as Record<string, unknown>;

  // v1：只有位置。**别把它当成"没有记录"** —— 老用户的位置是调过的
  const isLegacy = input.version !== 2 && (typeof input.x === "number" || typeof input.y === "number");
  const rectInput = isLegacy ? input : (input.rect as Record<string, unknown> | undefined);
  if (!rectInput || typeof rectInput !== "object") return fallback;

  const rect = clampAssistantRect(
    {
      x: typeof rectInput.x === "number" ? rectInput.x : fallback.rect.x,
      y: typeof rectInput.y === "number" ? rectInput.y : fallback.rect.y,
      width: typeof rectInput.width === "number" ? rectInput.width : DEFAULT_ASSISTANT_W,
      height: typeof rectInput.height === "number" ? rectInput.height : DEFAULT_ASSISTANT_H,
    },
    work,
  );

  return {
    version: 4,
    mode: isLegacy ? "floating" : normalizeAssistantMode(input.mode),
    rect,
    appearance: normalizeAppearance(input.appearance),
    locked: input.locked === true,
    // v2 文件没有这个字段：那时候侧栏还不能收，缺字段就是展开
    sidebar: input.sidebar !== false,
    // v3 文件没有这个字段：那时候还没有缩放，缺字段就是 1 倍
    fontScale: normalizeZoom(input.fontScale),
  };
}
