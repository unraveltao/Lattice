/**
 * 浏览器预览里的 assistant —— 把 `llm_*` 那几个命令搬到 vite dev server 上。
 *
 * 为什么需要这一层：`npm run dev` 里没有 Rust，`isTauri()` 为 false，而
 * `platform/assistant.ts` 的每一条路都是 `invoke("llm_…")`。于是浏览器里的
 * assistant 面板能画出来、能开关，但一按"发送"就报"IPC 不可用"。
 *
 * 为什么是**同源中间件**，不是那条 agent 回环端点（`127.0.0.1:65401`）：
 *   1. 端点默认是关的（`agent/config.json` 里 `enabled`），也就是"预览时它多半
 *      根本没在跑"；
 *   2. 它的请求体上限是 64 KB（`agent_policy::MAX_BODY`），而带工具的对话请求
 *      轻松超过这个数 —— 症状会是"短问题能问、长一点的必失败"；
 *   3. 它没有流式增量，而且它是一道**有令牌的公开口子**：拿到 token 的任何进程
 *      都能拿用户的 key 花钱。dev server 的中间件只在这台机器上、只在
 *      `npm run dev` 期间存在，而且浏览器根本不需要越过第二道口。
 *
 * 这一层**不复制**的是：流式增量、六只手的执行、审计日志。三条都有同一个理由
 * —— 它们要的是 Rust（`lattice:llm-delta` 事件、`assistant_tool` 的白名单与
 * 额度、`agent::audit` 的落盘）。所以浏览器预览是"能用"，不是"和桌面一样"：
 * 回答在结束时整句出现，手一按会得到一句"桌面应用里才有"。
 *
 * 这一层**必须复制**的是 `src-tauri/src/llm_policy.rs` 与 `llm.rs` 的那几条规则
 * （base URL 归一化、三种鉴权、错误翻译、`assistant.json` 的 v3 形状）。不复制
 * 就没有浏览器预览，复制了就有两处真相 —— 所以：
 *   - 每一条都跟 Rust 那份**逐字对齐**（连错误原句都一样），
 *   - `scripts/dev-llm-proxy.test.mjs` 用 Rust 测试里的同一组样例钉住它们。
 * 改这里之前先看 `llm_policy.rs` 里对应的那个函数。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 中间件的挂载前缀。前端（`platform/devLlm.ts`）拼的是同一个字符串 */
const PREFIX = "/api/llm/";

/** 请求体上限。60k 字的历史 + 工具表，JSON 也就两百来 KB；1 MB 是宽裕的上限 */
const MAX_BODY = 1024 * 1024;

/** 和 `llm_policy::MAX_RESPONSE_BYTES` 对齐：再大就不读了，省得把内存吃光 */
const MAX_RESPONSE_BYTES = 512 * 1024;
/** 和 `llm_policy::MAX_OUTPUT_TOKENS` 对齐 */
const MAX_OUTPUT_TOKENS = 2048;
/** 和 `llm_policy` 的三道上限对齐 —— 超了**拒绝并说清楚**，不静默截断 */
const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_TOOLS = 32;
/** 错误话里带多少字的响应体。太长会把界面撑破，太短看不出是谁的错 */
const ERROR_SNIPPET = 240;

/** 列模型是"测试连接"，用户在那儿等着，所以给得短 */
const MODELS_TIMEOUT_MS = 20_000;
/** 一轮对话可以很慢（推理模型），但不能无限等 */
const CHAT_TIMEOUT_MS = 180_000;

/** 六个开关的名字，顺序和 `HandsSettings` 一致 */
const HANDS_KEYS = ["files", "shell", "web", "screen", "input", "mcp"];

/** 三档审批，顺序和 `hands_policy::APPROVAL_MODES` 一致 */
const APPROVAL_MODES = ["ask", "auto", "readonly"];

/** 认不出来一律退回 `ask`：多问一次是麻烦，少问一次是事故 */
export function normalizeApprovalMode(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  return APPROVAL_MODES.includes(text) ? text : "ask";
}

const DEFAULT_TEMPERATURE = 0.6;

/** 预期内的失败。catch 到它就回 400，其余一律 500（那是这个中间件自己的 bug） */
export class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmError";
  }
}

// ---------------------------------------------------------------------------
// base URL / 鉴权（对齐 `llm_policy.rs` 的同名函数）
// ---------------------------------------------------------------------------

/**
 * 归一化用户填的 base URL。
 *
 * 用户会填成 `api.deepseek.com`、`https://api.deepseek.com/`、
 * `…/v1/chat/completions` 这几种样子，全都要认。**明文 http 只给本机**：
 * key 明文发到外网等于贴在明信片上，这一步拦不住，后面所有的权限设计都白做。
 */
export function normalizeBase(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new LlmError("the API base URL is empty");

  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const lower = withScheme.toLowerCase();
  const secure = lower.startsWith("https://");
  if (!secure && !lower.startsWith("http://")) {
    throw new LlmError("only http:// and https:// base URLs are supported");
  }

  let base = withScheme.replace(/\/+$/, "");
  // 用户把完整端点贴进来了：剥掉尾巴，只留 base
  for (const suffix of ["/chat/completions", "/completions", "/models"]) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (!base) throw new LlmError("the API base URL has no host");

  const host = hostOf(base);
  if (!host) throw new LlmError("the API base URL has no host");

  if (!secure && !isLoopback(host)) {
    throw new LlmError(
      `plain http is only allowed for localhost (got "${host}") — use https, or point at a local model on 127.0.0.1`,
    );
  }
  return base;
}

/**
 * 从 base URL 里取主机名。
 *
 * 三种形状都要对：`host:port`、带账号的 `user:pass@host`、IPv6 的 `[::1]:8080`。
 * 最后这种按冒号切会切成 `[`，于是"本机 Ollama"被判成远程，用户看到的是
 * "明文 http 只允许本机"，而地址明明就是本机。
 */
export function hostOf(base) {
  const text = String(base ?? "");
  const at = text.indexOf("://");
  const rest = at < 0 ? "" : text.slice(at + 3);
  const authority = rest.split(/[/?#]/)[0] || "";
  if (authority.startsWith("[")) return authority.slice(1).split("]")[0] || "";
  const bare = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return bare.split(":")[0] || "";
}

/** 本机地址。`[::1]` 也认 —— Windows 上 Ollama 有时就绑在 v6 上 */
export function isLoopback(host) {
  const bare = String(host ?? "").trim().replace(/^\[|\]$/g, "");
  return (
    bare.toLowerCase() === "localhost" || bare === "127.0.0.1" || bare.startsWith("127.") || bare === "::1"
  );
}

export function chatUrl(base) {
  return `${base}/chat/completions`;
}

export function modelsUrl(base) {
  return `${base}/models`;
}

/**
 * 界面上显示的 key 提示。**永远不回完整 key**：它一旦进了前端状态，就会跟着
 * 调试面板、截图、某次 `JSON.stringify` 一起外泄。
 */
export function maskKey(key) {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return "";
  const chars = [...trimmed];
  if (chars.length <= 8) return "••••";
  return `${chars.slice(0, 4).join("")}…${chars.slice(-4).join("")}`;
}

/** 和 TS 的 `normalizeAuth`、Rust 的 `normalize_auth` 同一组别名 */
export function normalizeAuth(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (value === "none" || value === "no-key") return "none";
  if (value === "api-key-header" || value === "apikey" || value === "api-key") return "api-key-header";
  return "bearer";
}

/** 这一档要挂的头。`none` 什么都不挂 —— 空的 Bearer 不是合法的鉴权，只会换来 401 */
export function authHeader(auth, key) {
  const trimmed = String(key ?? "").trim();
  switch (normalizeAuth(auth)) {
    case "none":
      return null;
    case "api-key-header":
      return ["api-key", trimmed];
    default:
      return ["authorization", `Bearer ${trimmed}`];
  }
}

/** 一档的默认名字：主机名（去掉 `www.`）。本机地址叫 "Local model" */
export function profileLabel(base) {
  const host = hostOf(base);
  if (!host) return "";
  if (isLoopback(host)) return "Local model";
  return host.replace(/^www\./, "");
}

/** id 规则：`p-` 开头，后面只许小写十六进制 / 数字 / 短横线（对齐 `profile_id_ok`） */
export function profileIdOk(id) {
  const text = String(id ?? "");
  if (!text.startsWith("p-")) return false;
  const rest = text.slice(2);
  return rest.length > 0 && rest.length <= 40 && /^[0-9a-f-]+$/.test(rest);
}

// ---------------------------------------------------------------------------
// 人话（对齐 `describe_status` / `describe_failure`）
// ---------------------------------------------------------------------------

function bodySnippet(body) {
  const text = String(body ?? "").trim();
  if (!text) return "";
  const oneLine = text.split(/\s+/).join(" ");
  const chars = [...oneLine];
  if (chars.length <= ERROR_SNIPPET) return oneLine;
  return `${chars.slice(0, ERROR_SNIPPET).join("")}…`;
}

/**
 * HTTP 状态码 → 人话。
 *
 * 这一层的价值在于**别把 401 说成"连不上"**：用户看到"检查你的网络"会去重启
 * 路由器，而真正要做的是换一把 key。
 */
export function describeStatus(status, body) {
  const snippet = bodySnippet(body);
  const detail = snippet ? ` — ${snippet}` : "";
  if (status === 401 || status === 403) {
    return `the provider rejected the API key (HTTP ${status})${detail}. Check the key in Assistant settings`;
  }
  if (status === 404) {
    return `the endpoint was not found (HTTP 404)${detail}. The base URL is usually https://api.<name>.com/v1`;
  }
  if (status === 413) return `the request was too large (HTTP 413)${detail}`;
  if (status === 429) return `the provider is rate limiting or out of quota (HTTP 429)${detail}`;
  if (status >= 400 && status <= 499) return `the provider rejected the request (HTTP ${status})${detail}`;
  if (status >= 500 && status <= 599) return `the provider returned an error (HTTP ${status})${detail}`;
  return `unexpected HTTP status ${status}${detail}`;
}

/**
 * 网络层失败 → 人话。Node 的 `fetch` 只会给一句 "fetch failed"，真正的原因在
 * `cause.code` 里；直接甩给用户等于没说。
 */
export function describeFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = String(error?.cause?.code ?? error?.code ?? "");
  const haystack = `${message} ${code}`.toLowerCase();

  if (haystack.includes("timeout") || haystack.includes("timed out") || haystack.includes("etimedout")) {
    return "the provider did not answer in time";
  }
  if (
    haystack.includes("certificate") ||
    haystack.includes("self-signed") ||
    haystack.includes("tls") ||
    haystack.includes("ssl")
  ) {
    return "the TLS handshake failed (a proxy or a certificate problem)";
  }
  if (
    haystack.includes("econnrefused") ||
    haystack.includes("enotfound") ||
    haystack.includes("econnreset") ||
    haystack.includes("ehostunreach") ||
    haystack.includes("fetch failed") ||
    haystack.includes("network")
  ) {
    return "could not reach the provider — check the base URL and your connection";
  }
  return `the request could not be sent: ${message}`;
}

// ---------------------------------------------------------------------------
// 请求体与应答（对齐 `build_body` / `check_messages` / `parse_chat` / `parse_models`）
// ---------------------------------------------------------------------------

function charCount(text) {
  return [...text].length;
}

/** 消息体检。超了就拒绝 —— 静默截断会让模型在"我不记得"的状态下自信地回答 */
export function checkMessages(messagesJson) {
  let list;
  try {
    list = JSON.parse(String(messagesJson ?? ""));
  } catch {
    throw new LlmError("the provider did not return JSON: messages is not JSON");
  }
  if (!Array.isArray(list)) throw new LlmError('"messages" must be an array');
  if (list.length === 0) throw new LlmError('"messages" is empty');
  if (list.length > MAX_MESSAGES) {
    throw new LlmError(
      `the conversation has ${list.length} messages, which is more than the ${MAX_MESSAGES} this platform sends`,
    );
  }
  let total = 0;
  for (const [index, message] of list.entries()) {
    const role = message && typeof message === "object" ? message.role : "";
    if (!["system", "user", "assistant", "tool"].includes(role)) {
      throw new LlmError(`message ${index} has an unknown role "${role}"`);
    }
    const content = typeof message.content === "string" ? message.content : "";
    const chars = charCount(content);
    if (chars > MAX_MESSAGE_CHARS) {
      throw new LlmError(`message ${index} is longer than ${MAX_MESSAGE_CHARS} characters`);
    }
    total += chars;
  }
  if (total > MAX_TOTAL_CHARS) {
    throw new LlmError(
      `the conversation is ${total} characters, which is more than the ${MAX_TOTAL_CHARS} this platform sends`,
    );
  }
}

export function checkTools(toolsJson) {
  let list;
  try {
    list = JSON.parse(String(toolsJson ?? ""));
  } catch {
    throw new LlmError("the provider did not return JSON: tools is not JSON");
  }
  if (!Array.isArray(list)) throw new LlmError('"tools" must be an array');
  if (list.length > MAX_TOOLS) throw new LlmError(`too many tools (max ${MAX_TOOLS})`);
}

function clampTemperature(value) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TEMPERATURE;
  return Number(Math.min(2, Math.max(0, number)).toFixed(2));
}

/**
 * 拼请求体。
 *
 * `tools` 为空或空数组时**整个字段都不出现**：有的供应商见到空数组会直接 400。
 * Rust 那边不重新序列化消息（省一次解析），这里用 `JSON.parse` 再 `stringify`：
 * 形状已经过 `checkMessages`，而 Node 的解析器不会给我们多一处"手写 JSON"的坑。
 */
export function buildBody(model, messagesJson, toolsJson, temperature, maxTokens) {
  const body = {
    model: String(model ?? "").trim(),
    messages: JSON.parse(String(messagesJson ?? "")),
    temperature: clampTemperature(temperature),
    max_tokens: maxTokens,
    stream: false,
  };
  if (toolsJson != null) {
    const tools = JSON.parse(String(toolsJson));
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
  }
  return JSON.stringify(body);
}

/**
 * 解析 `/chat/completions` 的应答。
 *
 * `arguments` 保持**字符串**（协议如此）：供应商给对象时这里就写成字符串，
 * 前端只处理一种形状。
 */
export function parseChat(body) {
  let value;
  try {
    value = JSON.parse(String(body ?? ""));
  } catch (error) {
    throw new LlmError(`the provider did not return JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object") {
    throw new LlmError("the provider did not return JSON: expected an object");
  }

  // 有的供应商在 200 里塞 error（兼容层尤其常见）
  if (value.error) {
    const message = value.error.message && typeof value.error.message === "string"
      ? value.error.message
      : "the provider reported an error";
    throw new LlmError(message);
  }

  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  if (!choice) throw new LlmError("the response has no choices");
  const message = choice.message;
  if (!message || typeof message !== "object") throw new LlmError("the response has no message");

  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    // 只调工具时是 null；有的供应商给的是数组（多段内容）
    text = message.content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  const toolCalls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const [index, call] of message.tool_calls.entries()) {
      const fn = call && typeof call === "object" ? call.function : null;
      const name = fn && typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      let args = "{}";
      if (fn.arguments !== undefined && fn.arguments !== null) {
        args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
      }
      const id = call && typeof call.id === "string" && call.id ? call.id : `call_${index}`;
      toolCalls.push({ id, name, arguments: args });
    }
  }

  const reply = {
    text,
    toolCalls,
    finish: typeof choice.finish_reason === "string" ? choice.finish_reason : "",
  };
  if (value.usage && typeof value.usage === "object") {
    reply.usage = {
      promptTokens: Number(value.usage.prompt_tokens) || 0,
      completionTokens: Number(value.usage.completion_tokens) || 0,
    };
  }
  return reply;
}

/** 解析 `GET /models`。只回 id 列表；Ollama 的兼容层给的是 `name` */
export function parseModels(body) {
  let value;
  try {
    value = JSON.parse(String(body ?? ""));
  } catch (error) {
    throw new LlmError(`the provider did not return JSON: ${error.message}`);
  }
  if (!Array.isArray(value?.data)) throw new LlmError('the response has no "data" list');

  const out = [];
  for (const item of value.data) {
    const id = typeof item?.id === "string" && item.id ? item.id : null;
    const name = !id && typeof item?.name === "string" && item.name ? item.name : null;
    const picked = id ?? name;
    if (picked && !out.includes(picked)) out.push(picked);
  }
  if (out.length === 0) throw new LlmError("the provider returned no models");
  return out;
}

// ---------------------------------------------------------------------------
// assistant.json（对齐 `llm.rs` 的 read_config / parse_config / normalize / write_config）
// ---------------------------------------------------------------------------

/** 配置文件的位置。`LATTICE_ASSISTANT_JSON` 只给测试用（指到一份临时文件） */
export function assistantPath(env = process.env) {
  const override = String(env.LATTICE_ASSISTANT_JSON ?? "").trim();
  if (override) return override;
  const roaming = String(env.APPDATA ?? "").trim() || join(homedir(), "AppData", "Roaming");
  return join(roaming, "com.iron-tom.lattice", "assistant.json");
}

export function emptyConfig() {
  return {
    version: 3,
    activeId: "",
    hands: { files: false, shell: false, web: false, screen: false, input: false, mcp: false },
    workspace: "",
    approvalMode: "ask",
    profiles: [],
  };
}

function profileFrom(value) {
  const at = value && typeof value === "object" ? value : {};
  return {
    id: String(at.id ?? ""),
    label: String(at.label ?? ""),
    baseUrl: String(at.baseUrl ?? ""),
    auth: String(at.auth ?? "bearer"),
    apiKey: String(at.apiKey ?? ""),
    model: String(at.model ?? ""),
    temperature: typeof at.temperature === "number" && Number.isFinite(at.temperature) ? at.temperature : null,
    models: Array.isArray(at.models) ? at.models.filter((model) => typeof model === "string") : [],
  };
}

/** v1 的四个平铺字段 → 一条档。地址不合法（比如以前存的明文 http 远程）就当没配 */
function migrateLegacy(value) {
  const config = emptyConfig();
  let base;
  try {
    base = normalizeBase(String(value?.baseUrl ?? ""));
  } catch {
    return config;
  }
  const apiKey = String(value?.apiKey ?? "");
  const profile = {
    // 不能写 "p-legacy"：`profileIdOk` 只认小写十六进制，"l" "g" "y" 不在里面，
    // 迁移出来的那一档会被 normalize 当成坏档丢掉。这串是 "legacy" 的十六进制写法。
    id: "p-1e9ac1",
    label: profileLabel(base),
    baseUrl: base,
    // v1 只有在 key 齐了时才算配置好，所以没有 key 的老文件基本是本机模型。
    // 迁成 `none` 而不是 `bearer`：本机模型挂一个空 Bearer 只会换来 401
    auth: apiKey.trim() ? "bearer" : "none",
    apiKey,
    model: String(value?.model ?? "").trim(),
    temperature:
      typeof value?.temperature === "number" && Number.isFinite(value.temperature) ? value.temperature : null,
    models: [],
  };
  config.activeId = profile.id;
  config.profiles = [profile];
  // 手一条都不开：老用户没同意过"它能跑命令"
  return config;
}

/** 归一化：坏档逐条丢、名字补上、active 不能悬空。**原地改，不写盘** */
export function normalizeConfig(config) {
  const next = config && typeof config === "object" ? config : emptyConfig();
  next.version = 3;

  const seen = [];
  next.profiles = (Array.isArray(next.profiles) ? next.profiles : [])
    .map(profileFrom)
    .filter((profile) => {
      if (!profileIdOk(profile.id)) return false;
      try {
        profile.baseUrl = normalizeBase(profile.baseUrl);
      } catch {
        return false;
      }
      if (seen.includes(profile.id)) return false;
      seen.push(profile.id);
      profile.auth = normalizeAuth(profile.auth);
      profile.model = profile.model.trim();
      if (!profile.label.trim()) profile.label = profileLabel(profile.baseUrl);
      // 列表最多留 40 个候选模型：它只是下拉提示，不是数据
      profile.models = profile.models.slice(0, 40);
      return true;
    });

  if (next.profiles.length === 0) {
    next.activeId = "";
  } else if (!next.profiles.some((profile) => profile.id === next.activeId)) {
    next.activeId = next.profiles[0].id;
  }

  const hands = next.hands && typeof next.hands === "object" ? next.hands : {};
  next.hands = {};
  for (const key of HANDS_KEYS) next.hands[key] = hands[key] === true;
  next.workspace = String(next.workspace ?? "").trim();
  // 审批档：空串 / 拼错一律落成 `ask`（和 `hands_policy::normalize_approval` 同一句）
  next.approvalMode = normalizeApprovalMode(next.approvalMode);
  return next;
}

/**
 * 把磁盘上的文本读成配置。v2/v3 直接用，v1 就地迁移。
 *
 * 读失败 / 坏档一律"当它没有"，但**不写回**：只有用户下一次保存才落盘。顺手写
 * 一次空配置的后果是"一次解析失败永久丢 key"，而 key 换不了。
 */
export function parseConfig(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? ""));
  } catch {
    return emptyConfig();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyConfig();
  const config = Array.isArray(value.profiles) ? emptyConfig() : migrateLegacy(value);
  if (Array.isArray(value.profiles)) {
    config.activeId = String(value.activeId ?? "");
    config.workspace = String(value.workspace ?? "");
    // 逐个字段搬：漏一个的症状是"刚存下的设置读回来是默认值"。`normalizeConfig`
    // 只负责归一化，它不会替你把漏掉的字段补成文件里的那份
    config.approvalMode = value.approvalMode;
    config.profiles = value.profiles;
    config.hands = value.hands;
    config.version = 3;
  }
  return normalizeConfig(config);
}

export function readConfig(env = process.env) {
  let text;
  try {
    text = readFileSync(assistantPath(env), "utf8");
  } catch {
    return emptyConfig();
  }
  return parseConfig(text);
}

/** 先写 `.tmp` 再改名，和 `llm.rs::write_config` / `state.rs` 同一条规矩 */
export function writeConfig(config, env = process.env) {
  const path = assistantPath(env);
  const temp = path.replace(/\.json$/, ".json.tmp");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (error) {
    throw new LlmError(`failed to write the assistant settings: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 视图（对齐 `llm.rs` 的 profile_view / views / resolve_active）
// ---------------------------------------------------------------------------

function envOverrides(env) {
  const read = (name) => {
    const value = String(env[name] ?? "").trim();
    return value || null;
  };
  return { base: read("LATTICE_LLM_BASE_URL"), model: read("LATTICE_LLM_MODEL"), key: read("LATTICE_LLM_KEY") };
}

/** 环境变量只盖**当前这一档**：否则"我设了 LATTICE_LLM_KEY，怎么所有档都亮了" */
export function resolveActive(config, overrides) {
  const profile = config.profiles.find((item) => item.id === config.activeId);
  if (!profile) return null;
  const next = { ...profile };
  let source = next.apiKey.trim() ? "file" : "none";
  if (overrides.base) next.baseUrl = overrides.base;
  if (overrides.model) next.model = overrides.model;
  if (overrides.key) {
    next.apiKey = overrides.key;
    source = "env";
  }
  next.keySource = source;
  return next;
}

function temperatureOf(profile) {
  const value = typeof profile.temperature === "number" && Number.isFinite(profile.temperature)
    ? profile.temperature
    : DEFAULT_TEMPERATURE;
  return Math.min(2, Math.max(0, value));
}

function profileView(profile, source) {
  let base = "";
  try {
    base = normalizeBase(profile.baseUrl);
  } catch {
    base = "";
  }
  const hasKey = Boolean(profile.apiKey.trim());
  const auth = normalizeAuth(profile.auth);
  return {
    id: profile.id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    auth,
    model: profile.model,
    temperature: temperatureOf(profile),
    models: profile.models,
    keyHint: maskKey(profile.apiKey),
    // `none` 的档不看 key：本机模型就是没有 key 也该算配好了
    configured: Boolean(base) && Boolean(profile.model.trim()) && (auth === "none" || hasKey),
    keySource: source,
  };
}

export function views(config, env = process.env) {
  const overrides = envOverrides(env);
  const profiles = config.profiles.map((stored) => {
    if (stored.id !== config.activeId) {
      return profileView(stored, stored.apiKey.trim() ? "file" : "none");
    }
    const active = resolveActive(config, overrides);
    return active ? profileView(active, active.keySource) : profileView(stored, "none");
  });
  return { activeId: config.activeId, profiles };
}

export function settingsOf(config) {
  return {
    ...config.hands,
    workspace: config.workspace,
    approvalMode: normalizeApprovalMode(config.approvalMode),
  };
}

function nowMillis() {
  return Date.now();
}

function freshId(config) {
  const seed = nowMillis();
  let serial = config.profiles.length + 1;
  for (;;) {
    const id = `p-${seed.toString(16)}-${serial.toString(16)}`;
    if (!config.profiles.some((profile) => profile.id === id)) return id;
    serial += 1;
  }
}

// ---------------------------------------------------------------------------
// 出门（对齐 `llm.rs::call` + `network::send`）
// ---------------------------------------------------------------------------

/**
 * 一次 HTTP 往返。
 *
 * 三件事和 Rust 对齐：**不跟随重定向**（跟随等于让 provider 把 key 带到一个
 * 我们没审过的地址）、**限制响应体积**、**失败翻译成人话**。
 */
async function callProvider({ url, method, auth, key, body, timeoutMs, fetchImpl, signal }) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const header = authHeader(auth, key);
  if (header) headers[header[0]] = header[1];

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body ?? undefined,
      redirect: "manual",
      signal: combined,
    });
  } catch (error) {
    throw new LlmError(describeFailure(error));
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new LlmError(describeFailure(error));
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new LlmError("the provider's response was too large to read");
  return { status: response.status, text };
}

// ---------------------------------------------------------------------------
// 四条命令
// ---------------------------------------------------------------------------

function saveProfile(body, env) {
  const base = normalizeBase(body.baseUrl);
  const model = String(body.model ?? "").trim();
  if (!model) throw new LlmError("the model name is empty");
  const auth = normalizeAuth(body.auth ?? "bearer");
  const label = String(body.label ?? "").trim();
  const temperature =
    typeof body.temperature === "number" && Number.isFinite(body.temperature)
      ? Math.min(2, Math.max(0, body.temperature))
      : null;

  const config = readConfig(env);
  const wanted = String(body.id ?? "").trim();
  let savedId;

  if (wanted) {
    if (!profileIdOk(wanted)) throw new LlmError("that is not a profile id");
    const profile = config.profiles.find((item) => item.id === wanted);
    if (!profile) throw new LlmError("that profile is gone — reload the assistant");
    profile.label = label || profileLabel(base);
    profile.baseUrl = base;
    profile.auth = auth;
    profile.model = model;
    profile.temperature = temperature;
    profile.models = [];
    savedId = profile.id;
  } else {
    savedId = freshId(config);
    config.profiles.push({
      id: savedId,
      label: label || profileLabel(base),
      baseUrl: base,
      auth,
      apiKey: "",
      model,
      temperature,
      models: [],
    });
    if (!config.activeId) config.activeId = savedId;
  }

  writeConfig(config, env);
  return { id: savedId, view: views(config, env) };
}

function removeProfile(body, env) {
  const id = String(body.id ?? "").trim();
  if (!profileIdOk(id)) throw new LlmError("that is not a profile id");
  const config = readConfig(env);
  config.profiles = config.profiles.filter((profile) => profile.id !== id);
  if (config.activeId === id) config.activeId = config.profiles[0]?.id ?? "";
  writeConfig(config, env);
  return views(config, env);
}

function activateProfile(body, env) {
  const id = String(body.id ?? "").trim();
  if (!profileIdOk(id)) throw new LlmError("that is not a profile id");
  const config = readConfig(env);
  if (!config.profiles.some((profile) => profile.id === id)) {
    throw new LlmError("that profile is gone — reload the assistant");
  }
  config.activeId = id;
  writeConfig(config, env);
  return views(config, env);
}

/** 存 / 清这一档的 key。空串表示"删掉"。存进去的**不再回传**，只回掩码 */
function setKey(body, env) {
  const id = String(body.id ?? "").trim();
  if (!profileIdOk(id)) throw new LlmError("that is not a profile id");
  const trimmed = String(body.key ?? "").trim();
  if (charCount(trimmed) > 512) {
    throw new LlmError("that does not look like an API key (more than 512 characters)");
  }
  const config = readConfig(env);
  const profile = config.profiles.find((item) => item.id === id);
  if (!profile) throw new LlmError("that profile is gone — reload the assistant");
  profile.apiKey = trimmed;
  writeConfig(config, env);
  return views(config, env);
}

function saveHands(body, env) {
  const incoming = body.hands && typeof body.hands === "object" ? body.hands : {};
  const config = readConfig(env);
  const hands = {};
  for (const key of HANDS_KEYS) hands[key] = incoming[key] === true;
  config.hands = hands;
  config.workspace = String(incoming.workspace ?? "").trim();
  config.approvalMode = normalizeApprovalMode(incoming.approvalMode);
  writeConfig(config, env);
  return settingsOf(config);
}

/**
 * 拉模型列表 = "测试连接"。
 *
 * 三种调用方式，和 Rust 一样：传 `baseUrl`（还没保存的草稿）、传 `profileId`
 * （已存的那一档）、都不传（active）。**只有草稿那条路会信请求里的 key** ——
 * 信已存那一档时 key 由 Node 自己读，前端看不见。
 */
async function listModels(body, env, fetchImpl) {
  const config = readConfig(env);
  const draft = String(body.baseUrl ?? "").trim();
  const wantedId = String(body.profileId ?? "").trim();
  let base;
  let auth;
  let key;
  let remember = null;

  if (draft) {
    base = normalizeBase(draft);
    auth = normalizeAuth(body.auth ?? "bearer");
    key = String(body.key ?? "").trim();
    // 改了地址但没重新粘 key：编辑已有的档时用存着的那一把
    if (!key && wantedId && profileIdOk(wantedId)) {
      const profile = config.profiles.find((item) => item.id === wantedId);
      if (profile) {
        key = profile.apiKey;
        remember = wantedId;
      }
    }
  } else {
    let profile = null;
    if (wantedId) {
      if (!profileIdOk(wantedId)) throw new LlmError("that is not a profile id");
      profile = config.profiles.find((item) => item.id === wantedId) ?? null;
    }
    if (profile) {
      remember = profile.id;
    } else {
      profile = resolveActive(config, envOverrides(env));
      if (!profile) throw new LlmError("no model profile yet — add one in the assistant settings");
    }
    base = normalizeBase(profile.baseUrl);
    auth = normalizeAuth(profile.auth);
    key = profile.apiKey;
  }

  if (auth !== "none" && !key.trim()) throw new LlmError("no key for this profile yet — paste one first");

  const response = await callProvider({
    url: modelsUrl(base),
    method: "GET",
    auth,
    key,
    body: null,
    timeoutMs: MODELS_TIMEOUT_MS,
    fetchImpl,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new LlmError(describeStatus(response.status, response.text));
  }

  const models = parseModels(response.text);
  // 记住了下次就能做下拉提示；写盘失败不影响这次的结果
  if (remember) {
    const next = readConfig(env);
    const profile = next.profiles.find((item) => item.id === remember);
    if (profile) {
      profile.models = models.slice(0, 40);
      try {
        writeConfig(next, env);
      } catch {
        /* 提示列表是锦上添花，不该让"测试连接"变成失败 */
      }
    }
  }
  return models;
}

async function chatOnce(body, env, fetchImpl, signal) {
  const config = readConfig(env);
  const wanted = String(body.profileId ?? "").trim();
  let profile;

  if (wanted) {
    if (!profileIdOk(wanted)) throw new LlmError("that is not a profile id");
    profile =
      wanted === config.activeId
        ? resolveActive(config, envOverrides(env))
        : config.profiles.find((item) => item.id === wanted) ?? null;
    if (!profile) throw new LlmError("that profile is gone — reload the assistant");
  } else {
    profile = resolveActive(config, envOverrides(env));
    if (!profile) throw new LlmError("no model profile yet — open the assistant settings and add one");
  }

  const auth = normalizeAuth(profile.auth);
  if (auth !== "none" && !String(profile.apiKey ?? "").trim()) {
    throw new LlmError("no key for this profile yet — open the assistant settings and paste one");
  }
  if (!String(profile.model ?? "").trim()) {
    throw new LlmError("the assistant has no model configured — open the assistant settings");
  }

  const messages = String(body.messages ?? "");
  checkMessages(messages);
  const tools = body.tools == null ? null : String(body.tools);
  if (tools !== null) checkTools(tools);

  const base = normalizeBase(profile.baseUrl);
  const payload = buildBody(String(profile.model).trim(), messages, tools, temperatureOf(profile), MAX_OUTPUT_TOKENS);

  const response = await callProvider({
    url: chatUrl(base),
    method: "POST",
    auth,
    key: profile.apiKey,
    body: payload,
    timeoutMs: CHAT_TIMEOUT_MS,
    fetchImpl,
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new LlmError(describeStatus(response.status, response.text));
  }
  return parseChat(response.text);
}

// ---------------------------------------------------------------------------
// HTTP 外壳
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function isLoopbackAddress(address) {
  const bare = String(address ?? "").trim().replace(/^\[|\]$/g, "");
  if (!bare) return false;
  if (bare === "::1") return true;
  // Node 在双栈监听下把 v4 客户端报成这个形状
  if (bare.startsWith("::ffff:")) return isLoopbackAddress(bare.slice(7));
  return bare.toLowerCase() === "localhost" || bare === "127.0.0.1" || bare.startsWith("127.");
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(String(origin));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackAddress(url.hostname);
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) return reject(new LlmError("the request body is too large"));
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return reject(new LlmError("the request body must be a JSON object"));
        }
        return resolve(value);
      } catch {
        return reject(new LlmError("the request body is not valid JSON"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

async function route(req, res, path, options) {
  const { env, fetchImpl } = options;
  const method = String(req.method ?? "GET").toUpperCase();

  // 浏览器断线（用户按了停止、或者关掉了页面）：别再往外花钱
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const handler = {
    "GET /api/llm/profiles": () => views(readConfig(env), env),
    "POST /api/llm/profiles": async () => {
      const body = await readJson(req);
      switch (String(body.op ?? "")) {
        case "save":
          return saveProfile(body, env);
        case "remove":
          return removeProfile(body, env);
        case "activate":
          return activateProfile(body, env);
        case "key":
          return setKey(body, env);
        default:
          throw new LlmError(`unknown profile operation "${String(body.op ?? "")}"`);
      }
    },
    "POST /api/llm/models": async () => listModels(await readJson(req), env, fetchImpl),
    "POST /api/llm/chat": async () => chatOnce(await readJson(req), env, fetchImpl, abort.signal),
    "GET /api/llm/hands": () => settingsOf(readConfig(env)),
    "POST /api/llm/hands": async () => saveHands(await readJson(req), env),
  };

  const key = `${method} ${path}`;
  if (!handler[key]) {
    if (Object.keys(handler).some((entry) => entry.endsWith(` ${path}`))) {
      return sendError(res, 405, `this route is ${key.split(" ")[0]} only`);
    }
    return sendError(res, 404, `there is no dev assistant route at ${path}`);
  }

  try {
    sendJson(res, 200, await handler[key]());
  } catch (error) {
    const status = error instanceof LlmError ? 400 : 500;
    sendError(res, status, error instanceof Error ? error.message : String(error));
  }
}

/**
 * 中间件本体。
 *
 * 三道闸，每一道都对应一个"这个口子会不会被人借走"的问题：
 *   1. **只认本机**（`req.socket.remoteAddress` 是回环）—— 就算有人把 dev server
 *      开成了 `--host`，这个口子也不会跟着出去；
 *   2. **只认本机的 Origin** —— 组件 iframe 的源是不透明的 `"null"`，它既过不了
 *      这一道，也过不了下一道；
 *   3. **POST 必须是 `application/json`** —— 这一条会让跨源请求先过预检，而没人
 *      答那份预检，所以不可信代码没法借这个口子花用户的 key。
 *
 * 读不到 key：所有回给前端的东西都过 `maskKey`，只有 `llm_set_key` 那一条会把
 * 用户刚粘进来的明文写进文件，**从不回传**。
 */
export function createLlmMiddleware(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return function llmMiddleware(req, res, next) {
    const path = String(req.url ?? "").split("?")[0];
    if (!path.startsWith(PREFIX)) return next();

    const socket = req.socket ?? req.connection;
    if (!isLoopbackAddress(socket?.remoteAddress)) {
      return sendError(res, 403, "the dev assistant proxy only answers this machine");
    }

    const origin = req.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      return sendError(res, 403, "the dev assistant proxy only answers this machine's origin");
    }

    const method = String(req.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const type = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!type.startsWith("application/json")) {
        return sendError(res, 415, "send JSON (content-type: application/json)");
      }
    }

    void route(req, res, path, { env, fetchImpl });
  };
}

/** 挂进 `vite.config.ts` 的插件。`apply: "serve"` —— 打包产物里没有这个口子 */
export function devLlmProxy(options = {}) {
  return {
    name: "lattice:dev-llm",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(createLlmMiddleware(options));
      if (options.quiet !== true) {
        server.config.logger.info(
          "[lattice] 浏览器预览的 assistant 走 /api/llm（key 只在 Node 里，不进前端）",
        );
      }
    },
  };
}

export default devLlmProxy;
