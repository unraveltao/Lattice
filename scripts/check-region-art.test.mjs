/**
 * `check-region-art.mjs` 自己的测试。
 *
 * 一个只会说"不合规"的检查器和没有检查器一样糟：作者会把它关掉。所以这里
 * 造两组**合成图**（一张干净、一张有明显毛病），确认它既能放行也能拦下。
 *
 *   node --test scripts/check-region-art.test.mjs
 *
 * 图是现画的：PNG 是 zlib + 行过滤器，Node 自带 zlib，写一个编码器比找一张
 * 版权干净的真图当夹具省事得多 —— 而且能精确控制"圆盘多大、影子在哪"。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(root, "scripts", "check-region-art.mjs");

// ---------------------------------------------------------------------------
// 一个只够用的 PNG 编码器（RGBA8、filter 0）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** `paint(x, y)` 返回 alpha（0..255）；RGB 统一填成不透明的蓝，反正没人看 */
function png(width, height, paint) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = 60;
      raw[offset + 1] = 120;
      raw[offset + 2] = 200;
      raw[offset + 3] = paint(x, y);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 画法
// ---------------------------------------------------------------------------

/** 一个圆盘，边缘 1px 抗锯齿（真实贴图就是这样） */
const disc = (cx, cy, radius) => (x, y) => {
  const distance = Math.hypot(x - cx, y - cy);
  if (distance <= radius - 1) return 255;
  if (distance <= radius) return 180;
  return 0;
};

/** 圆盘 + 一圈飘在空处的半透明（投影 / 发光） */
const halo = (cx, cy, radius, ring) => (x, y) => {
  const distance = Math.hypot(x - cx, y - cy);
  if (distance <= radius) return disc(cx, cy, radius)(x, y);
  if (distance >= radius + 3 && distance <= radius + ring) return 70;
  return 0;
};

function writeSet(files) {
  const dir = mkdtempSync(join(tmpdir(), "region-art-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, buffer] of Object.entries(files)) writeFileSync(join(dir, name), buffer);
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [checker, dir], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout || "") };
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("同一只、同一个位置、只有表情不同 → 放行", () => {
  // 贴图是**紧裁**的：主体几乎顶到画布边（留白 <= 8px），否则四周就是
  // "看不见但点得到"的死区
  const dir = writeSet({
    "idle.png": png(240, 240, disc(120, 120, 115)),
    "happy.png": png(240, 240, (x, y) => (y >= 60 && y <= 70 && x >= 100 && x <= 140 ? 0 : disc(120, 120, 115)(x, y))),
    "sleepy.png": png(240, 240, disc(121, 119, 113)),
  });
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /全部合规/);
});

test("图上带字（一堆互不相连的小块）→ 拦下", () => {
  // 八根竖条当"字"：每根独立，加上身体就是九个连通块
  const text = (x, y) => {
    for (const bar of [30, 55, 80, 105, 130, 155, 180, 205]) {
      if (x >= bar && x < bar + 10 && y >= 2 && y < 24) return 255;
    }
    return disc(120, 140, 95)(x, y);
  };
  const dir = writeSet({
    "idle.png": png(240, 240, disc(120, 140, 95)),
    "caption.png": png(240, 240, text),
  });
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /连通块/);
});

test("飘在空处的半透明影子 → 拦下", () => {
  const dir = writeSet({
    "idle.png": png(240, 240, disc(120, 120, 110)),
    "glow.png": png(240, 240, halo(120, 120, 100, 8)),
  });
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /悬空半透明/);
});

test("换了角色（轮廓对不上）→ 拦下", () => {
  // 相似度按**包围盒归一化**之后算，所以"同一个形状放大一倍"是 100% ——
  // 大小归高度差那条管。这条测的是形状本身换了：圆盘 vs 十字
  const cross = (x, y) => {
    const vertical = x >= 100 && x < 140 && y >= 4 && y < 236;
    const horizontal = y >= 100 && y < 140 && x >= 4 && x < 236;
    return vertical || horizontal ? 255 : 0;
  };
  const dir = writeSet({
    "a.png": png(240, 240, disc(120, 120, 115)),
    "b.png": png(240, 240, disc(120, 120, 110)),
    "c.png": png(240, 240, cross),
  });
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /相似度|轮廓/);
});

test("留白太多 → 拦下", () => {
  // 240 的画布上只画中间一小块：四周都是"看不见但点得到"的死区
  const dir = writeSet({ "tiny.png": png(240, 240, disc(120, 120, 40)) });
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /留白/);
});

test("不是 PNG 的文件 → 报错但不崩", () => {
  const dir = mkdtempSync(join(tmpdir(), "region-art-"));
  writeFileSync(join(dir, "broken.png"), Buffer.from("not a png at all"));
  const { status, stdout } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 0, stdout); // 一张都量不出来 = 没有不合规的项，但不是崩溃
  assert.match(stdout, /not a PNG/);
});
