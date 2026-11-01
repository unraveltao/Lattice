#!/usr/bin/env node
/**
 * 门禁的守门人：管的是「写了，但永远不会有人跑到它」。
 *
 * 这一条盯的不是代码，是**门禁自己**。前面五个守门人都在问"代码和文档对不对得上"，
 * 没人问"这些守门人会不会真的被执行"。四种漏法都不报错：
 *
 *   1. workflow 里拼错一个脚本名（`check:verison`）—— `npm run` 在本机不会替你
 *      检查拼写，YAML 也照样合法，只有 CI 跑起来才红，而那时候已经推到远端了。
 *   2. `ci.yml` 里多写一条命令 —— 它和 `release.yml` 就又变成两份清单。2026-10-31
 *      之前正是这样：同一提交上 release 成功、ci 失败（40882357297 对 40882358315）。
 *   3. release 的 build 不 `needs` 门禁 —— 那"发得出去"和"测过了"重新变成两件事。
 *   4. 新写的守门人没接进 `check:guards` 链，或者接了链却没进 `verify.yml` ——
 *      前者是 pre-push 也不跑，后者是 CI 不跑。两种都等于没写。
 *
 * 顺带查两个会让 GitHub **直接拒收**文件、或者让 job 卡住的形状：tab（YAML 不许
 * tab 缩进）和 job 没有 `timeout-minutes`（默认 6 小时，卡住时没人知道）。
 *
 *   npm run check:gates
 *
 * 只读，不改。没有 YAML 解析器也能查这些 —— 它们全是行首形状，不依赖解析。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const problems = [];
const fail = (message) => problems.push(message);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/**
 * 去掉整行注释和行尾注释再查。
 *
 * 为什么必须去：这些 workflow 的注释里到处在讲"以前只跑 `npm run typecheck`"。
 * 不剥掉的话，`ci.yml` 那条"不许出现 npm run"会被自己的注释判红 —— 而一条会
 * 被注释误伤的规则，最后一定会被人删掉，而不是修好。
 */
const stripComments = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/(^|\s)#\s.*$/, ""))
    .join("\n");

/**
 * 把 `jobs:` 下面那一层拆成 { job名 -> 该 job 的原始行[] }。
 *
 * 手写而不是上 YAML 解析器：仓库里一个依赖都不许引（组件是纯静态目录，脚本这边
 * 也一直只有 node 内置模块）。而这些文件只用到了「两空格一个 job、四空格一个键」，
 * 够用了；真出现解析不了的花样，`jobs:` 会读成空、这里立刻报红。
 */
function parseJobs(code) {
  const lines = code.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "jobs:");
  if (start < 0) return null;

  const jobs = new Map();
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break; // 回到顶层键，jobs 结束
    const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (head) {
      current = { name: head[1], body: [] };
      jobs.set(head[1], current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return jobs;
}

/** `needs:` 的三种写法（行内标量 / 行内数组 / 块状列表）都读。 */
function needsOf(job) {
  const index = job.body.findIndex((line) => /^ {4}needs:/.test(line));
  if (index < 0) return [];
  const inline = job.body[index].replace(/^ {4}needs:\s*/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/[[\]]/g, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (inline) return [inline];
  const list = [];
  for (let i = index + 1; i < job.body.length; i++) {
    const item = job.body[i].match(/^ {6}- (.+)$/);
    if (!item) break;
    list.push(item[1].trim());
  }
  return list;
}

/* ------------------------------------------------------- 三个 workflow 的形状 */

const WORKFLOWS = ["ci.yml", "release.yml", "verify.yml"];
const code = {};

for (const file of WORKFLOWS) {
  const rel = `.github/workflows/${file}`;
  if (!exists(rel)) {
    fail(`${rel} 不见了 —— 三个 workflow 缺一个，门禁就断了一环`);
    continue;
  }
  const raw = read(rel);
  code[file] = stripComments(raw);

  // tab：YAML 不允许 tab 缩进，GitHub 会直接拒收整个文件（不是拒收那个 job）。
  // 这条本机看不出来 —— 编辑器里 tab 和两个空格长得一样宽。
  const tabLine = code[file].split(/\r?\n/).findIndex((line) => line.includes("\t"));
  if (tabLine >= 0) {
    fail(`${rel} 第 ${tabLine + 1} 行有 tab —— YAML 不许 tab 缩进，GitHub 会拒收整个文件`);
  }

  for (const key of ["name", "on", "jobs"]) {
    if (!new RegExp(`^${key}:`, "m").test(code[file])) {
      fail(`${rel} 顶层没有 \`${key}:\` —— 形状不对`);
    }
  }

  const jobs = parseJobs(code[file]);
  if (jobs === null) {
    fail(`${rel} 读不出 \`jobs:\` 下面那一层 —— 形状变了，这个守门人要跟着改`);
    continue;
  }
  if (jobs.size === 0) fail(`${rel} 里一个 job 都没有`);

  // timeout-minutes：没写就是默认 6 小时。卡住的 job 会占着 runner 六个小时，
  // 而失败信息里只有"超时"两个字，看不出卡在哪一步。
  //
  // **调别人的 job 不算**：`uses: ./.github/workflows/x.yml` 那种 job 只接受
  // name/uses/with/secrets/strategy/needs/if/concurrency/permissions，写
  // `timeout-minutes` 会被 GitHub 判成非法键、整个文件拒收。超时归被调用的那份管，
  // 它自己每个 job 都有 —— 所以这里跳过 `uses:` 的 job。
  for (const job of jobs.values()) {
    if (job.body.some((line) => /^ {4}uses:/.test(line))) continue;
    if (!job.body.some((line) => /^ {4}timeout-minutes:/.test(line))) {
      fail(`${rel} 的 job \`${job.name}\` 没有 timeout-minutes —— 默认 6 小时`);
    }
  }
}

/* --------------------------------------------------- 命令清单只有一份，且被等着 */

if (code["verify.yml"]) {
  // 被 `uses:` 调用的工作流必须声明 `workflow_call`，否则调用方会以
  // "workflow is not reusable" 失败 —— 而那句话不会指出是这里少了三行。
  if (!/^ {2}workflow_call:\s*$/m.test(code["verify.yml"])) {
    fail("verify.yml 的 `on:` 下面没有 `workflow_call:` —— ci 和 release 都调不动它");
  }
}

const CALLS = "./.github/workflows/verify.yml";
for (const file of ["ci.yml", "release.yml"]) {
  if (!code[file]) continue;
  if (!code[file].includes(`uses: ${CALLS}`)) {
    fail(`${file} 没有调用 ${CALLS} —— 两边的门禁又开始各走各的了`);
  }
}

if (code["ci.yml"] && /npm run [a-z0-9:_-]+/.test(code["ci.yml"])) {
  fail(
    "ci.yml 里出现了 `npm run` —— 这一页只回答「什么时候跑」，命令清单只有 verify.yml 一份。" +
      "要加检查就加到 verify.yml（ci 和 release 都会跑到），别只加在 ci 里",
  );
}

if (code["release.yml"]) {
  const jobs = parseJobs(code["release.yml"]);
  if (jobs) {
    const build = jobs.get("build");
    if (!build) {
      fail("release.yml 里没有 `build` job —— 名字变了，这条规则要跟着改");
    } else {
      const needs = needsOf(build);
      for (const required of ["guard", "verify"]) {
        if (!needs.includes(required)) {
          fail(
            `release.yml 的 build 没有 needs \`${required}\`（现在是 [${needs.join(", ")}]）—— ` +
              "构建必须等门禁跑完，否则「发得出去」又会不等于「测过了」",
          );
        }
      }
    }
  }
}

/* ------------------------------------------------------- 点名的 npm 脚本存在 */

const scripts = JSON.parse(read("package.json")).scripts ?? {};
for (const file of WORKFLOWS) {
  if (!code[file]) continue;
  for (const match of code[file].matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    if (!(match[1] in scripts)) {
      fail(
        `.github/workflows/${file} 里跑 \`npm run ${match[1]}\`，但 package.json 没有这个脚本 —— ` +
          "拼错一个字母，本机不会红，只有 CI 会",
      );
    }
  }
}

/* ------------------------------------------------ 守门人自己接没接进门禁链 */

const GUARD_DIR = "scripts/guards";
const guardFiles = fs
  .readdirSync(path.join(ROOT, GUARD_DIR))
  // `*.test.mjs` 是某个守门人的单测，不是守门人本身 —— 它由 `npm run test:*` 跑，
  // 不该被要求接进 check:guards（否则给守门人补单测的人会先被这条判红）。
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));

const chain = scripts["check:guards"] ?? "";
if (!chain) fail("package.json 里没有 `check:guards` —— pre-push 和 CI 都靠它");

/** 哪个 npm 脚本在跑这个守门人文件（用来给报错指路，也用来查 verify.yml）。 */
const scriptOf = new Map();
for (const [name, command] of Object.entries(scripts)) {
  // 只认"整个脚本就是跑这一个文件"的写法。`check:guards` 是串起来的链，
  // 它里面的第一个 `node .../bridge.mjs` 会让 bridge 被记成 `check:guards`，
  // 于是拿它去 verify.yml 里找 `npm run check:guards` —— 那不是跑单个守门人的脚本。
  const match = command.match(new RegExp(`^node ${GUARD_DIR}/([\\w-]+\\.mjs)$`));
  if (match) scriptOf.set(match[1], name);
}

for (const guard of guardFiles) {
  if (!chain.includes(`${GUARD_DIR}/${guard}`)) {
    fail(
      `${GUARD_DIR}/${guard} 没接进 \`check:guards\` 链 —— 它永远不会被跑到，等于没写。` +
        "接进链里的同时记得也在 verify.yml 里加一行（CI 跑的是那一条）",
    );
    continue;
  }
  const name = scriptOf.get(guard);
  if (!name) {
    fail(`${GUARD_DIR}/${guard} 没有自己的 npm 脚本 —— 单独复现某一条红的时候没地方跑`);
    continue;
  }
  if (code["verify.yml"] && !code["verify.yml"].includes(`npm run ${name}`)) {
    fail(
      `\`npm run ${name}\` 在 check:guards 链里，但 verify.yml 没有跑它 —— ` +
        "pre-push 会红、CI 却绿，两边不一致",
    );
  }
}

/* ------------------------------------------------------------ 输出 */

console.log("门禁对账：\n");
console.log(`  workflow  ${WORKFLOWS.join(" / ")}`);
console.log(`  命令清单  verify.yml（ci 与 release 都 uses 它）`);
console.log(`  守门人    ${guardFiles.map((name) => name.replace(/\.mjs$/, "")).join(" / ")}`);

if (problems.length) {
  console.log(`\n${problems.length} 处对不上：\n`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log("\n这一条查的是「门禁会不会被跑到」，不是「代码对不对」—— 所以上面每一条都要修，不能放宽。");
  process.exit(1);
}

console.log("\n全部对上：脚本名都在、清单只有一份、每个守门人都接进了 pre-push 和 CI。");
