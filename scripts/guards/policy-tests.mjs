#!/usr/bin/env node
/**
 * 纯逻辑层的守门人：每个 `*_policy.rs` 都要能 `rustc --test` 单跑，并且跑绿。
 *
 * 这个仓库把"能判对错的逻辑"从副作用里拆出来放进 `*_policy.rs`，唯一目的是
 * **不装 cargo 也能验**：`cargo test` 在这台机器上起不来（`0xc0000139`，
 * target/debug/deps 下的 exe 被安全策略拦），所以整个 Rust 测试面只剩 CI 那一次。
 * 拆出来的这些文件是唯一的例外 —— 它们零依赖，`rustc --test` 一条命令就能跑。
 *
 * 而这个例外靠人记着。一旦有人在 `xxx_policy.rs` 里加一句 `use crate::state;`
 * 或者一个 `serde_json::json!`，它就悄悄变成"只能 cargo test"，而本机没有任何
 * 信号 —— 下次改它的人照样以为跑一下 rustc 就够了，结果测的是上一次编出来的旧
 * 二进制（或者干脆什么都没跑）。所以这里逐条盯着：
 *
 *   1. 能编：`rustc --test` 过。需要兄弟模块的，自动拼一个 shim 根，不用人管。
 *   2. 跑绿：测试二进制退出码 0，且输出里 `0 failed`。
 *   3. 有测试：一条 `#[test]` 都没有的"纯逻辑文件"是放错了地方。
 *   4. 豁免不腐烂：写进 NOT_STANDALONE 的文件如果哪天又能单跑了，也要报 ——
 *      否则那张名单只会越来越长，长到最后没人知道里面还剩几条是真的。
 *
 *   npm run check:policy-tests          全量，约 14 秒（编译）；没改过的文件走缓存，约 1 秒
 *
 * 编译产物落在 `.scratch/guards/policy/`（gitignore 里），按内容哈希判新旧。
 *
 * 只读，不改。没有 rustc 就跳过（打印一行说明，退出码 0）—— 这一条是给 pre-push
 * 用的，CI 的 rust job 上 rustc 一定在。
 */
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src-tauri", "src");
const CACHE = path.join(ROOT, ".scratch", "guards", "policy");
const EXE = process.platform === "win32" ? ".exe" : "";

const problems = [];
const fail = (message) => problems.push(message);

/**
 * 需要别的东西才能单跑的。**名单越短越好**，每一条都要写清"差什么"。
 * 判据是"它为什么不是零依赖"，不是"它现在编不过" —— 后者是症状，前者是理由。
 */
const NOT_STANDALONE = new Map([
  [
    "catalogue_policy.rs",
    "用了 serde_json（`json!` 宏），单跑要先有一个 rlib；它的测试跟着 cargo test 跑",
  ],
]);

/* ------------------------------------------------------------ rustc */

let rustcVersion = "";
try {
  rustcVersion = (await execFileAsync("rustc", ["--version"], { encoding: "utf8" })).stdout.trim();
} catch {
  console.log("policy 测试：这台机器上没有 rustc，跳过（CI 的 rust job 会跑）。");
  process.exit(0);
}

/* ------------------------------------------------------------ 收集 */

function policyFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith("_policy.rs")) files.push(full);
    }
  };
  walk(SRC);
  return files.sort();
}

/** `crate::foo` 里那些能在同目录找到文件的模块，递归展开成 shim 需要的 `mod` 列表。 */
function siblingModules(file, seen = new Set()) {
  const source = fs.readFileSync(file, "utf8");
  const modules = [];
  for (const match of source.matchAll(/\bcrate::(\w+)/g)) {
    const name = match[1];
    if (seen.has(name)) continue;
    const candidate = path.join(path.dirname(file), `${name}.rs`);
    if (!fs.existsSync(candidate)) continue;
    seen.add(name);
    modules.push({ name, file: candidate });
    modules.push(...siblingModules(candidate, seen));
  }
  return modules;
}

const slash = (value) => value.split(path.sep).join("/");

/* ------------------------------------------------------------ 编译 */

async function build(file, { force = false } = {}) {
  const name = path.basename(file, ".rs");
  const deps = siblingModules(file);
  const shimmed = deps.length > 0;

  // 缓存键要覆盖**参与编译的每一份源码**：只哈希自己，改了被依赖的兄弟模块就会
  // 拿旧二进制跑，而那时通过的是上一次的代码 —— 比不跑更坏。
  const hash = crypto.createHash("sha1").update(rustcVersion);
  for (const part of [file, ...deps.map((dep) => dep.file)]) hash.update(fs.readFileSync(part));
  const digest = hash.digest("hex").slice(0, 16);

  fs.mkdirSync(CACHE, { recursive: true });
  const stampPath = path.join(CACHE, `${name}.stamp`);
  const exePath = path.join(CACHE, `${name}${EXE}`);
  const stamp = `${digest}${shimmed ? " shim" : ""}`;

  if (
    !force &&
    fs.existsSync(exePath) &&
    fs.existsSync(stampPath) &&
    fs.readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    return { name, file, exePath, stampPath, deps, cached: true };
  }

  let input = file;
  if (shimmed) {
    const shimPath = path.join(CACHE, `${name}_shim.rs`);
    const lines = [
      "// 由 scripts/guards/policy-tests.mjs 生成，别手改。",
      ...deps.map((dep) => `#[path = "${slash(dep.file)}"] mod ${dep.name};`),
      `#[path = "${slash(file)}"] mod target;`,
    ];
    fs.writeFileSync(shimPath, `${lines.join("\n")}\n`);
    input = shimPath;
  }

  try {
    // `--crate-name` 必须显式给：rustc 默认拿文件名当 crate 名，而 shim 叫
    // `xxx_shim.rs`、路径里还有盘符 —— 一旦名字里有 `.` 或别的字符就直接拒绝编译，
    // 报的还是一句"crate name 里有非法字符"，看起来像环境问题。
    await execFileAsync(
      "rustc",
      ["--test", "--edition", "2021", "--crate-name", `guard_${name}`, "-A", "dead_code", "-o", exePath, input],
      { encoding: "utf8" },
    );
  } catch (error) {
    return { name, file, deps, error: (error.stderr ?? String(error)).trim() };
  }

  fs.writeFileSync(stampPath, `${stamp}\n`);
  return { name, file, exePath, stampPath, deps, cached: false };
}

/* ------------------------------------------------------------ 运行 */

function run(exePath, filter = []) {
  try {
    // 注意：`execFileSync` 直接返回 stdout（字符串），不是 `{ stdout }` ——
    // 那个形状是异步的 `execFile`。按异步的形状解构，拿到的是 undefined，
    // 于是每个文件都报"读不到 test result"，而二进制其实跑得好好的。
    const stdout = execFileSync(exePath, filter, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return parse(stdout);
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const parsed = parse(output);
    // 进程根本没起来（EPERM / ENOENT / 被安全软件拦）时 stdout 和 stderr 都是空的。
    // 只报"读不到 test result"会把人引去翻测试代码，而问题在"跑不起来"这一层。
    if (parsed.passed === null && output.trim() === "") {
      parsed.spawnError = `${error.code ?? ""} ${error.message ?? ""}`.trim();
    }
    return parsed;
  }
}

function parse(output) {
  const summary = output.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (!summary) return { passed: null, failed: null, output };
  return { passed: Number(summary[1]), failed: Number(summary[2]), output };
}

const failureLines = (output) =>
  output
    .split("\n")
    .filter((line) => /^failures:|^---- |^test .* FAILED|panicked at/.test(line))
    .slice(0, 8)
    .join("\n");

/* ------------------------------------------------------------ 主流程 */

const started = Date.now();
const files = policyFiles();
if (files.length === 0) {
  console.error("✗ src-tauri/src 下一个 *_policy.rs 都没找到 —— 目录结构变了？");
  process.exit(1);
}

/**
 * 一次开 N 个 rustc 是这里唯一的加速手段：31 个文件串行要 39 秒，而 pre-push 钩子
 * 一旦超过半分钟就会被 `--no-verify` 绕过 —— 那时候它连现在这点用都没有了。
 * 并行只影响首次编译；改过一个文件之后走缓存，只剩跑二进制的那 1 秒。
 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// 1. 先全部编一遍（并行）。没测试的文件不编，省时间。
const withTests = files.filter((file) => (fs.readFileSync(file, "utf8").match(/#\[test\]/g) ?? []).length > 0);
for (const file of files) {
  if (withTests.includes(file)) continue;
  fail(`${path.basename(file)} 一条 #[test] 都没有 —— 纯逻辑放这里的意义就是能单跑，没测试就没意义`);
}

const builtList = await pool(withTests, Math.min(8, os.cpus().length), (file) => build(file));

// 2. 再逐个判定 + 跑。顺序和文件名一致，输出稳定。
let compiled = 0;
let passedTotal = 0;
const results = [];

for (let index = 0; index < builtList.length; index += 1) {
  let built = builtList[index];
  const { name } = built;
  if (built.cached === false) compiled += 1;

  if (built.error) {
    const needsExternal = /E0432|E0433/.test(built.error);
    // 豁免名单按**文件名**（带 .rs）索引 —— 和人在仓库里 grep 到的那个字符串一致，
    // 而不是去掉后缀的词干。混用两种写法会得到"名单里明明有它，却报编不过"。
    const exempt = NOT_STANDALONE.get(path.basename(built.file));
    if (exempt && needsExternal) {
      results.push({ name, status: "exempt", note: exempt });
      continue;
    }
    if (exempt && !needsExternal) {
      // 豁免的理由是"缺一个外部依赖"，不是"随便什么错都不管"
      fail(`${name} 在豁免名单里，但这次是别的错（不是缺依赖）：\n${built.error.split("\n").slice(0, 6).join("\n")}`);
      continue;
    }
    fail(`${name} 编不过 —— 它已经不能单跑了：\n${built.error.split("\n").slice(0, 6).join("\n")}`);
    continue;
  }

  if (NOT_STANDALONE.has(path.basename(built.file))) {
    fail(
      `${name} 现在能单跑了 —— 从 NOT_STANDALONE 里删掉这条（理由：${NOT_STANDALONE.get(path.basename(built.file))}）`,
    );
    continue;
  }

  // 走 shim 的文件：兄弟模块的测试也被编进同一个二进制里，直接跑会把它们一起
  // 算进这个文件的条数（`secrets_policy` 会报 67 条，其中 50 条是 `llm_policy` 的）。
  // 所以给 libtest 一个过滤词 —— 它按名字做子串匹配，`target::` 只留这个文件自己的。
  const filter = built.deps.length > 0 ? ["target::"] : [];
  let result = run(built.exePath, filter);

  // 缓存里的二进制可能已经坏了：上一次被中断的删除、磁盘满、被安全软件截断。
  // 拿一个坏二进制报"读不到 test result"会让人去改脚本，而真正该做的是重编一次。
  if (result.passed === null) {
    built = await build(built.file, { force: true });
    compiled += 1;
    if (built.error) {
      fail(`${name} 重编之后还是编不过：\n${built.error.split("\n").slice(0, 6).join("\n")}`);
      continue;
    }
    result = run(built.exePath, filter);
  }

  if (result.passed === null) {
    fail(
      `${name} 跑完了但读不到 test result —— 输出形状变了：\n${
        result.spawnError ?? (failureLines(result.output) || result.output.split("\n").slice(0, 6).join("\n"))
      }`,
    );
    continue;
  }
  if (result.failed > 0) {
    fail(`${name} 有 ${result.failed} 条测试没过：\n${failureLines(result.output)}`);
    continue;
  }
  passedTotal += result.passed;
  results.push({ name, status: "ok", passed: result.passed });
}

/* ------------------------------------------------------------ 输出 */

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const ok = results.filter((result) => result.status === "ok");
const exempt = results.filter((result) => result.status === "exempt");

if (problems.length) {
  console.error(`policy 测试：${problems.length} 处要修\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\n见本文件头部：`*_policy.rs` 的存在意义就是零依赖、能 rustc --test 单跑。");
  process.exit(1);
}

console.log(
  `policy 测试通过：${ok.length} 个文件 ${passedTotal} 条（编译 ${compiled} 个，缓存 ${ok.length - compiled} 个，${elapsed}s）。`,
);
for (const item of exempt) console.log(`  · ${item.name} 跳过：${item.note}`);
