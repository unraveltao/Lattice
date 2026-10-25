/**
 * 浏览器预览那条 assistant 通道的测试（`npm run test:llm-proxy`）。
 *
 * 测两样东西：
 *   1. **纯规则**。`scripts/dev-llm-proxy.mjs` 把 `llm_policy.rs` / `llm.rs` 的
 *      几条规则抄了一份（浏览器里没有 Rust，不抄就没有预览）。这里用**和 Rust
 *      测试同一组样例**钉住它们：base URL 的四种写法、明文 http 只给本机、
 *      掩码、三种鉴权、401/404/429 各自的话、工具参数保持字符串。
 *   2. **整条路**。起一个假 provider（`127.0.0.1:0`），把中间件挂到一个真 HTTP
 *      服务上，然后像浏览器那样发请求。这样连"读的是哪份配置、key 有没有漏出去、
 *      请求体长什么样"一起测到了。
 *
 * 不测的是"Rust 那一份有没有跟着改" —— 那由 `cargo test` / 那几只 `rustc --test`
 * 壳子负责。两边同名函数的含义必须一致，改一边时另一边的测试是唯一的提醒。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authHeader,
  buildBody,
  chatUrl,
  createLlmMiddleware,
  describeFailure,
  describeStatus,
  LlmError,
  maskKey,
  modelsUrl,
  normalizeAuth,
  normalizeBase,
  parseChat,
  parseModels,
  profileIdOk,
  profileLabel,
  readConfig,
} from "./dev-llm-proxy.mjs";

// ---------------------------------------------------------------------------
// 纯规则
// ---------------------------------------------------------------------------

function rejectsWith(raw, message) {
  assert.throws(() => normalizeBase(raw), (error) => {
    assert.ok(error instanceof LlmError, `${raw} 应该是 LlmError`);
    assert.equal(error.message, message);
    return true;
  });
}

test("normalizeBase 认得用户会填的那几种样子", () => {
  // 少了协议头
  assert.equal(normalizeBase("api.deepseek.com"), "https://api.deepseek.com");
  // 多了尾斜杠
  assert.equal(normalizeBase("https://api.deepseek.com/"), "https://api.deepseek.com");
  // 带 /v1
  assert.equal(normalizeBase("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1");
  // 整个端点贴进来
  assert.equal(normalizeBase("https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/v1");
  assert.equal(normalizeBase("https://api.deepseek.com/v1/models"), "https://api.deepseek.com/v1");
  // 首尾空格
  assert.equal(normalizeBase("  https://api.deepseek.com/v1  "), "https://api.deepseek.com/v1");
});

test("normalizeBase 只放 http/https，明文 http 只给本机", () => {
  rejectsWith("", "the API base URL is empty");
  rejectsWith("   ", "the API base URL is empty");
  rejectsWith("ftp://example.com", "only http:// and https:// base URLs are supported");
  rejectsWith("https://", "the API base URL has no host");
  // 明文 http 打到外网：key 等于贴在明信片上
  rejectsWith(
    "http://api.example.com/v1",
    'plain http is only allowed for localhost (got "api.example.com") — use https, or point at a local model on 127.0.0.1',
  );
  // 本机四种写法都要放行
  assert.equal(normalizeBase("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeBase("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeBase("http://127.9.9.9:1"), "http://127.9.9.9:1");
  // IPv6 的方括号要认出来 —— 按冒号切会切成 "["，本机就被判成远程
  assert.equal(normalizeBase("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
});

test("urls 拼在 base 后面，不是替换", () => {
  assert.equal(chatUrl("https://x.dev/v1"), "https://x.dev/v1/chat/completions");
  assert.equal(modelsUrl("https://x.dev/v1"), "https://x.dev/v1/models");
});

test("maskKey 永远不回完整 key", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("   "), "");
  // 短的只给一个"有 key"的信号
  assert.equal(maskKey("sk-1234"), "••••");
  assert.equal(maskKey("sk-legacy-key-1234567890"), "sk-l…7890");
});

test("鉴权只有三种形状，别名和 Rust / TS 同一组", () => {
  assert.equal(normalizeAuth("bearer"), "bearer");
  assert.equal(normalizeAuth(""), "bearer");
  assert.equal(normalizeAuth("whatever"), "bearer");
  assert.equal(normalizeAuth("none"), "none");
  assert.equal(normalizeAuth("no_key"), "none");
  assert.equal(normalizeAuth("api-key-header"), "api-key-header");
  assert.equal(normalizeAuth("api_key"), "api-key-header");
  assert.equal(normalizeAuth("apikey"), "api-key-header");

  assert.deepEqual(authHeader("bearer", " sk-1 "), ["authorization", "Bearer sk-1"]);
  assert.deepEqual(authHeader("api-key-header", "sk-1"), ["api-key", "sk-1"]);
  // 本机模型常常不要 key；空的 Bearer 不是合法鉴权，只会换来 401
  assert.equal(authHeader("none", "sk-1"), null);
});

test("档的默认名字：主机名，本机叫 Local model", () => {
  assert.equal(profileLabel("https://api.deepseek.com/v1"), "api.deepseek.com");
  assert.equal(profileLabel("https://www.example.com"), "example.com");
  assert.equal(profileLabel("http://127.0.0.1:11434"), "Local model");
  assert.equal(profileLabel("http://[::1]:11434"), "Local model");
  assert.equal(profileLabel("nonsense"), "");
});

test("档 id 只认 p- 加小写十六进制", () => {
  assert.equal(profileIdOk("p-1e9ac1"), true);
  assert.equal(profileIdOk("p-19c47a6f2b1-2"), true);
  assert.equal(profileIdOk("p-legacy"), false); // 老 bug：l/g/y 不是十六进制
  assert.equal(profileIdOk("legacy"), false);
  assert.equal(profileIdOk("p-"), false);
  assert.equal(profileIdOk(`p-${"a".repeat(41)}`), false);
});

test("状态码说人话，别把 401 说成连不上", () => {
  assert.match(describeStatus(401, ""), /rejected the API key \(HTTP 401\)/);
  assert.match(describeStatus(403, ""), /rejected the API key \(HTTP 403\)/);
  assert.match(describeStatus(404, ""), /the endpoint was not found \(HTTP 404\)/);
  assert.match(describeStatus(404, ""), /usually https:\/\/api\.<name>\.com\/v1/);
  assert.match(describeStatus(429, ""), /rate limiting or out of quota/);
  assert.match(describeStatus(400, '{"error":"bad tools"}'), /rejected the request \(HTTP 400\) — \{"error":"bad tools"\}/);
  assert.match(describeStatus(500, ""), /the provider returned an error \(HTTP 500\)/);
  assert.match(describeStatus(302, ""), /unexpected HTTP status 302/);
  // 响应体压成一行、并且有限长
  const long = "x".repeat(400);
  const message = describeStatus(500, long);
  assert.ok(message.length < 400, "长响应体要被截断");
  assert.ok(message.endsWith("…"), "截断了要有省略号");
});

test("网络失败也分得清", () => {
  const refused = new Error("fetch failed");
  refused.cause = { code: "ECONNREFUSED" };
  assert.match(describeFailure(refused), /could not reach the provider/);

  assert.match(describeFailure(new Error("The operation was aborted due to timeout")), /did not answer in time/);
  assert.match(describeFailure(new Error("self-signed certificate")), /TLS handshake failed/);
  assert.match(describeFailure(new Error("weird")), /the request could not be sent: weird/);
});

test("parseChat：工具参数保持字符串，usage 有就带", () => {
  const reply = parseChat(
    JSON.stringify({
      choices: [
        {
          // 只调工具时 content 是 null
          message: {
            content: null,
            tool_calls: [
              { id: "call_x", function: { name: "placement.list", arguments: '{"a":1}' } },
              // 有的供应商给的是对象，不是字符串
              { function: { name: "widget.read", arguments: { id: "x" } } },
              // 没有名字的那条要丢掉，否则模型会去调一个空名字的工具
              { id: "call_3", function: { arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }),
  );
  assert.equal(reply.text, "");
  assert.equal(reply.finish, "tool_calls");
  assert.deepEqual(reply.toolCalls, [
    { id: "call_x", name: "placement.list", arguments: '{"a":1}' },
    // 没给 id 时按序号补一个
    { id: "call_1", name: "widget.read", arguments: '{"id":"x"}' },
  ]);
  assert.deepEqual(reply.usage, { promptTokens: 12, completionTokens: 3 });
});

test("parseChat：多段内容和 200 里的 error", () => {
  const parts = parseChat(
    JSON.stringify({ choices: [{ message: { content: [{ text: "你" }, { text: "好" }] }, finish_reason: "stop" }] }),
  );
  assert.equal(parts.text, "你好");
  assert.deepEqual(parts.toolCalls, []);

  assert.throws(() => parseChat(JSON.stringify({ error: { message: "quota exceeded" } })), /quota exceeded/);
  assert.throws(() => parseChat("not json"), /did not return JSON/);
  assert.throws(() => parseChat(JSON.stringify({ choices: [] })), /no choices/);
});

test("parseModels：id 优先、Ollama 的 name 也认、去重", () => {
  assert.deepEqual(
    parseModels(
      JSON.stringify({
        data: [{ id: "deepseek-chat" }, { id: "deepseek-chat" }, { name: "llama3:8b" }, { id: "" }],
      }),
    ),
    ["deepseek-chat", "llama3:8b"],
  );
  assert.throws(() => parseModels(JSON.stringify({ data: [] })), /no models/);
  assert.throws(() => parseModels(JSON.stringify({})), /no "data" list/);
});

test("buildBody：没工具时整个字段都不出现", () => {
  const body = JSON.parse(buildBody("deepseek-chat", '[{"role":"user","content":"hi"}]', null, 0.4, 2048));
  assert.deepEqual(body, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.4,
    max_tokens: 2048,
    stream: false,
  });

  // 空数组也不算"有工具"：有的供应商见到空数组直接 400
  assert.equal("tools" in JSON.parse(buildBody("m", "[]", "[]", 0.4, 16)), false);

  const withTools = JSON.parse(buildBody("m", "[]", '[{"type":"function"}]', 9, 16));
  assert.deepEqual(withTools.tools, [{ type: "function" }]);
  assert.equal(withTools.tool_choice, "auto");
  // temperature 夹在 0..2，且只留两位小数
  assert.equal(withTools.temperature, 2);
});

// ---------------------------------------------------------------------------
// 整条路
// ---------------------------------------------------------------------------

const MODELS = { data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] };

/** 假 provider：按 `plan` 回话，把收到的请求记在 `seen` 里 */
function startProvider() {
  const seen = [];
  const plan = { status: 200, body: MODELS };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: body || null });
      response.writeHead(plan.status, { "content-type": "application/json" });
      response.end(typeof plan.body === "string" ? plan.body : JSON.stringify(plan.body));
    });
  });
  // 原地改，不换对象 —— 用例里赋值给 `provider.plan` 只会换掉外面的引用，
  // 服务器闭包里那个还是旧的（这一版就栽在这儿：改了 401，它仍然回 200）
  const setPlan = (next) => {
    plan.status = next.status ?? 200;
    plan.body = next.body ?? "";
  };
  return { server, seen, plan, setPlan };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const provider = startProvider();
const providerBase = await listen(provider.server);

const dir = mkdtempSync(join(tmpdir(), "lattice-llm-proxy-"));
const configFile = join(dir, "assistant.json");
// 只给这份环境：真实环境里的 `LATTICE_LLM_*` 不该影响这些用例
const env = { LATTICE_ASSISTANT_JSON: configFile };

const proxy = createServer((request, response) => {
  createLlmMiddleware({ env })(request, response, () => {
    response.statusCode = 404;
    response.end("not the dev assistant");
  });
});
const proxyBase = await listen(proxy);

/** 每次请求都现读配置文件 —— 所以每个用例只要把文件写一遍 */
function seed(config) {
  writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
}

const LEGACY_KEY = "sk-legacy-key-1234567890";

function legacy(base = `${providerBase}/v1`) {
  return { baseUrl: base, model: "deepseek-chat", temperature: 0.4, apiKey: LEGACY_KEY };
}

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${proxyBase}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: response.status, value, text };
}

after(() => {
  proxy.close();
  provider.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("v1 的老文件读得出来，key 只以掩码出现", async () => {
  seed(legacy());
  const { status, value, text } = await call("GET", "/api/llm/profiles");

  assert.equal(status, 200);
  // v1 就地升级成一条档（id 是 "legacy" 的十六进制写法：老 bug 就是这里带了字母）
  assert.equal(value.activeId, "p-1e9ac1");
  assert.equal(value.profiles.length, 1);
  const profile = value.profiles[0];
  assert.equal(profile.id, "p-1e9ac1");
  assert.equal(profile.baseUrl, `${providerBase}/v1`);
  assert.equal(profile.model, "deepseek-chat");
  assert.equal(profile.auth, "bearer");
  assert.equal(profile.temperature, 0.4);
  assert.equal(profile.keyHint, maskKey(LEGACY_KEY));
  assert.equal(profile.keySource, "file");
  assert.equal(profile.configured, true);
  // 六只手在 v1 迁移里一律落成"关"
  assert.equal(readConfig(env).hands.shell, false);
  // **整份响应里不许出现明文 key**
  assert.equal(text.includes(LEGACY_KEY), false);
  // v1 的 key 跟着搬过去了，用户不该重输
  assert.equal(readConfig(env).profiles[0].apiKey, LEGACY_KEY);
});

test("存一档：地址被归一化，新档不会抢走 active", async () => {
  seed(legacy());
  const { status, value } = await call("POST", "/api/llm/profiles", {
    op: "save",
    id: null,
    label: "",
    baseUrl: `${providerBase}/v1/chat/completions`,
    auth: "bearer",
    model: "deepseek-reasoner",
    temperature: 1,
  });

  assert.equal(status, 200);
  assert.match(value.id, /^p-[0-9a-f]+-[0-9a-f]+$/);
  assert.equal(value.view.activeId, "p-1e9ac1", "老的那条仍然是 active");
  const saved = value.view.profiles.find((profile) => profile.id === value.id);
  assert.equal(saved.baseUrl, `${providerBase}/v1`, "整个端点贴进来要剥掉尾巴");
  assert.equal(saved.label, "Local model", "没给名字就用主机名");
  assert.equal(saved.keyHint, "", "新建的档没有 key");
  assert.equal(saved.configured, false);

  // 改已有那一档：label 空 = 用主机名覆盖；models 缓存清掉
  const edited = await call("POST", "/api/llm/profiles", {
    op: "save",
    id: "p-1e9ac1",
    label: "我的 DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    auth: "api_key",
    model: "deepseek-chat",
    temperature: 0.4,
  });
  const updated = edited.value.view.profiles.find((profile) => profile.id === "p-1e9ac1");
  assert.equal(updated.label, "我的 DeepSeek");
  assert.equal(updated.auth, "api-key-header");
  // key 不跟着走 —— 改个模型名不该让用户重新粘一次 key
  assert.equal(updated.keyHint, maskKey(LEGACY_KEY));
});

test("存 key：写进文件，回的是掩码；空串等于删掉", async () => {
  seed(legacy());
  const saved = await call("POST", "/api/llm/profiles", { op: "key", id: "p-1e9ac1", key: "  sk-new-key-abcdefgh  " });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.profiles[0].keyHint, "sk-n…efgh");
  assert.equal(saved.text.includes("sk-new-key-abcdefgh"), false);

  // 首尾空格要修掉：粘进来时几乎总带着换行
  assert.equal(readConfig(env).profiles[0].apiKey, "sk-new-key-abcdefgh");
  assert.equal(JSON.parse(readFileSync(configFile, "utf8")).version, 3, "写出去永远是 v3");

  const cleared = await call("POST", "/api/llm/profiles", { op: "key", id: "p-1e9ac1", key: "" });
  assert.equal(cleared.value.profiles[0].keyHint, "");
  assert.equal(cleared.value.profiles[0].configured, false);
});

test("切 active / 删档", async () => {
  seed(legacy());
  const added = await call("POST", "/api/llm/profiles", {
    op: "save",
    label: "second",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o",
    auth: "bearer",
    temperature: 0.2,
  });
  const second = added.value.id;

  const activated = await call("POST", "/api/llm/profiles", { op: "activate", id: second });
  assert.equal(activated.value.activeId, second);

  // 删掉 active 那条，active 退回第一条
  const removed = await call("POST", "/api/llm/profiles", { op: "remove", id: second });
  assert.equal(removed.status, 200);
  assert.equal(removed.value.activeId, "p-1e9ac1");
  assert.equal(removed.value.profiles.length, 1);
});

test("一轮对话：出门的请求体和回来的形状都对", async () => {
  seed(legacy());
  provider.seen.length = 0;
  provider.setPlan({
    status: 200,
    body: {
      choices: [
        {
          message: {
            content: "桌面上一共 2 个组件",
            tool_calls: [{ id: "call_9", function: { name: "placement.list", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 7 },
    },
  });

  const messages = JSON.stringify([
    { role: "system", content: "you are lattice" },
    { role: "user", content: "我桌面有什么" },
  ]);
  const tools = JSON.stringify([{ type: "function", function: { name: "placement.list" } }]);
  const { status, value } = await call("POST", "/api/llm/chat", { requestId: "r-1", messages, tools });

  assert.equal(status, 200);
  assert.equal(value.text, "桌面上一共 2 个组件");
  assert.deepEqual(value.toolCalls, [{ id: "call_9", name: "placement.list", arguments: "{}" }]);
  assert.deepEqual(value.usage, { promptTokens: 30, completionTokens: 7 });

  const [request] = provider.seen;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization, `Bearer ${LEGACY_KEY}`);
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, "deepseek-chat");
  assert.equal(sent.stream, false, "浏览器预览是非流式");
  assert.equal(sent.max_tokens, 2048);
  assert.equal(sent.temperature, 0.4);
  assert.deepEqual(sent.messages, JSON.parse(messages));
  assert.deepEqual(sent.tools, JSON.parse(tools));
  assert.equal(sent.tool_choice, "auto");
});

test("provider 的错要翻成人话，别统一说成网络问题", async () => {
  seed(legacy());
  provider.setPlan({ status: 401, body: { error: { message: "invalid api key" } } });
  const unauthorized = await call("POST", "/api/llm/chat", {
    messages: JSON.stringify([{ role: "user", content: "hi" }]),
  });
  assert.equal(unauthorized.status, 400);
  assert.match(unauthorized.value.error, /rejected the API key \(HTTP 401\)/);
  assert.match(unauthorized.value.error, /invalid api key/);

  provider.setPlan({ status: 404, body: "" });
  const missing = await call("POST", "/api/llm/chat", {
    messages: JSON.stringify([{ role: "user", content: "hi" }]),
  });
  assert.match(missing.value.error, /usually https:\/\/api\.<name>\.com\/v1/);
});

test("没配好就说清楚缺哪一样", async () => {
  seed({ version: 3, activeId: "", hands: {}, workspace: "", profiles: [] });
  const none = await call("POST", "/api/llm/chat", {
    messages: JSON.stringify([{ role: "user", content: "hi" }]),
  });
  assert.equal(none.status, 400);
  assert.match(none.value.error, /no model profile yet/);

  seed(legacy());
  // 地址合法、就是没有 key（v3 的 bearer 档）。v1 那条路没有 key 会迁成 `none`，
  // 那是"本机模型"的意思，不该报缺 key
  seed({
    version: 3,
    activeId: "p-1e9ac1",
    hands: {},
    workspace: "",
    profiles: [
      {
        id: "p-1e9ac1",
        label: "remote",
        baseUrl: `${providerBase}/v1`,
        auth: "bearer",
        apiKey: "",
        model: "deepseek-chat",
        temperature: 0.4,
        models: [],
      },
    ],
  });
  const noKey = await call("POST", "/api/llm/chat", {
    messages: JSON.stringify([{ role: "user", content: "hi" }]),
  });
  assert.match(noKey.value.error, /no key for this profile yet/);
});

test("测试连接：拉模型列表、记住候选", async () => {
  seed(legacy());
  provider.seen.length = 0;
  provider.setPlan({ status: 200, body: MODELS });

  const { status, value } = await call("POST", "/api/llm/models", { profileId: "p-1e9ac1" });
  assert.equal(status, 200);
  assert.deepEqual(value, ["deepseek-chat", "deepseek-reasoner"]);

  const [request] = provider.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/v1/models");
  assert.equal(request.headers.authorization, `Bearer ${LEGACY_KEY}`);

  // 记住了才能做下拉提示
  assert.deepEqual(readConfig(env).profiles[0].models, ["deepseek-chat", "deepseek-reasoner"]);
});

test("六只手的开关：读写同一份文件", async () => {
  seed(legacy());
  const saved = await call("POST", "/api/llm/hands", {
    hands: { files: true, shell: false, web: true, screen: false, input: false, mcp: false, workspace: " D:\\work " },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value, {
    files: true,
    shell: false,
    web: true,
    screen: false,
    input: false,
    mcp: false,
    workspace: "D:\\work",
    // 没给档位 → `ask`（多问一次是麻烦，少问一次是事故）
    approvalMode: "ask",
  });

  const read = await call("GET", "/api/llm/hands");
  assert.deepEqual(read.value, saved.value);
  // 拨得动 ≠ 接好了：浏览器里这些开关只是存进文件，执行仍然要 Rust
  assert.equal(readConfig(env).hands.files, true);
});

test("审批档：三选一，存下来的是归一化之后那个字面量", async () => {
  seed(legacy());
  const ro = await call("POST", "/api/llm/hands", {
    hands: { files: true, workspace: "", approvalMode: "ReadOnly" },
  });
  assert.equal(ro.value.approvalMode, "readonly");
  assert.equal(readConfig(env).approvalMode, "readonly");

  // 拼错的不许变成"更宽松的那一档"
  const typo = await call("POST", "/api/llm/hands", {
    hands: { files: true, workspace: "", approvalMode: "read-only" },
  });
  assert.equal(typo.value.approvalMode, "ask");
});

test("三道闸：只认本机 Origin、只收 JSON、别的路径不归它管", async () => {
  seed(legacy());
  // 组件的 iframe 源是不透明的 "null"，别的站也一样过不去
  const foreign = await call("POST", "/api/llm/chat", { messages: "[]" }, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);

  // 不是 application/json 的请求过不了"预检没人答"那一关
  const plain = await fetch(`${proxyBase}/api/llm/chat`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(plain.status, 415);

  // 不归它管的路径要交给下一个中间件（这里是 404 的兜底），不能自己编一页
  const other = await fetch(`${proxyBase}/somewhere-else`);
  assert.equal(other.status, 404);
  assert.equal(await other.text(), "not the dev assistant");

  // 路径对了、方法不对
  const wrongMethod = await call("GET", "/api/llm/chat");
  assert.equal(wrongMethod.status, 405);

  // 未知的 op 也要说清楚，别静默成功
  const unknown = await call("POST", "/api/llm/profiles", { op: "explode" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.value.error, /unknown profile operation "explode"/);
});
