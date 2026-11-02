#!/usr/bin/env node
/**
 * 文档体检：相对链接与**锚点**是否指得到东西 + 文档归属 + 应用内清单 + 代码量。
 *
 * 这几件事都属于"过期了不会报错"的类型 —— 链接死了只影响读者，归属乱了只影响
 * 下一个人找东西，行数旧了只影响可信度。所以放进 CI。
 *
 * 锚点那条和「获取帮助」清单那条是后加的，因为原来的"471 条全部可达"是**假绿灯**：
 * 它只 `existsSync` 路径，把 `#fragment` 整段剥掉了。
 *
 * **数字不在这里了。** 曾经这里自己算组件 / 权限 / 命令 / 坑四项，`guards/bridge.mjs`
 * 又各算一遍、`guards/commands.mjs` 再算一遍 —— 三份正则里有一份先失配，那一处就
 * 打印 0 并退出 0，体检全绿而数字全错。现在只有 `scripts/stats.mjs` 一份实现，
 * 文档里每一处数字由 `npm run check:stats` 对账（含"这是历史数吗"）。
 *
 * 这里留下的行数是另一类：它们只回答"这是个多大的项目"，每次提交都会动，
 * 要求精确相等等于让每个 PR 都去改 README —— 所以按 1% 容差比。
 *
 *   node scripts/check-docs.mjs            体检
 *   node scripts/check-docs.mjs --verbose  连能自动数的那几项也逐条打印（长行也全列）
 *
 * 退出码：全过 0，有问题 1。长行**不影响退出码**（见 `checkLineLength`）。
 *
 * 所有按行切分的地方都用 `/\r?\n/`：`.gitattributes` 是 `text=auto`，Windows 工作区
 * 检出的是 CRLF，而 JS 正则里 `.` 不匹配 `\r`、无 `m` 的 `$` 只认字符串末尾 ——
 * 按换行符裸切会让标题正则**一条都匹配不上**（这个坑真踩过：修的时候锚点检查报的是"71 条全过"）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 锚点规则只有一份实现：应用内渲染标题 id 用的是 `src/runtime/markdown.ts` 的 `slugify`，
 * 体检必须用同一个 —— 两份实现各自漂，漂的永远是没人看的那一份。
 *
 * 这里是**动态** import 一个 `.ts`（Node 从 22.18 起才默认剥类型）。拿不到就立刻红并
 * 退出 1，不能退化成"跳过锚点这一项继续报绿"：一个什么都没查的绿灯，比没有这条检查
 * 更糟，因为它教所有人相信那条 `✓`（`PIT-115` 记的就是这个形状的事故）。
 */
const anchorRule = await import("../src/runtime/markdown.ts")
  .then((module) => module.slugify)
  .catch(() => null);

if (!anchorRule) {
  console.error("锚点检查跑不起来：import src/runtime/markdown.ts 失败。需要 Node 22.18+（剥类型）。");
  process.exit(1);
}
const slugify = anchorRule;

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
  const incompatible = [];
  let total = 0;

  for (const file of files) {
    const text = stripCode(fs.readFileSync(file, "utf8"));
    const targets = [];

    // 应用渲染器尚不支持尖括号目标；不能只剥掉它们验磁盘路径，再给应用内坏链接报绿。
    // 仍检查目标可达性，但兼容性错误独立阻断，外链、页内锚点与图片同样不能漏过。
    for (const match of text.matchAll(/\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)) {
      if (match[1] !== undefined) incompatible.push({ file: relative(file), target: match[1] });
      targets.push(match[1] ?? match[2]);
    }
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

  return { total, broken, incompatible };
}

/* ------------------------------------------------------------------ 锚点 */

// 链接**指向的文件**可达，不等于链接**指向的那一节**存在。以前这里把 `#` 整段剥掉，
// 于是 `AGENTS.md` 里 24 条 `INVARIANTS.md#inv-1` 全都算"可达"—— 而真实锚点是
// `inv-1-零内置`，一条都跳不到。断链只影响读者，所以必须机器查。
//
// 锚点规则的家在 `src/runtime/markdown.ts` 的 `slugify`（应用内渲染标题 id 用的就是它）。
// 这里 import 它，不另写一份 —— 两份实现各自漂，漂的那份恰好是没人看的那一份。
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * 逐行去掉围栏代码块。
 *
 * 不能用 `stripCode` —— 它还会把**行内代码**抹掉，而标题里到处是行内代码
 * （`## INV-4 权限按 \`widgetId\` 授予`）。抹掉之后算出来的锚点和渲染器算的不是一个，
 * 体检就会一片假红 —— 假红比不查更糟，因为它教人忽略这条检查。
 */
function withoutFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const open = line.match(/^\s*(```|~~~)/);
    if (fence) {
      if (open && open[1] === fence) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/** 一份 md 里所有能当锚点用的东西：标题（含重名时的 `-N` 后缀）、显式 `<a id>`。 */
function anchorsOf(file) {
  const lines = withoutFences(fs.readFileSync(file, "utf8"));
  const found = new Set();
  const used = new Map();
  for (const line of lines) {
    const match = line.match(HEADING);
    if (!match) continue;
    const base = slugify(match[2]) || `section-${match[1].length}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    found.add(seen === 0 ? base : `${base}-${seen}`);
  }
  const text = lines.join("\n");
  for (const match of text.matchAll(/<a\s+[^>]*id=["']([^"']+)["']/gi)) found.add(match[1]);
  for (const match of text.matchAll(/\{#([^\s}]+)\}/g)) found.add(match[1]);
  return found;
}

function checkAnchors(files) {
  const anchors = new Map(files.map((file) => [file, anchorsOf(file)]));
  const problems = [];
  let total = 0;

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let fence = null;
    let lineNo = 0;

    for (const raw0 of lines) {
      lineNo += 1;
      const open = raw0.match(/^\s*(```|~~~)/);
      if (fence) {
        if (open && open[1] === fence) fence = null;
        continue;
      }
      if (open) {
        fence = open[1];
        continue;
      }
      // 行内代码里的链接是写法示范，不是要跳的地址（和 checkLinks 同一个口径）
      const line = raw0.replace(/`[^`\n]*`/g, "");

      for (const match of line.matchAll(/\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)) {
        const raw = match[1] ?? match[2];
        if (/^(https?:|mailto:|data:)/.test(raw)) continue;
        const cut = raw.indexOf("#");
        if (cut < 0) continue;
        const fragment = raw.slice(cut + 1);
        if (!fragment) continue;
        const target = raw.slice(0, cut);

        let host = file;
        if (target) {
          const resolved = path.resolve(path.dirname(file), decodeURI(target.split("?")[0]));
          // 非 .md（图片、svg）的 fragment 由链接检查管，这里不猜
          if (!resolved.endsWith(".md") || !anchors.has(resolved)) continue;
          host = resolved;
        }
        total += 1;
        let wanted = fragment;
        try {
          wanted = decodeURI(fragment);
        } catch {
          // 写歪的转义按原样比，下面会报出来
        }
        if (!anchors.get(host).has(wanted)) {
          problems.push(`${relative(file)}:${lineNo} → ${raw}`);
        }
      }
    }
  }

  return { total, problems };
}

/* ------------------------------------------------------------------ 长行 */

/**
 * 一行写满一整段，是"查不动"的头号原因：grep 命中一行就吐出一段，Ctrl+F 落不到
 * 句子上，diff 一行改动整段红。这里**只报不断** —— 文风规矩只对新老文档执行
 * （docs/README.md 第六节），回头批量改旧文档的 diff 会淹掉真正的改动。
 */
const LONG_LINE = 200;

function checkLineLength(files) {
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let over = 0;
    let longest = 0;
    for (const line of lines) {
      if (line.length > LONG_LINE) over += 1;
      if (line.length > longest) longest = line.length;
    }
    if (over > 0) rows.push({ file: relative(file), over, lines: lines.length, longest });
  }
  rows.sort((a, b) => b.over - a.over);
  return rows;
}

/* ------------------------------------------------------------ 应用内清单 */

/**
 * 「设置 → 获取帮助」那份十来条的清单写在 `src/runtime/docs.ts` 里，靠 glob 打包。
 * 清单里的路径没了，界面上就是一片空白 —— 而 `check:docs` 只看磁盘，看不见界面。
 * 所以这里反过来查：清单点的每一份都要在磁盘上、且被 catalog 认领。
 */
function checkAppList(byPath, wildcards) {
  const source = path.join(ROOT, "src", "runtime", "docs.ts");
  if (!fs.existsSync(source)) return { count: 0, problems: ["src/runtime/docs.ts 不存在"] };
  const text = fs.readFileSync(source, "utf8");
  const paths = [...text.matchAll(/\bpath:\s*"([^"]+)"/g)].map((match) => match[1]);
  const problems = [];
  for (const rel of paths) {
    if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`应用内清单点了 ${rel}，磁盘上没有`);
    else if (!byPath.has(rel) && !wildcards.some((pattern) => globMatch(pattern, rel))) {
      problems.push(`应用内清单点了 ${rel}，catalog 里没认领它`);
    }
  }
  return { count: paths.length, problems };
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
      for (const match of line.matchAll(/\]\((?:<(\.{1,2}\/[^>\n]+)>|(\.{1,2}\/[^)\s]+))\)/g)) {
        const resolved = relative(path.resolve(path.join(ROOT, "docs"), (match[1] ?? match[2]).split("#")[0]));
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

  return { count: claimed.size, problems, byPath, wildcards };
}

/* ------------------------------------------------------------------ 输出 */

const files = walk(ROOT);
const { total, broken, incompatible } = checkLinks(files);
const anchors = checkAnchors(files);
const lineRows = checkLines();
const design = checkDesign();
const catalog = checkCatalog(files);
const appList = checkAppList(catalog.byPath ?? new Map(), catalog.wildcards ?? []);
const longLines = checkLineLength(files);

console.log(`文档体检：${files.length} 份 .md，${total} 条相对链接\n`);

if (broken.length === 0) {
  console.log(`  链接      ✓ ${total} 条全部可达`);
} else {
  console.log(`  链接      ✗ ${broken.length} 条不可达`);
  for (const item of broken) console.log(`            ${item.file} → ${item.target}`);
}

if (incompatible.length === 0) {
  console.log("  链接语法  ✓ 没有应用不支持的尖括号目标");
} else {
  console.log(`  链接语法  ✗ ${incompatible.length} 条尖括号目标，应用内无法正确跳转；请改用普通括号目标`);
  for (const item of incompatible) console.log(`            ${item.file} → ${item.target}`);
}

if (anchors.problems.length === 0) {
  console.log(`  锚点      ✓ ${anchors.total} 条带 # 的链接，落到的那一节都在`);
} else {
  console.log(`  锚点      ✗ ${anchors.problems.length} 条指不到标题（文件可达不等于那一节存在）`);
  for (const item of anchors.problems) console.log(`            ${item}`);
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

if (appList.problems.length === 0) {
  console.log(`  应用清单  ✓ ${appList.count} 份在「获取帮助」里，磁盘与 catalog 都对得上`);
} else {
  console.log(`  应用清单  ✗ ${appList.problems.length} 处`);
  for (const item of appList.problems) console.log(`            ${item}`);
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

console.log("\n  代码量（大致，1% 容差）");
lineRows.forEach(printRow);

const failed = lineRows.filter((row) => !row.ok);
if (VERBOSE) {
  console.log(`\n  能自动数的六项行数：${LINE_METRICS.map((m) => `${m.en} ${m.derive()}`).join(" / ")}`);
  console.log("  计数类（组件 / 权限 / 桥方法 / 命令 / 坑）不在这里：`npm run check:stats`");
}

if (longLines.length) {
  const rows = longLines.slice(0, VERBOSE ? longLines.length : 6);
  console.log(`\n  长行（>${LONG_LINE} 字，只报不断）：${longLines.length} 份，共 ${longLines.reduce((n, r) => n + r.over, 0)} 行`);
  for (const row of rows) {
    console.log(`            ${row.file}  ${row.over}/${row.lines} 行  ·  最长 ${row.longest} 字`);
  }
  if (!VERBOSE && longLines.length > rows.length) console.log(`            …… 其余 ${longLines.length - rows.length} 份：--verbose`);
  console.log("  改法：一行一句（Markdown 里单个换行不改变渲染）。新写和重写的文档按这个来，别回头批量改旧的。");
}

const blocking = broken.length + incompatible.length + anchors.problems.length + failed.length + design.problems.length + catalog.problems.length + appList.problems.length;
if (blocking) {
  console.log(
    `\n${blocking} 处要修。（链接 ${broken.length} · 链接语法 ${incompatible.length} · 锚点 ${anchors.problems.length} · 归属 ${catalog.problems.length} · 设计文档 ${design.problems.length} · 应用清单 ${appList.problems.length} · 行数 ${failed.length}）`,
  );
  process.exit(1);
}
console.log("\n全部通过。");
