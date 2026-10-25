#!/usr/bin/env node
/**
 * 三张表的守门人：字号 / 圆角 / 间距。
 *
 * 规矩写在 src/styles.css 头部，但注释拦不住人 —— 收敛完的当天下午，同一个
 * 文件里就又长出了 `font-size: 10.5px` 和 `border-radius: 18px`。所以要有一条
 * 命令盯着，而不是靠记性。
 *
 *   npm run check:tokens            检查 src/**\/*.css，有违规就退出码 1
 *   npm run check:tokens -- --list  顺带把三张表当前的档位打出来
 *
 * 只读，不改。真要写规矩外的值，在那一行末尾写 `/* token-ok 理由 *\/` ——
 * 理由至少两个字，否则报"豁免没写理由"。豁免要写理由，是因为下一个人（或者
 * 三个月后的你）看到那个值只会觉得是漏网，不会知道它是在对齐什么东西。
 *
 * 为什么是这三张表：
 *   - 字号有半像素（10.5 / 11.5 / 12.5）时，100% 缩放下取整不一致，中文发虚。
 *   - 圆角每多一档，嵌套时"内圆角 = 外圆角 − padding"就没法算，看起来脏。
 *   - 奇数间距在 2x 屏上落在半个物理像素，两行之间差半格，说不上哪里歪。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 五档。11 用于 id / chip，12 正文，13 标题，15 面板标题，20 空状态。 */
export const FONT_SIZES = new Set(["11px", "12px", "13px", "15px", "20px"]);

/**
 * 六档。0 是"不要圆角"，2px 是微型块（热力图格子、气泡尾巴），
 * 12px 必须留着 —— Rust 那边 desktop::CORNER_RADIUS 就是 12，画布卡片得跟桌面一致。
 */
export const RADII = new Set(["0", "0px", "2px", "6px", "10px", "12px", "14px", "999px", "50%"]);

const SPACING_PROP =
  /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;

const FONT_SHORTHAND = /^font$/;

/** 行尾豁免：`/* token-ok 16px 图标在 30px 格子里居中 *\/` */
const EXEMPT = /\/\*\s*token-ok\s*(.*?)\s*\*\//;

/**
 * 把块注释换成空格，行号不变。行内注释（含豁免标记）也要清掉，
 * 否则 `padding: 2px; /* 说明 *\/` 里的说明会被当成值的一部分。
 */
export function stripComments(lines) {
  let inBlock = false;
  return lines.map((line) => {
    let out = "";
    let index = 0;
    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", index);
        if (end === -1) {
          index = line.length;
          break;
        }
        index = end + 2;
        inBlock = false;
        out += " ";
      } else {
        const start = line.indexOf("/*", index);
        if (start === -1) {
          out += line.slice(index);
          break;
        }
        out += line.slice(index, start);
        inBlock = true;
        index = start + 2;
      }
    }
    return out;
  });
}

const tokensOf = (value) => value.trim().split(/\s+/).filter(Boolean);

/** `calc(...)` / `var(...)` / 百分比 / em 一律放过：这些是算出来的，不是手写的档位。 */
const isLiteralPx = (token) => /^-?[0-9.]+px$/.test(token);

function radiusProblem(token) {
  if (RADII.has(token)) return null;
  if (/^var\(|^calc\(|^inherit$/.test(token)) return null;
  return `圆角只有 ${[...RADII].join(" / ")}，这一档没有对应物`;
}

function spacingProblem(token) {
  if (token === "0") return null;
  if (!isLiteralPx(token)) return null; // auto / var() / % / calc() 交给浏览器
  const number = Number.parseFloat(token);
  if (number < 0) return null; // 负边距是刻意的重叠，不是排版节奏
  if (Number.isInteger(number) && number % 2 === 0) return null;
  return "间距落在 2px 网格上（奇数在 2x 屏会落到半个物理像素）";
}

function fontSizeProblem(token) {
  if (FONT_SIZES.has(token)) return null;
  if (/^(inherit|initial|unset|0)$/.test(token)) return null;
  if (!isLiteralPx(token)) return null;
  return `字号只有 ${[...FONT_SIZES].join(" / ")}`;
}

/** `font: 11.5px/1.45 ui-sans-serif, …` —— 半像素最爱藏在这里 */
function shorthandProblem(value) {
  const match = /^([0-9.]+px)\s*(?:\/\s*[^ ]+)?\s+/.exec(value.trim());
  if (!match) return null;
  return fontSizeProblem(match[1]);
}

/**
 * @param {string} source CSS 全文
 * @returns {{ line: number, prop: string, value: string, reason: string }[]}
 */
export function inspect(source) {
  const rawLines = source.split("\n");
  const codeLines = stripComments(rawLines);
  const problems = [];

  codeLines.forEach((code, index) => {
    const line = code.trim();
    if (!line) return;
    // 一行一条声明。压缩成一行的 CSS 会漏检，但那种写法本身就该被拒。
    const match = /^([-a-z]+)\s*:\s*(.+?);?$/.exec(line);
    if (!match) return;
    const [, prop, rawValue] = match;
    const value = rawValue.trim();

    const exempt = EXEMPT.exec(rawLines[index]);
    if (exempt) {
      if (exempt[1].trim().length < 2) {
        problems.push({ line: index + 1, prop, value, reason: "token-ok 后面要写理由" });
      }
      return;
    }

    const push = (reason) => problems.push({ line: index + 1, prop, value, reason });

    if (prop === "font-size") {
      const reason = fontSizeProblem(value);
      if (reason) push(reason);
      return;
    }

    if (FONT_SHORTHAND.test(prop)) {
      const reason = shorthandProblem(value);
      if (reason) push(`${reason}（藏在 font 简写里）`);
      return;
    }

    if (prop === "border-radius") {
      for (const token of tokensOf(value)) {
        const reason = radiusProblem(token);
        if (reason) {
          push(reason);
          return;
        }
      }
      return;
    }

    if (SPACING_PROP.test(prop)) {
      for (const token of tokensOf(value)) {
        const reason = spacingProblem(token);
        if (reason) {
          push(reason);
          return;
        }
      }
    }
  });

  return problems;
}

/** `src/**` 下的所有 .css。组件目录不在范围内 —— 那是作者的创作空间。 */
export function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...collectFiles(path));
    } else if (entry.name.endsWith(".css")) {
      found.push(path);
    }
  }
  return found.sort();
}

function listTables(sources) {
  const fonts = new Set();
  const radii = new Set();
  const spaces = new Set();
  for (const source of sources) {
    for (const line of stripComments(source.split("\n"))) {
      const match = /^\s*([-a-z]+)\s*:\s*(.+?);?\s*$/.exec(line);
      if (!match) continue;
      const [, prop, rawValue] = match;
      for (const token of tokensOf(rawValue)) {
        if (prop === "font-size" && isLiteralPx(token)) fonts.add(Number.parseFloat(token));
        if (prop === "border-radius" && RADII.has(token)) radii.add(token);
        if (SPACING_PROP.test(prop) && isLiteralPx(token)) {
          const number = Number.parseFloat(token);
          if (number >= 0) spaces.add(number);
        }
      }
    }
  }
  const byNumber = (a, b) => a - b;
  return [
    `字号  ${[...fonts].sort(byNumber).join(" / ")}`,
    `圆角  ${[...radii].join(" / ")}`,
    `间距  ${[...spaces].sort(byNumber).join(" / ")}`,
  ];
}

function main() {
  const root = resolve(process.argv[1], "../..");
  const files = collectFiles(join(root, "src"));
  const sources = files.map((file) => readFileSync(file, "utf8"));

  let total = 0;
  files.forEach((file, index) => {
    const problems = inspect(sources[index]);
    if (problems.length === 0) return;
    total += problems.length;
    const shown = relative(root, file).replace(/\\/g, "/");
    for (const problem of problems) {
      console.error(`${shown}:${problem.line}  ${problem.prop}: ${problem.value}`);
      console.error(`    ${problem.reason}`);
    }
  });

  if (total > 0) {
    console.error(`\n${total} 处越界。规矩见 src/styles.css 头部；确有理由的写 /* token-ok 理由 */。`);
    process.exit(1);
  }

  const lines = listTables(sources);
  console.log(`三张表干净（${files.length} 个样式文件）。`);
  if (process.argv.includes("--list")) for (const line of lines) console.log("  " + line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
