/**
 * 画板：形状模型、文本语法、渲染几何（`0040`）。
 *
 * # 为什么语法住在这里，不住在 Rust
 *
 * agent 那条路只能传 `string`（`WIDGET_SPEC` §3.6：工具参数只认
 * `string / number / boolean`），所以"画一个红框"必须压成一行文本。这行文本
 * 解析出来的东西，前端本来就要拿去画 —— 于是"能传什么"和"能画什么"是同一份
 * 代码。放到 Rust 那边就变成两份语法：改一处，另一处静默地只认一半。
 *
 * Rust 那半守的是**上限与夹取**（状态在谁手里，闸就在谁手里）。所以这一份
 * 解析器的错误只负责"说清第几行坏了"，不负责"最后能不能落盘"。
 *
 * # 为什么坐标是世界坐标
 *
 * 窗口可以拉大拉小，板不该跟着变形。世界固定 1600×1000，窗口是视口，
 * 等比缩放居中（`fitTransform`）。代价是 16:9 的窗口上下留白 —— 那是
 * "板是一张纸"的代价，不是 bug。
 */

/** 世界尺寸。落盘时一并写下去，将来换尺寸靠它判断 */
export const BOARD_WORLD = { w: 1600, h: 1000 } as const;

/** 一条形状的描边。文字只有 `color` 和 `size`，没有 `width` */
export interface Stroke {
  color: string;
  width: number;
}

export type BoardShape =
  | ({ kind: "pen"; points: number[] } & Stroke)
  | ({ kind: "line"; x1: number; y1: number; x2: number; y2: number } & Stroke)
  | ({ kind: "arrow"; x1: number; y1: number; x2: number; y2: number } & Stroke)
  | ({ kind: "rect"; x: number; y: number; w: number; h: number } & Stroke)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & Stroke)
  | { kind: "text"; x: number; y: number; text: string; size: number; color: string };

/** 四个上限。数字不是拍的：它们决定"一次 agent 调用最多能把板弄多乱" */
export const MAX_SHAPES_PER_CALL = 200;
export const MAX_PEN_POINTS = 500;
export const MAX_TEXT_CHARS = 120;
export const MAX_TOTAL_SHAPES = 2000;

/** 落盘 / 渲染都认这个默认值。故意不用主题色：板是用户画的东西，不跟主题翻转 */
export const DEFAULT_INK = "#1b1b1b";
export const DEFAULT_WIDTH = 2;
export const DEFAULT_TEXT_SIZE = 18;

/** 十六进制颜色，3 / 4 / 6 / 8 位都认（`#333` 是速记，模型爱这么写） */
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const WIDTH_RE = /^w=(\d+(?:\.\d+)?)$/;

export interface ParseOptions {
  /** 世界尺寸，坐标按它夹取。缺省 `BOARD_WORLD` */
  world?: { w: number; h: number };
  /** 这一批没写 `#color` 时用什么颜色 */
  color?: string;
  /** 没写 `w=` 时用什么线宽 */
  width?: number;
  /** 文字没写 `w=` 时用什么字号 */
  size?: number;
  /** 板上**已经**有多少形状 —— 用它判总量上限，不是拿这一批自己数 */
  existing?: number;
}

export interface ParseError {
  /** 第几行（从 1 数，和编辑器里的行号一致） */
  line: number;
  /** 原样的那一行，方便回给模型 */
  text: string;
  reason: string;
}

export interface ParseResult {
  shapes: BoardShape[];
  errors: ParseError[];
}

/**
 * 解析一段文本。**一行一个形状，一行坏了整份不算。**
 *
 * 不"跳过坏行继续"：模型会以为自己画了五个，用户只看到三个，而没人知道
 * 少了哪两个。宁可整份退回让它重写 —— 和 `LAT-0008` 的"超限拒绝，不截断"
 * 是同一条。
 */
export function parseSpec(text: string, options: ParseOptions = {}): ParseResult {
  const world = options.world ?? BOARD_WORLD;
  const shapes: BoardShape[] = [];
  const errors: ParseError[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;

    if (shapes.length >= MAX_SHAPES_PER_CALL) {
      errors.push({ line: index + 1, text: raw, reason: `too many shapes (limit ${MAX_SHAPES_PER_CALL} per call)` });
      break;
    }

    const parsed = parseLine(raw, world, options);
    if (typeof parsed === "string") {
      errors.push({ line: index + 1, text: raw, reason: parsed });
      continue;
    }
    shapes.push(parsed);
  }

  // 总量在**整份解析完之后**再判：否则前 199 条合法、第 200 条才发现装不下，
  // 报出来的错会指向一个无辜的行
  if (errors.length === 0 && (options.existing ?? 0) + shapes.length > MAX_TOTAL_SHAPES) {
    errors.push({
      line: 0,
      text: "",
      reason: `the board already holds ${options.existing ?? 0} shapes (limit ${MAX_TOTAL_SHAPES})`,
    });
  }

  // 有错就**一条都不给**。这条是结构上的保证，不是调用方的约定：返回半批
  // 形状的接口，迟早会有人在某个分支里忘了看 `errors`
  return errors.length > 0 ? { shapes: [], errors } : { shapes, errors };
}

/** 一行 → 一个形状；返回 `string` 表示这一行为什么不行 */
function parseLine(raw: string, world: { w: number; h: number }, options: ParseOptions): BoardShape | string {
  const tokens = raw.split(/\s+/);
  const kind = tokens[0];
  const rest = tokens.slice(1);

  // 行尾修饰：`#333` 和 `w=4`，可以从任意顺序出现，但必须在**末尾连续**
  let color = options.color ?? DEFAULT_INK;
  let width = options.width ?? DEFAULT_WIDTH;
  while (rest.length > 0) {
    const tail = rest[rest.length - 1];
    if (COLOR_RE.test(tail)) {
      color = tail;
      rest.pop();
      continue;
    }
    const wm = WIDTH_RE.exec(tail);
    if (wm) {
      width = clampNumber(Number(wm[1]), 1, 12);
      rest.pop();
      continue;
    }
    break;
  }

  if (kind === "text") {
    // 文字是"坐标 + 剩下全部"，所以最后一个 token 可能只是句子的一部分
    if (rest.length < 2) return "text needs a point and some words";
    const point = parsePoint(rest[0]);
    if (!point) return `bad point "${rest[0]}" (want x,y)`;
    const body = rest.slice(1).join(" ");
    const chars = [...body];
    if (chars.length === 0) return "text is empty";
    if (chars.length > MAX_TEXT_CHARS) return `text is ${chars.length} characters (limit ${MAX_TEXT_CHARS})`;
    return {
      kind: "text",
      x: clamp(point[0], 0, world.w),
      y: clamp(point[1], 0, world.h),
      text: body,
      size: options.size ?? DEFAULT_TEXT_SIZE,
      color,
    };
  }

  if (kind === "pen") {
    const points: number[] = [];
    for (const token of rest) {
      const point = parsePoint(token);
      if (!point) return `bad point "${token}" (want x,y)`;
      points.push(clamp(point[0], 0, world.w), clamp(point[1], 0, world.h));
    }
    if (points.length < 4) return "pen needs at least two points";
    if (points.length / 2 > MAX_PEN_POINTS) return `pen has ${points.length / 2} points (limit ${MAX_PEN_POINTS})`;
    return { kind: "pen", points, color, width };
  }

  if (kind === "line" || kind === "arrow") {
    if (rest.length !== 2) return `${kind} needs exactly two points`;
    const a = parsePoint(rest[0]);
    const b = parsePoint(rest[1]);
    if (!a || !b) return "bad point (want x,y)";
    return {
      kind,
      x1: clamp(a[0], 0, world.w),
      y1: clamp(a[1], 0, world.h),
      x2: clamp(b[0], 0, world.w),
      y2: clamp(b[1], 0, world.h),
      color,
      width,
    };
  }

  if (kind === "rect") {
    // 两个角点，谁大谁小都行 —— 模型画"从右下往左上"是常事
    if (rest.length !== 2) return "rect needs two corners";
    const a = parsePoint(rest[0]);
    const b = parsePoint(rest[1]);
    if (!a || !b) return "bad point (want x,y)";
    const x1 = clamp(Math.min(a[0], b[0]), 0, world.w);
    const y1 = clamp(Math.min(a[1], b[1]), 0, world.h);
    const x2 = clamp(Math.max(a[0], b[0]), 0, world.w);
    const y2 = clamp(Math.max(a[1], b[1]), 0, world.h);
    return { kind: "rect", x: x1, y: y1, w: x2 - x1, h: y2 - y1, color, width };
  }

  if (kind === "ellipse") {
    if (rest.length !== 2) return "ellipse needs a centre and a radius";
    const c = parsePoint(rest[0]);
    const r = parsePoint(rest[1]);
    if (!c || !r) return "bad point (want x,y)";
    return {
      kind: "ellipse",
      cx: clamp(c[0], 0, world.w),
      cy: clamp(c[1], 0, world.h),
      rx: Math.max(1, Math.abs(r[0])),
      ry: Math.max(1, Math.abs(r[1])),
      color,
      width,
    };
  }

  return `unknown shape "${kind}" (want pen / line / arrow / rect / ellipse / text)`;
}

function parsePoint(token: string): [number, number] | null {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(token);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function clampNumber(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return clamp(value, lo, hi);
}

/**
 * 窗口 → 世界 的变换：等比缩放 + 居中。
 *
 * `scale` 只取决于窗口和世界的比例，所以窗口变了画不变形，只是整体变大。
 */
export function fitTransform(
  view: { w: number; h: number },
  world: { w: number; h: number } = BOARD_WORLD,
): { scale: number; dx: number; dy: number } {
  if (view.w <= 0 || view.h <= 0) return { scale: 1, dx: 0, dy: 0 };
  const scale = Math.min(view.w / world.w, view.h / world.h);
  return {
    scale,
    dx: (view.w - world.w * scale) / 2,
    dy: (view.h - world.h * scale) / 2,
  };
}

/** 世界坐标 → 视口坐标 */
export function toView(x: number, y: number, t: { scale: number; dx: number; dy: number }): [number, number] {
  return [x * t.scale + t.dx, y * t.scale + t.dy];
}

/** 视口坐标 → 世界坐标。**每次 pointerdown 只算一次**，之后全在世界上算 */
export function toWorld(x: number, y: number, t: { scale: number; dx: number; dy: number }): [number, number] {
  if (t.scale <= 0) return [0, 0];
  return [(x - t.dx) / t.scale, (y - t.dy) / t.scale];
}

/**
 * 折线 → 平滑路径。二次贝塞尔过中点，**两个端点一个像素都不动**。
 *
 * 端点不动是硬要求：`pen` 的第一笔和最后一笔要和用户手指按下的位置对上，
 * 平滑把端点挪掉，看起来就是"笔尖会飘"。
 */
export function smoothPath(points: number[]): string {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < points.length; index += 2) pairs.push([points[index], points[index + 1]]);
  if (pairs.length === 0) return "";
  if (pairs.length === 1) return `M ${fmt(pairs[0][0])} ${fmt(pairs[0][1])}`;
  if (pairs.length === 2) {
    return `M ${fmt(pairs[0][0])} ${fmt(pairs[0][1])} L ${fmt(pairs[1][0])} ${fmt(pairs[1][1])}`;
  }

  let d = `M ${fmt(pairs[0][0])} ${fmt(pairs[0][1])}`;
  for (let index = 1; index < pairs.length - 1; index += 1) {
    const [px, py] = pairs[index];
    const [nx, ny] = pairs[index + 1];
    d += ` Q ${fmt(px)} ${fmt(py)} ${fmt((px + nx) / 2)} ${fmt((py + ny) / 2)}`;
  }
  const last = pairs[pairs.length - 1];
  d += ` L ${fmt(last[0])} ${fmt(last[1])}`;
  return d;
}

/** 数字落成字符串：去掉 `0.30000000000000004` 那种尾巴，`path` 才能被逐字比对 */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 一个形状 → SVG `d`（`text` 没有 path，返回空串，由调用方画 `<text>`） */
export function shapePath(shape: BoardShape): string {
  switch (shape.kind) {
    case "pen":
      return smoothPath(shape.points);
    case "line":
      return `M ${fmt(shape.x1)} ${fmt(shape.y1)} L ${fmt(shape.x2)} ${fmt(shape.y2)}`;
    case "arrow":
      // 箭头就是线 + 两条回勾，勾长跟着线宽走，缩小时不会变成一坨
      return `M ${fmt(shape.x1)} ${fmt(shape.y1)} L ${fmt(shape.x2)} ${fmt(shape.y2)}` + arrowHead(shape);
    case "rect":
      return `M ${fmt(shape.x)} ${fmt(shape.y)} h ${fmt(shape.w)} v ${fmt(shape.h)} h ${fmt(-shape.w)} Z`;
    case "ellipse":
      return (
        `M ${fmt(shape.cx - shape.rx)} ${fmt(shape.cy)}` +
        ` a ${fmt(shape.rx)} ${fmt(shape.ry)} 0 1 0 ${fmt(shape.rx * 2)} 0` +
        ` a ${fmt(shape.rx)} ${fmt(shape.ry)} 0 1 0 ${fmt(-shape.rx * 2)} 0`
      );
    case "text":
      return "";
  }
}

function arrowHead(shape: { x1: number; y1: number; x2: number; y2: number; width: number }): string {
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const size = 6 + shape.width * 2;
  const spread = Math.PI / 7;
  const a = `${fmt(shape.x2 - size * Math.cos(angle - spread))} ${fmt(shape.y2 - size * Math.sin(angle - spread))}`;
  const b = `${fmt(shape.x2 - size * Math.cos(angle + spread))} ${fmt(shape.y2 - size * Math.sin(angle + spread))}`;
  return ` M ${a} L ${fmt(shape.x2)} ${fmt(shape.y2)} L ${b}`;
}

/**
 * 橡皮的命中测试：**整条形状**，不是像素。
 *
 * 判据是"点到这条线有多远"，不是包围盒 —— 包围盒会让一条斜线的空白角落
 * 也能擦掉它，用户会觉得橡皮在乱删东西。
 */
export function hitsShape(shape: BoardShape, x: number, y: number, radius: number, measure?: Measure): boolean {
  const pad = radius + ("width" in shape ? shape.width / 2 : 0);
  switch (shape.kind) {
    case "pen": {
      for (let index = 0; index + 3 < shape.points.length; index += 2) {
        if (segmentDistance(x, y, shape.points[index], shape.points[index + 1], shape.points[index + 2], shape.points[index + 3]) <= pad) {
          return true;
        }
      }
      return false;
    }
    case "line":
    case "arrow":
      return segmentDistance(x, y, shape.x1, shape.y1, shape.x2, shape.y2) <= pad;
    case "rect": {
      const { x: rx, y: ry, w, h } = shape;
      return (
        segmentDistance(x, y, rx, ry, rx + w, ry) <= pad ||
        segmentDistance(x, y, rx + w, ry, rx + w, ry + h) <= pad ||
        segmentDistance(x, y, rx + w, ry + h, rx, ry + h) <= pad ||
        segmentDistance(x, y, rx, ry + h, rx, ry) <= pad
      );
    }
    case "ellipse": {
      // 近似：把点映射到单位圆，差多少再按短半轴换回世界距离
      const nx = (x - shape.cx) / shape.rx;
      const ny = (y - shape.cy) / shape.ry;
      const ring = Math.hypot(nx, ny);
      if (ring === 0) return false;
      const gap = Math.abs(ring - 1) * Math.min(shape.rx, shape.ry);
      return gap <= pad;
    }
    case "text": {
      const width = measure ? measure(shape.text, shape.size) : shape.text.length * shape.size * 0.6;
      return x >= shape.x && x <= shape.x + width && y >= shape.y - shape.size && y <= shape.y + shape.size * 0.3;
    }
  }
}

/** 文字宽度从外面注入：纯逻辑里不猜"中文多宽、英文多宽"（`LAT-0022` 同一条） */
export type Measure = (text: string, size: number) => number;

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 所有形状的包围盒。空板返回 `null`（不是 0×0 的框） */
export function shapesBounds(shapes: BoardShape[], measure?: Measure): { x: number; y: number; w: number; h: number } | null {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const shape of shapes) {
    switch (shape.kind) {
      case "pen":
        for (let index = 0; index + 1 < shape.points.length; index += 2) take(shape.points[index], shape.points[index + 1]);
        break;
      case "line":
      case "arrow":
        take(shape.x1, shape.y1);
        take(shape.x2, shape.y2);
        break;
      case "rect":
        take(shape.x, shape.y);
        take(shape.x + shape.w, shape.y + shape.h);
        break;
      case "ellipse":
        take(shape.cx - shape.rx, shape.cy - shape.ry);
        take(shape.cx + shape.rx, shape.cy + shape.ry);
        break;
      case "text": {
        const width = measure ? measure(shape.text, shape.size) : shape.text.length * shape.size * 0.6;
        take(shape.x, shape.y - shape.size);
        take(shape.x + width, shape.y + shape.size * 0.3);
        break;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 一段形状的纯文本摘要（`board.read` 回给模型的那份），超长自己截到 `limit` */
export function summarize(shapes: BoardShape[], limit = 3500): string {
  const counts = new Map<string, number>();
  for (const shape of shapes) counts.set(shape.kind, (counts.get(shape.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${kind}`);
  const head = `${shapes.length} shapes${parts.length ? ` (${parts.join(", ")})` : ""}`;
  const texts = shapes.filter((shape): shape is Extract<BoardShape, { kind: "text" }> => shape.kind === "text");
  if (texts.length === 0) return head;
  const body = texts.map((shape) => shape.text).join(" | ");
  const full = `${head}: ${body}`;
  return full.length <= limit ? full : head;
}
