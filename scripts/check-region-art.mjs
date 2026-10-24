/**
 * 量一量 region 组件的贴图，看它配不配得上"按 alpha 裁窗口"这条路。
 *
 *   npm run check:art                                  # 扫 public/widgets/* 里所有 shape:"region" 的
 *   npm run check:art public/widgets/lattice.pet       # 指定组件目录
 *   npm run check:art path/to/greeting.png ...         # 直接量图片
 *
 * # 为什么要有这个脚本
 *
 * `shape: "region"` 的代价全在美术上：窗口只保留"不透明的像素"，所以图上
 * 一个水印、一圈白边、一块半透明阴影，都会变成区域的一部分 —— 字变成几十个
 * 细横条（能点到），画框变成一整块圆盘（"宠物"变成"贴纸"），阴影被裁成刀口。
 * 这些事**看代码看不出来**，只在桌面上看才发现，而那时候已经画完六张图了。
 *
 * 所以规格写成能算的数字，脚本负责算。WIDGET_SPEC 2.5 那张表和这里的常量
 * 是同一组值 —— 改一处就要改另一处（表里写着"以下每条都能被 check:art 量出来"）。
 *
 * # 为什么不引 sharp / pngjs
 *
 * 这个仓库的脚本层一直是零依赖（`test-browser.mjs` 连 CDP 都不用）。PNG 是
 * zlib + 5 种行过滤器，Node 自带 zlib —— 为了读几个 alpha 值装一个带原生
 * 二进制的图像库，不值。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 规格。和 WIDGET_SPEC 2.5 的"贴图规格"表逐条对应。
 *
 * 数值不是拍的：块数上限来自"每块一次 CombineRgn，几十块无感、几百块开始卡"；
 * IoU 0.75 是"同一个角色的两种表情"的经验下限 —— 换了衣服 / 换了画风就会掉到
 * 0.4 附近（`lattice.pet` 的 shy 和 greeting 就是 0.41）。
 */
const SPEC = {
  /** 单状态最多几块矩形。超了说明轮廓碎了（水印、噪点、碎发） */
  maxRuns: 120,
  /** 身体四周允许的透明留白（px）。留白 = 看不见但点得到的死区 */
  maxMargin: 8,
  /**
   * "悬空"的半透明像素占比上限。
   *
   * 只看半透明总量没用：抗锯齿边缘本身就有 2–3% 的半透明像素，那是**贴着**
   * 不透明区域的，裁出来没问题。真正会出事的是**离开身体**的半透明 —— 投影、
   * 外发光、柔边贴纸，它们在区域外，会被系统裁成刀口。所以数的是"周围 8 邻域
   * 里一个不透明像素都没有"的那些。
   */
  maxSemiFree: 0.005,
  /**
   * 连通块上限。字、水印、贴纸留白都会把一张图切成好几个互不相连的块 ——
   * "一只宠物"应该是一整块（最多加几根分开的头发）。
   */
  maxComponents: 6,
  /** 状态间包围盒高度差：max/min 不许超过这个倍数 */
  maxHeightRatio: 1.15,
  /** 每个状态和"典型状态"的轮廓相似度下限 */
  minIou: 0.75,
  /** 任意两个状态之间相似度的平均值下限。比单看基准更难糊弄 */
  minMeanIou: 0.75,
  /** 轮廓网格。和组件的 masks 生成器同一个口径 */
  grid: 6,
  /** alpha 二值化阈值。>= 这个值算"不透明" */
  alphaCutoff: 128,
  /** 抗锯齿的判定带：alpha 落在 (semiLow, semiHigh) 之间算"半透明" */
  semiLow: 8,
  semiHigh: 248,
};

// ---------------------------------------------------------------------------
// PNG 解码：只支持"图标 / 贴图"会遇到的那几种组合
// ---------------------------------------------------------------------------

/**
 * 读一张 PNG，返回 `{ width, height, alpha }`（alpha 是 0..255 的 Uint8Array）。
 *
 * 支持：位深 8、非隔行、灰度 / 灰度+alpha / RGB / RGBA / 调色板（带 tRNS）。
 * 不支持 16 位和隔行 —— 贴图不会用，真遇到了报错比猜一个结果好。
 */
function readPng(path) {
  const buffer = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${path}: not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`${path}: only 8-bit PNGs are supported (got ${bitDepth})`);
  if (interlace !== 0) throw new Error(`${path}: interlaced PNGs are not supported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  // 逐行反过滤（PNG 的五种过滤器）
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels] : 0;
      const up = prior ? prior[i] : 0;
      const upLeft = prior && i >= channels ? prior[i - channels] : 0;
      const value = line[i];

      switch (filter) {
        case 0:
          out[i] = value;
          break;
        case 1:
          out[i] = (value + left) & 0xff;
          break;
        case 2:
          out[i] = (value + up) & 0xff;
          break;
        case 3:
          out[i] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          out[i] = (value + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`${path}: unknown row filter ${filter}`);
      }
    }
  }

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    if (colorType === 6) alpha[i] = pixels[i * 4 + 3];
    else if (colorType === 4) alpha[i] = pixels[i * 2 + 1];
    else if (colorType === 3) {
      // 调色板：tRNS 里给的是"每个调色板项"的 alpha，没给就是不透明
      const index = pixels[i];
      alpha[i] = transparency && index < transparency.length ? transparency[index] : 255;
    } else alpha[i] = 255; // 灰度 / RGB：没有 alpha 通道 = 整张不透明
  }

  return { width, height, alpha };
}

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

/** 一张图量出来的所有数 */
function measure(path) {
  const { width, height, alpha } = readPng(path);
  const cutoff = SPEC.alphaCutoff;

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let opaque = 0;
  let semi = 0;
  let semiFree = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = alpha[y * width + x];
      if (value > SPEC.semiLow && value < SPEC.semiHigh) semi += 1;
      if (value < cutoff) continue;
      opaque += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  // 悬空的半透明像素：周围 8 邻域里一个不透明的都没有。抗锯齿边缘贴着身体，
  // 投影 / 发光是飘在空处的 —— 后者会被系统裁成刀口
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = alpha[y * width + x];
      if (value <= SPEC.semiLow || value >= SPEC.semiHigh) continue;
      let touching = false;
      for (let dy = -1; dy <= 1 && !touching; dy += 1) {
        for (let dx = -1; dx <= 1 && !touching; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (alpha[ny * width + nx] >= cutoff) touching = true;
        }
      }
      if (!touching) semiFree += 1;
    }
  }

  if (right < 0) {
    return { path, width, height, empty: true };
  }

  // 按网格合并成横条 —— 和组件生成 masks 的口径一致
  const runs = [];
  const cell = SPEC.grid;
  for (let y = top; y <= bottom; y += cell) {
    let start = -1;
    for (let x = left; x <= right + cell; x += cell) {
      let hit = false;
      for (let dy = 0; dy < cell && y + dy <= bottom && !hit; dy += 1) {
        for (let dx = 0; dx < cell && x + dx <= right; dx += 1) {
          if (alpha[(y + dy) * width + (x + dx)] >= cutoff) {
            hit = true;
            break;
          }
        }
      }
      if (hit && start < 0) start = x;
      if (!hit && start >= 0) {
        runs.push({ x: start, y, w: x - start, h: Math.min(cell, bottom - y + 1) });
        start = -1;
      }
    }
  }

  const boxW = right - left + 1;
  const boxH = bottom - top + 1;

  return {
    path,
    width,
    height,
    empty: false,
    box: { x: left, y: top, w: boxW, h: boxH },
    margin: Math.min(left, top, width - 1 - right, height - 1 - bottom),
    runs: runs.length,
    semiFree: semiFree / (width * height),
    components: countComponents(alpha, width, height, cutoff),
    fill: opaque / (boxW * boxH),
    alpha,
  };
}

/** 4 连通块个数。数的是"这张图由几块互不相连的东西组成" */
function countComponents(alpha, width, height, cutoff) {
  const seen = new Uint8Array(width * height);
  const stack = [];
  let count = 0;

  for (let start = 0; start < alpha.length; start += 1) {
    if (seen[start] || alpha[start] < cutoff) continue;
    count += 1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0) push(index - 1);
      if (x + 1 < width) push(index + 1);
      if (y > 0) push(index - width);
      if (y + 1 < height) push(index + width);
    }
  }

  function push(index) {
    if (seen[index] || alpha[index] < cutoff) return;
    seen[index] = 1;
    stack.push(index);
  }

  return count;
}

/**
 * 两张图的轮廓相似度。
 *
 * 先各自按包围盒裁出来，再缩放到 64×64 比 —— 直接按像素比会被"图不一样大"
 * 干扰，而"同一个角色换个表情"本来就会差几个像素。
 */
function silhouetteIou(a, b) {
  const size = 64;
  const sample = (image) => {
    const cells = new Uint8Array(size * size);
    for (let gy = 0; gy < size; gy += 1) {
      for (let gx = 0; gx < size; gx += 1) {
        const x0 = image.box.x + Math.floor((gx * image.box.w) / size);
        const y0 = image.box.y + Math.floor((gy * image.box.h) / size);
        const x1 = Math.max(x0 + 1, image.box.x + Math.floor(((gx + 1) * image.box.w) / size));
        const y1 = Math.max(y0 + 1, image.box.y + Math.floor(((gy + 1) * image.box.h) / size));
        let hit = 0;
        let total = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            total += 1;
            if (image.alpha[y * image.width + x] >= SPEC.alphaCutoff) hit += 1;
          }
        }
        cells[gy * size + gx] = total > 0 && hit * 2 >= total ? 1 : 0;
      }
    }
    return cells;
  };

  const left = sample(a);
  const right = sample(b);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] && right[i]) intersection += 1;
    if (left[i] || right[i]) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

// ---------------------------------------------------------------------------
// 找目标
// ---------------------------------------------------------------------------

function pngsIn(directory) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name.startsWith(".")) continue;
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (extname(name).toLowerCase() === ".png" && !/^icon/i.test(name)) found.push(full);
    }
  };
  walk(directory);
  return found.sort();
}

/** 一个目录算一组：`public/widgets/*` 里只有声明了 region 的才算 */
function targetsFrom(args) {
  const targets = [];
  const inputs = args.length > 0 ? args : readdirSync(join(root, "public", "widgets")).map((name) => join(root, "public", "widgets", name));

  for (const input of inputs) {
    const full = resolve(input);
    if (!existsSync(full)) {
      console.error(`  ${input}: 不存在`);
      continue;
    }
    if (statSync(full).isDirectory()) {
      const manifestPath = join(full, "manifest.json");
      if (!args.length && existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.shape !== "region") continue;
      }
      const files = pngsIn(full);
      if (files.length > 0) targets.push({ label: relative(root, full) || full, files });
    } else if (extname(full).toLowerCase() === ".png") {
      targets.push({ label: relative(root, full), files: [full] });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const pad = (text, width) => String(text).padEnd(width);
const padStart = (text, width) => String(text).padStart(width);

function checkTarget(target) {
  const images = [];
  for (const file of target.files) {
    try {
      images.push(measure(file));
    } catch (error) {
      console.log(`  ✗ ${relative(process.cwd(), file)}: ${error.message}`);
    }
  }

  const problems = [];
  const usable = images.filter((image) => !image.empty);

  /*
   * 基准取"块数居中"的那张，不取第一张：按文件名排序时第一张可能是张异类
   * （`lattice.pet` 的 angry 排在最前），拿它当基准会让其余五张全部"不像"。
   */
  const sorted = [...usable].sort((a, b) => a.runs - b.runs);
  const base = sorted[Math.floor(sorted.length / 2)] ?? null;

  console.log(`\n  ${target.label}  （${usable.length} 张图，基准是 ${base ? relative(dirname(base.path), base.path) : "—"}）`);
  console.log(
    `    ${pad("文件", 16)}${padStart("尺寸", 10)}${padStart("块数", 6)}${padStart("留白", 6)}${padStart("悬空半透明", 12)}${padStart("连通块", 8)}${padStart("IoU", 8)}`,
  );

  for (const image of images) {
    const name = relative(dirname(image.path), image.path);
    if (image.empty) {
      problems.push(`${name}: 整张透明`);
      console.log(`    ${pad(name, 16)}  整张透明 ✗`);
      continue;
    }

    const iou = image === base ? null : silhouetteIou(base, image);
    const flags = [];
    if (image.runs > SPEC.maxRuns) flags.push(`块数 ${image.runs} > ${SPEC.maxRuns}`);
    if (image.margin > SPEC.maxMargin) flags.push(`留白 ${image.margin}px > ${SPEC.maxMargin}px`);
    if (image.semiFree > SPEC.maxSemiFree) {
      flags.push(`悬空半透明 ${percent(image.semiFree)} > ${percent(SPEC.maxSemiFree)}（投影 / 发光会被裁成刀口）`);
    }
    if (image.components > SPEC.maxComponents) {
      flags.push(`连通块 ${image.components} 个 > ${SPEC.maxComponents}（像是有字 / 贴纸留白）`);
    }
    if (iou !== null && iou < SPEC.minIou) flags.push(`和基准的轮廓只重合 ${percent(iou)}（< ${percent(SPEC.minIou)}）`);
    problems.push(...flags.map((flag) => `${name}: ${flag}`));

    console.log(
      `    ${pad(name, 16)}${padStart(`${image.width}×${image.height}`, 10)}${padStart(image.runs, 6)}${padStart(image.margin, 6)}${padStart(percent(image.semiFree), 12)}${padStart(image.components, 8)}${padStart(iou === null ? "—" : percent(iou), 8)}${flags.length ? "  ✗" : ""}`,
    );
  }

  // 任意两张之间的平均相似度：一个异类混在五张同款里，单看基准可能漏掉
  if (usable.length > 2) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        sum += silhouetteIou(usable[i], usable[j]);
        pairs += 1;
      }
    }
    const mean = sum / pairs;
    if (mean < SPEC.minMeanIou) {
      problems.push(`任意两张的平均相似度 ${percent(mean)} < ${percent(SPEC.minMeanIou)}（这不是一套图）`);
    }
    console.log(
      `    任意两张平均 ${percent(mean)}（下限 ${percent(SPEC.minMeanIou)}）${mean < SPEC.minMeanIou ? " ✗" : ""}`,
    );
  }

  const heights = usable.map((image) => image.box.h);
  if (heights.length > 1) {
    const ratio = Math.max(...heights) / Math.min(...heights);
    if (ratio > SPEC.maxHeightRatio) {
      problems.push(`高度差 ${ratio.toFixed(2)}× > ${SPEC.maxHeightRatio}×（状态之间会跳大小）`);
    }
    console.log(
      `    高度 ${Math.min(...heights)}–${Math.max(...heights)}px（${ratio.toFixed(2)}×，上限 ${SPEC.maxHeightRatio}×）${ratio > SPEC.maxHeightRatio ? " ✗" : ""}`,
    );
  }

  return problems;
}

const targets = targetsFrom(process.argv.slice(2));
if (targets.length === 0) {
  console.log("\n  没有找到要量的图（public/widgets 里没有 shape:\"region\" 的组件）\n");
  process.exit(0);
}

let failed = 0;
for (const target of targets) {
  const problems = checkTarget(target);
  if (problems.length === 0) {
    console.log(`    ✓ 全部合规`);
    continue;
  }
  failed += 1;
  console.log(`    ✗ ${problems.length} 项不合规：`);
  for (const problem of problems) console.log(`      · ${problem}`);
}

console.log(
  failed === 0
    ? `\n  ${targets.length} 组图全部合规（块数 <= ${SPEC.maxRuns}、留白 <= ${SPEC.maxMargin}px、IoU >= ${percent(SPEC.minIou)}）\n`
    : `\n  ${failed} / ${targets.length} 组图不合规。规格见 docs/WIDGET_SPEC.md 2.5「贴图规格」\n`,
);
process.exit(failed === 0 ? 0 : 1);
