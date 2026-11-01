#!/usr/bin/env node
/**
 * agent 端点的真机探针。
 *
 * 为什么要有它：`agent_policy.rs` 的 26 条 + `tests/agent.html` 的 57 条 +
 * `npm run test:agent` 的 14 条，全在测"解析对不对 / 白名单对不对 / CLI 发出去的
 * 请求形状对不对"。**监听、令牌校验、Tauri 往返、只绑回环这四件只有真机能验** ——
 * `cargo check` 干净不等于那个 TCP 端口真的能连上，更不等于 Rust 把话递给 webview
 * 之后还能拿回一句话。
 *
 * 前提：Lattice 在跑，且开了 Agent access（设置里勾上，或 `agent/config.json` 写
 * `{"enabled": true}` 后重启应用）。
 *
 *   node scripts/probe-agent.mjs
 *
 * 它只读端点，不改任何文件，只发 `state` 与几条注定被拒的请求 —— 不动桌面。
 *
 * **`/health` 也要令牌**（[AGENT_ACCESS.md §3](../docs/AGENT_ACCESS.md)）。这不是
 * 疏忽：带上令牌它才回答，于是"401"和"连不上"是两句话 —— 前者说明端点活着、令牌
 * 不对，后者说明根本没人在听。第一版探针按"health 该是公开的"写，三条一起红；
 * 红的是探针的假设，不是代码。
 */
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.APPDATA ? join(process.env.APPDATA, "com.iron-tom.lattice", "agent") : null;
const ENDPOINT = CONFIG_DIR ? join(CONFIG_DIR, "endpoint.json") : null;

const lines = [];
const pass = (name, detail = "") => lines.push({ ok: true, name, detail });
const fail = (name, detail = "") => lines.push({ ok: false, name, detail });

function readEndpoint() {
  if (!ENDPOINT) throw new Error("no %APPDATA% — this endpoint only exists on Windows");
  return JSON.parse(readFileSync(ENDPOINT, "utf8"));
}

async function call(url, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, init);
    return { status: response.status, text: await response.text(), ms: Date.now() - started };
  } catch (error) {
    // 连不上时 fetch 抛 TypeError，真正的原因在 cause.code 里（ECONNREFUSED 等）
    return { status: 0, text: String(error?.cause?.code ?? error.message), ms: Date.now() - started };
  }
}

const authed = (token, extra = {}) => ({
  ...extra,
  headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
});

let endpoint;
try {
  endpoint = readEndpoint();
} catch (error) {
  console.log(`✗ 读不到端点：${error.message}`);
  console.log("  · 应用没在跑？ · Agent access 关着？ · 从没在这台机器上开过？");
  process.exit(1);
}

const { url, health, port, token } = endpoint;
console.log(`端点  ${url}`);
console.log(`端口  ${port}`);
console.log(`令牌  ${token ? `${String(token).length} 字符` : "(空 —— 那就不该有人在听)"}`);
console.log("");

/* ------------------------------------------------------- 1. 监听 + 令牌 */

{
  const result = await call(health, authed(token, { method: "GET" }));
  let body = null;
  try {
    body = JSON.parse(result.text);
  } catch {}
  if (result.status === 200 && body?.ok === true && body?.app === "lattice") {
    pass("监听：GET /health 带令牌回 200 且是 lattice 自己", `${result.ms}ms`);
  } else {
    fail("监听：GET /health 带令牌", `${result.status} ${result.text.slice(0, 120)}`);
  }
}

{
  // 这一条钉的是"401 与连不上能分开"：没有它，探针只能证明"有人在听"，
  // 证明不了"听的那个认令牌"。
  const result = await call(health, { method: "GET" });
  if (result.status === 401) pass("令牌：/health 不带令牌是 401（所以 401 ≠ 连不上）", `${result.ms}ms`);
  else fail("令牌：/health 不带令牌该是 401", `拿到 ${result.status} ${result.text.slice(0, 120)}`);
}

{
  const result = await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "state" }) });
  if (result.status === 401) pass("令牌：POST /rpc 不带令牌是 401");
  else fail("令牌：POST /rpc 不带令牌该是 401", `拿到 ${result.status} ${result.text.slice(0, 120)}`);
}

{
  const result = await call(url, authed("deadbeef", { method: "POST", body: JSON.stringify({ op: "state" }) }));
  if (result.status === 401) pass("令牌：错的令牌也是 401");
  else fail("令牌：错的令牌该是 401", `拿到 ${result.status} ${result.text.slice(0, 120)}`);

  // 401 里回显令牌，等于把校验变成一个 oracle
  if (result.text.includes(String(token))) fail("令牌：401 的响应里回显了真令牌");
  else pass("令牌：401 的响应里没有回显令牌");
}

/* --------------------------------------------------------- 2. Tauri 往返 */

{
  const result = await call(url, authed(token, { method: "POST", body: JSON.stringify({ op: "state" }) }));
  let body = null;
  try {
    body = JSON.parse(result.text);
  } catch {}

  const snapshot = body?.result;
  const looksReal =
    result.status === 200 &&
    body?.ok === true &&
    Array.isArray(snapshot?.actions) &&
    Array.isArray(snapshot?.widgets) &&
    typeof snapshot?.theme === "string";

  if (looksReal) {
    pass(
      "往返：state 从 webview 拿回了真快照",
      `${result.ms}ms · ${snapshot.widgets.length} 个组件 · ${snapshot.actions.length} 个动作 · theme=${snapshot.theme}`,
    );
  } else if (result.status === 200) {
    // 空壳（ok:true 但没有 actions/widgets）说明前端没接上，Rust 自己编了一个回答
    fail("往返：state 回了 200 但不是真快照", result.text.slice(0, 200));
  } else {
    fail("往返：state", `${result.status} ${result.text.slice(0, 200)}`);
  }
}

/* --------------------------------------------------- 3. 带令牌的四条路由 */

{
  const cases = [
    { name: "GET /rpc 是 405", expect: 405, target: url, init: authed(token, { method: "GET" }) },
    { name: "未知路径是 404", expect: 404, target: url.replace(/\/rpc$/, "/nope"), init: authed(token, { method: "GET" }) },
    {
      name: "坏 JSON 是 400",
      expect: 400,
      target: url,
      init: authed(token, { method: "POST", body: "{ not json" }),
    },
    {
      name: "白名单外的动作是 403",
      expect: 403,
      target: url,
      init: authed(token, { method: "POST", body: JSON.stringify({ op: "act", action: "state.drop" }) }),
    },
  ];

  for (const item of cases) {
    const result = await call(item.target, item.init);
    if (result.status === item.expect) pass(item.name, `${result.ms}ms`);
    else fail(item.name, `拿到 ${result.status} ${result.text.slice(0, 120)}`);
  }
}

/* ------------------------------------------------------ 4. 只绑回环 */

{
  // 端点带着桌面控制权，绑到 0.0.0.0 就是把整台机器交出去。endpoint.json 里写的是
  // 127.0.0.1，但那只是"客户端去连哪个地址"，不等于 listener 绑在哪个地址上 ——
  // 从本机的局域网 IP 去连一次，连不上才说明它真的只认回环。
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal)?.address;

  if (!lan) {
    pass("回环：这台机器没有局域网 IPv4，跳过（验不了不代表验过了）");
  } else {
    const result = await call(`http://${lan}:${port}/health`, { method: "GET" });
    if (result.status === 0) pass(`回环：从 ${lan} 连 ${port} 连不上`, result.text);
    else fail(`回环：从 ${lan} 连上了 ${port}`, `${result.status} —— 端点绑在了非回环地址上`);
  }
}

/* ---------------------------------------------------------------- 输出 */

const width = Math.max(...lines.map((line) => line.name.length));
for (const line of lines) {
  console.log(`${line.ok ? "PASS" : "FAIL"}  ${line.name.padEnd(width)}  ${line.detail}`);
}

const failed = lines.filter((line) => !line.ok).length;
console.log("");
console.log(`${lines.length} 条，${failed} 条红。`);
process.exit(failed ? 1 : 0);
