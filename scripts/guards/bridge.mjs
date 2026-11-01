#!/usr/bin/env node
/**
 * 桥的守门人：一个权限要落的六处，和 §4 那张方法表。
 *
 * 这个仓库里最贵的腐烂不是崩溃，是**静默不一致**。权限尤其如此，因为它落在六处，
 * 而其中三处漏改的表现是"不报错、只是不工作"：
 *
 *   1. `runtime/manifest.ts` 的 `Permission` 联合类型  —— 少了：tsc 会红（唯一会红的）
 *   2. `PERMISSION_READY`                              —— 少了：`normalizePermissions`
 *                                                          **静默丢掉**这个名字，组件
 *                                                          清单里写着、平台当没有，于是
 *                                                          那条桥方法永远 `permission_denied`
 *   3. `PERMISSION_LABELS`                             —— 少了：授权面板显示成 `audio:level`
 *   4. `runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS`   —— 少了：商店卡片少一行权限
 *   5. `docs/WIDGET_SPEC.md` §3 的权限表                —— 少了：写组件的人不知道有这条
 *   6. `runtime/bridge.ts` 的 `defineMethod`            —— 少了：勾得上、点不动
 *
 * 2 和 4 是两份名单，第 6 处漏了不会有任何报错。所以这里逐处对账，谁和联合类型
 * 不一致就红在哪一处，而不是等到某个组件的用户说"我勾了权限还是不行"。
 *
 * 同一份对账顺手覆盖 §4 的方法表：每个方法要哪条权限，文档和代码必须一样。那张表
 * 是写组件的人唯一会读的东西，它和代码漂了就等于文档在骗人。目录里那两句
 * "N 项能力" / "N 个方法" 一起对 —— 数字写在正文里没人会去核。
 *
 *   npm run check:bridge           对账，有问题退出码 1
 *
 * 只读，不改。
 */
import fs from "node:fs";
import path from "node:path";

import {
  ROOT as STATS_ROOT,
  bridgeMethods,
  cataloguePermissions,
  permissionLabels,
  permissionReady,
  permissionUnion,
} from "../stats.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 数的实现只有一份，在 `scripts/stats.mjs`。这里以前各写了一遍 —— 两份正则里
// 先失配的那一份会打印 0 并退出 0（"静默数错"），所以它们必须共用同一个函数。
if (STATS_ROOT !== ROOT) {
  console.error("✗ scripts/stats.mjs 认的仓库根和这里不是同一个 —— 相对路径会错位");
  process.exit(1);
}

const problems = [];
const fail = (message) => problems.push(message);

/* ------------------------------------------------------- 六处里的四处 */

const permissionsFromUnion = permissionUnion;
const permissionsFromReady = permissionReady;
const permissionsFromLabels = permissionLabels;
const permissionsFromCatalogue = cataloguePermissions;

/* ------------------------------------------------------------ 表格 */

/**
 * 取一张 markdown 表：从表头那一行开始，到第一行不以 `|` 开头为止。
 *
 * `header` 给**前两格**，不能只给第一格 —— §3.7 那张小表（`| 方法 | 参数 | 返回 |`）
 * 和 §4 的大表（`| 方法 | 权限 | 参数 | 返回 |`）第一格都是"方法"。只按第一格找，
 * 找到的是先出现的那张小表：它只有三行（secret.*），于是对账结果变成"§4 少了 28 个
 * 方法、secret 三条的权限写成了参数" —— 一条真实存在的、指向错表的报错。
 */
function tableRows(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    if (!line.trimStart().startsWith("|")) return false;
    const cells = line.split("|").map((cell) => cell.trim());
    return header.every((label, index) => cells[index + 1] === label);
  });
  if (start < 0) return null;

  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trimStart().startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    if (/^-{3,}$/.test(cells[1] ?? "")) continue; // 分隔行
    rows.push(cells.slice(1, -1)); // 去掉首尾那两个空串
  }
  return rows;
}

const unquote = (cell) => cell.replace(/`/g, "").trim();

/** §3 权限表：第一列是权限名 */
function permissionsFromSpec() {
  const rows = tableRows(read("docs/WIDGET_SPEC.md"), ["权限", "授予后可用"]);
  if (!rows) return null;
  return rows.map((cells) => unquote(cells[0]));
}

function documentedMethods() {
  const rows = tableRows(read("docs/WIDGET_SPEC.md"), ["方法", "权限"]);
  if (!rows) return null;
  return rows.map((cells) => ({
    name: unquote(cells[0]),
    permission: unquote(cells[1]) === "—" ? null : unquote(cells[1]),
  }));
}

/* ------------------------------------------------------------ 对账 */

const union = permissionsFromUnion();
if (!union) {
  console.error("✗ 在 src/runtime/manifest.ts 里找不到 `export type Permission = …` —— 正则和代码形状对不上了");
  process.exit(1);
}
const canonical = new Set(union);

/** 五处（联合类型自己不算）依次对账，报出差的**方向**，而不是一句"对不上"。 */
const PLACES = [
  { label: "PERMISSION_READY", where: "src/runtime/manifest.ts", derive: permissionsFromReady },
  { label: "PERMISSION_LABELS", where: "src/runtime/manifest.ts", derive: permissionsFromLabels },
  { label: "KNOWN_PERMISSIONS", where: "src/runtime/catalogue.ts", derive: permissionsFromCatalogue },
  { label: "WIDGET_SPEC §3 表", where: "docs/WIDGET_SPEC.md", derive: permissionsFromSpec },
];

for (const place of PLACES) {
  const found = place.derive();
  if (!found) {
    fail(`${place.where} 里找不到 ${place.label} —— 名字或形状变了，正则需要跟着改`);
    continue;
  }
  const set = new Set(found);
  const missing = union.filter((name) => !set.has(name));
  const extra = found.filter((name) => !canonical.has(name));
  const duplicated = found.filter((name, index) => found.indexOf(name) !== index);
  if (missing.length) fail(`${place.label} 少了：${missing.join(" / ")}（${place.where}）`);
  if (extra.length) fail(`${place.label} 多了：${extra.join(" / ")}（${place.where} 里没有对应的联合类型成员）`);
  if (duplicated.length) fail(`${place.label} 重复了：${[...new Set(duplicated)].join(" / ")}`);
}

/* 第 6 处：桥方法真的用到了这条权限 */

/**
 * 有权限、但没有桥方法的只有一条：`agent:tools` 是"让 agent 调这个组件声明的工具"，
 * 入口在 widget-host 那一侧（组件是被调的一方，不是调的一方），所以桥方法表里没有它。
 * 写在这里而不是写进注释：**"为什么没有"是规则，规则要和检查待在一起**，不然下一个人
 * 看到它就是一条没用的权限，顺手删掉。
 */
const NON_BRIDGE = new Map([["agent:tools", "由 widget-host 调用，组件是被调的一方，桥方法表里没有它"]]);

const methods = bridgeMethods();
if (methods.length === 0) {
  fail("src/runtime/bridge.ts 里一个 defineMethod 都没找到 —— 正则和代码形状对不上了");
}

for (const method of methods) {
  if (method.permission !== null && !canonical.has(method.permission)) {
    fail(`bridge.ts:${method.line} ${method.name} 要的 "${method.permission}" 不在 Permission 联合类型里`);
  }
}

const usedPermissions = new Set(methods.map((method) => method.permission).filter(Boolean));
for (const permission of union) {
  if (usedPermissions.has(permission)) continue;
  if (NON_BRIDGE.has(permission)) continue;
  fail(`权限 "${permission}" 没有任何桥方法用到 —— 要么补一条 defineMethod，要么写进 NON_BRIDGE 说明理由`);
}

/* §4 方法表：方法名集合一致，每条的权限也一致 */

const documented = documentedMethods();
if (!documented) {
  fail("docs/WIDGET_SPEC.md 里找不到 §4 的方法表（表头应为 `| 方法 | 权限 | 参数 | 返回 |`）");
} else {
  const byCode = new Map(methods.map((method) => [method.name, method]));
  const byDoc = new Map(documented.map((method) => [method.name, method]));

  const undocumented = [...byCode.keys()].filter((name) => !byDoc.has(name));
  const phantom = [...byDoc.keys()].filter((name) => !byCode.has(name));
  if (undocumented.length) fail(`WIDGET_SPEC §4 里没有：${undocumented.join(" / ")}（代码里有这个桥方法）`);
  if (phantom.length) fail(`WIDGET_SPEC §4 里多出来：${phantom.join(" / ")}（代码里没有这个桥方法）`);

  for (const [name, method] of byCode) {
    const doc = byDoc.get(name);
    if (!doc) continue;
    if (doc.permission !== method.permission) {
      fail(
        `WIDGET_SPEC §4 的 ${name} 写的是 ${doc.permission ?? "—"}，代码里是 ${method.permission ?? "null"}`,
      );
    }
  }
}

/**
 * WIDGET_SPEC 目录里那两句「N 项能力」/「N 个方法」。
 *
 * 它们和下面两张表是同一件事的两种说法，而表会被对账、目录不会 —— 于是最常出现的
 * 状态是"表更新了、目录还是旧数字"，而且没有任何检查会红。目录又恰好是新人读到的
 * 第一句，所以这里一起钉住。
 */
function checkSpecToc(pattern, actual, what) {
  const match = read("docs/WIDGET_SPEC.md").match(pattern);
  if (!match) {
    fail(`docs/WIDGET_SPEC.md 的目录里读不到「${what}」那句 —— 写法变了`);
    return;
  }
  if (Number(match[1]) !== actual) {
    fail(`docs/WIDGET_SPEC.md 的目录写「${match[1]} ${what}」，实际 ${actual}`);
  }
}

/* ARCHITECTURE.md §3 那张「一条能力落地的五处」表里写着"现在 N 条"。
 *
 * 那三个数字是给新人的第一手估计，也是最容易烂的地方 —— 它们曾经同时是 27 / 13 / 99，
 * 而实际是 31 / 15 / 117：三处全错，没有一条命令会因此报错。所以这里顺手对一下
 * 自己负责的那两行（Rust 命令那行归 `check:commands` 管，谁数的谁盯）。
 */
function checkArchitectureCount(label, actual) {
  const line = read("docs/ARCHITECTURE.md")
    .split("\n")
    .find((candidate) => candidate.includes(`**${label}**`));
  if (!line) {
    fail(`docs/ARCHITECTURE.md 里找不到「${label}」那一行 —— 表的结构变了`);
    return;
  }
  const claimed = line.match(/现在 (\d+) (?:条|项)/);
  if (!claimed) {
    fail(`docs/ARCHITECTURE.md 的「${label}」那行读不到「现在 N 条」—— 写法变了`);
    return;
  }
  if (Number(claimed[1]) !== actual) {
    fail(`docs/ARCHITECTURE.md 的「${label}」写的是 ${claimed[1]}，实际 ${actual}`);
  }
}

checkSpecToc(/\[3\. 权限\]\(#3-权限\) \| (\d+) 项能力/, union.length, "项能力");
checkSpecToc(/\[4\. 桥 API\]\(#4-桥-api\) \| (\d+) 个方法/, methods.length, "个方法");
checkArchitectureCount("桥方法表", methods.length);
checkArchitectureCount("权限清单", union.length);

/* ------------------------------------------------------------ 输出 */

if (problems.length) {
  console.error(`桥对账：${problems.length} 处不一致\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\n权限要落六处，见本文件头部；docs/reference/verify.md 也有一份同样的清单。");
  process.exit(1);
}

console.log(
  `桥对账通过：${union.length} 条权限 × 6 处 + ${methods.length} 个桥方法（§4 表与代码一致）。`,
);
