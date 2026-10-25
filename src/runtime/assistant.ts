/**
 * 内置 assistant —— **纯逻辑**这一半：工具表、系统提示、历史裁剪、工具说明。
 *
 * 不 import store、不 import 桥、不打请求：这样 `tests/assistant.html` 能把
 * "工具名和动作白名单对不对得上""历史怎么裁""模型把参数写成字符串怎么办"
 * 全跑一遍，而不需要真的连一次模型。
 *
 * # 工具从哪来
 *
 * **只有 `platform/agent.ts` 的白名单动作**。那张表本来就是"agent 能碰桌面
 * 的边界"，assistant 是同一个执行器的另一个入口 —— 另开一张表等于开第二条
 * 边界，迟早两边不一样。`tests/assistant.html` 钉着两张表**完全一致**。
 *
 * # 为什么 schema 写在这里、执行写在那里
 *
 * schema 是给模型看的（英文键、JSON Schema），执行是给 store 用的（中文错误
 * 信息、撤销、落盘）。混在一起的话，改一句描述就要读一遍 store 的实现。
 */

import { t } from "./i18n";

/** 一次对话里最多几轮"模型 → 工具 → 模型"。到顶就停，别让它自己转圈 */
export const MAX_STEPS = 6;

/**
 * 发给模型的历史条数上限。
 *
 * 比 Rust 那边（60）小：这里更早知道"该扔旧的了"，省下的 token 是用户的钱。
 * 裁的时候**保留 system**（那份是这次请求的上下文，扔了模型就不知道桌面长什么样）。
 */
export const MAX_HISTORY = 32;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** 只出现在 assistant 上：这一轮它要平台做的事 */
  toolCalls?: ToolCall[];
  /** 只出现在 tool 上：对应哪一条调用 */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 模型给的参数，**是 JSON 字符串**（协议如此）。解析失败要能说清楚 */
  arguments: string;
}

/** 模型这一次的完整回应（和 Rust 的 `ChatReply` 对齐） */
export interface AssistantReply {
  text: string;
  toolCalls: ToolCall[];
  finish: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ToolSpec {
  description: string;
  /** JSON Schema 的 properties。只写模型必须知道的部分 */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * 八个动作的说明书。
 *
 * 键必须和 `AGENT_ACTIONS` 一字不差（测试钉着）。描述写英文：模型对工具描述的
 * 训练语料以英文为主，写中文不省事还可能被忽略；**回复**才是用用户的语言。
 */
export const TOOL_SPECS: Record<string, ToolSpec> = {
  "placement.add": {
    description:
      "Put a new copy of an installed widget on the user's canvas. Pick the size from the widget's manifest; the platform chooses a free slot.",
    parameters: {
      type: "object",
      properties: {
        widgetId: { type: "string", description: "Widget package id, e.g. \"lattice.clock\"" },
      },
      required: ["widgetId"],
    },
  },
  "placement.move": {
    description: "Move one widget instance to a new position on the canvas (canvas pixels, origin top-left).",
    parameters: {
      type: "object",
      properties: {
        instanceId: { type: "string", description: "Instance id from the snapshot, e.g. \"lattice.clock#a1b2\"" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["instanceId", "x", "y"],
    },
  },
  "placement.resize": {
    description: "Resize one widget instance. The platform clamps to the widget's minimum size.",
    parameters: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        w: { type: "number" },
        h: { type: "number" },
      },
      required: ["instanceId", "w", "h"],
    },
  },
  "placement.remove": {
    description:
      "Remove one widget instance from the canvas. The user gets an 8 second undo, so this is recoverable but still visible.",
    parameters: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
    },
  },
  "placement.pin": {
    description: "Pin or unpin one instance: pinned widgets cannot be dragged or resized by accident.",
    parameters: {
      type: "object",
      properties: {
        instanceId: { type: "string" },
        pinned: { type: "boolean" },
      },
      required: ["instanceId", "pinned"],
    },
  },
  "placement.front": {
    description: "Bring one instance to the front of the canvas stacking order.",
    parameters: {
      type: "object",
      properties: { instanceId: { type: "string" } },
      required: ["instanceId"],
    },
  },
  "theme.set": {
    description: "Switch the platform theme. \"system\" follows the operating system.",
    parameters: {
      type: "object",
      properties: { theme: { type: "string", enum: ["light", "dark", "system"] } },
      required: ["theme"],
    },
  },
  "widgets.pause": {
    description: "Pause or resume every widget. Paused widgets are hidden and their timers stop.",
    parameters: {
      type: "object",
      properties: { paused: { type: "boolean" } },
      required: ["paused"],
    },
  },
};

/** OpenAI 兼容协议要的形状 */
export function toolDefs(): Array<{ type: "function"; function: ToolSpec & { name: string } }> {
  return Object.entries(TOOL_SPECS).map(([name, spec]) => ({
    type: "function" as const,
    function: { name, ...spec },
  }));
}

/**
 * 系统提示。
 *
 * 三条不能删的：
 * - **"先看快照再动手"**：不写这句，模型会照着用户的措辞编一个 instanceId。
 * - **"做不到就说做不到"**：工具之外的请求（装组件、授权、写存储）必须明确
 *   拒绝，否则它会描述一段它没做的事，用户以为成了。
 * - **"用用户的语言回复"**：工具描述是英文，回复不该跟着变成英文。
 */
export function systemPrompt(snapshot: string): string {
  return [
    "你是「棂」的桌面助手。用户在自己的 Windows 桌面上摆了一堆小组件，你能看到这些摆放，也能改动它们。",
    "",
    "规则：",
    "1. 只能通过给定的工具操作桌面。动手之前先看快照，用快照里真实的 instanceId；不要编造。",
    "2. 做完了用一两句话说明你改了什么。不要罗列工具调用过程，用户看得见。",
    "3. 工具之外的事情（安装组件、授予权限、读写组件的数据）你做不到 —— 直接说做不到，并告诉用户在界面哪里做。不要假装做了。",
    "4. 用用户的语言回复，简短、自然，不要用 Markdown 标题。",
    "",
    "当前桌面：",
    snapshot,
  ].join("\n");
}

/**
 * 裁剪历史。
 *
 * 保留**第一条 system** 和最后 `limit` 条；被砍掉的那一段用一句说明补上，
 * 免得模型以为对话刚开始。补的那句本身也占一条的位置 —— 所以 `limit` 至少 4。
 */
export function trimHistory(messages: ChatMessage[], limit = MAX_HISTORY): ChatMessage[] {
  if (messages.length <= limit) return messages.slice();
  const head = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.slice(head.length);
  const keep = Math.max(1, limit - head.length - 1);
  const dropped = rest.length - keep;
  return [
    ...head,
    { role: "system", content: `（更早的 ${dropped} 条对话已经省略。）` },
    ...rest.slice(dropped),
  ];
}

/**
 * 把一条调用翻译成界面上的小标签，例如 `Move lattice.clock#a1`。
 *
 * 这一行是**用户看得见**的（对话里工具结果那一行），所以走 `t()`：英文原句在
 * 这里，中文在 `runtime/i18n/assistant.ts`。**不是**给模型看的那份 ——
 * 回给模型的是原始 JSON（`toWire` 的 `content`），它不认识这几句。
 */
export function describeToolCall(name: string, rawArguments: string): string {
  const args = parseArguments(rawArguments);
  const pick = (key: string) => (args.ok && typeof args.value[key] === "string" ? String(args.value[key]) : "");
  /** 参数坏了 / 没给的时候，标签上写"某个组件"，而不是空着 */
  const target = (key: string) => pick(key) || t("a widget");
  switch (name) {
    case "placement.add":
      return t("Add {widget}", { widget: target("widgetId") });
    case "placement.move":
      return t("Move {instance}", { instance: target("instanceId") });
    case "placement.resize":
      return t("Resize {instance}", { instance: target("instanceId") });
    case "placement.remove":
      return t("Remove {instance}", { instance: target("instanceId") });
    case "placement.pin":
      return args.ok && args.value.pinned
        ? t("Pin {instance}", { instance: target("instanceId") })
        : t("Unpin {instance}", { instance: target("instanceId") });
    case "placement.front":
      return t("Bring {instance} to front", { instance: target("instanceId") });
    case "theme.set":
      return t("Switch theme to {theme}", { theme: pick("theme") || "?" });
    case "widgets.pause":
      return args.ok && args.value.paused ? t("Pause every widget") : t("Resume every widget");
    default:
      return name;
  }
}

/** 解析模型给的参数。失败返回原因 —— 这条要原样回给模型，它才知道怎么改 */
export function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "arguments must be a JSON object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `arguments are not valid JSON: ${String(error)}` };
  }
}

/** 发给 Rust 的形状：assistant 那几条要带 tool_calls，工具结果带 tool_call_id */
export function toWire(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        // OpenAI 协议里只调工具时 content 是 null；给空串有的供应商会拒
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

/** 这一轮还有没有活要干 */
export function isDone(reply: AssistantReply): boolean {
  return reply.toolCalls.length === 0;
}

/** `compactSnapshot` 吃的形状（`platform/agent.ts` 的 `agentSnapshot` 就够了） */
export interface DeskSnapshot {
  theme: string;
  paused: boolean;
  widgets: Array<{ id: string; name: string; installed: boolean }>;
  placements: Array<{
    instanceId: string;
    widgetId: string;
    name?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    pinned?: boolean;
    layer?: string;
    config?: Record<string, unknown>;
  }>;
}

/**
 * 系统提示里那段"桌面现状"。
 *
 * 三条取舍：
 * - **只列已安装的组件**：没装的它也用不了（`placement.add` 会被执行器拒），
 *   列出来只会让它推荐一个装不了的组件。
 * - **配置带上**（`config`）：桌宠的大小、时钟的 12/24 小时制都在这儿，模型
 *   要回答"她怎么这么大"就得看见它。
 * - **超长就把配置整段丢掉**：一个组件配了几十个键时，配置会把快照撑到几千
 *   token，而那些键几乎肯定和这次请求无关。宁可少给，不要每次都为它付钱。
 */
export function compactSnapshot(snapshot: DeskSnapshot, budget = 6000): string {
  const installed = snapshot.widgets
    .filter((widget) => widget.installed)
    .map((widget) => ({ id: widget.id, name: widget.name }));

  const placements = snapshot.placements.map((placement) => ({
    instanceId: placement.instanceId,
    widgetId: placement.widgetId,
    name: placement.name ?? placement.widgetId,
    x: placement.x,
    y: placement.y,
    w: placement.w,
    h: placement.h,
    pinned: !!placement.pinned,
    layer: placement.layer ?? "desktop",
    config: placement.config ?? {},
  }));

  const base = {
    theme: snapshot.theme,
    paused: snapshot.paused,
    installed,
    placements,
  };
  const text = JSON.stringify(base, null, 1);
  if (text.length <= budget) return text;

  // 超预算：先丢配置，再丢 layer/pinned 这类可以从别处推断的字段
  return JSON.stringify(
    {
      ...base,
      placements: placements.map(({ config: _config, ...rest }) => rest),
    },
    null,
    1,
  );
}

