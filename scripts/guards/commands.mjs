#!/usr/bin/env node
/**
 * 命令的守门人：前端 `invoke("x")` ↔ Rust `#[tauri::command]` ↔ `generate_handler!`。
 *
 * 一条 IPC 命令要落三处，而 Tauri 对其中两处的不一致**只在运行时说话**：
 *
 *   `invoke("widget_store_red")`   —— 拼错了。编译期没有任何人看得到，运行时
 *                                      reject 一句 `Command widget_store_red not found`，
 *                                      而界面上通常表现成"这块数据没加载出来"。
 *   `#[tauri::command] fn foo()` 声明了、`generate_handler!` 里漏了 —— 同上，而且
 *                                     这个函数在 Rust 侧是死代码（`cargo test` 也不报，
 *                                     因为它只是没人调）。
 *   `generate_handler!` 里写了、`fn` 不存在 —— 这条编译期会红，不用管。
 *
 * 所以两头都要对：**被调的名字必须注册过，注册的必须是声明过的**。
 *
 *   npm run check:commands          对账，有问题退出码 1
 *
 * 只读，不改。
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT as STATS_ROOT, declaredCommands, registeredCommands } from "../stats.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const problems = [];
const fail = (message) => problems.push(message);

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

// Rust 那一侧的解析只有一份，在 `scripts/stats.mjs`（`check:stats` 和 README 的
// "Tauri commands" 那格也读它）。这里只做**对账**，不重新发明一遍正则。
if (STATS_ROOT !== ROOT) {
  console.error("✗ scripts/stats.mjs 认的仓库根和这里不是同一个 —— 相对路径会错位");
  process.exit(1);
}

/* --------------------------------------------------- 前端那一侧 */

function tsSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));
  return files;
}

/**
 * 找 `invoke("cmd")` / `invoke<T>("cmd")` / `invoke<{…}>(…)`，跳过 `foo.invoke(…)`。
 *
 * 不写成一条正则：类型参数里可能有 `{}` 和嵌套的 `<>`（`invoke<Array<{ id: string }>>`），
 * 正则数不清深度，会在第一个 `>` 就收手，然后把后面的 `(` 看丢 —— 那一处调用就
 * 从"检查过"变成"没检查"，而且不报错。所以手工走一遍。
 */
function invokedCommands() {
  const staticCalls = [];
  const dynamicCalls = [];

  for (const file of tsSources()) {
    const raw = fs.readFileSync(file, "utf8");
    const source = stripCommentsKeepingStrings(raw);
    const where = path.relative(ROOT, file).replace(/\\/g, "/");

    for (const match of source.matchAll(/\binvoke\b/g)) {
      // `x.invoke(...)` 不是 Tauri 的 IPC
      const before = source.slice(0, match.index).trimEnd();
      if (before.endsWith(".")) continue;

      let index = match.index + "invoke".length;
      while (index < source.length && /\s/.test(source[index])) index += 1;

      if (source[index] === "<") {
        let depth = 0;
        while (index < source.length) {
          if (source[index] === "<") depth += 1;
          else if (source[index] === ">") {
            depth -= 1;
            if (depth === 0) {
              index += 1;
              break;
            }
          }
          index += 1;
        }
        while (index < source.length && /\s/.test(source[index])) index += 1;
      }

      if (source[index] !== "(") continue;
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;

      if (source[index] !== '"') {
        dynamicCalls.push({ where, line: lineOf(source, match.index) });
        continue;
      }
      const end = source.indexOf('"', index + 1);
      if (end < 0) continue;
      staticCalls.push({ name: source.slice(index + 1, end), where, line: lineOf(source, match.index) });
    }
  }
  return { staticCalls, dynamicCalls };
}

/** 和 bridge.mjs 里同一份：保留字符串与换行，去掉注释。 */
function stripCommentsKeepingStrings(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          out += source[index] + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/* ------------------------------------------------------------ 对账 */

const declaredScan = declaredCommands();
const declared = declaredScan.commands;
for (const problem of declaredScan.problems) fail(problem);
const registered = registeredCommands();
if (!registered) {
  console.error("✗ src-tauri/src/lib.rs 里找不到 `generate_handler![…]` —— 正则和代码形状对不上了");
  process.exit(1);
}

const { staticCalls, dynamicCalls } = invokedCommands();

if (declared.size === 0) fail("src-tauri/src 里一个 #[tauri::command] 都没找到 —— 正则和代码形状对不上了");
if (staticCalls.length === 0) fail("src/ 里一个 invoke(\"…\") 都没找到 —— 正则和代码形状对不上了");

// 1. 前端调的，必须是注册过的
const missing = new Map();
for (const call of staticCalls) {
  if (registered.has(call.name)) continue;
  if (!missing.has(call.name)) missing.set(call.name, []);
  missing.get(call.name).push(`${call.where}:${call.line}`);
}
for (const [name, places] of missing) {
  fail(`invoke("${name}") 没有注册 —— ${places.join(" / ")}；运行时只会 reject 一句 Command ${name} not found`);
}

// 2. 声明了 #[tauri::command] 的，必须注册
for (const [name, command] of declared) {
  if (registered.has(name)) continue;
  fail(`${command.where} 声明了 ${name}，但 generate_handler! 里没有它 —— 前端调不到，Rust 侧是死代码`);
}

// 3. 注册了但没声明的，编译期会红，这里顺手也说清楚
for (const [name, entry] of registered) {
  if (declared.has(name)) continue;
  fail(`generate_handler! 注册了 ${entry.module ? `${entry.module}::` : ""}${name}，但找不到带 #[tauri::command] 的同名函数`);
}

/* ARCHITECTURE.md §3 那行「Rust 命令」写着"现在 N 条"。曾经是 99，而实际早就过百 ——
 * 这个数字漂了不会让任何东西报错，所以由数它的那个人顺手盯住。 */
{
  const line = fs
    .readFileSync(path.join(ROOT, "docs", "ARCHITECTURE.md"), "utf8")
    .split("\n")
    .find((candidate) => candidate.includes("**Rust 命令**"));
  const claimed = line?.match(/现在 (\d+) 条/);
  if (!line) fail("docs/ARCHITECTURE.md 里找不到「Rust 命令」那一行 —— 表的结构变了");
  else if (!claimed) fail("docs/ARCHITECTURE.md 的「Rust 命令」那行读不到「现在 N 条」—— 写法变了");
  else if (Number(claimed[1]) !== declared.size) {
    fail(`docs/ARCHITECTURE.md 的「Rust 命令」写的是 ${claimed[1]}，实际 ${declared.size}`);
  }
}

/* ------------------------------------------------------------ 输出 */

if (problems.length) {
  console.error(`命令对账：${problems.length} 处不一致\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\n一条命令要落三处：`#[tauri::command] fn` / `generate_handler!` / 前端 invoke。");
  process.exit(1);
}

console.log(
  `命令对账通过：${declared.size} 条命令，声明 = 注册；${staticCalls.length} 处 invoke 全部命中。`,
);
if (dynamicCalls.length) {
  // 命令名是变量时无从核对。说出来而不是吞掉：下一个人要知道这块没被守住。
  console.log(`  · 跳过 ${dynamicCalls.length} 处动态命令名（无从核对）：`);
  for (const call of dynamicCalls) console.log(`      ${call.where}:${call.line}`);
}
