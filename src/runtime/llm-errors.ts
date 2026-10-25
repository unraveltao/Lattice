/**
 * 供应商失败那条字符串的**前端那一半**。
 *
 * 分工是这样定的：**Rust 只认得出"是哪一种失败"**（它手里有状态码和 WinHTTP 的错误码），
 * **句子按界面语言拼**（中文表在 `src/runtime/i18n/assistant.ts`）。
 *
 * 为什么不让 Rust 直接把中文拼好：那等于让 Rust 持有一份 i18n 表，界面文案就有了
 * 第二个家（`docs/README.md` 的"一份事实只有一个家"）。代价是协议上多一行抬头，
 * 就是 `@@llm:{...}` 那一行 —— 它在 `llm_policy.rs` 里生成，和这里的
 * `FAILURE_TAG` 必须是同一个字面量（`tests/llm-models.html` 钉着）。
 *
 * 三条别踩回去：
 * - **认不出就原样返回**。抬头坏了、码不认识、JSON 少了字段 —— 都不能让一条错误
 *   变成空白；英文原句（抬头之后那半）一定还在。
 * - **detail 是供应商说的那句话**，不翻译（那是数据，不是文案），原样贴在句子后面。
 * - **状态码不在前端重判**。401 是不是"key 被拒"由 Rust 的 `status_code` 一处说了算，
 *   这里只按码挑句子 —— 两处各判一次，迟早有一处漂。
 */
import { t } from "./i18n";

/** 和 `llm_policy.rs` 的 `FAILURE_TAG` 逐字一致 */
export const FAILURE_TAG = "@@llm:";

export interface LlmFailure {
  /** `key-rejected` / `not-found` / … （见 `llm_policy.rs::status_code`） */
  code: string;
  status: number | null;
  /** 供应商原话（可能为空） */
  detail: string;
  /** 抬头之后那句英文原话：认不出码时原样显示它 */
  english: string;
}

/**
 * 把一条失败字符串拆成"码 + 数字 + 原话"。不是这种形状就 `null`。
 *
 * 抬头只占**一行**，后面的英文原句可能有多行（供应商的 JSON 被压成一行过，但不保证）。
 */
export function parseLlmFailure(raw: string): LlmFailure | null {
  const text = raw.trimStart();
  if (!text.startsWith(FAILURE_TAG)) return null;
  const newline = text.indexOf("\n");
  const head = (newline < 0 ? text : text.slice(0, newline)).slice(FAILURE_TAG.length);
  const english = newline < 0 ? "" : text.slice(newline + 1).trim();

  let value: unknown;
  try {
    value = JSON.parse(head);
  } catch {
    // 抬头半截（比如日志被截断）：英文还在就显示英文，不然原样交给上层
    return english ? { code: "", status: null, detail: "", english } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !record.code) {
    return english ? { code: "", status: null, detail: "", english } : null;
  }
  return {
    code: record.code,
    status: typeof record.status === "number" ? record.status : null,
    detail: typeof record.detail === "string" ? record.detail : "",
    english,
  };
}

/**
 * 码 → 界面句子（英文原句，中文表按同一个 key 翻）。
 *
 * 加码的时候三处一起改：`llm_policy.rs::status_code` / 这里 / `i18n/assistant.ts`。
 */
const SENTENCES: Record<string, string> = {
  "key-rejected":
    "The provider rejected the API key (HTTP {status}) — check the key in Assistant settings",
  "not-found":
    "The endpoint was not found (HTTP {status}) — the base URL is usually https://api.<name>.com/v1",
  "too-large": "The request was too large (HTTP {status})",
  "rate-limited": "The provider is rate limiting or out of quota (HTTP {status})",
  rejected: "The provider rejected the request (HTTP {status})",
  "server-error": "The provider returned an error (HTTP {status})",
  unexpected: "Unexpected HTTP status {status}",
  unreachable: "Could not reach the provider — check the base URL and your connection",
  tls: "The TLS handshake failed (a proxy or a certificate problem)",
  timeout: "The provider did not answer in time",
  "send-error": "The request could not be sent",
};

/**
 * 给界面看的一条失败。认得出抬头就换成本地语言（带上供应商原话），否则原样返回。
 *
 * 调用点可以无脑套：不是 LLM 的错误（文件坏了、桥超时）会原样过去。
 */
export function describeFailure(raw: string): string {
  const failure = parseLlmFailure(raw);
  if (!failure) return raw;
  const sentence = SENTENCES[failure.code];
  if (!sentence) return failure.english || raw;
  const text = t(sentence, { status: failure.status ?? 0 });
  return failure.detail ? `${text} — ${failure.detail}` : text;
}
