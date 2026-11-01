/*
 * 平台页面那份 CSP 的断言（页面在 `tests/csp.html`，策略写在它的 meta 里）。
 *
 * 这一页回答的是**"这份策略会不会把平台打白"**，不是"策略够不够严" ——
 * 够不够严是 `scripts/guards/csp.mjs` 的事（它读 `tauri.conf.json`）。
 * 两件事分开：一边管"别放开"，一边管"放开之前先证明现在这版能用"。
 *
 * 每一条断言对应一个**真的会出现的机制**：
 *   - CSSOM 赋值 —— React 的 `style={{…}}` 走这条，`style-src` 管不着它
 *   - 内联 style 属性 —— 管得着，所以表格对齐改成了类名
 *   - 动态 `<style>` —— Vite 在 dev 下就是靠这个注 CSS 的，所以 dev 与 prod 不一样
 *   - 内联 `<script>` / 外部 `<script>` —— 注入最想落的两处
 *   - 同源 fetch / 外部 fetch —— 前者是随应用发的目录，后者一律不该通
 */

const lines = [];
const log = (pass, text) => lines.push((pass ? "PASS " : "FAIL ") + text);

/** 浏览器把每一次拦截都发成一个事件 —— 比"看它有没有成功"可靠（离线时也成立） */
const violations = [];
document.addEventListener("securitypolicyviolation", (event) => {
  violations.push(event.violatedDirective);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---- 1. React 的内联样式：走 CSSOM，不受 style-src 影响 ---- */
{
  const node = document.createElement("div");
  node.style.color = "rgb(1, 2, 3)";
  log(node.style.color === "rgb(1, 2, 3)", "CSSOM 赋值照旧生效（React 的 style={{…}} 走这条）");
}

/* ---- 2. 内联 style 属性：被拦，所以对齐必须走类名 ---- */
{
  const node = document.createElement("div");
  node.setAttribute("style", "color: rgb(9, 9, 9)");
  log(node.style.color === "", "内联 style 属性被拦（表格对齐已改成类名，见 runtime/markdown.ts）");
}

/* ---- 3. 动态 <style>：被拦 —— 这正是 dev 需要 'unsafe-inline' 的原因 ---- */
{
  const sheet = document.createElement("style");
  sheet.textContent = "#csp-probe { color: rgb(7, 7, 7) }";
  document.head.appendChild(sheet);
  const probe = document.createElement("div");
  probe.id = "csp-probe";
  document.body.appendChild(probe);
  log(
    getComputedStyle(probe).color !== "rgb(7, 7, 7)",
    "动态注入的 <style> 不生效（Vite 的 CSS 注入因此只能在 dev 里用）",
  );
}

/* ---- 4. 内联 <script>：不执行 ---- */
{
  const inline = document.createElement("script");
  inline.textContent = "window.__cspInlineRan = true";
  document.body.appendChild(inline);
  log(window.__cspInlineRan !== true, "注入的内联 <script> 不执行");
}

/* ---- 5. 外部 <script>：被拦 ---- */
{
  const remote = document.createElement("script");
  remote.src = "https://example.com/csp-probe.js";
  document.head.appendChild(remote);
  await sleep(80);
  // 元素级的拦截报的是 `script-src-elem`，不是 `script-src` —— 按前缀认，
  // 只认全等的写法会把一条真的拦住了的断言判成失败
  log(violations.some((name) => name.startsWith("script-src")), "外部脚本被拦（script-src 只有 'self'）");
}

/* ---- 6. 同源 fetch：放行 ---- */
{
  const own = await fetch("/tests/csp.html", { cache: "no-store" });
  log(own.ok, "同源 fetch 放行（随应用发的目录与组件清单走这条）");
}

/* ---- 7. 外部 fetch：被拦 ---- */
{
  try {
    await fetch("https://example.com/csp-probe.json");
  } catch {
    /* 被拦就是抛 TypeError，这里不看抛没抛，看下面的事件 */
  }
  await sleep(80);
  log(violations.includes("connect-src"), "外部 fetch 被拦（connect-src 里没有 https:）");
}

/* ---- 8. 外部 iframe：被拦（frame-src 只放行自己和组件协议） ---- */
{
  const frame = document.createElement("iframe");
  frame.src = "https://example.com/csp-probe-frame";
  document.body.appendChild(frame);
  await sleep(80);
  log(violations.includes("frame-src"), "外部 iframe 被拦（frame-src 只放行 'self' 与组件协议）");
}

const passed = lines.filter((line) => line.startsWith("PASS")).length;
document.getElementById("out").textContent = `${lines.join("\n")}\n\n${passed}/${lines.length} passed\nviolations: ${violations.join(", ")}`;
