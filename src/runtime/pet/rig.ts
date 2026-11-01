/**
 * 桌宠的 Canvas2D 渲染器 —— `render: "rig"` 这一档。
 *
 * # 这一版画的是"静止姿态"，而静止姿态不是占位图
 *
 * 骨骼的 25 个部件各有一张贴图和一个矩形；**弹簧和变形器在静止时是恒等变换**
 * （`x = 0`、`v = 0`），所以"她站着不动"这件事本身就等于"按 z 序把 25 张贴图
 * 各画到自己的矩形里"。走路、拖拽、眨眼是加在这一层之上的动画，不是画法的前提。
 *
 * 所以这个文件是**能用的第一版**，不是脚手架：它画出来的就是她站着的样子。
 *
 * # 五官是画上去的，不是贴上去的
 *
 * `tex/face.png` 只有皮肤和眼窝 —— 眼睛和嘴在 `face.ts` 里合成到一张离屏画布，
 * 再当作一个 `z = 9` 的部件贴回去。**这一层不能省**：少了它她是一张没有五官
 * 的脸，那不是"先做静态"，那是"看不出她是谁"。
 *
 * # 轮廓是加载时算的，不是构建期算的（LAT-0041 §5.2）
 *
 * 原组件靠 `art/build-masks.py` 在构建期把静止轮廓烘成 `rig-data.js` ——
 * 换一张贴图就要跑一次 Python。那**不叫换素材，叫改构建**。
 *
 * 这里改成加载时扫一遍 alpha：把整只画进一张离屏画布，按 6 像素的格子标脏。
 * 代价是一次性的几十毫秒，换来的是**皮肤目录里没有任何构建产物**。
 *
 * 能这么干的前提是一条容易被忽略的事：离屏画布读像素会被**跨域污染**，而贴图是
 * 从 `lattice-pet://` 拿的、和窗口不同源。所以 `<img>` 必须带
 * `crossOrigin = "anonymous"`，并且协议那边回 `Access-Control-Allow-Origin: *`
 * （`protocol.rs` 本来就回）。少任何一半，`getImageData` 抛 SecurityError。
 */

import {
  FACE_PART_ID,
  featKey,
  fit,
  place,
  runsFromMask,
  texPath,
  unionBox,
  type PetFeat,
  type PetPart,
  type PetRegionPart,
} from "./model";
import { featFiles } from "./face";

/** 轮廓网格的边长（画布像素）。6 是折中：再细就快逐像素，区域重建会掉帧。 */
export const CELL = 6;

/** alpha 低于它算"没有她"。和 `build-masks.py` 的 `ALPHA=8` 同一个门槛。 */
export const ALPHA_THRESHOLD = 8;

/**
 * 把皮肤目录里的贴图全部读进来 —— 部件的，以及表情层的。
 *
 * **一张失败不抛**：少一张耳朵不该让她整个人消失。返回的 map 里没有的键，
 * 画的时候跳过，`missing` 里留个名字给日志。
 *
 * 表情贴图用 `feat:` 前缀存进**同一个** Map：`drawPose` 只有一张表要查，
 * 而前缀已经把它们和部件 id 分开了（部件 id 里不可能有冒号）。
 */
export async function loadTextures(
  baseUrl: string,
  parts: PetPart[],
  feat?: PetFeat,
): Promise<{ textures: Map<string, HTMLImageElement>; missing: string[] }> {
  const textures = new Map<string, HTMLImageElement>();
  const missing: string[] = [];

  const wanted: Array<{ key: string; path: string }> = parts
    // 表情层是画布，不是文件 —— 读它等于读一个不存在的 png
    .filter((part) => part.id !== FACE_PART_ID)
    .map((part) => ({ key: part.id, path: texPath(part) }));

  for (const path of featFiles(feat)) {
    // `feat/happy_eyeL.png` → 键 `feat:happy_eyeL`
    wanted.push({ key: featKey(path.slice("feat/".length, -".png".length)), path });
  }

  await Promise.all(
    wanted.map(
      (item) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          // 见文件头：没有这一行，离屏画布会被污染，`getImageData` 直接抛
          image.crossOrigin = "anonymous";
          image.onload = () => {
            textures.set(item.key, image);
            resolve();
          };
          image.onerror = () => {
            missing.push(item.path);
            resolve();
          };
          image.src = `${baseUrl}${item.path}`;
        }),
    ),
  );

  return { textures, missing };
}

/**
 * 画一帧静止姿态。
 *
 * 按 `z` 从小到大 —— 小的在下。这个顺序是皮肤数据里的，不是平台猜的：
 * 换一只形象，前后关系跟着 `model.json` 走，渲染器一行都不用改。
 *
 * `face` 是 `paintFace` 交出来的那张画布。它没有贴图文件，所以在这里单独
 * 一个分支：见到 `faceFx` 就画它。
 */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  parts: PetPart[],
  textures: Map<string, HTMLImageElement>,
  layout: ReturnType<typeof fit>,
  face?: HTMLCanvasElement | null,
): void {
  const ordered = [...parts].sort((a, b) => a.z - b.z);
  for (const part of ordered) {
    const [x, y, w, h] = place(layout, part.box);
    if (w <= 0 || h <= 0) continue;

    if (part.id === FACE_PART_ID) {
      if (face) ctx.drawImage(face, x, y, w, h);
      continue;
    }

    const image = textures.get(part.id);
    if (!image) continue;
    ctx.drawImage(image, x, y, w, h);
  }
}

/**
 * 扫一遍 alpha，得到轮廓矩形。
 *
 * 整只画进离屏画布再逐格看，而不是逐部件算 —— 部件之间有重叠和抗锯齿，
 * 逐部件并集会在接缝处多出几像素的台阶（`PET_REFERENCE` 坑 8 就是这件事）。
 *
 * 返回的坐标是**画布 CSS 像素**；调用方负责乘 DPI 换成物理像素
 * （`window.setRegion` 那个口径）。
 */
export function measureRegion(
  parts: PetPart[],
  textures: Map<string, HTMLImageElement>,
  width: number,
  height: number,
  options: { scale?: number; face?: HTMLCanvasElement | null } = {},
): PetRegionPart[] {
  const { scale = 1, face = null } = options;
  const cols = Math.max(1, Math.ceil(width / CELL));
  const rows = Math.max(1, Math.ceil(height / CELL));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const layout = fit(unionBox(parts), width, height, scale);
  drawPose(ctx, parts, textures, layout, face);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    // 跨域污染。症状是"宠物显示了，但点不到也拖不动"（区域是空的）。
    // 不吞掉它 —— 这类问题必须留一句话在控制台，否则排查会从渲染器开始找。
    console.error(
      "[pet] could not read the silhouette: the canvas is tainted. " +
        "Textures need crossOrigin=\"anonymous\" and the pet protocol needs Access-Control-Allow-Origin.",
    );
    return [];
  }

  const mask = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * CELL;
      const y0 = row * CELL;
      const x1 = Math.min(width, x0 + CELL);
      const y1 = Math.min(height, y0 + CELL);
      let hit = 0;
      for (let y = y0; y < y1 && !hit; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (pixels[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) {
            hit = 1;
            break;
          }
        }
      }
      mask[row * cols + col] = hit;
    }
  }

  return runsFromMask(mask, cols, rows, CELL);
}
