/**
 * 模型的能力与预设 —— 纯数据 + 纯函数。
 *
 * # 为什么需要一张"能力表"
 *
 * 同一条 `/chat/completions` 下面，各家的模型脾气不一样：推理模型（`deepseek-reasoner`、
 * `o1`）**不收 `temperature`**，送了就 400；有的模型不支持 function calling，
 * 对 assistant 来说等于"能说话但改不了桌面"。这些差异不在协议里，只能按模型名认。
 *
 * 表里只收**真的撞过的**几条，未知模型一律走宽松默认（能调工具、能收温度、32k 上下文）：
 * 被 provider 拒一次就加一条，这张表是"踩过的坑的索引"，不是厂商规格的副本 ——
 * 抄一份规格进来，三个月后它有一半是错的，而错的那一半会静默地少送一个参数。
 *
 * # 预设为什么不是"供应商类型"
 *
 * 落盘的永远只有 `baseUrl` + `auth` + `model` 三个自由字段（见 `docs/design/0002-model-profiles.md`）。
 * 预设只是把这三个字段**填好**的按钮：协议已经收敛到 OpenAI 兼容，多一个
 * `provider` 枚举就多一处要维护的映射，而中转站、局域网里的 vLLM 这些地址
 * 压根没有预设可列。
 */

export interface ModelInfo {
  /** 能不能调工具。调不了就只能说话 —— 对 assistant 来说几乎是废的 */
  tools: boolean;
  /** 收不收 `temperature`。推理模型收了会 400 */
  temperature: boolean;
  /** 上下文窗口（token）。用来推历史预算，不是用来炫耀的 */
  context: number;
}

/** 未知模型：宽松。宁可被 provider 拒一次（错误话会说清），也不要凭空少给能力 */
export const UNKNOWN_MODEL: ModelInfo = { tools: true, temperature: true, context: 32_000 };

/**
 * 已知模型的补丁，按前缀匹配。
 *
 * `deepseek-reasoner` 不支持 function calling，也不收 temperature；
 * `o1` / `o3` 收工具但不收 temperature；`gpt-4o` 的窗口是 128k。
 */
const KNOWN: ReadonlyArray<{ prefix: string; info: Partial<ModelInfo> }> = [
  { prefix: "deepseek-reasoner", info: { tools: false, temperature: false } },
  { prefix: "o1", info: { temperature: false } },
  { prefix: "o3", info: { temperature: false } },
  { prefix: "gpt-4o", info: { context: 128_000 } },
];

/**
 * 按模型名认能力。**最长前缀胜出** —— `deepseek-reasoner-2026` 该命中推理
 * 那条，而不是"只要以 deepseek 开头"的那条。
 */
export function knownModel(id: string): ModelInfo {
  const name = id.trim().toLowerCase();
  if (!name) return { ...UNKNOWN_MODEL };

  let best = "";
  let info: ModelInfo = { ...UNKNOWN_MODEL };
  for (const entry of KNOWN) {
    if (!name.startsWith(entry.prefix)) continue;
    if (entry.prefix.length <= best.length) continue;
    best = entry.prefix;
    info = { ...UNKNOWN_MODEL, ...entry.info };
  }
  return info;
}

/** 历史预算的硬上限，和 Rust 的 `llm_policy::MAX_TOTAL_CHARS` 对齐 */
export const MAX_HISTORY_CHARS = 60_000;

/**
 * 一次请求能带多少字符的历史。
 *
 * 按 **1 token ≈ 1 字符** 估：中文差不多就是这个比值，英文会低估一点 ——
 * 低估是安全的方向（少带几条历史，不会 400）。上限仍然是 60k 字，
 * 再大就是在拿延迟换"它还记得"。
 */
export function historyChars(info: ModelInfo): number {
  if (!Number.isFinite(info.context) || info.context <= 0) return MAX_HISTORY_CHARS;
  return Math.min(MAX_HISTORY_CHARS, Math.floor(info.context));
}

/** 链路上的三种鉴权形状，落盘就存这三个字符串 */
export type AuthShape = "bearer" | "api-key-header" | "none";

export const AUTH_SHAPES: readonly AuthShape[] = ["bearer", "api-key-header", "none"];

/** 和 Rust 的 `llm_policy::normalize_auth` 同一套别名（大小写、下划线都认） */
export function normalizeAuth(raw: string): AuthShape {
  const value = raw.trim().toLowerCase().replace(/_/g, "-");
  if (value === "none" || value === "no-key") return "none";
  if (value === "api-key-header" || value === "apikey" || value === "api-key") return "api-key-header";
  return "bearer";
}

/** 本机地址：明文 http 只有它们配得上（见 `llm_policy::is_loopback`） */
export function isLoopbackBase(baseUrl: string): boolean {
  const host = baseUrl
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#]/)[0]
    .replace(/^.*@/, "")
    .replace(/^\[([^\]]*)\].*$/, "$1")
    .split(":")[0]
    .toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("127.") || host === "::1";
}

export interface Preset {
  id: string;
  /** 厂商名。产品名不翻（和组件 id 同一个道理） */
  label: string;
  baseUrl: string;
  auth: AuthShape;
  /** 留空 = 先「测试连接」列一遍再挑，别替用户猜版本号 */
  model: string;
  /** i18n key（英文原句），一句话说明这一档是什么 */
  hint: string;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    auth: "bearer",
    model: "deepseek-chat",
    hint: "DeepSeek's own endpoint, OpenAI-compatible",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    model: "gpt-4o-mini",
    hint: "OpenAI's own endpoint",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "bearer",
    model: "",
    hint: "One key for many providers — pick a model after testing the connection",
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    auth: "bearer",
    model: "",
    hint: "Moonshot's endpoint. Paste the key and list the models",
  },
  {
    id: "qwen",
    label: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    auth: "bearer",
    model: "",
    hint: "DashScope's OpenAI-compatible mode",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: "none",
    model: "",
    hint: "A model on this machine. No key needed",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    auth: "none",
    model: "",
    hint: "LM Studio's local server. No key needed",
  },
];

/** 比较两个 base URL 是否指向同一个地方（尾斜杠和大小写不算差别） */
function sameBase(left: string, right: string): boolean {
  const trim = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
  return trim(left) === trim(right);
}

/** 这个地址是某个预设吗？（用来在界面上标出"这是 Ollama 那一档"） */
export function presetFor(baseUrl: string): Preset | undefined {
  return PRESETS.find((preset) => sameBase(preset.baseUrl, baseUrl));
}
