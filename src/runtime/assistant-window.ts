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

/** 再小输入框和最后一条回答就叠在一起了（和 `assistant_window_policy.rs` 同一个数） */
export const MIN_ASSISTANT_W = 320;
export const MIN_ASSISTANT_H = 420;

/** 出厂尺寸：和这个窗口一直以来的 400×580 一致 */
export const DEFAULT_ASSISTANT_W = 400;
export const DEFAULT_ASSISTANT_H = 580;

/** 默认落点离屏幕边缘的余量（下边留两份，一份给任务栏） */
export const ASSISTANT_MARGIN = 28;

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

/** `assistant-window.json` v2 的全量形状 */
export interface AssistantWindowState {
  version: 2;
  mode: AssistantWindowMode;
  rect: AssistantRect;
  appearance: Appearance;
  locked: boolean;
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

/** 尺寸夹进 `MIN..`；坏值（NaN / 0 / 负数）落回出厂，不然会变成一个看不见的窗口 */
export function clampAssistantSize(width: unknown, height: unknown): [number, number] {
  const w = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : DEFAULT_ASSISTANT_W;
  const h =
    typeof height === "number" && Number.isFinite(height) && height > 0 ? height : DEFAULT_ASSISTANT_H;
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
 *   - v2（带 `version: 2`）：逐字段归一化；
 *   - v1（只有 `{x, y}`）：位置照用，尺寸取默认、底板出厂、不锁 —— 就地升级；
 *   - 别的（坏文件 / 空 / 不是对象）：整份出厂，落右下角。
 */
export function migrateAssistantWindow(
  raw: unknown,
  work: AssistantWorkArea,
): AssistantWindowState {
  const fallback: AssistantWindowState = {
    version: 2,
    mode: "floating",
    rect: defaultAssistantRect(work),
    appearance: { ...DEFAULT_APPEARANCE },
    locked: false,
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
    version: 2,
    mode: isLegacy ? "floating" : normalizeAssistantMode(input.mode),
    rect,
    appearance: normalizeAppearance(input.appearance),
    locked: input.locked === true,
  };
}
