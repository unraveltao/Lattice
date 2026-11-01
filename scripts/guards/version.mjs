#!/usr/bin/env node
/**
 * 版本的守门人：三处配置必须是同一个数，入口文档必须写着这个数。
 *
 * 为什么要有这一条：`check:docs` 查链接和归属，`check:stats` 查计数 —— **两边都不看
 * 版本号**。于是 2026-10-31 那天出现过一个谁都没发现的状态：`package.json` /
 * `Cargo.toml` / `tauri.conf.json` 都是 `0.3.0`，而 README 和 `AGENTS` 写着
 * "安装包报 `0.2.0`"，而 `0.2.0` 是草稿、从来没发布过。三条链路各自都对，合起来骗人。
 *
 * 三件事分开表达，别混成一句（外部审阅把这条列为 P0）：
 *
 *   源码版本     —— 配置里那个数，决定下一次构建叫自己什么。**这一份可以派生**，
 *                   所以由这里钉住。
 *   能下载到的   —— GitHub Releases 上最新的已发布条目。**派生不出来**（要问 GitHub），
 *                   所以只提醒它不归这里管，别在仓库里写死一个"已发布"。
 *   里程碑       —— `v0.13` 这种内部标签，永远不会出现在安装包里。
 *
 *   npm run check:version          对账，有问题退出码 1
 *
 * 只读，不改。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const problems = [];
const fail = (message) => problems.push(message);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ------------------------------------------------------------ 三处配置 */

const source = JSON.parse(read("package.json")).version;
if (!source) fail("package.json 里没有 version —— 形状变了，别猜着改");

const cargo = read("src-tauri/Cargo.toml").match(/^version *= *"([^"]+)"/m)?.[1] ?? null;
const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version ?? null;

// 为什么三处都要：tauri.conf.json 决定安装包的文件名（`Lattice_<版本>_x64-setup.exe`），
// Cargo.toml 决定 exe 里的元数据，package.json 是给人看的那一份。
// 只对两处的话，第三处会慢慢漂走，而漂走的那一处正好是 release.yml 拿来比对 tag 的。
for (const [label, value] of [
  ["src-tauri/Cargo.toml", cargo],
  ["src-tauri/tauri.conf.json", tauri],
]) {
  if (value === null) fail(`${label} 里读不到 version —— 形状变了，别猜着改`);
  else if (value !== source) fail(`${label} 是 ${value}，package.json 是 ${source}`);
}

/* ------------------------------------------------------------ 入口文档 */

/**
 * 三份入口文档里"源码版本"那一句。
 *
 * 写正则而不是"文件里出现过这个数"：后者在别处顺带提一句就绿了，而真正要钉的是
 * **那句话还在、还指着源码**。写法变了就红 —— 和 `stats.mjs` 的 CLAIMS 同一条规矩：
 * 失配意味着有人改了说法，那种事必须有人看一眼。
 */
const DOCS = [
  { file: "README.md", pattern: /the source tree is `(\d+\.\d+\.\d+)`/ },
  { file: "README.zh-CN.md", pattern: /源码是 `(\d+\.\d+\.\d+)`/ },
  { file: "AGENTS.md", pattern: /源码是 `(\d+\.\d+\.\d+)`/ },
];

for (const doc of DOCS) {
  const match = read(doc.file).match(doc.pattern);
  if (match === null) {
    fail(
      `${doc.file} 里找不到「源码版本」那一句（${doc.pattern}）—— 写法变了，` +
        `正则需要跟着改；别删掉这句话，三份入口都要说清源码是哪个数`,
    );
    continue;
  }
  if (match[1] !== source) {
    fail(`${doc.file} 写的是 ${match[1]}，配置里是 ${source}`);
  }
}

/* ------------------------------------------------------------ 输出 */

console.log("版本对账：\n");
console.log(
  `  配置      package.json ${source}  ·  Cargo.toml ${cargo ?? "?"}  ·  tauri.conf.json ${tauri ?? "?"}`,
);
console.log(`  入口文档  README.md / README.zh-CN.md / AGENTS.md 的「源码版本」= ${source}`);
console.log("  能下载到  **不在这里** —— 它在 GitHub Releases 上，写死一个数就会和事实脱钩");

if (problems.length) {
  console.log(`\n${problems.length} 处对不上：\n`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log("\n源码版本的真源是 package.json；改版本就三处配置 + 三份入口一起改。");
  process.exit(1);
}

console.log("\n全部对上。");
