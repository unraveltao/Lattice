/**
 * 画布总览（只读）的几何与分组。
 *
 * 纯函数：没有 React、没有 DOM、没有 store，所以 `tests/overview.html` 能直接
 * import 它跑断言。这一层只回答四个问题 —— 所有摆放合起来占多大、缩小多少才
 * 放得下、按层怎么分组、筛掉某一层之后剩什么。**它不改任何东西**：总览是"退后
 * 一步看一眼"，不是第二个画布。
 *
 * # 为什么缩放不能超过 1
 *
 * "缩放到刚好放得下"听起来该是双向的 —— 画布上只有一张 240×176 的卡时，
 * 按 `min(视口/内容)` 算会把它放大到铺满整屏。那不是"看一眼全局"，那是把一张
 * 便签当成壁纸，而且卡片的字号、圆角、窗饰全被拉成马赛克。所以 `max` 默认 1：
 * **只缩小，不放大**。放大看细节是画布自己的事（滚轮 / 拖边）。
 *
 * # 为什么空画布返回 null 而不是 0×0
 *
 * 0×0 的包围盒会让 `fitScale` 算出 `Infinity`，再被夹成 `max` —— 于是"什么都没有"
 * 和"一张卡片铺满屏"长得一模一样。`null` 让调用方必须显式处理空这一支。
 */

import { WINDOW_LAYERS, type WindowLayer } from "./layer";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 总览只关心这四个数；`Placement` 直接满足它 */
export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: WindowLayer;
}

/**
 * 所有摆放合起来的包围盒。
 *
 * 左上角**可以是负的**：画布是能滚的，用户把卡片拖到原点左边是合法的
 * （`Canvas` 不夹位置）。所以这里算的是 `min(x)` 而不是 `0` —— 从 0 起算会
 * 把负坐标那几张卡切掉一半。
 */
export function overviewBounds(items: readonly Placed[]): Box | null {
  if (items.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    if (item.x < left) left = item.x;
    if (item.y < top) top = item.y;
    if (item.x + item.w > right) right = item.x + item.w;
    if (item.y + item.h > bottom) bottom = item.y + item.h;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export interface FitOptions {
  /** 四周留白。默认 32：卡片贴着窗口边缘时看不出边界在哪 */
  pad?: number;
  /** 最小缩放。再小就只剩色块，不如承认"太多了，看列表" */
  min?: number;
  /** 最大缩放。默认 1 —— 只缩小不放大，见文件头 */
  max?: number;
}

/**
 * 让 `bounds` 整个放进 `viewport` 的那个缩放比。
 *
 * 取两个方向的**较小值**：只满足宽度的话，横向排得很开的一排卡会把高度撑爆；
 * 只满足高度同理。任一方向为 0（包围盒退化成一个点或一条线）时，那个方向的
 * 比值是 `Infinity`，`Math.min` 自然取另一个 —— 不用特判。
 */
export function fitScale(
  bounds: Box | null,
  viewport: { w: number; h: number },
  options: FitOptions = {},
): number {
  const { pad = 32, min = 0.1, max = 1 } = options;
  if (!bounds) return max;
  const usableW = viewport.w - pad * 2;
  const usableH = viewport.h - pad * 2;
  /*
   * 视口比留白还小（窗口被拖到很窄，或者总览刚挂载、还没量到尺寸）。
   * 这里返回 `min` 而不是 `max`：宁可显示成一堆小方块，也不要把一张卡
   * 放大到屏幕外 —— 后者会让用户以为"我的布局就长这样"。
   */
  if (usableW <= 0 || usableH <= 0) return min;
  const ratio = Math.min(
    bounds.w > 0 ? usableW / bounds.w : Infinity,
    bounds.h > 0 ? usableH / bounds.h : Infinity,
  );
  return Math.min(max, Math.max(min, ratio));
}

/**
 * 缩小之后的平面该摆在哪儿（相对 stage 左上角）。
 *
 * 平面用 `transform: scale()` + `transform-origin: 0 0`，所以它的视觉左上角
 * 就是 `left/top`。把包围盒居中：先算"缩完剩多少空"，一半给左边，再减掉包围盒
 * 自己的原点 —— 负坐标那几张卡因此也被摆在对的位置上。
 */
export function fitOffset(
  bounds: Box | null,
  viewport: { w: number; h: number },
  scale: number,
): { left: number; top: number } {
  if (!bounds) return { left: 0, top: 0 };
  return {
    left: (viewport.w - bounds.w * scale) / 2 - bounds.x * scale,
    top: (viewport.h - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

/**
 * 按层分组，**从最上面那层开始**。
 *
 * 顺序是 `WINDOW_LAYERS` 反过来（top → normal → desktop），理由是总览的左边
 * 那栏读起来该像"叠在一起的几张纸从上往下看" —— 置顶层在最上，桌面层垫底。
 * 用 `WINDOW_LAYERS` 保证三档齐全，不跟着数据里出现了哪些层走：只有桌面层的
 * 时候，用户也该看到"置顶层：0"吗？不 —— **空的层不出现**，一行"0 个"是噪音，
 * 而"我明明有置顶的卡"这件事在卡片自己身上看得见。
 */
export function layerGroups<T extends Placed>(
  items: readonly T[],
): { layer: WindowLayer; items: T[] }[] {
  const groups: { layer: WindowLayer; items: T[] }[] = [];
  for (const layer of [...WINDOW_LAYERS].reverse()) {
    const bucket = items.filter((item) => item.layer === layer);
    if (bucket.length > 0) groups.push({ layer, items: bucket });
  }
  return groups;
}

/** 每一层各有几个。三档都给（没东西的给 0），筛选按钮要摆全 */
export function layerCounts(items: readonly Placed[]): Record<WindowLayer, number> {
  const counts: Record<WindowLayer, number> = { desktop: 0, normal: 0, top: 0 };
  for (const item of items) counts[item.layer] += 1;
  return counts;
}

/**
 * 只看某一层。`null` = 全部。
 *
 * 筛选**只改显示**，不改布局：筛掉置顶层之后，剩下的卡不该重新排 —— 用户要看的
 * 是"置顶的那几张压在哪里"，重新排会把那个信息抹掉。所以总览的包围盒按**全部**
 * 摆放算，筛选只决定画哪些。
 */
export function filterByLayer<T extends Placed>(items: readonly T[], layer: WindowLayer | null): T[] {
  if (!layer) return [...items];
  return items.filter((item) => item.layer === layer);
}
