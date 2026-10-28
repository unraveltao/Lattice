#!/usr/bin/env node
/**
 * 文档体检：相对链接是否可达 + README 的数字和代码对不对得上。
 *
 * 两件事都属于"过期了不会报错"的类型 —— 链接死了只影响读者，数字旧了只影响可信度，
 * 而两者都是靠人手维护必然漂移的东西。所以放进 CI。
 *
 * 数的东西分两类，因为它们的"正确"标准不一样：
 *
 * - **计数类**（组件、权限、命令、坑）：离散的，必须精确相等。
 * - **行数类**（TS / CSS / Rust / SDK / 组件 / 脚本）：只回答"这是个多大的项目"，
 *   每次提交都会动。要求精确相等等于让每个 PR 都去改 README，而一张没人愿意
 *   维护的表最后会被删掉 —— 所以按 1% 容差比，只在"明显旧了"的时候才红。
 *
 *   node scripts/check-docs.mjs            体检
 *   node scripts/check-docs.mjs --verbose  连能自动数的那几项也逐条打印
 *
 * 退出码：全过 0，有问题 1。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".scratch",
  "target",
  "dist",
  "dist-prev",
  ".workbuddy-ai",
  "widget-backups",
]);
const VERBOSE = process.argv.includes("--verbose");

/* ------------------------------------------------------------------ 文件 */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/* ------------------------------------------------------------------ 链接 */

function stripCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

function checkLinks(files) {
  const broken = [];
  let total = 0;

  for (const file of files) {
    const text = stripCode(fs.readFileSync(file, "utf8"));
    const targets = [];

    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(match[1]);
    for (const match of text.matchAll(/\bsrc="([^"]+)"/g)) targets.push(match[1]);

    for (const raw of targets) {
      if (/^(https?:|mailto:|#|data:)/.test(raw)) continue;
      const clean = decodeURI(raw.split("#")[0].split("?")[0]);
      if (!clean) continue;
      total += 1;
      const target = path.resolve(path.dirname(file), clean);
      if (!fs.existsSync(target)) broken.push({ file: relative(file), target: raw });
    }
  }

  return { total, broken };
}

/* ------------------------------------------------------------------ 数字 */

function firstNumbers(text) {
  const found = text.match(/\d[\d\s]*/g) ?? [];
  return found.map((chunk) => Number(chunk.replace(/\s/g, ""))).filter(Number.isFinite);
}

function tableRow(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\|\\s*\\*{0,2}${escaped}\\*{0,2}\\s*\\|([^|]*)\\|`));
  return match ? match[1] : null;
}

function countTrackedWidgets() {
  try {
    const out = execFileSync("git", ["ls-files", "public/widgets/*/manifest.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean).length;
  } catch {
    const dir = path.join(ROOT, "public", "widgets");
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "manifest.json")))
      .length;
  }
}

function countPermissions() {
  const source = fs.readFileSync(path.join(ROOT, "src", "runtime", "catalogue.ts"), "utf8");
  const block = source.match(/KNOWN_PERMISSIONS[\s\S]*?\]\);/);
  if (!block) throw new Error("src/runtime/catalogue.ts 里找不到 KNOWN_PERMISSIONS");
  return (block[0].match(/"[a-z:]+"/g) ?? []).length;
}

function countCommands() {
  const dir = path.join(ROOT, "src-tauri", "src");
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".rs")) continue;
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    total += (source.match(/#\[tauri::command\]/g) ?? []).length;
  }
  return total;
}

/** 坑的条数不用人数：数 PITFALLS.md 里的表行，顺带和它自己开头那句对账。 */
function countPitfalls() {
  const source = fs.readFileSync(path.join(ROOT, "docs", "PITFALLS.md"), "utf8");
  const rows = source
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-{3,}/.test(line) && !line.startsWith("| 症状"));
  const claimed = source.match(/现在 \*\*(\d+) 条\*\*/);
  if (!claimed) throw new Error("docs/PITFALLS.md 里找不到「现在 **N 条**」这句");
  if (Number(claimed[1]) !== rows.length) {
    throw new Error(`docs/PITFALLS.md 开头写 ${claimed[1]} 条，表里实际 ${rows.length} 行`);
  }
  return rows.length;
}

/* ---------------------------------------------------------------- 行数 */

/** 行数只按"大致规模"这个精度才有意义，所以留 1% 的余量。 */
const LINE_TOLERANCE = 0.01;

const lineCount = (text) => text.split("\n").length - 1;

function countLines(relativeDir, exts) {
  let total = 0;
  const stack = [path.join(ROOT, relativeDir)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (exts.includes(path.extname(entry.name))) {
        total += lineCount(fs.readFileSync(full, "utf8"));
      }
    }
  }
  return total;
}

/** 组件与示例只数仓库里有的：桌宠还在工作区里没提交，算进来就是一个随时会变的数。 */
function countTrackedLines(globs, exts) {
  const out = execFileSync("git", ["ls-files", ...globs], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((file) => exts.includes(path.extname(file)))
    .reduce((total, file) => total + lineCount(fs.readFileSync(path.join(ROOT, file), "utf8")), 0);
}

const METRICS = [
  { key: "widgets", en: "Official widgets", zh: "官方组件", derive: countTrackedWidgets },
  { key: "permissions", en: "Permissions", zh: "权限", derive: countPermissions },
  { key: "commands", en: "Tauri commands", zh: "Tauri 命令", derive: countCommands },
  { key: "assertions", en: "Browser assertions", zh: "浏览器断言", derive: null },
  { key: "rustTests", en: "Rust tests", zh: "Rust 单测", derive: null },
  { key: "pitfalls", en: "Documented pitfalls", zh: "记下来的坑", derive: countPitfalls },
];

/** 「代码量，大致」那张表。标签在中英两份里不一样，所以三条标签分开写。 */
const LINE_METRICS = [
  { key: "typescript", en: "TypeScript", zh: "TypeScript", derive: () => countLines("src", [".ts", ".tsx"]) },
  { key: "css", en: "CSS", zh: "CSS", derive: () => countLines("src", [".css"]) },
  { key: "rust", en: "Rust", zh: "Rust", derive: () => countLines("src-tauri/src", [".rs"]) },
  { key: "sdk", en: "SDK", zh: "SDK", derive: () => countLines("packages/sdk", [".js", ".ts"]) },
  {
    key: "widgetsAndExample",
    en: "Widgets + example",
    zh: "官方组件 + 示例",
    derive: () => countTrackedLines(["public/widgets", "examples"], [".html", ".css", ".js", ".json", ".md"]),
  },
  { key: "scripts", en: "Scripts", zh: "脚本", derive: () => countLines("scripts", [".mjs", ".js"]) },
];

function checkNumbers() {
  const en = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const zh = fs.readFileSync(path.join(ROOT, "README.zh-CN.md"), "utf8");
  const rows = [];

  for (const metric of METRICS) {
    const enCell = tableRow(en, metric.en);
    const zhCell = tableRow(zh, metric.zh);
    const row = { ...metric, label: metric.en, en: null, zh: null, actual: null, ok: true, note: "" };

    if (!enCell || !zhCell) {
      row.ok = false;
      row.note = !enCell ? `README.md 里找不到「${metric.en}」` : `README.zh-CN.md 里找不到「${metric.zh}」`;
      rows.push(row);
      continue;
    }

    const enNums = firstNumbers(enCell);
    const zhNums = firstNumbers(zhCell);
    row.en = enNums;
    row.zh = zhNums;

    const samePair =
      enNums.length === zhNums.length && [...enNums].sort((a, b) => a - b).join() === [...zhNums].sort((a, b) => a - b).join();
    if (!samePair) {
      row.ok = false;
      row.note = "中英文两份对不上";
    }

    if (metric.derive) {
      let actual = null;
      try {
        actual = metric.derive();
      } catch (error) {
        // 派生失败本身就是一处要修的文档问题（比如 PITFALLS 开头那句和表对不上），
        // 不该让整个脚本带着堆栈崩掉 —— 那样人只会看到「脚本坏了」。
        row.ok = false;
        row.note = error.message;
        rows.push(row);
        continue;
      }
      row.actual = actual;
      if (!enNums.includes(actual)) {
        row.ok = false;
        row.note = `README 写的是 ${enNums.join(" / ")}`;
      }
    }

    rows.push(row);
  }

  return rows;
}

function checkLines() {
  const en = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const zh = fs.readFileSync(path.join(ROOT, "README.zh-CN.md"), "utf8");
  const rows = [];

  for (const metric of LINE_METRICS) {
    const enCell = tableRow(en, metric.en);
    const zhCell = tableRow(zh, metric.zh);
    const row = { label: metric.en, en: null, zh: null, actual: null, ok: true, note: "" };

    if (!enCell || !zhCell) {
      row.ok = false;
      row.note = !enCell ? `README.md 里找不到「${metric.en}」` : `README.zh-CN.md 里找不到「${metric.zh}」`;
      rows.push(row);
      continue;
    }

    row.en = firstNumbers(enCell);
    row.zh = firstNumbers(zhCell);

    const samePair =
      row.en.length === row.zh.length && [...row.en].sort((a, b) => a - b).join() === [...row.zh].sort((a, b) => a - b).join();
    if (!samePair) {
      row.ok = false;
      row.note = "中英文两份对不上";
    }

    try {
      row.actual = metric.derive();
    } catch (error) {
      row.ok = false;
      row.note = error.message;
      rows.push(row);
      continue;
    }

    // 1% 容差：表里写的是"上一次量的时候有多大"，不是"现在必须正好是这么多"。
    const slack = Math.round(row.actual * LINE_TOLERANCE);
    if (!row.en.some((n) => Math.abs(n - row.actual) <= slack)) {
      row.ok = false;
      row.note = `README 写的是 ${row.en.join(" / ")}，差了 ${Math.abs(row.en[0] - row.actual)} 行（容差 ${slack}）`;
    }

    rows.push(row);
  }

  return rows;
}

/* ------------------------------------------------------------ 设计文档 */

// 两份 0010 同时存在过（多源目录 / 终端），而编号是设计文档唯一的身份 ——
// 引用里写"见 0010"的时候没有别的线索能消歧。这两条检查就是为了让那种事
// 在提交那一刻红，而不是等到有人翻不到。
const DESIGN_STATUS = ["draft", "accepted", "superseded"];

// 前缀抽成常量，**别在两处各写一遍**。文件名过滤和取号是同一个身份的两种用法，
// 分开写的话改前缀只会改到一处，另一处把 `LAT-0001` 取成 `LAT-` —— 于是"编号
// 不重"这条检查静默失效：`files` 非空、编号全一样、报一堆撞号，或者更糟，
// 过滤正则没改、`files` 空掉、打印 `✓ 0 份` 而 CI 全绿。这两种都比报错难查。
const DESIGN_PREFIX = "LAT-";
const DESIGN_FILE = new RegExp(`^${DESIGN_PREFIX}\\d{4}-.*\\.md$`);
const DESIGN_NUMBER = new RegExp(`^${DESIGN_PREFIX}(\\d{4})-`);

function checkDesign() {
  const dir = path.join(ROOT, "docs", "design");
  if (!fs.existsSync(dir)) return { count: 0, problems: [`没有 ${path.relative(ROOT, dir)} 这个目录`] };

  const problems = [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => DESIGN_FILE.test(name))
    .sort();

  // 一份都没匹配上 = 文件名形状和正则对不上。不报的话这里打印的是
  // `✓ 0 份，编号不重、status 都在词表里` —— 一个什么都没查的绿灯。
  if (files.length === 0) {
    problems.push(`一份 ${DESIGN_PREFIX}NNNN-*.md 都没找到 —— 文件名形状和正则对不上？`);
  }

  const byNumber = new Map();
  for (const name of files) {
    const number = name.match(DESIGN_NUMBER)[1];
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  for (const [number, list] of byNumber) {
    if (list.length > 1) problems.push(`编号 ${number} 撞了 ${list.length} 次：${list.join(" / ")}`);
  }

  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const head = text.split("\n---")[0]; // 状态头 = 第一个 --- 之前那一段
    const match = head.match(/^status:[ \t]*(\S+)[ \t]*$/m);
    if (!match) {
      problems.push(`${name} 没有 status 头`);
    } else if (!DESIGN_STATUS.includes(match[1])) {
      problems.push(`${name} 的 status 是 ${match[1]}，只认 ${DESIGN_STATUS.join(" / ")}`);
    }
  }

  return { count: files.length, problems };
}

/* ------------------------------------------------------------ 文档归属 */

// 每份 md 有且只有一个坐标。`docs/README.md` 第一节那张表是**人读**的归属，
// 这里是**机器读**的那一份。两者重叠的那一维（时态）由下面第 4 步强制相等 ——
// 所以它们漂不了，而这正是这个仓库最怕的那种腐烂（两处各写一遍）。
//
// 表里**不写 owner**：README 那一列的原文是句子（"想改一个看着奇怪的设计之前"），
// 抄进 JSON 就是同一句话的第二份，而且没有任何检查能拿它判对错。也不写第二根
// 分类轴（现行 / 归档）—— README 第 9 行立的是"一份文档只有一个坐标"。
const CATALOG_LAYERS = ["past", "now", "future", "by-design-status"];

// 不进归属表的四份。写在这里而不是 catalog.json 里：**"为什么不算文档"是规则，
// 不是数据**，而规则该和检查待在一起，改它的人一定在看这个文件。
const CATALOG_EXEMPT = new Map([
  ["README.md", "项目入口，跟着版本走，不是文档体系的一部分（docs/README.md 第 27 行）"],
  ["README.zh-CN.md", "同上 —— 和英文那份是同一份东西"],
  ["CONTRIBUTING.md", "只写从 clone 到 push 的顺序和什么会被拒，不构成事实的家（第 43 行）"],
  ["CREDITS.md", "致谢跟着版本走，没有时态"],
]);

/** 只支持一个 `*`，够用了 —— 引一个 glob 依赖来干这件事不值得 */
function globMatch(pattern, file) {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === file;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return false;
  return !file.slice(prefix.length, file.length - suffix.length).includes("/");
}

function checkCatalog(files) {
  const problems = [];
  const catalogPath = path.join(ROOT, "docs", "catalog.json");
  if (!fs.existsSync(catalogPath)) return { count: 0, problems: ["docs/catalog.json 不存在"] };

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) {
    return { count: 0, problems: [`docs/catalog.json 不是合法 JSON：${error.message}`] };
  }
  if (catalog.schema !== 1) problems.push(`catalog 的 schema 是 ${catalog.schema}，只认 1`);
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];

  // 1. 条目自身：路径唯一、layers 在词表里、by-design-status 只许挂在通配上
  const byPath = new Map();
  for (const entry of entries) {
    const rel = entry?.path;
    if (typeof rel !== "string" || rel === "") {
      problems.push(`catalog 里有一条没有 path：${JSON.stringify(entry)}`);
      continue;
    }
    if (byPath.has(rel)) problems.push(`catalog 里 ${rel} 出现了两次`);
    byPath.set(rel, entry);
    const layers = entry.layers;
    if (!Array.isArray(layers) || layers.length === 0) {
      problems.push(`${rel} 没有 layers`);
      continue;
    }
    for (const layer of layers) {
      if (!CATALOG_LAYERS.includes(layer)) {
        problems.push(`${rel} 的 layers 里有 ${layer}，只认 ${CATALOG_LAYERS.join(" / ")}`);
      }
    }
    if (layers.includes("by-design-status") && !rel.includes("*")) {
      problems.push(`${rel} 是具体路径，不能用 by-design-status（那是给通配的）`);
    }
  }

  const wildcards = [...byPath.keys()].filter((rel) => rel.includes("*"));

  // 2. 具体路径必须真的存在（通配由第 3 步的认领反过来保证非空）
  for (const rel of byPath.keys()) {
    if (rel.includes("*")) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`catalog 里的 ${rel} 不存在`);
  }

  // 3. 每份 md 恰好被一条认领。**具体路径优先，通配只负责剩下的** ——
  //    所以 `docs/design/README.md`（索引）能和 `LAT-*.md`（正文）并存。
  const claimed = new Map();
  const claim = (rel, by) => {
    if (claimed.has(rel)) problems.push(`${rel} 被 ${claimed.get(rel)} 和 ${by} 同时认领`);
    else claimed.set(rel, by);
  };
  for (const file of files) {
    const rel = relative(file);
    if (CATALOG_EXEMPT.has(rel)) continue;
    if (byPath.has(rel)) {
      claim(rel, rel);
      continue;
    }
    const hit = wildcards.find((pattern) => globMatch(pattern, rel));
    if (hit) claim(rel, hit);
    else problems.push(`${rel} 没有归属 —— 在 docs/catalog.json 里给它一条，或者写进 CATALOG_EXEMPT`);
  }

  // 4. 和 docs/README.md 第一节那张表对账。只认「一、」到「二、」之间的 `|` 行，
  //    不猜别处的散文 —— 那张表是这张地图的主体，保持表格形态是它的职责。
  const mapPath = path.join(ROOT, "docs", "README.md");
  if (fs.existsSync(mapPath)) {
    const text = fs.readFileSync(mapPath, "utf8");
    const start = text.indexOf("## 一、");
    const end = text.indexOf("## 二、");
    const section = start >= 0 && end > start ? text.slice(start, end) : "";
    if (section === "") {
      problems.push("docs/README.md 里找不到「一、」到「二、」那一节 —— 归属表的形状变了");
    }
    const LAYER_WORDS = { 过去: "past", 现在: "now", 未来: "future" };
    for (const line of section.split("\n")) {
      if (!line.trimStart().startsWith("|")) continue;
      const cells = line.split("|").map((cell) => cell.trim());
      const word = Object.keys(LAYER_WORDS).find((candidate) => cells[1]?.includes(candidate));
      if (!word) continue; // 表头与分隔行
      const layer = LAYER_WORDS[word];
      for (const match of line.matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
        const resolved = relative(path.resolve(path.join(ROOT, "docs"), match[1].split("#")[0]));
        if (!resolved.endsWith(".md")) {
          // 目录链接（`./design/`）：要求 catalog 里有一条通配把它整个收下
          if (!wildcards.some((pattern) => pattern.startsWith(`${resolved}/`))) {
            problems.push(`README 第一节把 ${resolved}/ 归在「${word}」，但 catalog 里没有认领它的通配条目`);
          }
          continue;
        }
        const entry = byPath.get(resolved);
        if (!entry) {
          problems.push(`README 第一节提到了 ${resolved}，catalog 里没有这一条`);
        } else if (!entry.layers.includes(layer)) {
          problems.push(
            `${resolved} 在 README 第一节是「${word}」，catalog 写的是 ${entry.layers.join(" / ")}`,
          );
        }
      }
    }
  }

  return { count: claimed.size, problems };
}

/* ------------------------------------------------------------------ 输出 */

const files = walk(ROOT);
const { total, broken } = checkLinks(files);
const rows = checkNumbers();
const lineRows = checkLines();
const design = checkDesign();
const catalog = checkCatalog(files);

console.log(`文档体检：${files.length} 份 .md，${total} 条相对链接\n`);

if (broken.length === 0) {
  console.log(`  链接      ✓ ${total} 条全部可达`);
} else {
  console.log(`  链接      ✗ ${broken.length} 条不可达`);
  for (const item of broken) console.log(`            ${item.file} → ${item.target}`);
}

if (design.problems.length === 0) {
  console.log(`  设计文档  ✓ ${design.count} 份，编号不重、status 都在词表里`);
} else {
  console.log(`  设计文档  ✗ ${design.problems.length} 处`);
  for (const item of design.problems) console.log(`            ${item}`);
}

if (catalog.problems.length === 0) {
  console.log(`  文档归属  ✓ ${catalog.count} 份，各有一个坐标（37 份 design 按 status 分）`);
} else {
  console.log(`  文档归属  ✗ ${catalog.problems.length} 处`);
  for (const item of catalog.problems) console.log(`            ${item}`);
}

const pad = (text, width) => String(text).padEnd(width);
const cell = (numbers) => (numbers === null ? "—" : numbers.join(" / "));

function printRow(row) {
  const mark = row.ok ? "✓" : "✗";
  const label = row.label.length > 20 ? row.label : pad(row.label, 20);
  console.log(
    `  ${mark} ${label} README ${cell(row.en)}  ·  zh ${cell(row.zh)}  ·  实测 ${
      row.actual === null ? "手数" : row.actual
    }${row.note ? `   ${row.note}` : ""}`,
  );
}

console.log("");
rows.forEach(printRow);

console.log("\n  代码量（大致，1% 容差）");
lineRows.forEach(printRow);

const failed = [...rows, ...lineRows].filter((row) => !row.ok);
if (VERBOSE) {
  console.log(`\n  能自动数的四项：组件 ${countTrackedWidgets()} / 权限 ${countPermissions()} / 命令 ${countCommands()} / 坑 ${countPitfalls()}`);
  console.log(`  能自动数的六项行数：${LINE_METRICS.map((m) => `${m.en} ${m.derive()}`).join(" / ")}`);
}

if (broken.length || failed.length || design.problems.length || catalog.problems.length) {
  console.log(
    `\n${broken.length + failed.length + design.problems.length + catalog.problems.length} 处要修。`,
  );
  process.exit(1);
}
console.log("\n全部通过。");
