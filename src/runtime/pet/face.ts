/**
 * 表情层 —— 把眼睛、嘴、腮红画进一张离屏画布。
 *
 * # 为什么这一层不能省
 *
 * `tex/face.png` 是一张**没有五官的脸**：只有皮肤和眼窝。眼睛是
 * `feat/eyeL_ball` + `eyeL_iris` + `eyeL_lash` 三层叠出来的，嘴是
 * `feat/*_mouth` 一张贴图。少了这一层，她站在桌面上是一个没有脸的团
 * —— 那不是"占位"，是"看不出她是谁"。
 *
 * # 坐标
 *
 * 这一层里所有数字都是 **master 像素**（原画的像素），画布原点就是
 * `FACE_BOX` 的左上角。`paintFace` 交出来的画布由 `drawPose` 缩到模型坐标
 * 里去，所以这里一个 `S` 都不用乘。
 *
 * # 为什么眼睛要单独一张画布
 *
 * 虹膜要用 `source-atop` 只涂在眼球里（不然会溢出到眼框外），眼睑要用
 * `destination-out` 擦掉眼球上半部分。这两种混合模式一旦作用在共享画布上，
 * 会连旁边已经画好的东西一起吃掉 —— 所以每只眼先在自己的小画布上合成，
 * 再整张贴到脸上。
 */

import {
  FACE_BOX,
  type Box4,
  type PetFaceEye,
  type PetFeat,
  type PetModel,
  type Rect4,
} from "./model";

/** 表情名 → 这一张脸怎么画。名字是**皮肤数据**里的，不是代码里的。 */
interface FaceSpec {
  /** `"open"` = 走"眼球 + 虹膜 + 眼睑"那条路（能半闭）；其余值是整眼贴图的前缀。 */
  eyes: string;
  /** 睁眼程度，1 全睁。只在 `eyes: "open"` 时有用。 */
  open?: number;
  mouth: string;
  blush?: number;
}

/**
 * 内置的 11 张脸。
 *
 * `open` 那几档的差别就是眼睑压下去多少：`neutral` 1 全睁、`happy` 0.72 笑眼、
 * `slack` 0.3 快睡着。这些数字是从原组件调出来的，不是算出来的。
 */
const FACES: Record<string, FaceSpec> = {
  neutral: { eyes: "open", open: 1, mouth: "neutral_mouth" },
  happy: { eyes: "open", open: 0.72, mouth: "happy_mouth", blush: 0.6 },
  shy: { eyes: "open", open: 0.8, mouth: "drag_mouth", blush: 1 },
  angry: { eyes: "open", open: 0.55, mouth: "drag_mouth" },
  unhappy: { eyes: "open", open: 0.62, mouth: "neutral_mouth" },
  slack: { eyes: "open", open: 0.3, mouth: "sleep_mouth" },
  sleep: { eyes: "sleep", mouth: "sleep_mouth" },
  love: { eyes: "love", mouth: "love_mouth", blush: 1 },
  surprised: { eyes: "surprised", mouth: "surprised_mouth" },
  dragged: { eyes: "drag", mouth: "drag_mouth" },
  dizzy: { eyes: "dizzy", mouth: "dizzy_mouth" },
};

/** 皮肤可以用的表情名。设置页拿它做校验，`pet.json` 写错时能立刻说出来。 */
export const EXPRESSIONS: string[] = Object.keys(FACES);

/**
 * 三张嘴比原画里的位置高一点（happy 高 9、drag 高 16、sleep 高 4 master 像素），
 * 这里补回中间线上 —— 否则换表情时嘴会跳一下。
 */
const MOUTH_DY: Record<string, number> = {
  happy_mouth: 9,
  drag_mouth: 16,
  sleep_mouth: 4,
};

/**
 * 腮红两团，`[x, y, 半径x, 半径y]`（master 像素）。
 *
 * 用椭圆而不是正圆：她的脸是压扁的，正圆看起来像贴了两块圆片。
 */
const CHEEKS: Rect4[] = [
  [618, 770, 40, 20],
  [852, 762, 22, 15],
];

/** 二次曲线求值：`a·x² + b·x + c`。眼睑和眼缘都是这个形状。 */
function poly2(curve: [number, number, number], x: number): number {
  return curve[0] * x * x + curve[1] * x + curve[2];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** 一张角点矩形的宽高。`Rect4` 是 `[x0,y0,x1,y1]`，别和 `Box4` 混。 */
function rectSize(rect: Rect4): [number, number, number, number] {
  return [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]];
}

/**
 * 一只眼的几何，外加"闭眼要走多远"。
 *
 * `travel` = 上眼睑到下眼缘的最大间距 + 2。多给 2 像素是因为抗锯齿的边
 * 擦不干净会在闭眼时留一条细缝 —— 那种 bug 只在睡着时看得见。
 */
function eyeGeometry(spec: PetFaceEye): {
  travel: number;
  cx: number;
  cy: number;
} {
  const bx0 = spec.ball[0];
  let travel = 0;
  for (let x = bx0 + 4; x < spec.ball[2] - 4; x += 2) {
    travel = Math.max(travel, poly2(spec.rimFit, x) - poly2(spec.lidFit, x));
  }
  const cx = (spec.iris[0] + spec.iris[2]) / 2;
  return { travel: travel + 2, cx, cy: poly2(spec.lidFit, cx) };
}

/**
 * 画一张脸，返回那张画布。`null` = 这份皮肤没有表情层，或者环境里没有 canvas。
 *
 * `expr` 认不出来就退回 `neutral` —— **不抛**。皮肤可能比平台新，写了一个
 * 平台还不认识的表情名；那时候"她仍然是同一张脸"比"她整只消失"好。
 */
export function paintFace(
  model: PetModel,
  textures: Map<string, HTMLImageElement>,
  expr: string,
): HTMLCanvasElement | null {
  const feat: PetFeat | undefined = model.feat;
  if (!feat?.eyes) return null;

  const box: Box4 = feat.box ?? FACE_BOX;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box[2]));
  canvas.height = Math.max(1, Math.round(box[3]));
  const fx = canvas.getContext("2d");
  if (!fx) return null;

  // 画布原点是 FACE_BOX 的左上角，所以之后所有 master 坐标都要减掉它
  const ox = box[0];
  const oy = box[1];
  const sprites = feat.sprites ?? {};

  /** 一张整图表情（一双眼或一张嘴）：按它自己的矩形放。 */
  const drawSprite = (name: string): void => {
    const rect = sprites[name];
    if (!rect) return;
    const image = textures.get(`feat:${name}`);
    if (!image) return;
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2;
    fx.save();
    fx.translate(cx - ox, cy + (MOUTH_DY[name] ?? 0) - oy);
    fx.drawImage(image, rect[0] - cx, rect[1] - cy);
    fx.restore();
  };

  /**
   * 一只睁着的眼。`open` 0 = 全闭、1 = 全睁。
   *
   * 顺序不能换：先画眼球，`source-atop` 盖虹膜（不越出眼框），再
   * `destination-out` 把眼睑以上整片擦掉。睫毛最后单独画，跟着眼睑往下走、
   * 闭眼时压扁 —— 睫毛要是和眼球一起被擦，闭眼就成了"没有睫毛的闭眼"。
   */
  const openEye = (key: string, open: number): void => {
    const spec = feat.eyes?.[key];
    if (!spec) return;
    const ball = textures.get(`feat:${key}_ball`);
    if (!ball) return;

    const [bx0, by0, w, h] = rectSize(spec.ball);
    const { travel, cx, cy } = eyeGeometry(spec);

    // 上下各留 20 px：睫毛和眼睑曲线都要余量，否则会被小画布的边切掉
    const eyeCv = document.createElement("canvas");
    eyeCv.width = w + 40;
    eyeCv.height = h + 40;
    const g = eyeCv.getContext("2d");
    if (!g) return;

    g.setTransform(1, 0, 0, 1, 20 - bx0, 20 - by0);
    g.globalCompositeOperation = "source-over";
    g.drawImage(ball, bx0, by0);

    const iris = textures.get(`feat:${key}_iris`);
    if (iris) {
      g.globalCompositeOperation = "source-atop";
      g.drawImage(iris, spec.iris[0], spec.iris[1]);
    }

    const drop = (1 - clamp(open, 0, 1)) * travel;
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.moveTo(bx0 - 20, by0 - 20);
    for (let x = bx0 - 20; x <= spec.ball[2] + 20; x += 3) {
      g.lineTo(x, poly2(spec.lidFit, clamp(x, bx0, spec.ball[2])) + drop - 1);
    }
    g.lineTo(spec.ball[2] + 20, by0 - 20);
    g.closePath();
    g.fill();
    g.globalCompositeOperation = "source-over";
    g.setTransform(1, 0, 0, 1, 0, 0);

    fx.drawImage(eyeCv, bx0 - 20 - ox, by0 - 20 - oy);

    const lash = textures.get(`feat:${key}_lash`);
    if (!lash) return;
    fx.save();
    fx.translate(cx - ox, cy + drop - oy);
    fx.scale(1, 0.55 + 0.45 * clamp(open, 0, 1));
    fx.drawImage(lash, spec.lash[0] - cx, spec.lash[1] - cy);
    fx.restore();
  };

  const blush = (amount: number): void => {
    if (amount < 0.02) return;
    for (const [x, y, rx, ry] of CHEEKS) {
      fx.save();
      fx.translate(x - ox, y - oy);
      fx.scale(1, ry / rx);
      const gradient = fx.createRadialGradient(0, 0, 0, 0, 0, rx);
      gradient.addColorStop(0, `rgba(255,120,140,${0.55 * amount})`);
      gradient.addColorStop(1, "rgba(255,120,140,0)");
      fx.fillStyle = gradient;
      fx.beginPath();
      fx.arc(0, 0, rx, 0, Math.PI * 2);
      fx.fill();
      fx.restore();
    }
  };

  const face = FACES[expr] ?? FACES.neutral;
  if (face.eyes === "open") {
    const open = face.open ?? 1;
    openEye("eyeL", open);
    openEye("eyeR", open);
  } else {
    drawSprite(`${face.eyes}_eyeL`);
    drawSprite(`${face.eyes}_eyeR`);
  }
  blush(face.blush ?? 0);
  drawSprite(face.mouth);

  return canvas;
}

/**
 * 这份皮肤需要读哪些表情贴图。
 *
 * 返回相对皮肤目录的路径。**只读它真的用得到的**：`feat/` 里躺着的
 * 二十几张表情不是每张都要，一张都不漏地加载会让桌宠窗多等 200 毫秒。
 * 但这里按"全部"算 —— 换表情是运行时的事，缺一张的症状是"换个表情眼睛没了"。
 */
export function featFiles(feat: PetFeat | undefined): string[] {
  if (!feat?.eyes) return [];
  const files = new Set<string>();
  for (const name of Object.keys(feat.sprites ?? {})) files.add(`feat/${name}.png`);
  for (const side of ["eyeL", "eyeR"]) {
    if (!feat.eyes[side]) continue;
    for (const layer of ["ball", "iris", "lash"]) files.add(`feat/${side}_${layer}.png`);
  }
  return [...files];
}
