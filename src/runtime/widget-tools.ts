/**
 * 数据平面（0003 的 B 一类，见 docs/AGENT_ACCESS.md §2）：组件把自己会做的事声明成
 * 工具，平台/assistant 调它。
 *
 * 这里是**纯逻辑**：清单里那一节的归一化、工具名的形状、给模型的 schema。
 * 真去敲组件（跨 iframe 的往返、超时）在 `platform/widget-tools.ts`。
 *
 * 三条设计约束，改之前先读：
 *
 * 1. **平台不当数据出口。** 组件的 `widget-data/<id>.json` 是用户的便签和待办，
 *    没有 schema，agent 读了也只能瞎猜。要数据就走组件自己声明的工具 —— 由组件的
 *    代码决定暴露什么、怎么解释。
 * 2. **工具名带组件 id，段与段之间用点**（`widget.lattice.todo.add`），和
 *    `mcp.<server>.<tool>` 同一副形状。组件 id 本身带点，所以解析时**从右边切**。
 * 3. **答话的永远是画布里的那一份**。每个 placement 在画布上都有一个 iframe，
 *    与它有没有投放到桌面无关 —— 于是"组件没在跑"这个问题在大半情况下不存在，
 *    只有"组件没装 / 画布上那份已经卸了"才回 `not-running`。
 *
 *    这条约束有代价：桌面模式下每个摆放其实**已经有一个真窗口**，画布再挂一份
 *    活副本等于同一个组件跑两遍（桌宠实测每份空转 0.3 核）。所以桌面模式下画布
 *    只画静态卡（`canvasNeedsLiveFrame`），**唯独声明了工具的那几个例外** ——
 *    它们的画布副本就是唯一的答话人，撤了就没人应了。等哪天桌面窗口能自己应
 *    这条约束才可以彻底去掉（AGENTS §8 的「不唤醒窗口」）。
 */
import type { ToolSpec } from "./assistant";

/** 参数只有这三种：够写待办和时间，不够"传一个对象进来让我猜" */
export type AgentArgType = "string" | "number" | "boolean";

const ARG_TYPES: ReadonlySet<string> = new Set<AgentArgType>(["string", "number", "boolean"]);

/** 一个组件最多声明几条工具。多了模型会挑花眼，描述也会把预算吃光 */
export const MAX_AGENT_TOOLS = 8;

/** 一条工具最多几个参数 */
export const MAX_AGENT_TOOL_PARAMS = 6;

/** 描述的字数上限（按码点算，和 help 那套一致） */
export const MAX_AGENT_TOOL_DESCRIPTION = 120;

/** 一次调用最多等多久。组件在忙自己的事时不该把一整轮卡死 */
export const WIDGET_TOOL_TIMEOUT = 8000;

/** 组件回的话最多几个字符。**超了拒绝，不截断** —— 截断过的 JSON 会让模型以为数据就是这样 */
export const MAX_WIDGET_TOOL_RESULT = 4000;

/** 整张表最多几条组件工具。挡的是"装了二十个组件，每个都声明满" */
export const MAX_WIDGET_TOOL_TOTAL = 32;

/**
 * 工具名的前缀。`widget.` 这一段是平台加的，组件自己的名字只会出现在最后一节 ——
 * 于是"这个工具是谁的"和"这个工具叫什么"永远能分开，也让审批和审计一眼能认。
 */
export const WIDGET_TOOL_PREFIX = "widget.";

const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * 清单里的一条工具声明（`manifest.agent.tools[i]`）。
 *
 * 没有 `result` 字段：组件回什么都行，平台只把它当 JSON 交给模型 —— 声明返回
 * 形状的好处是"模型猜得准一点"，坏处是"组件改一次返回就得改两处"，而后者
 * 没有测试能钉住。v1 不声明。
 */
export interface AgentToolSpec {
  /** 组件自己起的名字，例如 `add` */
  name: string;
  description: string;
  params: Record<string, AgentArgType>;
  required: string[];
}

/**
 * 组件回给平台的那一条。形状故意和 `AgentReply` / `HandsReply` 对齐：
 * 循环里三种来源的返回值只有一副样子，它不需要知道这是谁答的。
 *
 * 和那两份一样是**判别联合**，不是"一堆可选字段"：`ok: false` 一定带着 code 和
 * error（成功那侧一定没有），否则界面上会出现一条"失败了但没原因"的行。
 */
export type WidgetToolReply =
  | { ok: true; result?: unknown }
  | { ok: false; code: string; error: string };

const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

function normalizeParams(raw: unknown): Record<string, AgentArgType> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AgentArgType> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_AGENT_TOOL_PARAMS) break;
    if (!PARAM_NAME_RE.test(key)) continue;
    // `instanceId` 是平台自己加的那一格（调哪一份）。组件声明一个同名的参数
    // 会被平台那一格盖掉，作者会看到"我传的值没了" —— 直接不收
    if (key === "instanceId") continue;
    // 类型写在字符串里（`"params": {"text": "string"}`），不写成 JSON Schema：
    // 作者要写的是"这个参数是什么"，不是"帮我拼一段 schema"
    if (typeof value !== "string" || !ARG_TYPES.has(value)) continue;
    out[key] = value as AgentArgType;
  }
  return out;
}

function normalizeOneTool(raw: unknown): AgentToolSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!TOOL_NAME_RE.test(name)) return null;

  const params = normalizeParams(input.params);
  const required: string[] = [];
  if (Array.isArray(input.required)) {
    for (const item of input.required) {
      if (typeof item !== "string") continue;
      // `required` 不是 `params` 的子集时，那一条是写坏的 —— 丢掉它，
      // 不因为一个多余的名字让整条工具消失（和 help 那一套同一条规矩）
      if (params[item] && !required.includes(item)) required.push(item);
    }
  }

  const description =
    typeof input.description === "string"
      ? clip(input.description.trim(), MAX_AGENT_TOOL_DESCRIPTION)
      : "";

  return { name, description, params, required };
}

/**
 * 清单里的 `agent.tools` 归一化：**坏条目逐条丢，不整包失败**。
 *
 * 和 `config` / `icon` / `help` 同一条规矩。理由是同一个：声明工具是锦上添花，
 * 不该有"让组件打不开"的权力；写坏一条的代价应该是"这一条用不了"。
 */
export function normalizeAgentTools(raw: unknown): AgentToolSpec[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).tools;
  if (!Array.isArray(list)) return [];

  const out: AgentToolSpec[] = [];
  for (const item of list) {
    if (out.length >= MAX_AGENT_TOOLS) break;
    const tool = normalizeOneTool(item);
    if (!tool) continue;
    // 撞名：先来的留下。后来的那条如果被静默覆盖，作者会以为自己改了它
    if (out.some((existing) => existing.name === tool.name)) continue;
    out.push(tool);
  }
  return out;
}

/** 给模型的完整工具名：`widget.<组件 id>.<工具名>` */
export function widgetToolName(widgetId: string, tool: string): string {
  return `${WIDGET_TOOL_PREFIX}${widgetId}.${tool}`;
}

/**
 * 拆回来。**从右边切**：组件 id 自带点（`lattice.todo`），工具名不带。
 * 认不出来一律 `null` —— 循环里靠这个判断"这是不是组件声明的工具"。
 */
export function parseWidgetTool(name: string): { widgetId: string; tool: string } | null {
  if (!name.startsWith(WIDGET_TOOL_PREFIX)) return null;
  const rest = name.slice(WIDGET_TOOL_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const widgetId = rest.slice(0, dot);
  const tool = rest.slice(dot + 1);
  if (!widgetId || !TOOL_NAME_RE.test(tool)) return null;
  return { widgetId, tool };
}

/**
 * 一份能答话的组件：一个 placement（实例）+ 它清单里的工具声明。
 *
 * `instanceId` 是调用要带的东西（不变量：调**哪个实例**）。三份天气组件各自
 * 摆在上海、东京，工具只有一套名字 —— 选哪一份由参数说。
 */
export interface WidgetToolSource {
  instanceId: string;
  widgetId: string;
  /** 界面上那个名字，用来把"哪一份"讲清楚 */
  title: string;
  tools: AgentToolSpec[];
}

/**
 * 把组件声明的工具变成这一轮发给模型的 schema。
 *
 * 同一个组件的多份实例**合成一条工具**，`instanceId` 那一格列出所有能答的：
 * 一个工具里嵌着"我这边只有上海"这种信息，模型读不出来也没法用。
 */
export function widgetToolSpecs(sources: WidgetToolSource[]): Record<string, ToolSpec> {
  const byWidget = new Map<string, WidgetToolSource[]>();
  for (const source of sources) {
    if (source.tools.length === 0) continue;
    const list = byWidget.get(source.widgetId);
    if (list) list.push(source);
    else byWidget.set(source.widgetId, [source]);
  }

  const out: Record<string, ToolSpec> = {};
  for (const [widgetId, group] of byWidget) {
    const instances = group.map((source) => source.instanceId);
    const many = instances.length > 1;
    const first = group[0];
    if (!first) continue;

    for (const tool of first.tools) {
      if (Object.keys(out).length >= MAX_WIDGET_TOOL_TOTAL) return out;

      const properties: Record<string, unknown> = {};
      for (const [key, type] of Object.entries(tool.params)) properties[key] = { type };
      properties.instanceId = {
        type: "string",
        enum: instances,
        description: `Which copy of ${widgetId} to call`,
      };

      const required = [...tool.required];
      // 只有一份时不逼模型抄一遍 id：省略就是那唯一的一份（见 platform 侧的补全）
      if (many) required.push("instanceId");

      const where = many ? ` (copies: ${instances.join(", ")})` : ` (${first.title})`;
      out[widgetToolName(widgetId, tool.name)] = {
        description: `${tool.description || tool.name}${where}`,
        parameters: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      };
    }
  }
  return out;
}

/**
 * 清单里声明了、但**现在还不能调**的那些：没装、或者用户没授 `agent:tools`。
 *
 * 判据只留这一份。三件事必须同时为真才进表 —— 少一条的症状都是"模型有个工具，
 * 一调就失败"，而它没有任何办法从失败里学到"该去授权"。
 */
export interface WidgetToolCandidate extends WidgetToolSource {
  installed: boolean;
  granted: boolean;
}

/**
 * 一张"清单 × 摆放"的候选表：谁是这一轮可能答话的实例、它能不能答。
 *
 * 为什么在纯逻辑这一侧、而不是在面板里拼：这份表**两个窗口都要**。主窗口自己算，
 * 桌面小窗问主窗口要（`assistant_widget_tools` → `platform/assistant.ts` 的
 * `remoteSurface`）—— 各拼一遍的话，小窗那份迟早会漏掉 `granted` 那一条，
 * 症状是"小窗里模型调一个没授权的工具、每次都失败"，而它没有任何办法学到该去授权。
 *
 * **这里只拼、不筛**：`installed` / `granted` / "一条工具都没声明"这三条判据只在
 * `widgetToolSources` 里过一遍。预先筛一遍等于把判据变成两份。
 */
export interface WidgetToolRecord {
  /** 组件 id（`lattice.todo`） */
  id: string;
  tools: readonly AgentToolSpec[];
}

/** 平台那两样只有它自己知道的事：摆了哪些、装没装、授没授权 */
export interface WidgetToolState {
  placements: ReadonlyArray<{ instanceId: string; widgetId: string }>;
  installedIds: readonly string[];
  grants: Readonly<Record<string, readonly string[] | undefined>>;
}

export function widgetToolCandidates(
  records: readonly WidgetToolRecord[],
  state: WidgetToolState,
): WidgetToolCandidate[] {
  const out: WidgetToolCandidate[] = [];
  for (const record of records) {
    for (const placement of state.placements) {
      if (placement.widgetId !== record.id) continue;
      out.push({
        instanceId: placement.instanceId,
        widgetId: record.id,
        // 用 id 当"哪一份"的说明：它稳定、不用翻译，也不会因为两门语言各写一个
        // 名字而让模型看到两个不同的东西
        title: record.id,
        tools: [...record.tools],
        installed: state.installedIds.includes(record.id),
        granted: (state.grants[record.id] ?? []).includes("agent:tools"),
      });
    }
  }
  return out;
}

export function widgetToolSources(candidates: WidgetToolCandidate[]): WidgetToolSource[] {
  return candidates
    .filter((item) => item.installed && item.granted && item.tools.length > 0)
    .map((item) => ({
      instanceId: item.instanceId,
      widgetId: item.widgetId,
      title: item.title,
      tools: item.tools,
    }));
}

/**
 * 画布上这一份要不要挂**活的 iframe**（桌面模式下默认只画静态卡）。
 *
 * 为什么可以只画静态卡：桌面模式（`desktopMode`）下每个摆放都已经是一个真窗口，
 * 画布再挂一份等于同一个组件跑两遍 —— 实测每份活副本空转约 0.3 核（桌宠那种每帧
 * 整屏重绘的），内存还多一个 renderer。
 *
 * 三个例外，都是"撤了会真的坏"：
 *
 * - **没进桌面模式**：那时没有窗口，画布就是它唯一的家，必须活着（设计态得能调它）。
 * - **声明了工具并且授了 `agent:tools`**：画布这一份是数据平面唯一的答话人
 *   （见文件头第 3 条），撤了模型调它只会得到 `not-running`。
 * - **那一份窗口已经不在了**（`suppressed`，组件自己调 `window.close()` 关掉的，
 *   见 `runner.rs::widget_close`）。桌面模式说的是"摆放都投放了"，可窗口会没 ——
 *   静态卡的意义是"它在那儿跑，你去那儿看"，窗口不在还画静态卡的话，这个组件
 *   在屏幕上就**一个像素都没有了**，而卡片还在骗人说它在桌面上。
 *
 * 判据和 `widgetToolSources` 是同一条（装了 / 授了 / 真声明了），这里只看后两条：
 * "装了"在 `Canvas` 里已经筛过一遍（没装的走破卡）。
 */
export function canvasNeedsLiveFrame(input: {
  /** 现在是桌面模式吗（摆放都在真窗口里跑） */
  desktopMode: boolean;
  /** 清单里声明了几条工具 */
  toolCount: number;
  /** 这个组件拿到的权限 */
  granted: readonly string[];
  /** 这一份的窗口本次运行里被组件自己关掉了 */
  suppressed?: boolean;
}): boolean {
  if (!input.desktopMode) return true;
  if (input.suppressed) return true;
  return input.toolCount > 0 && input.granted.includes("agent:tools");
}

/**
 * 这次调用该打给哪一份实例。
 *
 * 三种情况：模型说了是哪一份（必须在**这个组件**的实例里，不能借别家的 id）、
 * 只有一份（省略就等于它）、有多份而它没说（回 `null`，让上面报一条能看懂的错）。
 */
export function resolveWidgetInstance(
  sources: WidgetToolSource[],
  widgetId: string,
  wanted: unknown,
): string | null {
  const mine = sources.filter((source) => source.widgetId === widgetId);
  if (mine.length === 0) return null;
  if (typeof wanted === "string" && wanted.trim()) {
    const hit = mine.find((source) => source.instanceId === wanted.trim());
    return hit ? hit.instanceId : null;
  }
  return mine.length === 1 ? mine[0]?.instanceId ?? null : null;
}

/**
 * 组件回话的归一化：形状不对、太长、或者根本没回，都折成一条 `ok: false`。
 *
 * 为什么不做"截断后照样给模型"：截断过的 JSON 会让模型把半截数据当成真的
 * （`{"items": ["买牛奶", "洗` 之后它会接着编），而它没有任何办法知道自己看到的是残片。
 */
export function normalizeToolReply(widgetId: string, tool: string, raw: unknown): WidgetToolReply {
  const name = widgetToolName(widgetId, tool);
  if (!raw || typeof raw !== "object") {
    return { ok: false, code: "bad-reply", error: `${name}: the widget sent nothing back` };
  }
  const input = raw as Record<string, unknown>;
  if (input.ok !== true) {
    const error = typeof input.error === "string" && input.error.trim() ? input.error.trim() : "";
    return {
      ok: false,
      code: typeof input.code === "string" && input.code.trim() ? input.code.trim().slice(0, 40) : "failed",
      error: error || `${name}: the widget reported a failure`,
    };
  }
  const result = input.result;
  if (result === undefined || result === null) return { ok: true };
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return { ok: false, code: "bad-reply", error: `${name}: the widget's result is not JSON` };
  }
  if (json.length > MAX_WIDGET_TOOL_RESULT) {
    return {
      ok: false,
      code: "too-big",
      error: `${name}: the result is ${json.length} characters, over the ${MAX_WIDGET_TOOL_RESULT} limit — ask for less`,
    };
  }
  return { ok: true, result };
}

/**
 * 组件没答话时回的那一句。
 *
 * **不唤醒**（v1 的取舍，AGENT_ACCESS §2.2）：建窗口 → 等宿主页 boot → 再投递
 * 是一串会输的竞态，而"它没在跑"这个答案对模型已经够用 —— 它能转述给用户。
 */
export function notRunningReply(widgetId: string, tool: string): WidgetToolReply {
  return {
    ok: false,
    code: "not-running",
    error: `${
      widgetToolName(widgetId, tool)
    }: no live copy of this widget answered in time — it may be uninstalled, or its canvas card is gone. Tell the user instead of retrying`,
  };
}
