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
  systemPrompt,
  toWire,
  toolsFor,
  trimHistory,
  toolDefs,
  type AssistantReply,
  type ChatMessage,
  type DeskSnapshot,
  type ToolSpec,
} from "../runtime/assistant";
import { t } from "../runtime/i18n";
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

/**
 * 一轮对话要碰的两样东西：桌面现状、执行动作。
 *
 * 抽出来是因为**同一个面板会跑在两个窗口里**：主窗口里的抽屉，和桌面上那个
 * 独立小窗。后者不能自己执行动作 —— 布局的权威在主窗口的 `useLattice` 里，
 * 小窗那份 store 是另一份内存（`state.json` 只是副本）。两份真相打架的后果是
 * "画布没动、文件变了"，这个项目被它咬过一次（见 `platform/agent.ts`）。
 *
 * 所以小窗那份 surface 把活儿转给主窗口（`assistant_act` → `lattice:agent`），
 * 主窗口用自己的 store 跑同一个执行器。工具表、循环、提示词全都不用变。
 */
export interface AssistantSurface {
  /** 这次请求要带上的"桌面现状"（已经压过的文本） */
  snapshot(): Promise<string>;
  act(action: string, args: unknown): Promise<AgentReply>;
}

/** 主窗口自己跑：快照现拍，动作走 `runAgentAction`，撤销/落盘照旧 */
export function localSurface(records: WidgetRecord[]): AssistantSurface {
  return {
    async snapshot() {
      return describeDesktop(records);
    },
    async act(action, args) {
      return runAgentAction(action, args, records);
    },
  };
}

/**
 * 桌面小窗：都是 IPC 往返。
 *
 * 注意返回体是**主窗口给的 JSON 原样**（`AgentReply` 的形状），Rust 不解释它 ——
 * 和 `agent` 端点那条通道同一个约定：少一层转译，少一处会不一致的地方。
 */
export function remoteSurface(): AssistantSurface {
  return {
    async snapshot() {
      const raw = await invoke<string>("assistant_snapshot");
      const reply = JSON.parse(raw) as AgentReply;
      if (!reply.ok) throw new Error(reply.error);
      return compactSnapshot(reply.result as DeskSnapshot);
    },
    async act(action, args) {
      const raw = await invoke<string>("assistant_act", { action, args });
      const reply = JSON.parse(raw) as AgentReply;
      return reply;
    },
  };
}

export interface TurnOptions {
  /** 会话本身。**原地追加** —— 面板要留着看，调用方拿同一个数组就行 */
  messages: ChatMessage[];
  /** 桌面那一半：谁执行、快照从哪儿来 */
  surface: AssistantSurface;
  onEvent: (event: TurnEvent) => void;
  /** 用户按了停止 / 面板关了。每轮开始和每次工具调用前都会看一眼 */
  shouldStop?: () => boolean;
  /**
   * 这一轮给模型哪些工具。默认全部八个。
   *
   * 组件借平台的手时传 `toolsFor("widget")`（少 `placement.remove`），**并且**
   * 系统提示要用同一个表生成 —— 两边不一致的症状是"模型调了一个它没被给的工具"，
   * 或者"它能调，但提示里说它做不到"。
   */
  tools?: Record<string, ToolSpec>;
}

/**
 * 跑一轮对话（可能包含多次"模型 → 工具 → 模型"）。
 *
 * 返回 `false` 表示是被 `shouldStop` 叫停的，界面可以据此不写"完成"。
 */
export async function runAssistantTurn(options: TurnOptions): Promise<boolean> {
  const { messages, surface, onEvent, shouldStop, tools } = options;
  const defs = toolDefs(tools);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (shouldStop?.()) return false;

    const wire = toWire(trimHistory(messages));
    const reply = await invoke<AssistantReply>("llm_chat", {
      messages: JSON.stringify(wire),
      tools: JSON.stringify(defs),
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
      // 执行走 surface：主窗口那份在本地跑 `runAgentAction`，小窗那份是 IPC
      // 转给主窗口。循环本身不需要知道区别 —— 它只要一个 `AgentReply`
      const result: AgentReply = parsed.ok
        ? await surface.act(call.name, parsed.value)
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

  onEvent({
    type: "text",
    text: t("I stopped here: a single turn can run at most {steps} tool steps.", { steps: MAX_STEPS }),
  });
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

/** 组件借手那一轮的结果。气泡要的两样：说什么、做了什么 */
export interface WidgetTurnOutcome {
  text: string;
  actions: Array<{ detail: string; ok: boolean; error?: string }>;
}

/**
 * 组件借平台的手：跑**完整**的一轮（模型 → 工具 → 模型 …），返回结果。
 *
 * 三条设计要点，每条都对应一个"本来可以更省事"的做法：
 *
 * 1. **循环在这儿，不在组件里**。组件跑循环就得给组件一份带工具的 `llm.chat`，
 *    那等于把"能改布局的模型"塞进不可信代码里。这里反过来：组件的 iframe 从头
 *    到尾只发一句 `assistant.ask`，拿到的是文字和"我做了什么"。
 * 2. **工具表是 `toolsFor("widget")`**（少 `placement.remove`），而且系统提示、
 *    工具定义用的是**同一个表** —— 两边不一致的症状是模型调一个没给它的工具。
 * 3. **执行仍然走 `localSurface` → `runAgentAction`**：同一份 store、同一份撤销、
 *    同一份落盘。这条路上没有第二个执行器，也没有第二种"谁在说"能绕开白名单。
 */
export async function runWidgetTurn(options: {
  messages: ChatMessage[];
  persona: { name: string; text: string } | null;
  records: WidgetRecord[];
}): Promise<WidgetTurnOutcome> {
  const { messages, persona, records } = options;
  const surface = localSurface(records);
  const tools = toolsFor("widget");
  const snapshot = await surface.snapshot();

  const conversation: ChatMessage[] = [
    { role: "system", content: systemPrompt(snapshot, { tools, persona }) },
    ...messages,
  ];

  let text = "";
  const actions: WidgetTurnOutcome["actions"] = [];
  await runAssistantTurn({
    messages: conversation,
    surface,
    tools,
    onEvent: (event) => {
      if (event.type === "text") {
        // 模型可能先说一句、调完工具再说一句。气泡只要最后那句 —— 前面的
        // "我看看" 在气泡里只会把真正那句挤出去
        text = event.text;
      } else if (event.type === "tool") {
        actions.push({ detail: event.detail, ok: event.ok, error: event.error });
      }
    },
  });

  return { text: text.trim(), actions };
}
