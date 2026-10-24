/**
 * 拖拽对齐参考线（纯函数）
 *
 * 拖一张卡片时，它的左/中/右三条竖线、上/中/下三条横线，会和其它卡片的同名
 * 线互相吸引：偏差在阈值内就吸过去，并把那条线亮出来。网格吸附解决的是
 * "摆得整齐"，对齐参考线解决的是"和旁边那个对齐" —— 后者是用户真的在做的事。
 *
 * 三处刻意的选择：
 *
 * 1. **吸附和网格是两件事**，不是二选一。网格把坐标量化到 8px，参考线把坐标
 *    拉到别人的边上；两者同时开着时，先网格后对齐 —— 网格给出一个近似的落点，
 *    对齐再把它精确地拉到线上。关掉网格之后对齐照样工作（那时候它更重要）。
 *
 * 2. **容器边界也参与吸附**（`bounds`）。vela 那份只处理了左/上零线，结果
 *    "把卡片拖到画布正中"这个最常见的动作反而没有参考线。这里把容器的
 *    起 / 中 / 止 三条线也放进候选集，并且**认原点** —— 画布的原点是 0，
 *    桌面上的容器是某块显示器的工作区，原点可能是负的。两份坐标系统共用
 *    这一个函数，桌面上才不会算出偏几像素的线。
 *
 * 3. **返回所有同偏差的线**。三条线同时对齐时（左边缘对齐一个、中线对齐另一个），
 *    只亮一条会让人以为只对上了一半。同一个坐标只出现一次。
 *
 * 4. **线是局部的短段，不是贯穿全屏**（`guideLines`）。一条从屏幕顶画到底的线
 *    会把整块桌面切成两半，用户看到的第一个反应是"这线太大"，而不是"对上了"。
 *    真正需要被指出的只有"我这条边和它那条边在同一个坐标" —— 所以线只画在
 *    被拖的那个矩形旁边，两端各伸出「半个矩形 + 48px」。画布和桌面都用这一条
 *    规则算段长。
 */

export interface AlignRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 吸附阈值（px）：拖拽中的边/中线与目标线距离小于等于它时吸过去 */
export const ALIGN_THRESHOLD_PX = 8;

export interface AlignOptions {
  threshold?: number;
  /**
   * 容器尺寸。给了就把 起 / 中 / 止 三条线也当候选；不给就只和 `others` 对齐。
   *
   * `x` / `y` 是容器原点，缺省 0 —— 画布的坐标原点就是内容左上角，而桌面上
   * 的容器是"这块显示器的工作区"，原点可能是 `(-1728, 0)` 这种负值。
   */
  bounds?: { x?: number; y?: number; w: number; h: number } | null;
}

export interface AlignResult {
  x: number;
  y: number;
  /** 要画的竖线（画布坐标），空数组 = 这个轴没对上 */
  xs: number[];
  /** 要画的横线 */
  ys: number[];
}

/** 一个矩形在某轴上的三条线：起、中、止 */
function linesOf(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

/**
 * 某一轴上"赢"的那条线：偏差最小的那对，返回偏差和线坐标。
 *
 * 平手（三条线同时对上、偏差一样）时取先遇到的 —— 两个同尺寸的组件左对齐，
 * 左/中/右三对线的偏差完全相同，这时候随便取哪条都指向同一个动作。
 */
function pick(
  mine: number[],
  theirs: number[],
  threshold: number,
): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const line of theirs) {
    for (const self of mine) {
      const delta = line - self;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, line };
    }
  }
  return best;
}

/**
 * 算吸附后的位置。
 *
 * 两个轴**各自独立**求最近的一条线：横向能对上不代表纵向也能对上，混着算会
 * 出现"横向差 7px 纵向差 1px，结果按 1px 那条把两个轴都拽过去"。
 *
 * **每个轴最多画一条线。** 三条线同时对上（两个同尺寸的组件左对齐，左/中/右
 * 全对上）是**最常见**的情况，按"对上几条画几条"就会画出三条横跨整块画布的
 * 竖线 —— 它们说的是同一件事，但看起来像界面卡了。只画赢的那条。
 */
export function computeAlign(
  nx: number,
  ny: number,
  w: number,
  h: number,
  others: ReadonlyArray<AlignRect>,
  options: AlignOptions = {},
): AlignResult {
  const threshold = options.threshold ?? ALIGN_THRESHOLD_PX;
  if (!(threshold > 0)) return { x: nx, y: ny, xs: [], ys: [] };

  const candidateXs: number[] = [];
  const candidateYs: number[] = [];
  for (const other of others) {
    candidateXs.push(...linesOf(other.x, other.w));
    candidateYs.push(...linesOf(other.y, other.h));
  }
  if (options.bounds) {
    const { x: bx = 0, y: by = 0, w: bw, h: bh } = options.bounds;
    candidateXs.push(bx, bx + bw / 2, bx + bw);
    candidateYs.push(by, by + bh / 2, by + bh);
  }

  const pickX = pick(linesOf(nx, w), candidateXs, threshold);
  const pickY = pick(linesOf(ny, h), candidateYs, threshold);

  return {
    x: pickX ? nx + pickX.delta : nx,
    y: pickY ? ny + pickY.delta : ny,
    xs: pickX ? [pickX.line] : [],
    ys: pickY ? [pickY.line] : [],
  };
}

/* ------------------------------------------------------------------ *
 * 线画多长
 * ------------------------------------------------------------------ */

/**
 * 线头：线在"半个矩形"之外再多伸出去这么多像素。
 *
 * 上一版是 24px（总长 = 矩形 + 48px），看着就像卡片自己的一条边描了个边；
 * 现在每端再伸出半个矩形，总长翻了一倍，才像一条"这里对齐了"的轨道。
 */
export const GUIDE_PAD_PX = 48;

/**
 * 一条参考线。
 *
 * `at` 是它钉住的坐标（竖线是 x、横线是 y）；`from` / `length` 是它自己那一截
 * 从哪儿开始、有多长。以前只有 `at`，线一律画满整块容器 —— 那是"全屏线"的
 * 来源，也正是"线太大"的一半原因。
 */
export interface GuideSegment {
  at: number;
  from: number;
  length: number;
}

export interface GuideLines {
  vertical: GuideSegment[];
  horizontal: GuideSegment[];
}

/**
 * 拖动中要画的线：吸附结果 + 被拖的那个矩形。
 *
 * 两个宿主（画布 / 桌面）拿到的都是这一份，再交给 `guideLines` 算段长 ——
 * 少给一个矩形，线就只能退回"画满整块容器"。
 */
export interface AlignGuideState {
  result: AlignResult;
  rect: AlignRect;
}

/**
 * 把"吸到了哪条线"变成"这条线该画多长"。
 *
 * 规则只有一条：**以被拖的那个矩形为中心，向两端各伸出「半个矩形 + 48px」**，
 * 再夹进容器。也就是总长 = `2 × (矩形尺寸 + GUIDE_PAD_PX)` —— 和上一版
 * （`矩形尺寸 + 2 × 24px`）相比正好长一倍：线要能伸到卡片外面去，才看得出
 * "这条边和那条边在同一个坐标"；只比卡片长一点点，看起来像卡片自己的描边。
 *
 * 夹进容器仍然保留：贴着屏幕边 / 画布边时线不许溢出去。于是"桌子另一头那个
 * 对齐目标"不会把线拉成一根跨屏的横梁。
 *
 * `rect` 传吸附**之后**的位置 —— 线标记的是最终落点，不是手指的位置。
 */
export function guideLines(
  result: AlignResult,
  rect: AlignRect,
  limit?: AlignRect | null,
  pad: number = GUIDE_PAD_PX,
): GuideLines {
  /** 从 `start` 起长 `size`，两端各伸出「半个 + 线头」，再夹进 `lo..hi` */
  const span = (
    start: number,
    size: number,
    lo: number,
    hi: number,
  ): Omit<GuideSegment, "at"> => {
    const over = size / 2 + pad;
    let from = start - over;
    let to = start + size + over;
    if (hi > lo) {
      from = Math.max(lo, from);
      to = Math.min(hi, to);
    }
    if (to < from) to = from;
    return { from: Math.round(from), length: Math.round(to - from) };
  };

  const loX = limit ? limit.x : 0;
  const hiX = limit ? limit.x + limit.w : 0;
  const loY = limit ? limit.y : 0;
  const hiY = limit ? limit.y + limit.h : 0;

  return {
    // 竖线沿 y 方向排版，所以它盖住的是矩形的**高**，夹的是容器的上下边
    vertical: result.xs.map((at) => ({ at, ...span(rect.y, rect.h, loY, hiY) })),
    horizontal: result.ys.map((at) => ({ at, ...span(rect.x, rect.w, loX, hiX) })),
  };
}
