#!/usr/bin/env node
/**
 * 数字的唯一真源：**所有**"这个平台现在有多少条 X"都从这里算，别处一律引用。
 *
 * 为什么要有这一份：同一个数曾经有三处各算一遍 —— `check-docs.mjs` 自己写了一条
 * `KNOWN_PERMISSIONS` 的正则、`guards/bridge.mjs` 写了另一条、`guards/commands.mjs`
 * 又数了一遍 `#[tauri::command]`。三份实现里只要有一份的正则先失配（比如代码从
 * `new Set<string>([` 改成 `new Set([`），那一处就会**打印 0 并退出 0** —— 体检全绿，
 * 数字全错。这类"静默数错"比报错难查得多，因为没有任何信号。
 *
 * 所以这里只有一份实现，而且**失配就抛**，不许返回 0。谁调用谁决定怎么报错。
 *
 * ## 作用域：全局 vs 局部
 *
 * 每个数都带 `scope`。这不是分类癖：文档里写"31 个方法"的时候，读者默认它指
 * **整座桥**；而"9 个动作"只指 agent 那张白名单。两者混在一句话里（"31 个方法、
 * 9 个动作"）看起来是一组，其实一个是全局、一个是某个子系统的局部 —— 这正是
 * `docs/AGENT_ACCESS.md` 与 `docs/ROADMAP.md` 曾经对不上的地方（9 vs 8，因为
 * 0037 给那张白名单加了 `config.set`，而 ROADMAP 那两行记的是 v0.8 / v0.10 的 8）。
 *
 * 所以：
 *   - `global`    —— 整个平台这一层的总数，文档里可以直接写"现在 N 条"。
 *   - `subsystem` —— 只有那个子系统是 N，**写的时候必须带主语**（"agent 的 N 个动作"）。
 *
 * 局部数的名单故意很短：只收那些**已经在文档里被写过、并且漂过**的。收得越多，
 * 这份文件越像第二份代码地图，而它不该是。
 *
 * ## 命令行
 *
 *   node scripts/stats.mjs            打印一张表（全局在前、局部在后）
 *   node scripts/stats.mjs --json     同上，机器读
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 失配一律抛，不返回 0 —— 见文件头。 */
function must(value, message) {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/* ------------------------------------------------------------------ 去注释 */

/**
 * 去掉 JS/TS 的 `//` 与 `/* *\/`，**保留字符串和换行**。
 *
 * 保留字符串：要找的正是 `defineMethod("storage.get", "storage", …)` 里那两个字面量。
 * 保留换行：报错要说第几行，按行报错的前提是行号没被删注释挤掉。
 *
 * 不写成正则，是因为 `"https://…"` 里的 `//` 会被当成注释开头 —— 那一行后面的代码
 * 就整段消失，于是"这一行有 defineMethod"变成"这一行没有"，守卫静默放过。
 */
export function stripJsComments(source) {
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

/**
 * 去掉 Rust 的 `//`、`/* *\/`（块注释可嵌套）和字符字面量里的假注释。
 *
 * `'` 要分两种：`'a` 是生命周期（不跳），`'\n'` / `'x'` 是字符字面量（要跳过去，
 * 否则 `'"'` 会把后面的引号配对全打乱）。
 */
export function stripRustComments(source) {
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
      let depth = 0;
      while (index < source.length) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          out += source[index] + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "'") {
      const escaped = source[index + 1] === "\\" && source[index + 3] === "'";
      const simple = source[index + 2] === "'" && source[index + 1] !== "\\";
      if (escaped || simple) {
        const length = escaped ? 4 : 3;
        out += source.slice(index, index + length);
        index += length;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

/* -------------------------------------------------------------- 权限 */

/** `export type Permission = "a" | "b";` */
export function permissionUnion() {
  const source = stripJsComments(read("src/runtime/manifest.ts"));
  const block = source.match(/export type Permission =([\s\S]*?);/);
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** `export const PERMISSION_READY: ReadonlySet<Permission> = new Set([...])` */
export function permissionReady() {
  const source = stripJsComments(read("src/runtime/manifest.ts"));
  const block = source.match(/export const PERMISSION_READY[\s\S]*?new Set<Permission>\(\[([\s\S]*?)\]\)/);
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** `export const PERMISSION_LABELS: Record<Permission, string> = { clock: "…", … }` */
export function permissionLabels() {
  const source = stripJsComments(read("src/runtime/manifest.ts"));
  const block = source.match(/export const PERMISSION_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return null;
  return [...block[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)].map((match) => match[1] ?? match[2]);
}

/** `const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>([...])` */
export function cataloguePermissions() {
  const source = stripJsComments(read("src/runtime/catalogue.ts"));
  const block = source.match(/const KNOWN_PERMISSIONS[^=]*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block) return null;
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/* ------------------------------------------------------------ 桥方法 */

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

/** `defineMethod("ns.method", "perm" | null, handler)` */
export function bridgeMethods() {
  const source = stripJsComments(read("src/runtime/bridge.ts"));
  const methods = [];
  const pattern = /defineMethod\(\s*"([^"]+)"\s*,\s*(null|"([^"]+)")\s*,/g;
  for (const match of source.matchAll(pattern)) {
    methods.push({
      name: match[1],
      permission: match[2] === "null" ? null : match[3],
      line: lineOf(source, match.index),
    });
  }
  return methods;
}

/* ---------------------------------------------------------- Tauri 命令 */

function rustSources() {
  const dir = path.join(ROOT, "src-tauri", "src");
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".rs")) files.push(full);
    }
  };
  walk(dir);
  return files;
}

/**
 * `#[tauri::command]` 之后第一个 `fn NAME`（中间可能夹着 `#[cfg(...)]`）。
 *
 * 返回 `problems` 而不是自己 `process.exit`：调用方有的一份在 `check:commands`
 * 里要逐条累计、有的是在 CI 里只想看一条 —— 让它们各自决定怎么报。
 */
export function declaredCommands() {
  const commands = new Map();
  const problems = [];
  for (const file of rustSources()) {
    const source = stripRustComments(fs.readFileSync(file, "utf8"));
    for (const match of source.matchAll(/#\[tauri::command\]/g)) {
      const fn = source.slice(match.index).match(/\bfn\s+(\w+)/);
      const where = `${path.relative(ROOT, file).replace(/\\/g, "/")}:${lineOf(source, match.index)}`;
      if (!fn) {
        problems.push(`${where} 有 #[tauri::command]，但后面找不到 fn —— 形状变了`);
        continue;
      }
      commands.set(fn[1], { name: fn[1], where });
    }
  }
  return { commands, problems };
}

/** `generate_handler![ widgets::list_widgets, quit_app, … ]` —— 允许 `mod::fn` 和裸 `fn`。 */
export function registeredCommands() {
  const source = stripRustComments(read("src-tauri/src/lib.rs"));
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) return null;
  const registered = new Map();
  for (const match of block[1].matchAll(/(?:(\w+)::)?(\w+)\s*,/g)) {
    registered.set(match[2], { name: match[2], module: match[1] ?? null });
  }
  return registered;
}

/* ------------------------------------------------------------ 官方组件 */

/**
 * 只数仓库里**已被 git 跟踪**的组件包。
 *
 * 磁盘上可能有还没提交的新组件（桌宠就那样在工作区里待过一阵），算进来就是一个
 * 每小时都在变的数，而 README 里那个数是给读者看"这个平台带多少东西"的。
 */
export function officialWidgets() {
  try {
    const out = execFileSync("git", ["ls-files", "public/widgets/*/manifest.json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    const dir = path.join(ROOT, "public", "widgets");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "manifest.json")))
      .map((entry) => `public/widgets/${entry.name}/manifest.json`);
  }
}

/* --------------------------------------------------- 局部：agent 动作 */

/**
 * 动作白名单有两份（Rust 挡端口进来的请求、TS 挡"将来第二条入口忘了校验"），
 * 两边必须逐字一致 —— `tests/agent.html` 钉着这件事，这里只负责**数**。
 */
export function agentActions() {
  const rust = stripRustComments(read("src-tauri/src/agent_policy.rs"));
  const block = rust.match(/pub const ACTIONS: &\[Action\] = &\[([\s\S]*?)\];/);
  const rustActions = block
    ? [...block[1].matchAll(/Action::(\w+)/g)].map((match) => match[1])
    : null;

  const ts = stripJsComments(read("src/platform/agent.ts"));
  const tsBlock = ts.match(/export const AGENT_ACTIONS = \[([\s\S]*?)\];/);
  const tsActions = tsBlock ? [...tsBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : null;

  return { rust: rustActions, ts: tsActions };
}

/* ---------------------------------------------------------------- 坑 */

/** PITFALLS.md 的表行，顺带和它自己开头那句对账。 */
export function pitfalls() {
  const source = read("docs/PITFALLS.md");
  const lines = source.split("\n");
  const separator = (line) => /^\|\s*-{3,}/.test(line);
  // 表头按结构认（下一行是分隔行），不认字面量 —— 加了 ID 列以后 `| 症状` 不再是首列。
  const rows = lines.filter((line, i) => line.startsWith("|") && !separator(line) && !separator(lines[i + 1] ?? ""));
  const claimed = source.match(/现在 \*\*(\d+) 条\*\*/);
  if (!claimed) throw new Error("docs/PITFALLS.md 里找不到「现在 **N 条**」这句");
  if (Number(claimed[1]) !== rows.length) {
    throw new Error(`docs/PITFALLS.md 开头写 ${claimed[1]} 条，表里实际 ${rows.length} 行`);
  }
  return rows.length;
}

/* --------------------------------------------------------- Rust 单测 */

/**
 * `#[test]` 的个数 —— 静态数，不需要 cargo。
 *
 * 这一项原来是**手数**的（"`check:policy-tests` + `cargo test` 两批加起来"），于是它烂了
 * 两次都没人发现：`AGENTS.md` 写着 457 条（实测 `#[test]` 618 条），`README` 写 548 条，
 * 两个数还互不相同 —— 手数的数没有来源，就没有人复核，而它和写错的数是同一串字符。
 *
 * 口径定死成"`src-tauri/src/**\/*.rs` 里 `#[test]` 的个数"：`#[test]` 只写在
 * `#[cfg(test)] mod tests` 里，所以它和 `cargo test` 报的 "running N tests" 是同一个数。
 * 其中一部分能 `rustc --test` 单跑，那个**子集**的条数由 `check:policy-tests` 另外报，
 * 不是第二个总数。
 */
export function rustTestCount() {
  let total = 0;
  for (const file of rustSources()) {
    const source = stripRustComments(fs.readFileSync(file, "utf8"));
    total += (source.match(/^[ \t]*#\[test\]/gm) ?? []).length;
  }
  return total;
}

/* ------------------------------------------------------------ 汇总 */

/**
 * 每个数一份元数据。`scope` 决定文档里该怎么写（见文件头），`how` 是给人看的一句话 ——
 * 文档里"`npm run check:stats` 会数"背后指的就是这一条。
 */
export const METRICS = {
  officialWidgets: {
    scope: "global",
    unit: "个",
    zh: "官方组件",
    en: "Official widgets",
    how: "`git ls-files public/widgets/*/manifest.json`",
    derive: () => officialWidgets().length,
  },
  permissions: {
    scope: "global",
    unit: "项",
    zh: "权限",
    en: "Permissions",
    how: "`src/runtime/manifest.ts` 的 `Permission` 联合类型",
    derive: () => must(permissionUnion(), "manifest.ts 里找不到 `export type Permission = …`")?.length,
  },
  bridgeMethods: {
    scope: "global",
    unit: "个",
    zh: "桥方法",
    en: "Bridge methods",
    how: "`src/runtime/bridge.ts` 的 `defineMethod(…)`",
    derive: () => bridgeMethods().length,
  },
  tauriCommands: {
    scope: "global",
    unit: "条",
    zh: "Tauri 命令",
    en: "Tauri commands",
    how: "`#[tauri::command]`（声明，不是注册）",
    derive: () => declaredCommands().commands.size,
  },
  pitfalls: {
    scope: "global",
    unit: "条",
    zh: "记下来的坑",
    en: "Documented pitfalls",
    how: "`docs/PITFALLS.md` 的表行",
    derive: pitfalls,
  },
  // 手数的那一项：浏览器断言要真 Chrome + 真 dev server，`check:stats` 里跑不了。
  // 留在表里是为了让"中英两份必须写同一个数"这条仍然成立。
  browserAssertions: {
    scope: "global",
    unit: "条",
    zh: "浏览器断言",
    en: "Browser assertions",
    how: "手数：`npm run test:browser` 的输出",
    derive: null,
  },
  rustTests: {
    scope: "global",
    unit: "条",
    zh: "Rust 单测",
    en: "Rust tests",
    how: "`#[test]` 在 `src-tauri/src/**/*.rs` 里的个数（其中一部分能 `rustc --test` 单跑）",
    derive: rustTestCount,
  },
  agentActions: {
    scope: "subsystem",
    subsystem: "agent 白名单动作（外部 agent 端点 + assistant 桌面动作共用）",
    unit: "个",
    zh: "agent 动作",
    en: "Agent actions",
    how: "`src-tauri/src/agent_policy.rs` 的 `ACTIONS`",
    derive: () => must(agentActions().rust, "agent_policy.rs 里找不到 `pub const ACTIONS`")?.length,
  },
};

/** 全部数一遍。**任何一个派生失败就抛** —— 不许带着 0 继续。 */
export function counts() {
  const out = {};
  for (const [key, metric] of Object.entries(METRICS)) {
    out[key] = metric.derive ? metric.derive() : null;
  }
  return out;
}

/* ---------------------------------------------------------------- CLI */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const values = counts();
  const asJson = process.argv.includes("--json");

  if (asJson) {
    console.log(JSON.stringify({ values, metrics: METRICS }, null, 2));
  } else {
    const globals = Object.entries(METRICS).filter(([, m]) => m.scope === "global");
    const locals = Object.entries(METRICS).filter(([, m]) => m.scope === "subsystem");

    console.log("全局（整个平台这一层的总数）\n");
    for (const [key, metric] of globals) {
      const value = values[key] === null ? "手数" : `${values[key]} ${metric.unit}`;
      console.log(`  ${metric.zh.padEnd(8)} ${String(value).padStart(6)}   ${metric.how}`);
    }

    console.log("\n局部（只有那个子系统是这个数，写进文档要带主语）\n");
    for (const [key, metric] of locals) {
      console.log(`  ${metric.zh.padEnd(8)} ${`${values[key]} ${metric.unit}`.padStart(6)}   ${metric.subsystem}`);
      console.log(`  ${"".padEnd(8)} ${"".padStart(6)}   ${metric.how}`);
    }
  }
}
