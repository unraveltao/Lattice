#!/usr/bin/env node
/**
 * 文档体检：相对链接是否可达 + README 的数字和代码对不对得上。
 *
 * 两件事都属于"过期了不会报错"的类型 —— 链接死了只影响读者，数字旧了只影响可信度，
 * 而两者都是靠人手维护必然漂移的东西。所以放进 CI。
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

const METRICS = [
  { key: "widgets", en: "Official widgets", zh: "官方组件", derive: countTrackedWidgets },
  { key: "permissions", en: "Permissions", zh: "权限", derive: countPermissions },
  { key: "commands", en: "Tauri commands", zh: "Tauri 命令", derive: countCommands },
  { key: "assertions", en: "Browser assertions", zh: "浏览器断言", derive: null },
  { key: "rustTests", en: "Rust tests", zh: "Rust 单测", derive: null },
  { key: "pitfalls", en: "Documented pitfalls", zh: "记下来的坑", derive: null },
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
      const actual = metric.derive();
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

/* ------------------------------------------------------------------ 输出 */

const files = walk(ROOT);
const { total, broken } = checkLinks(files);
const rows = checkNumbers();

console.log(`文档体检：${files.length} 份 .md，${total} 条相对链接\n`);

if (broken.length === 0) {
  console.log(`  链接      ✓ ${total} 条全部可达`);
} else {
  console.log(`  链接      ✗ ${broken.length} 条不可达`);
  for (const item of broken) console.log(`            ${item.file} → ${item.target}`);
}

const pad = (text, width) => String(text).padEnd(width);
const cell = (numbers) => (numbers === null ? "—" : numbers.join(" / "));

console.log("");
for (const row of rows) {
  const mark = row.ok ? "✓" : "✗";
  const label = row.label.length > 20 ? row.label : pad(row.label, 20);
  console.log(
    `  ${mark} ${label} README ${cell(row.en)}  ·  zh ${cell(row.zh)}  ·  实测 ${
      row.actual === null ? "手数" : row.actual
    }${row.note ? `   ${row.note}` : ""}`,
  );
}

const failed = rows.filter((row) => !row.ok);
if (VERBOSE) {
  console.log(`\n  能自动数的三项：组件 ${countTrackedWidgets()} / 权限 ${countPermissions()} / 命令 ${countCommands()}`);
}

if (broken.length || failed.length) {
  console.log(`\n${broken.length + failed.length} 处要修。`);
  process.exit(1);
}
console.log("\n全部通过。");
