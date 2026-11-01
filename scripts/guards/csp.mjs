#!/usr/bin/env node
/**
 * 平台页面的 CSP 守门人。
 *
 * 这里守的是**主窗口**（以及 assistant / widget-host / pet 三扇同源的平台窗），
 * 不是组件文档。两者是不同的东西，别混：
 *
 *   - **组件文档**是不可信代码，策略在 `src-tauri/src/csp.rs`，比这一份紧得多
 *     （`default-src 'none'`、`connect-src` 只放行组件自己的协议源）。
 *   - **平台页面**是我们自己的代码，但"自己的代码"不等于"不会出事"：一个依赖
 *     渲染了没转义的 HTML、一处 `innerHTML` 拼错了，注入就在平台这一侧发生了 ——
 *     而平台这一侧握着桥、握着权限开关、握着 agent 端点。少了 CSP，那次注入
 *     直接等于拿到全部能力；有了 `script-src 'self'`，注入的**内联**脚本连
 *     执行都进不去。
 *
 * 为什么要有这条命令：CSP 的失效方式是**白屏**，而白屏的第一反应是"先放开再
 * 说"。放开一次之后没有人会记得收回来，也没人记得当初为什么放开。所以这里把
 * "能放开什么"写死成检查，把"为什么不能放开"写在下面每一条的注释里。
 *
 *   npm run check:csp            对账，有问题退出码 1
 *
 * 只读，不改。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

/* ------------------------------------------------------------ 读策略 */

const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const security = config.app?.security ?? {};
const policy = security.csp;

if (typeof policy !== "string" || policy.trim() === "") {
  console.error(
    "✗ tauri.conf.json 的 app.security.csp 是空的。\n" +
      "  主窗口没有 CSP 就等于没有第二道防线 —— 这不是「以后再加」，见本文件头部。",
  );
  process.exit(1);
}

/**
 * `default-src 'self'; script-src 'self'` → `{ "default-src": ["'self'"], … }`
 *
 * 也接受 Tauri 允许的对象写法（`{ "default-src": "'self'" }`）：两种写法在
 * 运行时等价，检查不该因为换了写法就静默变成"0 条策略、全部通过"。
 */
function parsePolicy(value) {
  if (typeof value === "object" && value !== null) {
    return new Map(
      Object.entries(value).map(([key, sources]) => [
        key,
        Array.isArray(sources) ? sources.map(String) : String(sources).split(/\s+/).filter(Boolean),
      ]),
    );
  }
  const map = new Map();
  for (const part of String(value).split(";")) {
    const pieces = part.trim().split(/\s+/).filter(Boolean);
    if (pieces.length === 0) continue;
    map.set(pieces[0], pieces.slice(1));
  }
  return map;
}

const directives = parsePolicy(policy);

/* --------------------------------------------------- 从代码里取事实 */

/**
 * 两个自定义协议的 scheme 名，**从 Rust 里读**，不在这里再抄一遍。
 *
 * 抄一遍的代价是真实的：`csp.rs` 的注释里专门记过"桩的值抄成 `lattice`、
 * 真值是 `lattice-widget`，单测会红"。CSP 里的 origin 写错一个字母的症状
 * 不是报错，是那个窗口白屏 —— 组件加载不出来，控制台里只有一句
 * `Refused to frame`。所以这里让代码说话。
 */
function schemes() {
  const source = read("src-tauri/src/protocol.rs");
  const widget = source.match(/pub const SCHEME:\s*&str\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const pet = source.match(/pub const PET_SCHEME:\s*&str\s*=\s*"([^"]+)"/)?.[1] ?? null;
  if (!widget) fail("src-tauri/src/protocol.rs 里读不到 `pub const SCHEME` —— 写法变了");
  if (!pet) fail("src-tauri/src/protocol.rs 里读不到 `pub const PET_SCHEME` —— 写法变了");
  return { widget, pet };
}

/** Tauri 把自定义 scheme 挂在 `http://<scheme>.localhost` 上（Windows）。 */
const originOf = (scheme) => `http://${scheme}.localhost`;

const { widget, pet } = schemes();

/** 平台页面里真的会用到的东西。每一项都要有出处，写不出出处的就不该在策略里。 */
const REQUIRED = [
  {
    directive: "default-src",
    sources: ["'self'"],
    why: "没列出来的一律不给。以后新增资源类型默认是关的，要开得有人主动来加一行",
  },
  {
    directive: "script-src",
    sources: ["'self'"],
    why: "四个入口的脚本全是外链 module（`index.html` / `assistant.html` / `widget-host.html` / `pet.html` 都只有一条 `<script src>`）。Tauri 会把自己的内联初始化脚本按哈希加进来，不需要 `'unsafe-inline'`",
  },
  {
    directive: "style-src",
    sources: ["'self'"],
    why: "样式全是打包出来的 `.css`。`widget-host.html` / `pet.html` 里那两段内联 `<style>` 由 Tauri 发 nonce（`html2::inject_nonce_token`），markdown 的表格对齐已经改成类名 —— 所以**没有** `'unsafe-inline'`",
  },
  {
    directive: "connect-src",
    sources: ["'self'", "ipc:", originOf("ipc")],
    why: "`'self'` 是随应用发的那份目录、`widgets/index.json` 与各组件清单；`ipc:` + `http://ipc.localhost` 是 Tauri 的命令通道。**远端目录、商店下载、更新器、agent 端点、LLM 都不在这里** —— 它们走 Rust（见下面「不许直连」那条）",
  },
  {
    directive: "img-src",
    sources: ["'self'", originOf(widget), originOf(pet)],
    why: "组件图标（用户装的在 `lattice-widget://`）、桌宠皮肤贴图在 `lattice-pet://`，其余是打包资源",
  },
  {
    directive: "frame-src",
    sources: ["'self'", originOf(widget)],
    why: "主窗口的画布和 widget-host 都**要**嵌组件文档的 iframe（内置组件同源，用户组件走 `lattice-widget://`）。这条不能是 `'none'` —— 组件文档自己那份更紧的 CSP 在 `csp.rs`",
  },
  {
    directive: "object-src",
    sources: ["'none'"],
    why: "`<embed>` / `<object>` 是另一条能加载外部内容的旧路，平台一个都不用",
  },
  { directive: "base-uri", sources: ["'none'"], why: "不许改 `<base>`，否则相对路径可以被劫持到别的源" },
  { directive: "form-action", sources: ["'none'"], why: "平台没有表单提交。这一条关掉的是「把数据拼进一次 POST」" },
  {
    directive: "frame-ancestors",
    sources: ["'none'"],
    why: "平台页面不该被任何页面套框（组件文档的套框由它自己那份 CSP 管）",
  },
];

/* --------------------------------------------------------- 一、必备项 */

for (const item of REQUIRED) {
  const sources = directives.get(item.directive);
  if (!sources) {
    fail(`策略里没有 \`${item.directive}\` —— ${item.why}`);
    continue;
  }
  for (const source of item.sources) {
    if (!sources.includes(source)) {
      fail(`\`${item.directive}\` 少了 \`${source}\` —— ${item.why}`);
    }
  }
}

/* ------------------------------------------------- 二、不许出现的东西 */

/**
 * 这几条是"注入能不能变成执行 / 能不能把数据送出去"的答案。
 * 每一条都写清为什么，因为下一次有人为了白屏来放开时，得先读到它。
 */
const FORBIDDEN = [
  {
    source: "'unsafe-eval'",
    anywhere: true,
    why: "`eval` / `new Function` 是注入之后最直接的一条执行路。平台不用它，Vite 生产构建也不产出它",
  },
  {
    source: "'unsafe-inline'",
    directives: ["script-src", "style-src"],
    why:
      "内联脚本 / 内联样式正是注入最爱落的地方。Tauri 会给内联 `<style>` 发 nonce、给内联 `<script>` 算哈希，所以**不需要**它；真要写内联样式，改成类名（`styles.css`）",
  },
  {
    source: "*",
    anywhere: true,
    why: "通配符等于把这条指令作废。要放开哪个源就写哪个源，让 review 看得见",
  },
  {
    source: "data:",
    directives: ["script-src"],
    why: "`data:` 脚本能把任意代码塞进文档，而且没有任何来源可查",
  },
  {
    source: "http:",
    directives: ["script-src", "style-src", "connect-src", "frame-src"],
    why: "明文 http 的代码 / 连接可以被中间人改写。本机回环和自定义协议已经逐条写出来了",
  },
  {
    source: "https:",
    directives: ["script-src", "style-src", "connect-src", "frame-src"],
    why: "外部脚本和外部连接一律不开。远端数据全部经 Rust（商店、更新器、agent、LLM）",
  },
];

for (const rule of FORBIDDEN) {
  const targets = rule.anywhere
    ? [...directives.entries()]
    : (rule.directives ?? []).map((name) => [name, directives.get(name)]).filter(([, sources]) => sources);
  for (const [directive, sources] of targets) {
    if (!sources.includes(rule.source)) continue;
    fail(`\`${directive}\` 里有 \`${rule.source}\` —— ${rule.why}`);
  }
}

/* --------------------------------------------- 三、img-src 里那一个例外 */

/**
 * 商店图标是**远程**的，而且主机不可枚举。
 *
 * 目录源的地址是用户自己填的（`store.sources`），官方那份挂在 GitHub Pages 上，
 * `entry.icon` 按源地址解析出来就是一个 `https://…` 的绝对地址，直接进 `<img src>`。
 * 把它关掉不会报错 —— 只是商店里每一行都变成一个碎图标。
 *
 * 所以 `img-src` 放行 `https:`，**只放行它**：
 *   - 图片不是代码执行通道（`<img>` 不会跑脚本）；
 *   - 想拿它外发数据，前提是已经能往页面里塞任意 HTML —— 而 `script-src 'self'`
 *     挡的是更前面那一步，`connect-src` / `form-action` 挡的是另外两条更顺手的路；
 *   - `connect-src` 一个外部地址都没开，所以"直接把数据 POST 出去"这条路是关的。
 *
 * 这是这份策略里唯一的让步，写在这里而不是散在配置里 —— 下次有人想再开一个
 * `https:`，得先看见这一条为什么单独存在。
 */
{
  const images = directives.get("img-src") ?? [];
  if (!images.includes("https:")) {
    notes.push("img-src 没有 `https:` —— 商店里远程图标会变成碎图标（见本文件那段注释）");
  }
}

/* --------------------------------------- 四、自定义协议必须真的注册过 */

/**
 * 策略里写了一个 `http://<x>.localhost`，而 Rust 侧没注册那个 scheme —— 症状是
 * 那个窗口白屏、控制台一句 `Refused to …`，而 CI 全绿。所以逐个对。
 */
{
  const lib = read("src-tauri/src/lib.rs");
  const registered = new Set(
    [...lib.matchAll(/register_uri_scheme_protocol\(\s*(?:protocol::)?([A-Z_]+|[a-z_]+)/g)].map(
      (match) => match[1],
    ),
  );
  const known = new Map([
    ["SCHEME", widget],
    ["PET_SCHEME", pet],
  ]);

  for (const [directive, sources] of directives) {
    for (const source of sources) {
      const host = source.match(/^http:\/\/([a-z0-9-]+)\.localhost$/);
      if (!host || host[1] === "ipc") continue;
      const scheme = host[1];
      const registeredNames = [...registered].map((name) => known.get(name) ?? name);
      if (!registeredNames.includes(scheme)) {
        fail(
          `\`${directive}\` 放行了 \`${source}\`，但 \`src-tauri/src/lib.rs\` 里没有注册这个协议 —— ` +
            `要么是拼错了，要么那个窗口根本加载不出来`,
        );
      }
    }
  }
}

/* ------------------------------------------- 五、入口 HTML 与策略对得上 */

/**
 * "内联的东西"是策略与实际之间最容易漂的一处：今天没有内联脚本，所以
 * `script-src 'self'` 成立；明天某个插件往 HTML 里注一段内联脚本，dev 照跑
 * （dev 没有 CSP），打包之后白屏 —— 而没有任何检查会红。
 *
 * 所以直接看构建产物（CI 里 `npm run build` 在前）。没有 `dist` 就看源 HTML，
 * 并说明看的是哪一份。
 */
function entryFiles() {
  const sets = [];
  // 仓库根的四个入口是**输入**：新增的内联样式一定先出现在这里
  const root = fs
    .readdirSync(ROOT)
    .filter((name) => name.endsWith(".html"))
    .map((name) => path.join(ROOT, name));
  if (root.length) sets.push({ where: "源文件", files: root });

  // `dist/` 是**产物**：打包插件可能往里注内联脚本，而 dev 下看不见
  const dist = path.join(ROOT, "dist");
  if (fs.existsSync(dist)) {
    const files = fs.readdirSync(dist).filter((name) => name.endsWith(".html"));
    if (files.length) sets.push({ where: "dist", files: files.map((name) => path.join(dist, name)) });
  }
  return sets;
}

/**
 * 入口清单的**真源是 `vite.config.ts` 的 `rollupOptions.input`**，不是"根目录有几份
 * `.html`"—— 后者会把一份从没被构建的 HTML 也算进来（它永远不会出现在用户机器上），
 * 也会漏掉"配置里写了、文件却不在"这种情况（那一次 `npm run build` 直接失败）。
 */
function viteInputs() {
  const source = read("vite.config.ts");
  const block = source.match(/rollupOptions\s*:\s*\{[\s\S]*?\binput\s*:\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  return [...block[1].matchAll(/["']([\w.-]+\.html)["']/g)].map((match) => match[1]);
}

const entrySets = entryFiles();
if (entrySets.length === 0) {
  fail('一份入口 HTML 都没找到 —— 仓库根和 dist/ 都没有 .html');
}

{
  const inputs = viteInputs();
  if (!inputs) {
    notes.push("`vite.config.ts` 里读不到 `rollupOptions.input` —— 入口清单没能对账");
  } else {
    for (const name of inputs) {
      if (!fs.existsSync(path.join(ROOT, name))) {
        fail(`\`vite.config.ts\` 把 \`${name}\` 列成入口，根目录却没有这个文件 —— 构建会直接失败`);
      }
    }
    const dist = path.join(ROOT, "dist");
    if (fs.existsSync(dist)) {
      const built = new Set(fs.readdirSync(dist).filter((name) => name.endsWith(".html")));
      const missing = inputs.filter((name) => !built.has(name));
      if (missing.length) {
        // 不是错误：`dist/` 只是**上次构建的快照**，加了新入口还没 build 就会差一份。
        // 但必须说出来 —— 否则"源文件 4 份 / dist 3 份"看着像漏扫了一份。
        notes.push(
          `dist/ 比入口清单少 ${missing.length} 份（${missing.join("、")}）—— ` +
            `那是上次构建的快照，\`npm run build\` 之后就齐；这一轮看的是根目录那份源文件`,
        );
      }
    }
  }
}

/**
 * 入口 HTML 里引用的地址，**逐条拿去问策略**：`script-src 'self'` 下一条
 * `<script src="https://cdn…">` 不会加载，症状是白屏 —— 而白屏的第一反应是
 * "把策略放开"。所以这里当场对账，别让人靠猜。
 */
const allowedBy = (directive, url) => {
  const sources = directives.get(directive) ?? [];
  // 相对地址 / 站内绝对路径由 `'self'` 兜
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return sources.includes("'self'");
  if (sources.includes(url)) return true;
  let origin;
  try {
    origin = new URL(url, "http://placeholder.invalid/").origin;
  } catch {
    return false;
  }
  if (sources.some((source) => source.replace(/\/$/, "") === origin)) return true;
  return sources.includes(`${origin.split(":")[0]}:`);
};

let inlineStyles = 0;
for (const set of entrySets) {
  for (const file of set.files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const html = fs.readFileSync(file, 'utf8');

    for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
      if (/\bsrc\s*=/.test(match[1])) continue;
      fail(
        `${rel} 里有内联 <script> —— \`script-src 'self'\` 下它不会执行（Tauri 会给它算哈希，` +
          `但那是「信任构建产物里的内联脚本」，等于把这道防线让掉）。挪到 .ts 里`,
      );
    }

    // 内联 `<style>` 是允许的：Tauri 会给它发 nonce。数出来只是为了让人看见
    for (const match of html.matchAll(/<style\b[^>]*>/gi)) {
      if (!/\bnonce\s*=/.test(match[0])) inlineStyles += 1;
    }

    // 属性上的样式**没有** nonce 可用，只能靠 `'unsafe-inline'` —— 而那是我们
    // 明确不要的。所以 HTML 里出现 `style="…"` 就是一处未来的白屏（或者一处
    // 悄悄放开）。markdown 的表格对齐已经改成类名了，见 runtime/markdown.ts。
    for (const match of html.matchAll(/\sstyle\s*=\s*["']/gi)) {
      const at = html.slice(0, match.index).split('\n').length;
      fail(
        `${rel}:${at} 有内联 style 属性 —— 它需要 \`style-src 'unsafe-inline'\`，` +
          `而那份放开等于整页的样式注入面。改成类名`,
      );
    }

    // 外链资源：**这一条才让"没有外部代码"那句话变成证据**。策略里一个外部源
    // 都没有，所以 HTML 里任何一条 `https://…` 的 script / stylesheet / iframe
    // 在生产里都不会加载。dev 下会（dev 没有 CSP），于是"dev 好好的、装上就白屏"。
    for (const match of html.matchAll(/<(script|link|iframe)\b([^>]*)>/gi)) {
      const tag = match[1].toLowerCase();
      const attrs = match[2];
      if (tag === "link" && !/\brel\s*=\s*["'][^"']*stylesheet/i.test(attrs)) continue;
      const directive =
        tag === "script" ? "script-src" : tag === "link" ? "style-src" : "frame-src";
      const url = attrs.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!url || allowedBy(directive, url)) continue;
      const at = html.slice(0, match.index).split('\n').length;
      fail(
        `${rel}:${at} 引用了 ${url}，而 \`${directive}\` 里没有它 —— 生产环境这份资源不加载` +
          `（dev 下会加载，因为 dev 没有 CSP，于是症状是「装上才白屏」）`,
      );
    }
  }
}

if (inlineStyles > 0) {
  notes.push(`入口 HTML 里 ${inlineStyles} 段内联 <style>（Tauri 发 nonce，不用 'unsafe-inline'）`);
}

/* --------------------------- 五之二、断言页里那份策略必须和配置一模一样 */

/**
 * `tests/csp.html` 用 meta 把同一份策略挂在自己身上，然后在真 Chrome 里证明
 * "这份策略不会打白页面"（`npm run test:browser -- --filter csp`）。
 *
 * 那条证明只有在**两份策略相同**时才有效 —— 一份放开的测试页能证明什么？
 * 所以这里逐字对账。`frame-ancestors` 除外：meta 形式不支持它，浏览器会忽略。
 */
function canonical(map) {
  const out = {};
  for (const [directive, sources] of [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (directive === "frame-ancestors") continue;
    out[directive] = [...sources].sort().join(" ");
  }
  return out;
}

{
  if (!exists("tests/csp.html")) {
    fail("`tests/csp.html` 不见了 —— 「这份策略不会打白页面」那条证明就没有了");
  } else {
    const page = read("tests/csp.html");
    const content = page.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1];
    if (!content) {
      fail("`tests/csp.html` 里读不到 `http-equiv=\"Content-Security-Policy\"` 的 content —— 写法变了");
    } else {
      const fromConfig = JSON.stringify(canonical(directives));
      const fromPage = JSON.stringify(canonical(parsePolicy(content)));
      if (fromConfig !== fromPage) {
        fail(
          "`tests/csp.html` 的 meta 策略和 `tauri.conf.json` 对不上 —— 两边各是一份真源，" +
            "而测试页要证明的正是配置里那一份",
        );
      }
    }
  }
}

/* ------------------------------------------- 六、平台代码不许自己直连外网 */

/**
 * `connect-src` 敢写这么死，是因为**平台自己不发外网请求**。这条检查就是那句话的
 * 证据：`src/` 里任何一处带字面量 `http(s)://` 的 `fetch` / `WebSocket` / XHR 都红。
 *
 * 远端目录、商店包、更新器、agent 端点、LLM —— 全都走 Rust 命令。这不是口味问题：
 * 一旦渲染进程自己 `fetch` 一次远端，`connect-src` 就得为它开一个口子，而那个口子
 * 对页面里的任何注入同样有效。
 */
{
  const ALLOW = new Map([
    // 例外的形状：文件 → 为什么它可以
    ["src/petMain.tsx", "`lattice-pet://` 是平台自己的只读协议源，不是外网"],
  ]);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));

  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const source = read(rel);
    for (const match of source.matchAll(
      /\b(?:fetch|WebSocket|EventSource)\s*\(\s*[`"'](https?:\/\/[^`"']+)/g,
    )) {
      if (ALLOW.has(rel)) continue;
      const at = source.slice(0, match.index).split("\n").length;
      fail(
        `${rel}:${at} 直接连了 ${match[1]} —— 平台页面不直连外网，这条请求应该走 Rust 命令。` +
          `真要开，得先改 \`connect-src\`，而那不是一次"顺手"的改动`,
      );
    }
  }
}

/* ------------------------------------------------------------ 七、dev */

/**
 * **`tauri dev` 下主窗口没有 CSP，这是 Tauri 的结构决定的，不是漏配。**
 *
 * CSP 只在 Tauri 自己发资产时挂头（`manager/mod.rs::get_asset` → `Asset.csp_header`），
 * 而 `devUrl` 指向 Vite，HTML 由 Vite 发 —— Tauri 摸不到那份响应，`devCsp` 也就
 * 没有落点。所以别把 `devCsp` 当成"dev 也有保护"：它只在"由 Tauri 发前端资产"
 * 的配置下才生效。
 *
 * 这一条留成检查，是为了记住**如果哪天真的给 dev 加上 CSP，需要多什么**：
 *   - `script-src` 要 `'unsafe-inline'`（`@vitejs/plugin-react` 往 HTML 里注
 *     一段内联的 refresh 前导脚本，它没有 nonce 可用）；
 *   - `connect-src` 要 `ws://127.0.0.1:1420`（HMR 的 WebSocket；`'self'` 在
 *     部分 Chromium 版本里不覆盖 ws:）；
 *   - `style-src` 要 `'unsafe-inline'`（Vite 把 CSS 以 `<style>` 注入）。
 *
 * 换句话说：**dev 的松弛是真实存在的，只是它现在不在配置里，而在"没有头"这件事上。**
 */
if (security.devCsp) {
  const dev = parsePolicy(security.devCsp);
  const devScript = dev.get("script-src") ?? [];
  const devConnect = dev.get("connect-src") ?? [];
  if (!devScript.includes("'unsafe-inline'")) {
    fail("配了 devCsp 但 script-src 没有 'unsafe-inline' —— React 的 refresh 前导脚本是内联的，会白屏");
  }
  if (!devConnect.some((source) => source.startsWith("ws:"))) {
    fail("配了 devCsp 但 connect-src 没有 ws: —— Vite HMR 的 WebSocket 会被拦，页面不热更新");
  }
} else {
  notes.push("没配 devCsp：`tauri dev` 下主窗口没有 CSP（Vite 发 HTML，Tauri 挂不上头）");
}

/* ------------------------------------------------------------ 输出 */

const show = (value) => (value === undefined ? "—" : value.join(" "));

console.log("平台页面 CSP（`tauri.conf.json` 的 `app.security.csp`）\n");
for (const [directive, sources] of directives) {
  console.log(`  ${directive.padEnd(16)} ${show(sources)}`);
}

console.log(
  `\n  入口 HTML  ${entrySets.map((set) => `${set.where} ${set.files.length} 份`).join(" / ")}`,
);
console.log(`  协议源      ${widget} / ${pet}（从 protocol.rs 读的）`);

if (notes.length) {
  console.log("\n  提示（不拦）");
  for (const note of notes) console.log(`    · ${note}`);
}

if (problems.length) {
  console.log(`\n${problems.length} 处要改：\n`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exit(1);
}

console.log("\n策略成立：没有内联脚本、没有内联样式属性、没有外部代码、没有外部连接。");
