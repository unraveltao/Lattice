/**
 * 跑一遍 `tests/*.html` 里的断言。
 *
 *   npm run dev                 # 另一个终端；测试页要 dev server 才能 import .ts/.tsx
 *   npm run test:browser
 *   npm run test:browser -- --base http://localhost:1420 --filter catalogue
 *   CHROME=/path/to/chrome npm run test:browser
 *
 * # 为什么要有这个脚本
 *
 * 36 个断言页、1357 条断言，以前是"打开看一眼"：那叫抽查，不叫验收。断言结果本来
 * 就写进 `<pre id="out">` 里了，拿一次 DOM 就能数出来 —— 于是这件事可以变成一条
 * 命令、一个退出码，也就能进 CI。（现在是 53 页 / 2539 条，脚本自己会数对。）
 *
 * # 为什么用 `--dump-dom` 而不是 CDP
 *
 * 结果已经在 DOM 里了，不需要再开一个 websocket 客户端。CDP 会多一个依赖，
 * 而这个脚本的价值在于"谁都跑得起来、CI 里不用装浏览器驱动"。
 *
 * `--virtual-time-budget` 必须给足：页面里的 `setTimeout` / `await` 要跑完，
 * 给少了截到的是 `running…` —— 那会让"没跑完"看起来像"没有断言"。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 不是断言页、只被别的页面当夹具加载的页。
 *
 * 它们也有 `#out`，但一条 PASS 都不会写 —— 期望值就是 0，别当成失败。
 * 新加夹具页要往这里加一条，否则脚本会报"0 条断言"。
 */
const FIXTURES = new Set(["sdk-child"]);

/** 页面里 `setTimeout` 最长等多久。给足，慢机器上也不至于截到一半 */
const BUDGET_MS = 9000;

function flag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const base = flag("--base", "http://localhost:1420").replace(/\/+$/, "");
const filter = flag("--filter");
const budget = flag("--budget", String(BUDGET_MS));

/** 按平台常见位置找 Chrome。找不到就让调用方用 `CHROME=` 指一个 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;

  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("\n  找不到 Chrome。用 CHROME=<可执行文件路径> 指定一个，或者装一个。\n");
  process.exit(1);
}

const pages = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".html"))
  .map((name) => name.slice(0, -".html".length))
  .filter((name) => !filter || name.includes(filter))
  .sort();

if (pages.length === 0) {
  console.error(`\n  tests/ 下没有匹配 ${filter ?? "*"} 的页面\n`);
  process.exit(1);
}

/** 一页的输出：条数、失败条数、失败明细 */
function runPage(name) {
  /*
   * 每一页一个**全新的 profile 目录**。
   *
   * 不给 `--user-data-dir` 时 Chrome 会用默认 profile，而连续拉起二十几次
   * 共用同一个 profile 会撞锁：在 CI 上表现是随机的几页 `ETIMEDOUT`，
   * 本地因为快、又常常复用同一个实例，看不出来。每页一个临时目录最省事。
   */
  const profile = mkdtempSync(join(tmpdir(), "lattice-chrome-"));

  try {
    const result = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        `--user-data-dir=${profile}`,
        /*
         * 界面文案有了中英两套之后，断言必须钉在**一种**语言上。
         *
         * 有些页面断言的正是"用户看得见的那句话"（`describeAge` 的 `5 minutes ago`、
         * 商店卡片上的状态词），而那些字现在走 `t()`，取的是 `navigator.languages`。
         * 不钉的话，同一页在中文机器上红、在英文机器上绿 —— 最坏的一种不稳定：
         * 本地全过、换台机器全红。
         */
        "--lang=en-US",
        `--virtual-time-budget=${budget}`,
        "--dump-dom",
        `${base}/tests/${name}.html`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    );

    if (result.error) return { name, error: String(result.error), total: 0, failed: 0, lines: [] };

    const html = result.stdout ?? "";
    const block = html.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
    if (!block) {
      // 页面根本没渲染出来：多半是 dev server 没起，或者这一页 import 时就抛了
      return { name, error: "no #out block — is the dev server running?", total: 0, failed: 0, lines: [] };
    }

    const lines = block[1]
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("PASS ") || line.startsWith("FAIL "));

    const failed = lines.filter((line) => line.startsWith("FAIL "));
    return { name, error: null, total: lines.length, failed: failed.length, lines: failed };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

console.log(`\n  ${base}   chrome: ${chrome}\n`);

let total = 0;
let failed = 0;
const problems = [];
/** 有自己的 FAIL 行的页。要进最后那份小结 —— 不然"哪一页红的"只出现在列表中间，
 *  而 CI 只把**最后十几行**写成 annotation（见 ci.yml 的 "Run every self-check page"），
 *  结论就是"看见红色、看不见红在哪"，只能整轮重跑。 */
const failing = [];

for (const name of pages) {
  const page = runPage(name);

  if (page.error) {
    console.log(`  ${name.padEnd(20)} ——  ${page.error}`);
    problems.push(`${name}: ${page.error}`);
    continue;
  }

  if (page.total === 0) {
    if (FIXTURES.has(name)) {
      console.log(`  ${name.padEnd(20)} 夹具页（没有断言，正常）`);
      continue;
    }
    console.log(`  ${name.padEnd(20)}   0 条 —— 一条断言都没跑完`);
    problems.push(`${name}: 0 assertions (did it finish?)`);
    continue;
  }

  total += page.total;
  failed += page.failed;
  if (page.failed > 0) failing.push(`${name}: ${page.failed} 条断言失败`);
  console.log(
    `  ${name.padEnd(20)} ${String(page.total).padStart(3)} 条   ${page.failed === 0 ? "全过" : `FAIL ${page.failed}`}`,
  );
  for (const line of page.lines.slice(0, 5)) {
    console.log(`      ${line}`);
  }
  if (page.lines.length > 5) console.log(`      …… 还有 ${page.lines.length - 5} 条`);
}

console.log(`\n  ${pages.length - problems.length} 页 / ${total} 条断言，FAIL ${failed}\n`);

if (problems.length > 0 || failed > 0) {
  // 先报"哪一页红了几条"，再报"哪一页压根没跑起来"：前者是断言里的真问题，
  // 后者多半是环境（dev server 没起）。两类都要在最后几行里出现。
  for (const problem of [...failing, ...problems]) console.error(`  ! ${problem}`);
  console.error("");
  process.exit(1);
}
