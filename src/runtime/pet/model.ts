/**
 * 桌宠皮肤的几何 —— **纯函数，不碰 DOM**（`tests/pet-render.html` 钉着）。
 *
 * # 为什么单独一层
 *
 * 这一层回答"她画在哪、有多大、轮廓是哪几块矩形"，和"用 canvas 怎么画"是两件事。
 * 分开之后，几何可以在没有 canvas、没有贴图、没有 Tauri 的浏览器里断言 ——
 * 而 `lattice-pet://` 在 `npm run dev` 的页面里根本不存在。
 *
 * # 坐标系有两套，别混
 *
 * | 名字 | 单位 | 谁在用 |
 * | --- | --- | --- |
 * | **模型坐标** | 皮肤自己的世界单位（脚底在 y=1363 那种） | `model.json` 里的 `box` / `pivots` |
 * | **画布坐标** | 窗口里的 CSS 像素 | `fit()` 算出来的 `k` / `ox` / `oy` |
 *
 * 换算只有一条：`画布 = o + 模型 × k`。所有缩放都走这一个 `k`
 * （原组件里那句话：改它一个，轮廓和气泡位置全都跟着走）。
 */

/** 模型坐标里的一个矩形：`[x, y, 宽, 高]`。 */
export type Box4 = [number, number, number, number];

/** 一个部件 = 一张贴图 + 一个矩形 + 一个变形器链上的父节点。 */
export interface PetPart {
  id: string;
  /** 逻辑贴图名。缺省时贴图路径是 `tex/<tex>.png`。 */
  tex: string;
  /** 显式路径（服装部件用）。有它就压过 `tex`。 */
  src?: string;
  /** 绘制顺序，小的在下。 */
  z: number;
  /** 变形器链上的父节点名。静止姿态下用不到，留着给动画那一层。 */
  parent: string;
  /** 网格密度。Canvas2D 下封顶 6×8，构建期就该定好。 */
  grid: [number, number];
  box: Box4;
}

export interface PetOutfit {
  id: string;
  parts?: PetPart[];
}

/**
 * 一只眼的三张贴图 + 两条曲线（**master 像素**）。
 *
 * `ball` / `iris` / `lash` 是 `[x0, y0, x1, y1]` 的**角点**矩形，不是宽高 ——
 * 上游 `model.json` 一直用这个口径（嘴是 `[758, 764, 773, 775]`，15×11）。
 * 两套矩形在同一份文件里并存是历史包袱，`Rect4` 和 `Box4` 分开命名就是为了
 * 别让下一个人把它当宽高用。
 *
 * `lidFit` / `rimFit` 是二次曲线 `a·x² + b·x + c`：上眼睑和下眼缘。
 * 两者之差的最大值 = "闭眼要走多远"。
 */
export interface PetFaceEye {
  lash: Rect4;
  ball: Rect4;
  iris: Rect4;
  lidFit: [number, number, number];
  rimFit: [number, number, number];
}

/**
 * 表情层（`feat`）。
 *
 * `face` 那张贴图只有皮肤和眼窝，**眼睛和嘴是画上去的** —— 少了这一层，
 * 她有一张没有五官的脸。这不是装饰，是"她是不是一个角色"的分界。
 */
export interface PetFeat {
  eyes?: Record<string, PetFaceEye>;
  /** 整张表情贴图：`happy_eyeL`、`neutral_mouth`…… 值是 `[x0,y0,x1,y1]`。 */
  sprites?: Record<string, Rect4>;
  blush?: [number, number, number];
  skin?: [number, number, number];
  /**
   * 表情画布覆盖的那块原画（`[x, y, 宽, 高]`，master 像素）。
   *
   * 缺省用 `FACE_BOX`。**它是唯一一个没法从 `model.json` 推出来的数** ——
   * 上游把它写在 `pet-rig.js` 的常量里。愿意自己声明的话，换一张不同尺寸的
   * 原画就不用改代码。
   */
  box?: Box4;
}

/** 角点矩形 `[x0, y0, x1, y1]`（master 像素）。和 `Box4`（`[x, y, 宽, 高]`）不是一回事。 */
export type Rect4 = [number, number, number, number];

export interface PetModel {
  units: { S: number; X0: number; FEET: number; DS: number; featDS: number };
  parts: PetPart[];
  pivots?: Record<string, [number, number]>;
  outfits?: PetOutfit[];
  feat?: PetFeat;
  view?: unknown;
}

/** 画布坐标下的落位。`画布 = (ox + x·k, oy + y·k)`。 */
export interface Fit {
  k: number;
  ox: number;
  oy: number;
}

/** 轮廓里的一块。和 Rust 那边 `desktop::RegionPart` 同一个形状（物理像素）。 */
export interface PetRegionPart {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 出厂缩放。
 *
 * 窗口尺寸是平台定的，而"一只占满整扇窗口的宠物"在桌面上太大了 —— 原组件
 * 出厂 0.55，那是在 420×340 里她大约 190 像素高。这里给 1：**皮肤的 `size`
 * 已经是平台夹取过的**，再乘一道系数等于同一个判断落两个地方。
 */
export const DEFAULT_SCALE = 1;

/** 画布底部给她脚下影子留的空隙（和原组件 `layout` 里那个 18 一致）。 */
export const GROUND_INSET = 18;

// ---------------------------------------------------------------------------
// 姿态 → 表情
// ---------------------------------------------------------------------------

/**
 * 姿态名的顺序。**必须和 `pet_policy::POSTURES` 一字不差、一序不差。**
 *
 * `pet.json` 的 `postures` 在 Rust 那边被按这个顺序拍平成一个数组
 * （`SkinView.postures`），前端按同一个下标读回来。两边错位一位的症状是
 * "她开心的时候一脸惊恐"—— 而且不会报错。
 */
export const POSTURES = ["idle", "working", "waiting", "done", "error", "asleep"] as const;

export type Posture = (typeof POSTURES)[number];

/**
 * 这个姿态该画哪张脸。
 *
 * 三级回落：**皮肤为这个姿态声明的 → 皮肤为 `idle` 声明的 → `null`**。
 * 第三级不是"没表情"，是"皮肤什么都没说"，调用方自己决定用不用 `neutral`。
 *
 * 和 Rust 的 `pet_policy::expression_for` 是同一条规则。那边管"能不能用"，
 * 这边管"用哪张" —— 两份判断落在一个地方就够了，所以这里只做查表。
 */
export function expressionFor(
  postures: ReadonlyArray<string | null>,
  posture: string,
): string | null {
  const index = POSTURES.indexOf(posture as Posture);
  if (index < 0) return null;
  const declared = postures[index];
  if (declared) return declared;
  return postures[0] ?? null;
}

/**
 * 这一套服装的部件。
 *
 * `outfits[i].parts` **整体替换**基础部件，不是叠加 —— 原组件就是这么导出的
 * （服装自带它要替换的那几件）。所以这里不做合并。
 *
 * 表情层（`faceFx`）是**后加**的：它不属于任何一套服装，换衣服不换脸。
 */
export function partsFor(model: PetModel, outfitId?: string): PetPart[] {
  const base = baseParts(model, outfitId);
  const face = facePart(model);
  return face ? [...base, face] : base;
}

function baseParts(model: PetModel, outfitId?: string): PetPart[] {
  if (outfitId) {
    const outfit = model.outfits?.find((entry) => entry.id === outfitId);
    if (outfit?.parts?.length) return outfit.parts;
  }
  return model.parts ?? [];
}

/** 所有部件的并集（模型坐标）。它替代了原组件里构建期算好的那个 `mask.box`。 */
export function unionBox(parts: PetPart[]): Box4 {
  if (parts.length === 0) return [0, 0, 1, 1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const part of parts) {
    const [x, y, w, h] = part.box;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w;
    if (y + h > y1) y1 = y + h;
  }
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

/** 贴图路径，相对于皮肤目录。 */
export function texPath(part: PetPart): string {
  if (part.src) return part.src;
  return `tex/${part.tex}.png`;
}

// ---------------------------------------------------------------------------
// 表情层
// ---------------------------------------------------------------------------

/**
 * 表情层在部件表里的 id。
 *
 * 它**没有对应的贴图文件** —— `drawPose` 见到这个 id 就去画那张离屏画布。
 * `tex` 写成同一个名字只是为了让它走同一条代码路径，别真去读 `tex/faceFx.png`。
 */
export const FACE_PART_ID = "faceFx";

/**
 * 表情层的绘制层级。**9** 不是随便挑的：要压过 `eye_creases`（8.5）和
 * `brows`（8.6），又必须被刘海（13）盖住 —— 眼睛不该画在头发上面。
 */
export const FACE_Z = 9;

/**
 * 表情画布覆盖的原画范围（`[x, y, 宽, 高]`，master 像素）。
 *
 * 和 `pet-rig.js` 里那个 `FACE` 常量是同一个矩形。它没法从 `model.json` 推出来，
 * 所以在这里当默认值；皮肤可以在 `feat.box` 里覆盖它。
 */
export const FACE_BOX: Box4 = [520, 578, 390, 252];

/** 表情贴图在纹理表里的键前缀。和部件贴图共用一个 Map，靠前缀区分。 */
export const FEAT_PREFIX = "feat:";

export function featKey(name: string): string {
  return `${FEAT_PREFIX}${name}`;
}

/**
 * master 像素 → 模型坐标。
 *
 * 两条式子照抄 `pet-rig.js` 的 `U` / `V`：
 *
 *   `x_model = ox + (x_master − X0) · S`
 *   `y_model = oy − (FEET − y_master) · S`
 *
 * `S` / `X0` / `FEET` 来自 `units`，`(ox, oy)` 是**身体枢轴**（`pivots.body`，
 * 原画里是 `[128, 256]`）。枢轴不从数据里取就会变成两个魔数 —— 而这两个数
 * 恰好就是 `pivots.body`，没有理由再抄一遍。
 */
export function masterToModel(model: PetModel, mx: number, my: number): [number, number] {
  const { S, X0, FEET } = model.units;
  const origin = model.pivots?.body ?? [128, 256];
  return [origin[0] + (mx - X0) * S, origin[1] - (FEET - my) * S];
}

/** master 像素的 `[x, y, 宽, 高]` → 模型坐标的 `Box4`。缩放是线性的，宽高各乘 `S`。 */
export function masterBox(model: PetModel, box: Box4): Box4 {
  const [x, y] = masterToModel(model, box[0], box[1]);
  return [x, y, box[2] * model.units.S, box[3] * model.units.S];
}

/**
 * 表情层那个"部件"。皮肤没有 `feat` 时返回 `null`。
 *
 * 它不是文件、是画布，所以 `tex` 填 `faceFx` 而不是某个 png 名 —— `loadTextures`
 * 认这个前缀会跳过它。
 */
export function facePart(model: PetModel): PetPart | null {
  if (!model.feat?.eyes) return null;
  return {
    id: FACE_PART_ID,
    tex: FACE_PART_ID,
    z: FACE_Z,
    parent: "headFeat",
    grid: [4, 4],
    box: masterBox(model, model.feat.box ?? FACE_BOX),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 把模型坐标拟合进窗口。
 *
 * 算法照 `pet-rig.js` 的 `layout()` 抄的（那是调出来的，不是算出来的）：
 *
 * 1. 先按"四周留白"算一个 `fit`（上下留 96、左右留 40），夹进 `0.5..1.8`；
 * 2. 乘用户系数，夹进 `0.25..2`；
 * 3. **再按"整只装得下"夹一次** —— 用户系数大于 1 时第 1 步的留白就不作数了，
 *    她的头顶会跑出画布上边界（画不出来、也不在区域里，看着"断头"）；
 * 4. 底部对齐：脚踩在 `h - GROUND_INSET`，水平居中。
 *
 * 第 3 步不能省。少了它，"把大小调到最大"这个操作的症状是宠物被切掉脑袋。
 */
export function fit(box: Box4, width: number, height: number, scale = DEFAULT_SCALE): Fit {
  const [, , boxW, boxH] = box;
  const safeW = Math.max(1, boxW);
  const safeH = Math.max(1, boxH);

  const loose = clamp(
    Math.min(1.55, (height - 96) / safeH, (width - 40) / safeW),
    0.5,
    1.8,
  );
  let k = clamp(loose * scale, 0.25, 2);
  k = Math.min(k, (height - GROUND_INSET) / safeH, width / safeW);

  const ox = width / 2 - (box[0] + safeW / 2) * k;
  const oy = height - GROUND_INSET - (box[1] + safeH) * k;
  return { k, ox, oy };
}

/** 模型坐标的矩形 → 画布坐标的矩形。 */
export function place(fit: Fit, box: Box4): Box4 {
  return [
    fit.ox + box[0] * fit.k,
    fit.oy + box[1] * fit.k,
    box[2] * fit.k,
    box[3] * fit.k,
  ];
}

/**
 * 把一张 alpha 网格折成矩形块。
 *
 * 区域只有矩形粒度，所以"她的轮廓"只能是**一串矩形**。网格在这里的作用是
 * 把"这一块有没有她"变成一个布尔矩阵，然后逐行合并连续的格子 —— 一行一条，
 * 比一格一条少几十倍。
 *
 * `cell` 是画布像素。6 是折中：再细就快接近逐像素（区域重建会掉帧），
 * 再粗就看得见轮廓上的台阶。
 */
export function runsFromMask(
  mask: Uint8Array,
  cols: number,
  rows: number,
  cell: number,
): PetRegionPart[] {
  const runs: PetRegionPart[] = [];
  for (let row = 0; row < rows; row += 1) {
    let start = -1;
    for (let col = 0; col <= cols; col += 1) {
      const on = col < cols && mask[row * cols + col] !== 0;
      if (on && start < 0) {
        start = col;
      } else if (!on && start >= 0) {
        runs.push({
          kind: "rect",
          x: Math.round(start * cell),
          y: Math.round(row * cell),
          w: Math.max(1, Math.round((col - start) * cell)),
          h: Math.max(1, Math.round(cell)),
        });
        start = -1;
      }
    }
  }
  return runs;
}

/**
 * 小窗挡住宠物时她该站哪 —— 和 Rust 那边 `pet_policy::avoid` 是同一个判据。
 *
 * **前端这一份不参与决策**（让位由 `pet::avoid_assistant` 在 Rust 里做，
 * 因为只有那边同时知道两个窗口的矩形）。这里留着它是因为"她该往哪边挪"
 * 是个需要断言的几何问题，而 `pet_policy` 的测试跑不了浏览器。
 * 两边算出来的答案不一致就是 bug —— 这条注释是那个约定的落点。
 */
export function avoid(
  pet: Box4,
  window: Box4,
  work: Box4,
  gap = 12,
): [number, number] {
  const [px, py, pw, ph] = pet;
  if (!overlaps(pet, window)) return [px, py];

  const [wx, wy, ww, wh] = window;
  const candidates: Array<[number, number]> = [
    [wx + ww + gap, py],
    [wx - pw - gap, py],
    [px, wy + wh + gap],
    [px, wy - ph - gap],
  ];

  let best: { position: [number, number]; distance: number } | null = null;
  for (const [cx, cy] of candidates) {
    const [x, y] = clampToWork(cx, cy, pw, ph, work);
    if (overlaps([x, y, pw, ph], window)) continue;
    const distance = Math.abs(x - px) + Math.abs(y - py);
    if (!best || distance < best.distance) best = { position: [x, y], distance };
  }
  return best ? best.position : [px, py];
}

function overlaps(a: Box4, b: Box4): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/** 至少要露出来这么多（和 `pet_policy::MIN_VISIBLE` 一致）。 */
export const MIN_VISIBLE = 48;

function clampToWork(
  x: number,
  y: number,
  w: number,
  h: number,
  work: Box4,
): [number, number] {
  const [left, top, workW, workH] = work;
  const keepX = Math.min(MIN_VISIBLE, w);
  const keepY = Math.min(MIN_VISIBLE, h);
  return [
    Math.min(Math.max(x, left - w + keepX), left + workW - keepX),
    Math.min(Math.max(y, top), top + workH - keepY),
  ];
}
