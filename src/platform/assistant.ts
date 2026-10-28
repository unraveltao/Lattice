/**
 * 内置 assistant —— **平台这一半**：设置、快照、工具循环。
 *
 * 和三样东西打交道，每样都只有一个入口：
 *   - 模型：`callCommand("llm_chat_stream")` —— 桌面里是 Rust 发请求，浏览器预览
 *     走 dev server 的 `/api/llm`（key 仍然只在 Node 里，见 `platform/devLlm.ts`）
 *   - 桌面：`runAgentAction`（**和外部 agent 端点同一个执行器**，撤销/落盘照旧）
 *   - 状态：`useLattice`（快照只读）
 *
 * 循环停在三处：没有工具调用了、到了 `MAX_STEPS`、用户按了停止。
 */

import { listen } from "@tauri-apps/api/event";

import {
  MAX_STEPS,
  approvalFor,
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
import {
  DEFAULT_ASSISTANT_MODE,
  HANDS_OFF,
  approvalSummary,
  handGroup,
  modeIgnoresSwitches,
  overBudget,
  MAX_TURN_TOKENS,
  MAX_TURN_MS,
  type AssistantMode,
  type HandGroup,
  type HandsSettings,
} from "../runtime/hands";
import { t } from "../runtime/i18n";
import type { AuthShape } from "../runtime/llm-models";
import type { WidgetRecord } from "../runtime/registry";
import { agentSnapshot, runAgentAction, type AgentReply } from "./agent";
import { callCommand, hasRust } from "./devLlm";
import {
  parseWidgetTool,
  resolveWidgetInstance,
  type WidgetToolReply,
  type WidgetToolSource,
} from "../runtime/widget-tools";
import { callWidgetTool, listWidgetTools } from "./widget-tools";
import { callHand, cancelHand, type HandsReply } from "./hands";

/** 和 Rust 的 `ProfileView` 对齐。**没有 apiKey 字段**，只有掩码 */
export interface ProfileView {
  id: string;
  label: string;
  baseUrl: string;
  auth: AuthShape;
  model: string;
  temperature: number;
  /** 上次「测试连接」列出来的模型，只用来做下拉提示 */
  models: string[];
  keyHint: string;
  /** base + model 齐了，且（auth 不是 none 时）key 也齐了 */
  configured: boolean;
  keySource: "file" | "env" | "none";
}

export interface ProfilesView {
  activeId: string;
  profiles: ProfileView[];
}

export async function readLlmProfiles(): Promise<ProfilesView> {
  return await callCommand<ProfilesView>("llm_profiles");
}

export interface SavedProfile {
  /** 这次存的是哪一条 —— 新建时前端还不知道 id，别靠 diff 猜 */
  id: string;
  view: ProfilesView;
}

/**
 * 存一档。`id` 为空表示新建 —— 新建的档如果还没有 active，就自动变成 active。
 * **key 不走这里**：改个模型名不该要求用户重新粘一次 key（见 `saveLlmKey`）。
 */
export async function saveLlmProfile(input: {
  id?: string;
  label: string;
  baseUrl: string;
  auth: AuthShape;
  model: string;
  temperature: number;
}): Promise<SavedProfile> {
  return await callCommand<SavedProfile>("llm_profile_save", {
    id: input.id ?? null,
    label: input.label,
    baseUrl: input.baseUrl,
    auth: input.auth,
    model: input.model,
    temperature: input.temperature,
  });
}

/** 删一档。它带着 key 一起走 —— 界面上要两步确认 */
export async function removeLlmProfile(id: string): Promise<ProfilesView> {
  return await callCommand<ProfilesView>("llm_profile_remove", { id });
}

/** 空串等于"删掉这一档的 key" */
export async function saveLlmKey(id: string, key: string): Promise<ProfilesView> {
  return await callCommand<ProfilesView>("llm_set_key", { id, key });
}

/**
 * 拉模型列表（也就是"测试连接"）。
 *
 * 可以传还没保存的地址 / 鉴权 / key（试好了再存），也可以只传 `profileId`
 * 复用已存的那一档。返回空数组是合法的：有些中转站的 `/models` 什么都不给。
 */
export async function listModels(options: {
  profileId?: string;
  baseUrl?: string;
  auth?: AuthShape;
  key?: string;
} = {}): Promise<string[]> {
  return await callCommand<string[]>("llm_models", {
    profileId: options.profileId ?? null,
    baseUrl: options.baseUrl ?? null,
    auth: options.auth ?? null,
    key: options.key ?? null,
  });
}

/** 主动切换 active 档：点一下另一条就等于把它设成 active */
export async function activateLlmProfile(id: string): Promise<ProfilesView> {
  return await callCommand<ProfilesView>("llm_profile_activate", { id });
}

/**
 * 密封库（`secrets.bin`）的状态。
 *
 * 只回答一句话：**这些 key 到底加密存进去了没有**。`error` 是上一次 DPAPI
 * 失败的原因 —— 那一刻明文还留在 `assistant.json` 里（宁可没加密，也不能把
 * key 弄丢），界面必须把这件事说出来，否则用户以为"已经安全了"。
 *
 * 浏览器预览里没有这条命令，回 `null`，那一行就不显示。
 */
export interface SecretsStatus {
  path: string;
  exists: boolean;
  count: number;
  error: string | null;
}

export async function readSecretsStatus(): Promise<SecretsStatus | null> {
  if (!hasRust()) return null;
  try {
    return await callCommand<SecretsStatus>("secrets_status");
  } catch {
    return null;
  }
}

/**
 * 配置文件的绝对路径（`…/assistant.json`）。设置里那行小字要显示它。
 *
 * 浏览器预览里没有这条命令，调用方要自己 catch —— 预览里没有"磁盘上的文件"
 * 这回事，藏掉那一行比显示一个假的路径诚实。
 */
export async function configPath(): Promise<string> {
  return await callCommand<string>("assistant_config_path");
}

/**
 * 交给系统默认程序打开（记事本 / VS Code / 用户自己设的那个）。返回路径。
 *
 * **不是"导入"**：导入要先定义合并语义（同 id 覆盖还是新增？key 怎么算？
 * 导一半失败怎么办？），那是一个功能。这里只让用户打开**真正的那个文件**
 * 去改，改完点"重新读取" —— `readLlmProfiles` 每次都是现读磁盘，没有缓存。
 */
export async function openConfigFile(): Promise<string> {
  return await callCommand<string>("assistant_config_open");
}

/** 导入的账：新增几档、更新几档、跳过几档（跳过的那些是坏档，不连累其它） */
export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
  view: ProfilesView;
}

/**
 * 一键导入：把一份配置文件**读成文本**递过去，解析和合并都在 Rust。
 *
 * 前端不碰合并规则 —— 那套规则（同 id / 同地址覆盖、空 key 不覆盖、授权不导）
 * 必须和读盘时的 `normalize` 是同一份，否则"导入成功"的东西下一次读盘就没了。
 * 这里只负责"用户选了个文件，把它的字给后端"。
 */
export async function importConfig(text: string): Promise<ImportReport> {
  return await callCommand<ImportReport>("assistant_config_import", { text });
}

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; detail: string; ok: boolean; error?: string }
  | { type: "usage"; promptTokens: number; completionTokens: number };

/** 流式增量的载荷。**带 `requestId`**：Rust 那边 `emit` 是广播（不变量 9） */
interface DeltaPayload {
  requestId: string;
  text: string;
}

let requestSerial = 0;
/** 正在飞的那一轮。用户的"停止"按钮要知道叫停谁 */
let activeRequest: string | null = null;
/** 正在跑的那只手。停命令和停模型是两条通道 —— 按停止时两条都要收 */
let activeTool: string | null = null;

function newRequestId(): string {
  requestSerial += 1;
  return `r-${Date.now().toString(36)}-${requestSerial}`;
}

/**
 * 叫停正在跑的那一轮。**幂等**：那一轮已经结束（或者从没开始）时什么都不做 ——
 * 界面不该因为"按晚了一步"弹一个错误。
 *
 * 两条都要发：模型那头是"别再读了"，命令那头是"把进程杀了"。只发前者的话，
 * 用户按停止之后 `npm test` 还在后台跑 —— 而界面上写着"已停止"。
 */
export async function cancelActiveTurn(): Promise<void> {
  const tool = activeTool;
  if (tool) void cancelHand(tool);
  const id = activeRequest;
  if (!id) return;
  try {
    await callCommand<boolean>("llm_chat_cancel", { requestId: id });
  } catch {
    // 那一轮已经结束了：这不是错误
  }
}

/**
 * 跑一轮**流式**对话。
 *
 * 三件事和整包那条路不一样：
 *   1. 增量边走边交给 `onDelta`（界面上就是字一个个出来）；
 *   2. 增量**只用来画**，权威结果是这个函数的返回值 —— 最后用它覆盖气泡，
 *      所以"拼增量拼错了"最多是中间闪一下，不会留下一句错话；
 *   3. 停止靠 `llm_chat_cancel`：Rust 那边在 1 秒读超时时看见标志就收手。
 */
async function streamChat(options: {
  messages: string;
  tools: string;
  onDelta: (text: string) => void;
}): Promise<AssistantReply> {
  const requestId = newRequestId();
  activeRequest = requestId;
  // 先挂监听再发请求：迟一步的话，第一段字会在监听注册之前到（尤其是本地模型）
  //
  // 浏览器预览里没有这条事件（增量是 Rust 从 SSE 切出来的），所以**不挂**：
  // `listen()` 在没有 `__TAURI_INTERNALS__` 时注册不上，而那一轮的字会在结束时
  // 整句回来 —— 少一串增量，不是少一次回答。
  const unlisten: () => void = hasRust()
    ? await listen<DeltaPayload>("lattice:llm-delta", (event) => {
        const payload = event.payload;
        if (!payload || payload.requestId !== requestId) return;
        if (typeof payload.text === "string" && payload.text) options.onDelta(payload.text);
      })
    : () => {};
  try {
    return await callCommand<AssistantReply>("llm_chat_stream", {
      requestId,
      messages: options.messages,
      tools: options.tools,
    });
  } finally {
    if (activeRequest === requestId) activeRequest = null;
    unlisten();
  }
}

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
  /**
   * 这一轮能调的组件工具（数据平面）。**清单和实例都问宿主**：
   * 主窗口自己算（`listWidgetTools`），小窗问主窗口要。
   *
   * 为什么不做成面板里的 `useMemo`：小窗里那份 store 是空的（它不加载平台外壳），
   * 算出来永远是"一个组件工具都没有" —— 而画布上的 iframe 全在主窗口里。
   */
  widgetTools(): Promise<WidgetToolSource[]>;
  /** 真去敲一份组件实例。同样只有主窗口敲得到（iframe 在那儿） */
  callWidget(input: {
    instanceId: string;
    widgetId: string;
    tool: string;
    args: Record<string, unknown>;
  }): Promise<WidgetToolReply>;
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
    async widgetTools() {
      return listWidgetTools(records);
    },
    async callWidget(input) {
      return await callWidgetTool(input);
    },
  };
}

/**
 * 桌面小窗：都是 IPC 往返。
 *
 * 注意返回体是**主窗口给的 JSON 原样**（`AgentReply` 的形状），Rust 不解释它 ——
 * 和 `agent` 端点那条通道同一个约定：少一层转译，少一处会不一致的地方。
 *
 * `widgetTools` 拿不到就**当没有**（不抛）：主窗口还没接上桥时，这一轮少几条
 * 组件工具远好过整轮报错 —— 和 MCP 发现失败同一条规矩。
 */
export function remoteSurface(): AssistantSurface {
  return {
    async snapshot() {
      const raw = await callCommand<string>("assistant_snapshot");
      const reply = JSON.parse(raw) as AgentReply;
      if (!reply.ok) throw new Error(reply.error);
      return compactSnapshot(reply.result as DeskSnapshot);
    },
    async act(action, args) {
      const raw = await callCommand<string>("assistant_act", { action, args });
      const reply = JSON.parse(raw) as AgentReply;
      return reply;
    },
    async widgetTools() {
      try {
        const raw = await callCommand<string>("assistant_widget_tools");
        const reply = JSON.parse(raw) as AgentReply;
        if (!reply.ok) return [];
        const result = reply.result as { tools?: WidgetToolSource[] } | undefined;
        return Array.isArray(result?.tools) ? result.tools : [];
      } catch {
        return [];
      }
    },
    async callWidget(input) {
      const raw = await callCommand<string>("assistant_widget_call", {
        instanceId: input.instanceId,
        widgetId: input.widgetId,
        tool: input.tool,
        args: input.args,
      });
      const reply = JSON.parse(raw) as AgentReply;
      if (!reply.ok) throw new Error(reply.error);
      const result = reply.result as WidgetToolReply | undefined;
      // 形状不对不猜：宁可回一条"没答话"，也不把 undefined 当成功塞进对话
      return result && typeof result === "object" && "ok" in result
        ? result
        : { ok: false, code: "bad-reply", error: `${input.widgetId}.${input.tool}: the main window sent nothing back` };
    },
  };
}

/** 一条要用户点头的调用。确认条上只显示 `detail`，其余给按钮用 */
export interface ApprovalRequest {
  name: string;
  args: Record<string, unknown>;
  /** 路径 / 命令 / 坐标 —— 用户点 Allow 之前必须看得懂的那一行 */
  detail: string;
  /** 哪一组手。`null` = 桌面动作（今天只有 `placement.remove` 会问到这里） */
  group: HandGroup | null;
}

/** `true` 才执行。抛异常按"拒绝"处理（宁可少做，也不要带着未知状态往下跑） */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

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
  /**
   * 历史预算（字符）。由 `historyChars(knownModel(model))` 算出来 —— 上下文
   * 小的模型带不动 60k 字的历史，超了不是慢，是 400。不传 = 只按条数裁。
   */
  maxChars?: number;
  /** 用户拨开的手（`assistant_hands` 读来的那份）。不传 = 一条都没有 */
  hands?: HandsSettings;
  /**
   * 这一轮是什么模式（0009）。不传 = 内部。
   *
   * 它管**要不要问**（`approvalFor` 的 `everything`），"能碰什么"由调用方把
   * `effectiveHands(hands, mode)` 传进 `hands` —— 工具表、提示词、执行器三处
   * 用的必须是同一份，所以"六组全开"这件事只在调用方算一次。
   */
  mode?: AssistantMode;
  /**
   * 这一轮能调的组件工具（数据平面）。不传 = 一条都没有。
   *
   * 它**不是**工具表的一部分：表由 `allTools` 拼（那是唯一一处合表），这里要的
   * 是"这条工具名能落到哪些实例上"—— `instanceId` 补全和校验都靠它。两边必须
   * 来自同一份清单，否则会出现"表里有、却谁都调不到"。
   */
  widgets?: WidgetToolSource[];
  /** 危险动作的审批。不传 = 一律拒绝（安全默认，不是"自动放行"） */
  approve?: Approver;
}

/**
 * 真去执行一条调用。三种执行者，只有一个入口：
 *
 * 1. 手（文件 / 命令 / 网页 / 屏幕 / 键鼠 / MCP）—— 走 Rust 的 `assistant_tool`
 * 2. 组件自己声明的工具 —— 走**宿主窗口**（`surface.callWidget`：iframe 只有主窗口里有，
 *    小窗那条会转过去，见 `remoteSurface` 上面那段）
 * 3. 桌面动作 —— 走 `surface`（主窗口本地跑，小窗 IPC 转给主窗口）
 *
 * 放在这里而不是循环体里，是为了审批之后那两处分支**看到的是同一段代码** ——
 * 以前它们各写一遍 `group ? runHand : surface.act`，加第三种执行者时漏一处的
 * 症状是"自动档能跑、问一次之后反而跑不了"。
 */
async function executeCall(
  name: string,
  args: Record<string, unknown>,
  surface: AssistantSurface,
  widgets: WidgetToolSource[],
): Promise<AgentReply | WidgetToolReply> {
  const group = handGroup(name);
  if (group) return runHand(name, args);

  const widget = parseWidgetTool(name);
  if (widget) {
    const instanceId = resolveWidgetInstance(widgets, widget.widgetId, args.instanceId);
    if (!instanceId) {
      return {
        ok: false,
        code: "bad_args",
        error: `${name}: instanceId must be one of this widget's live copies — check the enum in the tool schema`,
      };
    }
    // `instanceId` 是平台那一格（选哪一份），不是组件声明的参数：剥掉再递进去
    const { instanceId: _ignored, ...rest } = args;
    return surface.callWidget({
      instanceId,
      widgetId: widget.widgetId,
      tool: widget.tool,
      args: rest,
    });
  }

  return surface.act(name, args);
}

/** 跑一只手：带一个自己的 requestId，停止时能精确地叫停它 */
async function runHand(name: string, args: Record<string, unknown>): Promise<HandsReply> {
  const id = newRequestId();
  activeTool = id;
  try {
    return await callHand(id, name, args);
  } finally {
    if (activeTool === id) activeTool = null;
  }
}

/** 触顶那句话。**说清是哪一条**：用户接下来的动作完全不同 */
function budgetNote(kind: "time" | "tokens"): string {
  if (kind === "time") {
    return t("I stopped here: this turn has been running for {minutes} minutes.", {
      minutes: Math.round(MAX_TURN_MS / 60_000),
    });
  }
  return t("I stopped here: this turn has used {tokens} tokens.", { tokens: MAX_TURN_TOKENS });
}

/**
 * 跑一轮对话（可能包含多次"模型 → 工具 → 模型"）。
 *
 * 返回 `false` 表示是被 `shouldStop` 叫停的，界面可以据此不写"完成"。
 */
export async function runAssistantTurn(options: TurnOptions): Promise<boolean> {
  const { messages, surface, onEvent, shouldStop, tools, maxChars, hands, mode, approve, widgets } =
    options;
  const widgetSources = widgets ?? [];
  const defs = toolDefs(tools);
  const active = hands ?? HANDS_OFF;
  // 「全部」模式：**审批不问**（问就不叫全部了）。`readonly` 仍然优先 ——
  // 那一档连工具表都裁过一遍，这里再兜一次（0009 §3）
  const everything = modeIgnoresSwitches(mode ?? DEFAULT_ASSISTANT_MODE);
  const startedAt = Date.now();
  let tokens = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (shouldStop?.()) return false;
    // 预算是**每一步**看一次：模型绕圈时用户只能看着它花钱（0004 §4）
    const spent = overBudget({ elapsedMs: Date.now() - startedAt, tokens });
    if (spent) {
      onEvent({ type: "text", text: budgetNote(spent) });
      return true;
    }

    const wire = toWire(trimHistory(messages, undefined, maxChars));
    // 走流式：字先出来，用户能立刻看见"它在说话"，而不是等 20 秒的 Thinking…
    const reply = await streamChat({
      messages: JSON.stringify(wire),
      tools: JSON.stringify(defs),
      onDelta: (text) => onEvent({ type: "delta", text }),
    });

    const text = (reply.text ?? "").trim();
    if (text) onEvent({ type: "text", text });
    if (reply.usage) {
      const spentNow = (reply.usage.promptTokens ?? 0) + (reply.usage.completionTokens ?? 0);
      tokens += spentNow;
      onEvent({
        type: "usage",
        promptTokens: reply.usage.promptTokens ?? 0,
        completionTokens: reply.usage.completionTokens ?? 0,
      });
    }

    messages.push({ role: "assistant", content: reply.text ?? "", toolCalls: reply.toolCalls });

    // 用户在"字还在冒"的时候按了停止：**别再执行任何动作**。
    // 半句话可以留着，半个工具调用不行 —— 参数拼到一半的 JSON 要么解析失败，
    // 要么更糟：解析成功但少一个字段，模型会在下一步拿错误的值去改桌面
    if (shouldStop?.()) return false;

    const calls = reply.toolCalls ?? [];
    if (calls.length === 0) return true;

    for (const call of calls) {
      if (shouldStop?.()) return false;

      const parsed = parseArguments(call.arguments);
      const group = handGroup(call.name);
      let result: HandsReply | AgentReply | WidgetToolReply;

      if (!parsed.ok) {
        result = { ok: false, code: "bad_args", error: parsed.error };
      } else if (group && !active[group]) {
        // 开关关着，而模型还是调了：前端没把 schema 给它时不该发生，
        // 但真发生了就要说清楚，别让它以为"工具坏了"
        result = {
          ok: false,
          code: "disabled",
          error: t("The {group} capability is switched off in Assistant settings.", { group }),
        };
      } else {
        // 审批（0003 §3）：`allow` 直接跑，`ask` 先问，`deny` 连执行器都不碰。
        // **必须在执行之前** await —— 放在之后等于"先删了再问"（0003 §5）。
        // 桌面动作和手走同一个裁决：`placement.remove` 是唯一会问的桌面动作，
        // 它在 `auto` 档也仍然问（`DANGEROUS_ACTIONS`）。
        // `path` / `workspace` 是免问区的两个入参（0005 §4）：只有 `file.write`
        // 落在工作目录里才因此免掉那一次确认，别的工具一概不受影响
        const gate = approvalFor(call.name, active.approvalMode, {
          everything,
          path: typeof parsed.value.path === "string" ? parsed.value.path : undefined,
          workspace: active.workspace,
        });
        if (gate === "deny") {
          result = {
            ok: false,
            code: "readonly",
            error: t("Read-only mode is on, so {name} is not available. Tell the user where to change it.", {
              name: call.name,
            }),
          };
        } else if (gate === "ask") {
          const detail = approvalSummary(call.name, parsed.value);
          const allowed = approve
            ? await approve({ name: call.name, args: parsed.value, detail, group })
            : false;
          if (shouldStop?.()) return false;
          if (!allowed) {
            result = {
              ok: false,
              code: "denied",
              error: "the user declined this action — do not retry it; ask what they want instead",
            };
          } else {
            result = await executeCall(call.name, parsed.value, surface, widgetSources);
          }
        } else {
          // 桌面动作走 surface（主窗口本地跑，小窗 IPC 转给主窗口）。
          // 循环不需要知道区别 —— 它只要一个 `AgentReply`
          result = await executeCall(call.name, parsed.value, surface, widgetSources);
        }
      }

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

// ---------------------------------------------------------------------------
// 会话（0003 §4）：四份文件级操作，形状和 `assistant_session.rs` 一一对齐
// ---------------------------------------------------------------------------
//
// 为什么不是"面板自己 `invoke` 一下"：面板有两个宿主（主窗口抽屉、桌面小窗），
// 而小窗不加载 store、不许自己执行动作。会话读写是**纯文件**，两个宿主都该走
// 同一条路，而不是各写一遍 `invoke` 拼字符串。

/** 列表里的一行。**没有正文** —— 50 份会话全部读进内存只为画个列表是不划算的 */
export interface SessionSummary {
  id: string;
  /** 坏文件是空串，界面自己说"损坏的会话" */
  title: string;
  updatedAt: number;
  messageCount: number;
  usage: SessionUsage;
  /** 文件在、但解析不了：可删不可加载 */
  damaged: boolean;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface SessionMessage {
  role: string;
  content: string | null;
  [key: string]: unknown;
}

/** 一份完整会话（磁盘上那个文件） */
export interface AssistantSession {
  version: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  profileId: string;
  messages: SessionMessage[];
  usage: SessionUsage;
  /** 上一次保存丢过条目 —— 界面要显示"这条会话被截断" */
  truncated: boolean;
}

export interface SessionSaved {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  /** 这次保存丢了几条（0 = 一条没丢） */
  dropped: number;
}

/** 按 `updatedAt` 倒序。坏文件也在列表里（`damaged: true`），**不会**让整份列表读崩 */
export async function listSessions(): Promise<SessionSummary[]> {
  return await callCommand<SessionSummary[]>("assistant_sessions");
}

export async function loadSession(id: string): Promise<AssistantSession> {
  return await callCommand<AssistantSession>("assistant_session_load", { id });
}

/**
 * 存一份会话。`id` 给了就是更新那一份，没给就是新建（新 id 由 Rust 造）。
 *
 * `messages` 序列化成 **JSON 文本**再递过去，和 `llm_chat` 同一条约定。
 */
export async function saveSession(input: {
  id?: string;
  title?: string;
  model: string;
  profileId?: string;
  messages: ChatMessage[];
  usage?: SessionUsage;
}): Promise<SessionSaved> {
  return await callCommand<SessionSaved>("assistant_session_save", {
    id: input.id ?? null,
    title: input.title ?? null,
    model: input.model,
    profileId: input.profileId ?? null,
    messages: JSON.stringify(input.messages),
    usage: input.usage ?? null,
  });
}

/** 只改标题。**不走 `saveSession`** —— 那条会把 `updatedAt` 写成现在，
 *  于是改个名字这份会话就跳到侧栏最上面。返回落盘之后的那句（可能被清洗过） */
export async function renameSession(id: string, title: string): Promise<string> {
  return await callCommand<string>("assistant_session_rename", { id, title });
}

/** 文件本来就不在也算成功 —— 用户点"删除"想要的是"它不在了" */
export async function deleteSession(id: string): Promise<void> {
  await callCommand<void>("assistant_session_delete", { id });
}

