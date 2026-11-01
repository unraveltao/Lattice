#!/usr/bin/env node
/**
 * 文档检索：把"我记得有这份文档，但想不起在哪"变成一条命令。
 *
 *   node scripts/docs-query.mjs 权限                        全库找
 *   node scripts/docs-query.mjs 权限 --where pit            只在 PITFALLS 的坑里找
 *   node scripts/docs-query.mjs emit_to --layer now         只看「现在」那一层
 *   node scripts/docs-query.mjs 冻住 --limit 5 --context    多给一点原文
 *   node scripts/docs-query.mjs PIT-027                     按编号直接定位那条坑
 *
 * # 为什么不建索引文件
 *
 * 扫的是 git 跟踪的那 72 份 md，一次约 0.1 秒。落成 `index.json` 就要回答
 * "什么时候重建"，而"忘了重建的索引"比没有索引更糟 —— 它会用上周的文档地图
 * 回答今天的问题，还不报错。所以这里**每次现算**，不留缓存。
 *
 * # 为什么只扫 git 跟踪的文件
 *
 * 全库 `grep` 的命中里有一半来自 `.scratch/` 和 `.workbuddy-ai/` 那些旧快照 ——
 * 它们和 `docs/` 说同一件事，但说的是三个月前的那一版。`git ls-files` 天然把它们
 * 排除在外，不需要维护第二份排除清单（`check-docs.mjs` 用的是硬编码目录名，
 * 那份是给它自己看的，这里不复用：这里的判据是"有没有提交过"）。
 *
 * 退出码：找到 0，没找到 2（和 `grep` 一致，方便写进脚本里判断）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flags = new Map();
const terms = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--where" || args[i] === "--layer" || args[i] === "--limit") {
    flags.set(args[i], args[i + 1]);
    i += 1;
  } else if (args[i].startsWith("--")) flags.set(args[i], true);
  else terms.push(args[i]);
}

if (terms.length === 0 || flags.get("--help")) {
  console.log(`用法：npm run docs:query -- <关键词> [--where pit|gaps|design|spec] [--layer past|now|future] [--limit N] [--context]`);
  console.log(`      关键词给中文就行（按子串匹配）；PIT-027 这类编号可以直接查。`);
  process.exit(terms.length === 0 ? 2 : 0);
}

const LIMIT = Number(flags.get("--limit") ?? 12);
const WHERE = flags.get("--where");
const LAYER = flags.get("--layer");

/* ---------------------------------------------------------------- 文件集 */

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "catalog.json"), "utf8"));

/** catalog 里那条通配 `docs/design/LAT-*.md` 只支持一个 `*`，和 check-docs 同一个口径 */
function layerOf(rel) {
  for (const entry of catalog.entries) {
    const pattern = entry.path;
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern === rel) return entry.layers.filter((l) => l !== "by-design-status");
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (rel.startsWith(prefix) && rel.endsWith(suffix) && !rel.slice(prefix.length, rel.length - suffix.length).includes("/")) {
      // 设计文档的时态由它自己的 status 头说了算，不是 catalog 里那个词
      return entry.layers.includes("by-design-status") ? null : entry.layers;
    }
  }
  return [];
}

function designStatus(text) {
  const match = text.split("\n---")[0]?.match(/^status:[ \t]*(\S+)/m);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ 解析 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const SEPARATOR = /^\|\s*-{3,}/;
const HEADER = (next) => next !== undefined && SEPARATOR.test(next);
const PIT_ID = /^PIT-(\d{3})$/;

/**
 * 一份 md 拆成可命中的单元。
 *
 * 表格行是**单独一个单元**，不是它所属段落的一部分 —— 因为 `PITFALLS` /
 * `known-gaps` 的全部内容都在表里，按段落算会把 131 条坑当成 13 段。
 */
function unitsOf(rel, text) {
  const lines = text.split(/\r?\n/);
  const units = [];
  const section = [];
  let fence = null;

  lines.forEach((line, index) => {
    const open = line.match(/^\s*(```|~~~)/);
    if (fence) {
      if (open && open[1] === fence) fence = null;
      return;
    }
    if (open) {
      fence = open[1];
      return;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      while (section.length && section[section.length - 1].level >= level) section.pop();
      section.push({ level, text: heading[2].replace(/`/g, "") });
      units.push({ kind: "heading", line: index + 1, text: heading[2], path: section.map((s) => s.text) });
      return;
    }

    if (line.startsWith("|") && !SEPARATOR.test(line) && !HEADER(lines[index + 1])) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));
      const id = PIT_ID.test(cells[0]) ? cells[0] : null;
      units.push({
        kind: id ? "pit" : "row",
        line: index + 1,
        id,
        cells,
        // 首列是症状/缺口，后面才是原因与解法 —— 命中的位置要分得开
        text: cells.join(" "),
        path: section.map((s) => s.text),
      });
      return;
    }

    if (line.trim().length > 12 && !line.startsWith("|")) {
      units.push({ kind: "line", line: index + 1, text: line.trim(), path: section.map((s) => s.text) });
    }
  });

  return units;
}

/* ------------------------------------------------------------------ 打分 */

const lowered = terms.map((term) => term.toLowerCase());
const ID_QUERY = /^PIT-\d{3}$/i.test(terms[0] ?? "") ? terms[0].toUpperCase() : null;

/** 命中的是第几列，权重不一样：症状列是读者真正会搜的东西。 */
function score(unit) {
  if (ID_QUERY) return unit.id === ID_QUERY ? 100 : -1;
  const haystacks =
    unit.kind === "heading"
      ? [[unit.text, 3]]
      : unit.kind === "pit"
        ? [[unit.cells[1], 2.5], [unit.cells.slice(2).join(" "), 1.2]]
        : [[unit.text, unit.kind === "row" ? 1.8 : 1]];

  let score = 0;
  let hits = 0;
  for (const [hay, weight] of haystacks) {
    const text = hay.toLowerCase();
    for (const term of lowered) {
      let at = text.indexOf(term);
      let n = 0;
      while (at >= 0) {
        n += 1;
        at = text.indexOf(term, at + term.length);
      }
      if (n > 0) hits += 1;
      score += n * weight;
    }
  }
  // 查的是"这个词在哪"，所以只命中一次的小节和命中五次的小节不是一回事，
  // 但命中**几个词**比命中几次更能说明相关 —— 全部命中才给满权重。
  return score * (0.6 + 0.4 * (hits / lowered.length));
}

function excerpt(unit, term) {
  const text = unit.kind === "pit" ? [unit.cells[1], unit.cells[2], unit.cells[3]].filter(Boolean).join(" → ") : unit.text;
  const index = text.toLowerCase().indexOf(term);
  const start = index < 0 ? 0 : Math.max(0, index - 40);
  const width = flags.get("--context") ? 320 : 150;
  return (start > 0 ? "…" : "") + text.slice(start, start + width).replace(/\s+/g, " ") + (start + width < text.length ? "…" : "");
}

/* ------------------------------------------------------------------ 开跑 */

const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const WHERE_DIRS = {
  pit: (rel) => rel === "docs/PITFALLS.md",
  gaps: (rel) => rel === "docs/reference/known-gaps.md",
  design: (rel) => rel.startsWith("docs/design/"),
  spec: (rel) => rel === "docs/WIDGET_SPEC.md" || rel === "AGENTS.md",
};

const started = Date.now();
const found = [];
let scanned = 0;

for (const rel of tracked) {
  if (WHERE && !WHERE_DIRS[WHERE]?.(rel)) continue;

  let layers = layerOf(rel) ?? [];
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");

  const status = designStatus(text);
  if (status) layers = status === "draft" ? ["future"] : ["past"];

  if (LAYER && !layers.includes(LAYER)) continue;
  scanned += 1;

  for (const unit of unitsOf(rel, text)) {
    const value = score(unit);
    if (value > 0) found.push({ rel, layers, unit, value });
  }
}

found.sort((a, b) => b.value - a.value || a.rel.localeCompare(b.rel) || a.unit.line - b.unit.line);

const KIND = { heading: "标题", pit: "坑", row: "表格行", line: "正文" };
const shown = found.slice(0, LIMIT);

if (shown.length === 0) {
  console.log(`没找到「${terms.join(" ")}」。试试：`);
  console.log(`  · 换你看到的**现象**，别换原因（PITFALLS 的按症状分组就是这个意思）`);
  console.log(`  · 少打一个字：「${terms[0].slice(0, 2)}」`);
  console.log(`  · 去掉 --where / --layer 放宽范围`);
  process.exit(2);
}

let currentFile = null;
for (const hit of shown) {
  if (hit.rel !== currentFile) {
    currentFile = hit.rel;
    console.log(`\n${hit.rel}${hit.layers.length ? `  [${hit.layers.join("/")}]` : ""}`);
  }
  const where = hit.unit.path.length ? hit.unit.path.join(" › ") : "（开头）";
  const id = hit.unit.id ? `${hit.unit.id} · ` : "";
  const tag = KIND[hit.unit.kind];
  console.log(`  ${String(hit.unit.line).padStart(4)} ${tag.padEnd(4)} ${id}${where}`);
  console.log(`        ${excerpt(hit.unit, terms[0])}`);
}

const more = found.length - shown.length;
console.log(`\n${found.length} 处命中（${scanned} 份文档，${Date.now() - started}ms）${more > 0 ? ` · 还有 ${more} 处：--limit ${Math.min(found.length, 40)}` : ""}`);
if (!ID_QUERY) console.log(`按编号精确定位：npm run docs:query -- PIT-027`);
