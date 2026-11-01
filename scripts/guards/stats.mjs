#!/usr/bin/env node
/**
 * 数字的守门人：文档里每一个"现在有多少条 X"都要和 `scripts/stats.mjs` 数出来的对上。
 *
 * 为什么单独一条命令：这个仓库最贵的腐烂是**静默不一致**，而数字是最安静的那一种 ——
 * 代码改了、文档没改，`tsc` 不红、测试不红、界面照跑，只有读到那句话的人被误导。
 * 更糟的是它有两个方向，而人们只防第一个：
 *
 *   - **漂了**：代码 31 个方法，文档还写 27。读者以为桥只有 27 个。
 *   - **看起来漂了，其实没漂**：文档写 27 是因为它在记 **v0.13 那一刻**，
 *     而现在真的是 31。这种"历史数"和上一种是**同一串字符**，读者分不出来 ——
 *     所以历史数必须带版本或日期，否则它和错误无法区分。
 *
 * 于是这里有两类声明：
 *
 *   - `current`    —— 陈述**当前**状态。必须等于实测，不等就红。
 *   - `historical` —— 陈述**某一版**的状态。值可以旧，但那一行（或它所在的小节）
 *                    必须带版本号 / 日期 / "当时"这类词，否则红。
 *
 * 还有一张**网**（`SWEEP`）：按短语形状扫全仓库，扫到没登记的命中就红。它防的是
 * "新写一份文档又抄了一个数"。网不是证明 —— 换个说法就漏过去了，但它能把最常见
 * 的三种形状（"N 个方法"、"N 项能力"、"| 权限 | N |"）兜住。
 *
 * ## 作用域
 *
 * 每个声明都带 `metric`，而 metric 在 `stats.mjs` 里有 `scope`：
 * `global` 的数写"现在 N 条"就够了；`subsystem` 的数**必须带主语**（"agent 的九个动作"），
 * 否则读者会把它当成全局数 —— `docs/ROADMAP.md` 的 v0.8 行写"8 个白名单动作"、
 * `AGENTS.md` 写"9 个白名单动作"，两句话长得一样，差的却是 v0.13 的 0037 给那张
 * 白名单加了 `config.set`。
 *
 *   npm run check:stats          对账，有问题退出码 1
 *   npm run check:stats -- --audit   连"历史数、没拦"的也逐条列出来
 *
 * 只读，不改。
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT, METRICS, counts } from "../stats.mjs";

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);
const AUDIT = process.argv.includes("--audit");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const values = counts();

/* ------------------------------------------------------------ 小工具 */

/** `4 474` / `86 页 4 474 条` 都认：先抹掉数字之间的空格，再抓每一段数字。 */
function numbers(cell) {
  return (cell.match(/\d[\d\s]*/g) ?? [])
    .map((chunk) => Number(chunk.replace(/\s/g, "")))
    .filter(Number.isFinite);
}

/** `| **Label** | 值 |` 这一行里的第二格，以及那一行在全文里的位置。 */
function tableRow(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\|\\s*\\*{0,2}${escaped}\\*{0,2}\\s*\\|([^|]*)\\|`));
  // 位置要的是**整行开头**，不是那格文字第一次出现的地方 —— 值通常是个短数字
  // （`24`），`indexOf` 会撞上前文任意一处 `24`，于是"已登记"记到了别的行上，
  // 真正的表格行反而被当成没登记。
  if (!match) return null;
  const start = text.lastIndexOf("\n", match.index) + 1;
  return { cell: match[1], index: start };
}

/** 「九」「十一」「二十三」—— 只到九十九，够用了。 */
function chineseNumber(text) {
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!text.includes("十")) return digits[text] ?? null;
  const [tens, ones] = text.split("十");
  const high = tens === "" ? 1 : digits[tens];
  const low = ones === "" ? 0 : digits[ones];
  if (high === undefined || low === undefined) return null;
  return high * 10 + low;
}

/**
 * `nineteen` / `Fifteen` / `twenty-four` —— 英文数词。
 *
 * 为什么需要：`CODE_SIGNING.md` 那段是给 Winget 提交用的英文文案，里面的数写成
 * "nineteen official widgets"、"422 Rust unit tests"。中文数字早有 `chineseNumber`
 * 管，英文数词没有 —— 于是那三个数在代码块里烂了很久（19 vs 24、422 vs 618），
 * 而 `check:stats` 一声不吭。**两种语言的数词是同一类问题**，只认其中一种等于没认。
 */
function englishNumber(text) {
  const words = {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
  };
  const key = text.toLowerCase().trim().replace(/\s+/g, "-");
  if (words[key] !== undefined) return words[key];
  const [tens, ones] = key.split("-");
  if (words[tens] !== undefined && words[ones] !== undefined) return words[tens] + words[ones];
  return null;
}

/**
 * 一份文档的坐标是不是"过去"。
 *
 * `docs/design/` 的每一份都带 `date:`，`reference/history.md` 整个就是"当时怎么做"。
 * 这些文件里的数是**快照**，不该跟着代码走 —— 要求它们等于当前值等于要求人
 * 回头改历史，而这个仓库明说了"旧的记当时为什么这么想"。
 *
 * 但豁免是有条件的：**`date:` 得真的在**。没有日期头，读者无从知道 27 是哪一天的
 * 27，它就退化成"写错了的 31" —— 那正是这一整条检查要消灭的东西。
 */
const PAST_BY_COORDINATE = [/^docs\/design\/LAT-\d{4}-/, /^docs\/reference\/history\.md$/];

const isPastByCoordinate = (file) => PAST_BY_COORDINATE.some((pattern) => pattern.test(file));

/** design 文档的 front matter 里那句 `date: 2026-10-26`。 */
function frontMatterDate(text) {
  const head = text.split("\n---")[0];
  return head.match(/^date:[ \t]*(\S+)[ \t]*$/m)?.[1] ?? null;
}

/** 历史数的"身份证"：版本号、日期，或者一句明确说这是过去的话。 */
const LABEL = /v0\.\d+|\b\d{4}-\d{2}-\d{2}\b|当时|截至|历史|快照|原来|已有|那一版|上一版/;

/**
 * 找这一行所属小节的标题（`##` / `**加粗**` 那两种），看里面有没有版本或日期。
 *
 * 表格里的行自己通常不带版本（`| Tauri 命令 | 99 个 |`），版本写在表头那句
 * `**当前规模**（截至 2026-10-26）：` 里 —— 只查行内的话，一张标好了日期的表
 * 会整张判红，而它其实是对的。
 */
function sectionLabel(text, lineNumber) {
  const lines = text.split("\n");
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*/.test(line)) {
      if (LABEL.test(line)) return line;
      // 标题本身不带标签就继续往上找一层：`## 四、…` 底下可能是 `**当前规模**（…）`。
      // 但只往上找两屏，再远就不是"这个数所在的小节"了。
      if (lineNumber - index > 40) return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------ 声明表 */

/**
 * 每一条 = 文档里的一处数字。
 *
 * `pattern` 只给一个捕获组，抓到的就是那个数（中文数字也行，会过 `chineseNumber`）。
 * 写正则而不是行号：行号每天都在动，正则只在**写法变了**的时候失配 —— 而"写法变了"
 * 正是这套检查最该喊出来的事（失配 = 静默放过，这个仓库吃过太多次）。
 */
const CLAIMS = [
  /* ---- README：两张表（中英各一份，必须写同一个数） ---- */
  { id: "readme.en.widgets", file: "README.md", metric: "officialWidgets", kind: "current", table: "Official widgets" },
  { id: "readme.zh.widgets", file: "README.zh-CN.md", metric: "officialWidgets", kind: "current", table: "官方组件" },
  { id: "readme.en.permissions", file: "README.md", metric: "permissions", kind: "current", table: "Permissions" },
  { id: "readme.zh.permissions", file: "README.zh-CN.md", metric: "permissions", kind: "current", table: "权限" },
  { id: "readme.en.commands", file: "README.md", metric: "tauriCommands", kind: "current", table: "Tauri commands" },
  { id: "readme.zh.commands", file: "README.zh-CN.md", metric: "tauriCommands", kind: "current", table: "Tauri 命令" },
  { id: "readme.en.assertions", file: "README.md", metric: "browserAssertions", kind: "current", table: "Browser assertions" },
  { id: "readme.zh.assertions", file: "README.zh-CN.md", metric: "browserAssertions", kind: "current", table: "浏览器断言" },
  { id: "readme.en.rust", file: "README.md", metric: "rustTests", kind: "current", table: "Rust tests" },
  { id: "readme.zh.rust", file: "README.zh-CN.md", metric: "rustTests", kind: "current", table: "Rust 单测" },
  { id: "readme.en.pitfalls", file: "README.md", metric: "pitfalls", kind: "current", table: "Documented pitfalls" },
  { id: "readme.zh.pitfalls", file: "README.zh-CN.md", metric: "pitfalls", kind: "current", table: "记下来的坑" },

  /* ---- README 正文里那句"平台不带组件" ---- */
  {
    id: "readme.en.prose",
    file: "README.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /All (\d+) official ones/,
  },
  {
    id: "readme.zh.prose",
    file: "README.zh-CN.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /(\d+) 个官方组件和第三方的走同一条安装链路/,
  },

  /* ---- README 正文里那两个"数词"写法：一个中文、一个英文 ---- */
  {
    id: "readme.en.fifteen",
    file: "README.md",
    metric: "permissions",
    kind: "current",
    pattern: /\*\*Permissions\.\*\* (Fifteen) of them/,
  },
  {
    id: "readme.zh.dozens",
    file: "README.zh-CN.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /(二十[三四五])个组件里找某一个/,
  },

  /* ---- CODE_SIGNING：给 Winget 提交的那段英文文案。
     它在 ```text 围栏里，而下面那张网**故意跳过围栏**（"代码块是写法示范，不是对平台
     的陈述"）—— 于是这三个数一直没被任何检查覆盖：19（实际 24）、422（实际 618）、
     以及一个核不了的断言数。围栏这一条对"示例"成立，对"这就是要发出去的文案"不成立。 ---- */
  {
    id: "signing.widgets",
    file: "docs/CODE_SIGNING.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /Distribution: (\d+) official widgets/,
  },
  {
    id: "signing.rust",
    file: "docs/CODE_SIGNING.md",
    metric: "rustTests",
    kind: "current",
    pattern: /and (\d+) Rust unit tests/,
  },

  /* ---- ARCHITECTURE §3「一条能力落地的五处」 ---- */
  {
    id: "arch.methods",
    file: "docs/ARCHITECTURE.md",
    metric: "bridgeMethods",
    kind: "current",
    pattern: /^\| 1 \| \*\*桥方法表\*\* \|[^\n]*?现在 (\d+) 条/m,
  },
  {
    id: "arch.permissions",
    file: "docs/ARCHITECTURE.md",
    metric: "permissions",
    kind: "current",
    pattern: /^\| 2 \| \*\*权限清单\*\* \|[^\n]*?现在 (\d+) 项/m,
  },
  {
    id: "arch.commands",
    file: "docs/ARCHITECTURE.md",
    metric: "tauriCommands",
    kind: "current",
    pattern: /^\| 3 \| \*\*Rust 命令\*\* \|[^\n]*?现在 (\d+) 条/m,
  },
  {
    id: "arch.widgets",
    file: "docs/ARCHITECTURE.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /官方组件已经 (\d+) 个/,
  },

  /* ---- WIDGET_SPEC 目录那两句 ---- */
  {
    id: "spec.toc.permissions",
    file: "docs/WIDGET_SPEC.md",
    metric: "permissions",
    kind: "current",
    pattern: /\[3\. 权限\]\(#3-权限\) \| (\d+) 项能力/,
  },
  {
    id: "spec.toc.methods",
    file: "docs/WIDGET_SPEC.md",
    metric: "bridgeMethods",
    kind: "current",
    pattern: /\[4\. 桥 API\]\(#4-桥-api\) \| (\d+) 个方法/,
  },

  /* ---- AGENTS 那条不变量里的组件数 ---- */
  {
    id: "recipes.widgets",
    file: "docs/reference/recipes.md",
    metric: "officialWidgets",
    kind: "current",
    pattern: /^\d+\. \*\*内置组件必须真做到\*\*[^\n]*?(\d+) 个官方组件/m,
  },

  /* ---- 局部：agent 动作。**必须带主语**，这里是当前的九 ---- */
  {
    id: "agent-access.actions",
    file: "docs/AGENT_ACCESS.md",
    metric: "agentActions",
    kind: "current",
    pattern: /([一二三四五六七八九十]+)\s*个动作/g,
    all: true,
  },
  {
    id: "agents.actions",
    file: "AGENTS.md",
    metric: "agentActions",
    kind: "current",
    pattern: /(\d+) 个白名单动作/g,
    all: true,
  },

  /* ---- 历史：ROADMAP 的 v0.8 / v0.10 那两行（那时确实是 8 个） ---- */
  {
    id: "roadmap.v08.actions",
    file: "docs/ROADMAP.md",
    metric: "agentActions",
    kind: "historical",
    since: "v0.8",
    pattern: /^\| v0\.8 \| Agent 接入 \|[^\n]*?(\d+) 个白名单动作/m,
  },
  {
    id: "roadmap.v010.actions",
    file: "docs/ROADMAP.md",
    metric: "agentActions",
    kind: "historical",
    since: "v0.10",
    pattern: /^\| v0\.10 \| 内置 assistant \|[^\n]*?(\d+) 个动作/m,
  },
  {
    id: "roadmap.oldhands.actions",
    file: "docs/ROADMAP.md",
    metric: "agentActions",
    kind: "historical",
    since: "v0.10",
    pattern: /手就是\*\*已有的那([一二三四五六七八九十]+)个\*\*白名单动作/,
  },
  {
    id: "roadmap.oldhands.prose",
    file: "docs/ROADMAP.md",
    metric: "agentActions",
    kind: "historical",
    since: "v0.10",
    pattern: /手仍然是原来那([一二三四五六七八九十]+)只/,
  },

  /* ---- 历史：组件数漂过好几次，每一处都要能看出是哪一版的 ---- */
  {
    id: "roadmap.v05.catalogue",
    file: "docs/ROADMAP.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "v0.6",
    pattern: /目录只有内置那一份（(\d+) 个官方包/,
  },
  {
    id: "roadmap.v06.onboarding",
    file: "docs/ROADMAP.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "v0.6",
    pattern: /组件库"可安装"那一段现在只有 (\d+) 个官方包/,
  },
  {
    id: "roadmap.registry.align",
    file: "docs/ROADMAP.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "2026-10-26",
    pattern: /（2026-10-26）\*\*：本地 (\d+) 个官方包/,
  },
  {
    id: "gaps.style-guard",
    file: "docs/reference/known-gaps.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "当时",
    pattern: /`public\/widgets\/\*\/style\.css`（当时 (\d+) 个官方包）/,
  },
  {
    id: "agent-access.snapshot",
    file: "docs/AGENT_ACCESS.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "2026-10-25",
    pattern: /`state` 回 (\d+) 个组件的快照/,
  },

  /* ---- 历史：ROADMAP「当前规模」那张表（截至 2026-10-26） ---- */
  {
    id: "roadmap.scale.commands",
    file: "docs/ROADMAP.md",
    metric: "tauriCommands",
    kind: "historical",
    since: "2026-10-26",
    pattern: /^\| Tauri 命令 \| (\d+) 个 \|/m,
  },
  {
    id: "roadmap.scale.permissions",
    file: "docs/ROADMAP.md",
    metric: "permissions",
    kind: "historical",
    since: "2026-10-26",
    pattern: /^\| 权限 \| (\d+) 项全可用/m,
  },
  {
    id: "roadmap.scale.pitfalls",
    file: "docs/ROADMAP.md",
    metric: "pitfalls",
    kind: "historical",
    since: "2026-10-26",
    pattern: /^\| 踩过的坑 \| (\d+) 条/m,
  },
  {
    id: "roadmap.scale.widgets",
    file: "docs/ROADMAP.md",
    metric: "officialWidgets",
    kind: "historical",
    since: "2026-10-26",
    pattern: /^\| 官方组件 \+ 示例 \| [\d ]+ 行 \| (\d+) 个官方包/m,
  },

  /* ---- 历史：LAT-0020 那张"五族能力"表。27 是 2026-10-26 的快照，当前 31 ---- */
  {
    id: "design0020.methods",
    file: "docs/design/LAT-0020-capability-descriptor.md",
    metric: "bridgeMethods",
    kind: "historical",
    since: "2026-10-26",
    pattern: /^\| 桥方法 \| 按 `widgetId` 的权限 \| `runtime\/bridge\.ts` \| (\d+)（/m,
  },
];

/* ------------------------------------------------------------ 对账 */

/** 登记过的命中位置，供下面的"网"判"这条登记过没有"。 */
const registered = new Map(); // file -> Set<lineNumber>

function markRegistered(file, lineNumber) {
  if (!registered.has(file)) registered.set(file, new Set());
  registered.get(file).add(lineNumber);
}

for (const claim of CLAIMS) {
  let text;
  try {
    text = read(claim.file);
  } catch {
    fail(`${claim.id}：读不到 ${claim.file}`);
    continue;
  }

  const metric = METRICS[claim.metric];
  const actual = values[claim.metric];
  if (!metric) {
    fail(`${claim.id}：声明里的 metric 叫 ${claim.metric}，stats.mjs 里没有这一项`);
    continue;
  }

  /* 表格类：标签对不上就是"表没了"或"标签改名了" */
  if (claim.table) {
    const row = tableRow(text, claim.table);
    if (row === null) {
      fail(`${claim.id}：${claim.file} 里找不到「${claim.table}」那一行 —— 标签改名了？`);
      continue;
    }
    const found = numbers(row.cell);
    if (found.length === 0) {
      fail(`${claim.id}：${claim.file} 的「${claim.table}」那格里没有数字`);
      continue;
    }
    markRegistered(claim.file, lineOf(text, row.index));

    // 手数的那两项（断言 / Rust 单测）没有实测值，只核中英两份写的是同一个数。
    if (actual === null) {
      if (found.length !== 1) {
        notes.push(`${claim.id}：手数的项写了 ${found.join(" / ")}，只核中英文一致`);
      }
      continue;
    }
    if (!found.includes(actual)) {
      fail(`${claim.id}：${claim.file} 写的是 ${found.join(" / ")}，实测 ${actual}（${metric.how}）`);
    }
    continue;
  }

  /* 正则类 */
  const flags = claim.all ? claim.pattern.flags : claim.pattern.flags;
  const re = new RegExp(claim.pattern.source, flags.includes("g") ? flags : `${flags}g`);
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) {
    fail(`${claim.id}：${claim.file} 里匹配不到「${claim.pattern}」—— 写法变了，正则需要跟着改`);
    continue;
  }

  for (const match of matches) {
    const lineNumber = lineOf(text, match.index);
    markRegistered(claim.file, lineNumber);
    const raw = match[1] ?? "";
    const found = /^\d+$/.test(raw) ? Number(raw) : (chineseNumber(raw) ?? englishNumber(raw));
    if (found === null) {
      fail(`${claim.id}：${claim.file}:${lineNumber} 的「${raw}」认不出是多少`);
      continue;
    }

    if (claim.kind === "current") {
      if (actual === null) continue;
      if (found !== actual) {
        fail(
          `${claim.id}：${claim.file}:${lineNumber} 写 ${found}，实测 ${actual}（${metric.how}）` +
            `\n            ${claim.file}:${lineNumber}  ${match[0].replace(/\n/g, " ").slice(0, 90)}`,
        );
      }
      // 局部数要带主语 —— 这一行得出现这个子系统的名字，否则读者会当成全局数。
      // 允许的说法不止"agent"一个：同一个白名单在文档里叫过"桌面动作"、"白名单动作"、
      // "手"，都是它。只认一个词的话，四处正确的行会全判红。
      if (metric.scope === "subsystem") {
        const line = text.split("\n")[lineNumber - 1] ?? "";
        if (!/agent|assistant|助手|桌面|手|白名单/.test(line)) {
          fail(`${claim.id}：${claim.file}:${lineNumber} 是局部数（${metric.subsystem}），但那行没写是谁的`);
        }
      }
      continue;
    }

    /* historical：值可以旧，但必须看得出"这是旧的" */
    if (isPastByCoordinate(claim.file)) {
      // design 文档靠文件自己的坐标（`date:`）说话 —— 但那份日期得在
      if (claim.file.startsWith("docs/design/") && frontMatterDate(text) === null) {
        fail(`${claim.id}：${claim.file} 里有一个历史数，但 front matter 没有 \`date:\` —— 读者不知道这是哪一天的数`);
      }
      continue;
    }
    const line = text.split("\n")[lineNumber - 1] ?? "";
    if (LABEL.test(line)) continue;
    if (sectionLabel(text, lineNumber)) continue;
    fail(
      `${claim.id}：${claim.file}:${lineNumber} 是历史数（${claim.since}），但那一行和它的小节都没标版本或日期 —— ` +
        `读者分不出它和"写错了"`,
    );
  }
}

/* ------------------------------------------------------------ 那张网 */

/**
 * 按短语形状扫全仓库。命中而没登记的，说明有人新抄了一个数。
 *
 * 只收这三种形状：它们覆盖了实际出现过的全部写法（"N 个方法"、"N 项能力"、
 * 表格里的 `| 权限 | N |`）。**网不是证明** —— 换个说法（"方法一共三十一个"）
 * 就漏过去了；但它挡的是最常见的那种复制粘贴。
 */
const SWEEP = [
  { metric: "bridgeMethods", pattern: /(\d+)\s*[个条]\s*桥?方法/g },
  { metric: "permissions", pattern: /(\d+)\s*[项条]\s*(?:能力|权限|全可用)/g },
  { metric: "tauriCommands", pattern: /(\d+)\s*[条个]\s*命令/g },
  // 只收「官方」两个字都在的：`5 个组件时 CPU` 是"摆 5 个"，`第 14 个官方组件` 是序号，
  // 两个都不是"平台带多少个"。把它们算进来，这张网第一天就会红成一片噪声，
  // 而噪声里的真问题没人看 —— 那比没有网更糟。
  { metric: "officialWidgets", pattern: /(\d+)\s*个官方(?:组件|包)/g },
  {
    metric: null, // 表格行：值在另一格，靠登记表兜。**必须带数字** —— 不带数字的是表头
    pattern: /^\|\s*(?:Tauri 命令|Tauri commands|权限|Permissions|官方组件|Official widgets|桥方法表)\s*\|[^\n]*\d/gm,
  },
  // 中文数词与英文数词：上面那几条只认阿拉伯数字，于是"二十四个组件"、"nineteen
  // official widgets"这类写法整类漏掉 —— 而 CODE_SIGNING 里的 19 vs 24 就是这么烂的。
  // 这两种写法在 CLAIMS 里都有解析器（`chineseNumber` / `englishNumber`）。
  { metric: "officialWidgets", pattern: /(?:二十[三四五六]|十[三四五])\s*个\s*官方?组件/g },
  { metric: "permissions", pattern: /十[三四五六七]\s*[项条]\s*(?:权限|能力)/g },
  { metric: "bridgeMethods", pattern: /(?:三十一|二十七)\s*个\s*(?:桥)?方法/g },
  { metric: "tauriCommands", pattern: /(?:一百二十八|一百一十七|九十九)\s*条\s*命令/g },
  { metric: "officialWidgets", pattern: /\b(?:nineteen|twenty[- ]four|twenty[- ]five)\s+official\s+widgets/gi },
  { metric: "permissions", pattern: /\b(?:thirteen|fifteen)\s+(?:of them|permissions)\b/gi },
];

function markdownFiles() {
  const out = [];
  const skip = new Set(["node_modules", ".git", ".scratch", "target", "dist", "dist-prev", ".workbuddy-ai", "widget-backups"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(ROOT);
  return out;
}

for (const file of markdownFiles()) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  const known = registered.get(rel) ?? new Set();

  for (const { metric, pattern } of SWEEP) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(re)) {
      const lineNumber = lineOf(text, match.index);
      if (known.has(lineNumber)) continue;
      // 「第 14 个官方组件」是**序号**（这是第几个做出来的），不是"平台带 14 个"。
      // 这两种写法在 ROADMAP 里长得一模一样，而它们的意思差着量级 —— 一个词两个
      // 意思，是这个仓库踩过最多次的坑（见 PITFALLS）。序号一律放行。
      if (/第\s*$/.test(text.slice(Math.max(0, match.index - 4), match.index))) continue;
      // 代码块里的示例不算 —— 那是写法示范，不是对平台的陈述
      if (isInsideFence(text, match.index)) continue;
      if (isPastByCoordinate(rel)) {
        notes.push(`${rel}:${lineNumber} 历史数（design 文档，不拦）：${match[0].replace(/\n/g, " ").slice(0, 60)}`);
        continue;
      }
      const hint = metric ? `（${METRICS[metric].how}）` : "";
      fail(
        `${rel}:${lineNumber} 有一个没登记的数字「${match[0].replace(/\n/g, " ").slice(0, 60)}」${hint}\n` +
          `            要么改成实测值，要么在 scripts/guards/stats.mjs 的 CLAIMS 里登记它是历史数`,
      );
    }
  }
}

/** 这一处是不是落在 ``` 围栏里。 */
function isInsideFence(text, index) {
  const before = text.slice(0, index);
  const fences = (before.match(/^```/gm) ?? []).length;
  return fences % 2 === 1;
}

/* ------------------------------------------------------------ 输出 */

console.log("数字对账：\n");
console.log("  全局（整座平台这一层的总数）");
for (const [key, metric] of Object.entries(METRICS)) {
  if (metric.scope !== "global") continue;
  const value = values[key] === null ? "手数" : `${values[key]} ${metric.unit}`;
  console.log(`    ${metric.zh.padEnd(10)} ${value.padStart(8)}   ${metric.how}`);
}
console.log("\n  局部（只有那个子系统是这个数）");
for (const [key, metric] of Object.entries(METRICS)) {
  if (metric.scope !== "subsystem") continue;
  console.log(`    ${metric.zh.padEnd(10)} ${`${values[key]} ${metric.unit}`.padStart(8)}   ${metric.subsystem}`);
}

const current = CLAIMS.filter((claim) => claim.kind === "current").length;
const historical = CLAIMS.filter((claim) => claim.kind === "historical").length;
console.log(`\n  ${CLAIMS.length} 处声明：${current} 处当前态、${historical} 处历史数`);

if (AUDIT && notes.length) {
  console.log("\n  提示（不拦）");
  for (const note of notes) console.log(`    · ${note}`);
}

if (problems.length) {
  console.log(`\n${problems.length} 处对不上：\n`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  console.log("\n数的真源是 scripts/stats.mjs；历史数要带版本或日期。");
  process.exit(1);
}

console.log("\n全部对上。");
