/**
 * 内置 assistant —— **平台这一半**：设置、快照、工具循环。
 *
 * 和三样东西打交道，每样都只有一个入口：
 *   - 模型：`invoke("llm_chat")`（Rust 那边发请求，key 不进前端）
 *   - 桌面：`runAgentAction`（**和外部 agent 端点同一个执行器**，撤销/落盘照旧）
 *   - 状态：`useLattice`（快照只读）
 *
 * 循环停在三处：没有工具调用了、到了 `MAX_STEPS`、用户按了停止。
 */

import { invoke } from "@tauri-apps/api/core";

import {
  MAX_STEPS,
  compactSnapshot,
  describeToolCall,
  parseArguments,
  toWire,
  trimHistory,
  toolDefs,
  type AssistantReply,
  type ChatMessage,
} from "../runtime/assistant";
import type { WidgetRecord } from "../runtime/registry";
import { agentSnapshot, runAgentAction, type AgentReply } from "./agent";

/** 和 Rust 的 `LlmStatus` 对齐。**没有 apiKey 字段**，只有掩码 */
export interface LlmStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  keyHint: string;
  keySource: "file" | "env" | "none";
  endpoint: string;
}

export async function readLlmStatus(): Promise<LlmStatus> {
  return await invoke<LlmStatus>("llm_status");
}

export async function saveLlmSettings(baseUrl: string, model: string, temperature: number): Promise<LlmStatus> {
  return await invoke<LlmStatus>("llm_save", { baseUrl, model, temperature });
}

/** 空串等于"删掉这把 key" */
export async function saveLlmKey(key: string): Promise<LlmStatus> {
  return await invoke<LlmStatus>("llm_set_key", { key });
}

/** 拉模型列表（也就是"测试连接"）。可以传还没保存的地址和 key */
export async function listModels(baseUrl?: string, key?: string): Promise<string[]> {
  return await invoke<string[]>("llm_models", {
    baseUrl: baseUrl ?? null,
    key: key ?? null,
  });
}

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string; ok: boolean; error?: string }
  | { type: "usage"; promptTokens: number; completionTokens: number };

export interface TurnOptions {
  /** 会话本身。**原地追加** —— 面板要留着看，调用方拿同一个数组就行 */
  messages: ChatMessage[];
  records: WidgetRecord[];
  onEvent: (event: TurnEvent) => void;
  /** 用户按了停止 / 面板关了。每轮开始和每次工具调用前都会看一眼 */
  shouldStop?: () => boolean;
}

/**
 * 跑一轮对话（可能包含多次"模型 → 工具 → 模型"）。
 *
 * 返回 `false` 表示是被 `shouldStop` 叫停的，界面可以据此不写"完成"。
 */
export async function runAssistantTurn(options: TurnOptions): Promise<boolean> {
  const { messages, records, onEvent, shouldStop } = options;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (shouldStop?.()) return false;

    const wire = toWire(trimHistory(messages));
    const reply = await invoke<AssistantReply>("llm_chat", {
      messages: JSON.stringify(wire),
      tools: JSON.stringify(toolDefs()),
    });

    const text = (reply.text ?? "").trim();
    if (text) onEvent({ type: "text", text });
    if (reply.usage) {
      onEvent({
        type: "usage",
        promptTokens: reply.usage.promptTokens ?? 0,
        completionTokens: reply.usage.completionTokens ?? 0,
      });
    }

    messages.push({ role: "assistant", content: reply.text ?? "", toolCalls: reply.toolCalls });

    const calls = reply.toolCalls ?? [];
    if (calls.length === 0) return true;

    for (const call of calls) {
      if (shouldStop?.()) return false;

      const parsed = parseArguments(call.arguments);
      const result: AgentReply = parsed.ok
        ? runAgentAction(call.name, parsed.value, records)
        : { ok: false, code: "bad_args", error: parsed.error };

      onEvent({
        type: "tool",
        name: call.name,
        detail: describeToolCall(call.name, call.arguments),
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      });

      // 工具结果原样回给模型：`ok:false` 比"抛异常"有用得多 ——
      // 它看得见 code，下一轮能改参数重来（比如 instanceId 抄错了）
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  onEvent({ type: "text", text: `（我先停在这里：一次对话最多 ${MAX_STEPS} 轮操作。）` });
  return true;
}

/**
 * 这次请求要带上的"桌面现状"。
 *
 * 只挑模型用得上的字段。整份 `state.json` 塞进去的代价是每次请求都多几千 token，
 * 而那些 token 一个都不会影响它做的决定。
 */
export function describeDesktop(records: WidgetRecord[]): string {
  return compactSnapshot(agentSnapshot(records));
}
