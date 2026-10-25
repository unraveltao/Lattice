/**
 * 数据平面在平台这一侧：把"这个组件能不能答"变成"它答了"。
 *
 * 纯逻辑（清单解析、工具名、schema）在 `runtime/widget-tools.ts`；这里只做两件
 * 纯逻辑做不了的事：**记住画布上哪些实例还活着**、**真去敲它并等回话**。
 *
 * 为什么答话的是画布那一份而不是桌面上那个窗口：每个 placement 在画布上都有
 * 一个 iframe，而它有没有投放到桌面是另一件事。于是"组件没在跑"这个问题在大半
 * 情况下不存在（主窗口只是 hide，React 树和 iframe 都还在），也就不用为它造一条
 * 跨窗口的中转。**代价**：组件被卸载后，那张破卡（`WidgetFrame` 的 `is-broken`）
 * 不会注册处理器，调用回 `not-running`。
 *
 * 一次调用的寿命：`WIDGET_TOOL_TIMEOUT`（8 秒）。组件在忙自己的事（一次长网络
 * 请求、一段动画）时不该把一整轮对话卡住 —— 超时回一句能转述给用户的话，比
 * 让模型永远等下去强。
 */
import {
  WIDGET_TOOL_TIMEOUT,
  normalizeToolReply,
  notRunningReply,
  widgetToolCandidates,
  widgetToolSources,
  type WidgetToolReply,
  type WidgetToolSource,
} from "../runtime/widget-tools";
import { useLattice } from "./store";
import type { WidgetRecord } from "../runtime/registry";

/** 画布上的一个实例能答什么：给它工具名和参数，回它自己的 `agent-result` 载荷 */
type ToolHandler = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, ToolHandler>();

/** 画布实例挂载时登记。**同一个 instanceId 覆盖**：重载之后旧的窗口已经没了 */
export function registerCanvasWidgetTools(instanceId: string, handler: ToolHandler): void {
  handlers.set(instanceId, handler);
}

export function unregisterCanvasWidgetTools(instanceId: string, handler?: ToolHandler): void {
  // 只删自己那一份：重载时 React 会先挂新的再卸旧的（effect 顺序不保证），
  // 无条件 delete 会把刚登记的那个删掉，症状是"换个权限之后它忽然不理人了"
  if (handler && handlers.get(instanceId) !== handler) return;
  handlers.delete(instanceId);
}

/** 这一份实例现在有没有人答话。面板据此决定要不要把它的工具写进提示词 */
export function canvasWidgetAlive(instanceId: string): boolean {
  return handlers.has(instanceId);
}

/**
 * 这一轮能调的组件工具：清单 × 摆放，再按"装了 / 授了 / 真声明了"筛一遍。
 *
 * 住在平台这一侧（而不是面板里）是因为**两个窗口都要这份表**：主窗口自己算，
 * 桌面小窗问主窗口要（`assistant_widget_tools` → `remoteSurface().widgetTools()`）。
 * 小窗没有 `useLattice` 的权威状态，问来的清单就是它这一轮的全部 —— 所以判据
 * 必须在这儿、且只在这儿过一遍，两边各拼一份的话小窗迟早会漏掉 `granted`。
 */
export function listWidgetTools(records: WidgetRecord[]): WidgetToolSource[] {
  const state = useLattice.getState();
  return widgetToolSources(
    widgetToolCandidates(
      records.map((record) => ({
        id: record.manifest.id,
        // 夹具和将来的调用方可能拿裸清单来喂（归一化过的 record 一定带这一节，
        // 手写的没有）—— 一个组件没声明工具，不该让整张表拿不到
        tools: record.manifest.agent?.tools ?? [],
      })),
      {
        placements: state.placements,
        installedIds: state.installedIds,
        grants: state.grants,
      },
    ),
  );
}

export const TIMED_OUT: unique symbol = Symbol("widget-tool-timeout");

/**
 * 敲一份实例。
 *
 * 返回形状和 `AgentReply` / `HandsReply` 对齐 —— 循环里三种来源只有一副样子。
 */
export async function callWidgetTool(input: {
  instanceId: string;
  widgetId: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<WidgetToolReply> {
  const handler = handlers.get(input.instanceId);
  if (!handler) return notRunningReply(input.widgetId, input.tool);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), input.timeoutMs ?? WIDGET_TOOL_TIMEOUT);
  });

  try {
    const raw = await Promise.race([handler(input.tool, input.args), expired]);
    if (raw === TIMED_OUT) return notRunningReply(input.widgetId, input.tool);
    return normalizeToolReply(input.widgetId, input.tool, raw);
  } catch (error) {
    // 组件那边抛的异常不该掀翻整轮：它是一次工具调用的失败，不是平台的失败
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "failed",
      error: `${input.widgetId}.${input.tool} threw while handling the call: ${message}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
