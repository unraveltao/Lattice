/**
 * Agent 接入 —— 前端这一半。
 *
 * ## 为什么执行器在前端
 *
 * 布局的**权威**在 `useLattice` 的内存状态里，`state.json` 只是它的落盘副本
 * （`state.rs` 是整份覆盖写）。所以 agent 的请求必须落在这份状态上，否则就是
 * "改文件"和"改内存"两套真相打架 —— 这个项目被孤儿进程这么咬过一次。
 *
 * 链路：`agent.rs` 收到 HTTP → emit `lattice:agent` → 这里执行 → `agent_reply`
 * 把结果原样带回去当响应体。
 *
 * ## 两处都校验
 *
 * 动作白名单在 Rust（`agent_policy::ACTIONS`）和这里各有一份，看起来重复，
 * 但两边防的不是同一件事：Rust 那份挡的是"从端口进来的请求"，这份挡的是
 * "将来有人给前端开第二条入口时忘了校验"。**改动作时两边一起改**，
 * `tests/agent.html` 钉着两张表一致。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nextFreeSlot, useLattice, type Placement, type ThemeMode } from "./store";
import type { WidgetRecord } from "../runtime/registry";
import { pickText } from "../runtime/widget-text";

const EVENT = "lattice:agent";

/** 与 `src-tauri/src/agent_policy.rs` 的 `ACTIONS` 必须逐字一致 */
export const AGENT_ACTIONS = [
  "placement.add",
  "placement.move",
  "placement.resize",
  "placement.remove",
  "placement.pin",
  "placement.front",
  "theme.set",
  "widgets.pause",
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

export type AgentReply =
  | { ok: true; result?: unknown }
  | { ok: false; code: AgentErrorCode; error: string };

export type AgentErrorCode =
  | "unknown_action"
  | "bad_args"
  | "not_found"
  | "not_installed"
  | "internal";

export interface AgentRequest {
  op: string;
  action?: string;
  args?: unknown;
}

/** `agent_status` 的返回。`port` 只有正在听才有值 —— 端口由系统分配，每次开都可能不同。 */
export interface AgentStatus {
  enabled: boolean;
  port: number | null;
  token: string | null;
}

export async function readAgentStatus(): Promise<AgentStatus> {
  return await invoke<AgentStatus>("agent_status");
}

/**
 * 开关端点。**这是人在界面上按的** —— agent 自己调不到它（它不在白名单里，
 * 而且端点上根本没有这个 op）。
 */
export async function setAgentEnabled(enabled: boolean): Promise<AgentStatus> {
  return await invoke<AgentStatus>("agent_set_enabled", { enabled });
}

/**
 * 给 agent 看的世界。
 *
 * 刻意**不含**组件存储（`widget-store/<id>.json`）—— 那里是用户的便签和待办，
 * 而 agent 要读它得走组件自己声明的工具（第二层，还没做）。快照只回答
 * "桌面上摆着什么、摆在哪、什么主题"，这些是布局，不是内容。
 */
export function agentSnapshot(records: WidgetRecord[]) {
  const state = useLattice.getState();
  const byId = new Map(records.map((record) => [record.manifest.id, record.manifest]));

  return {
    app: "lattice",
    theme: state.theme,
    snapToGrid: state.snapToGrid,
    desktopMode: state.desktopMode,
    paused: state.paused,
    actions: AGENT_ACTIONS,
    widgets: records.map((record) => ({
      id: record.manifest.id,
      // 快照是给模型 / CLI 看的一份纯文本，名字取当前语言那一份就够了
      name: pickText(record.manifest.name),
      version: record.manifest.version,
      installed: state.installedIds.includes(record.manifest.id),
      permissions: record.manifest.permissions ?? [],
      size: record.manifest.size,
    })),
    placements: state.placements.map((placement) => ({
      instanceId: placement.instanceId,
      widgetId: placement.widgetId,
      name: pickText(byId.get(placement.widgetId)?.name) || placement.widgetId,
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
      layer: placement.layer,
      pinned: placement.pinned,
      clickThrough: placement.clickThrough,
      config: state.configs[placement.instanceId] ?? {},
    })),
  };
}

function fail(code: AgentErrorCode, error: string): AgentReply {
  return { ok: false, code, error };
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new TypeError(`missing string argument "${key}"`);
  return value;
}

function readNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`missing number argument "${key}"`);
  }
  return Math.round(value);
}

function readBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new TypeError(`missing boolean argument "${key}"`);
  return value;
}

function findPlacement(instanceId: string): Placement | undefined {
  return useLattice.getState().placements.find((item) => item.instanceId === instanceId);
}

/**
 * 执行一条动作。**只读 store 的公开 action**，不直接 set 状态 ——
 * 这样撤销、落盘、桌面窗口同步这些副作用全都照常发生。
 */
export function runAgentAction(
  action: string,
  rawArgs: unknown,
  records: WidgetRecord[],
): AgentReply {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const store = useLattice.getState();

  try {
    switch (action) {
      case "placement.add": {
        const widgetId = readString(args, "widgetId");
        if (!store.installedIds.includes(widgetId)) {
          return fail("not_installed", `${widgetId} is not installed; install it first`);
        }
        const record = records.find((item) => item.manifest.id === widgetId);
        if (!record) {
          return fail("not_found", `${widgetId} is installed but its manifest could not be read`);
        }
        const { w, h } = record.manifest.size;
        // 用和界面上"添加"完全同一个落位算法：agent 摆出来的桌面
        // 不该和用户自己摆的不一样
        const slot = nextFreeSlot(store.placements, w, h);
        const instanceId = `${widgetId}#${crypto.randomUUID().slice(0, 8)}`;
        store.addPlacement({
          instanceId,
          widgetId,
          x: slot.x,
          y: slot.y,
          w,
          h,
          layer: record.manifest.layer,
          clickThrough: false,
          pinned: false,
        });
        return { ok: true, result: { instanceId, x: slot.x, y: slot.y, w, h } };
      }

      case "placement.move": {
        const instanceId = readString(args, "instanceId");
        if (!findPlacement(instanceId)) return fail("not_found", `no placement ${instanceId}`);
        store.updatePlacement(instanceId, {
          x: readNumber(args, "x"),
          y: readNumber(args, "y"),
        });
        return { ok: true, result: { instanceId } };
      }

      case "placement.resize": {
        const instanceId = readString(args, "instanceId");
        const placement = findPlacement(instanceId);
        if (!placement) return fail("not_found", `no placement ${instanceId}`);
        const record = records.find((item) => item.manifest.id === placement.widgetId);
        // 缩到比清单的 minW/minH 还小，组件自己就会溢出卡片 —— 用户手拖时
        // 界面会拦，agent 走的是同一个下限
        const minW = record?.manifest.size.minW ?? 80;
        const minH = record?.manifest.size.minH ?? 60;
        store.updatePlacement(instanceId, {
          w: Math.max(minW, readNumber(args, "w")),
          h: Math.max(minH, readNumber(args, "h")),
        });
        return { ok: true, result: { instanceId, minW, minH } };
      }

      case "placement.remove": {
        const instanceId = readString(args, "instanceId");
        if (!findPlacement(instanceId)) return fail("not_found", `no placement ${instanceId}`);
        // 走 removePlacement 而不是自己 filter：它会把 rect / config 一起清掉，
        // 并且留一份 lastClosed 让用户还能"撤销"
        store.removePlacement(instanceId);
        return { ok: true, result: { instanceId } };
      }

      case "placement.pin": {
        const instanceId = readString(args, "instanceId");
        if (!findPlacement(instanceId)) return fail("not_found", `no placement ${instanceId}`);
        store.updatePlacement(instanceId, { pinned: readBoolean(args, "pinned") });
        return { ok: true, result: { instanceId } };
      }

      case "placement.front": {
        const instanceId = readString(args, "instanceId");
        if (!findPlacement(instanceId)) return fail("not_found", `no placement ${instanceId}`);
        store.bringToFront(instanceId);
        return { ok: true, result: { instanceId } };
      }

      case "theme.set": {
        const theme = readString(args, "theme");
        if (theme !== "light" && theme !== "dark" && theme !== "system") {
          return fail("bad_args", 'theme must be "light", "dark" or "system"');
        }
        store.setTheme(theme as ThemeMode);
        return { ok: true, result: { theme } };
      }

      case "widgets.pause": {
        const paused = readBoolean(args, "paused");
        store.setPaused(paused);
        return { ok: true, result: { paused } };
      }

      default:
        // 白名单外的一律到这里。Rust 那边已经挡过一次，这里是第二道
        return fail("unknown_action", `unknown action ${JSON.stringify(action)}`);
    }
  } catch (error) {
    // 参数错和内部错分开：前者是 agent 写错了，后者是这个平台的问题
    const code = error instanceof TypeError ? "bad_args" : "internal";
    return fail(code, String(error instanceof Error ? error.message : error));
  }
}

export function runAgentRequest(request: AgentRequest, records: WidgetRecord[]): AgentReply {
  if (request.op === "state") return { ok: true, result: agentSnapshot(records) };
  if (request.op === "act") {
    return runAgentAction(request.action ?? "", request.args, records);
  }
  // `op: "ask"` 是**异步**的（要等模型），走 `startAgentBridge` 的 handlers，
  // 不在这个同步函数里 —— 到了这里说明没有人接，回绝掉
  return fail("unknown_action", `unknown op ${JSON.stringify(request.op)}`);
}

/**
 * 宿主窗口能多做的两件事。
 *
 * `act` / `state` 都在这个模块里同步跑完；`ask` 要等一轮模型（可能几十秒），
 * 所以由窗口自己接 —— 但执行仍然是同一个 `AGENT_ACTIONS` 与同一份 store。
 */
export interface AgentHandlers {
  /**
   * `op: "ask"`：组件借平台的手跑一轮（`assistant.ask`，权限 `desktop:control`）。
   *
   * 不接这一条就等于"这个平台没有那扇门"：请求会被回成 `unknown_action`，
   * 组件那侧看到的是 `internal`，它会退回只说话。
   */
  ask?: (request: AgentRequest, records: WidgetRecord[]) => Promise<AgentReply>;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 开始应答 agent 端点。返回一个取消订阅的函数。
 *
 * `getRecords` 是个函数而不是数组：组件清单会在运行中变（装一个、删一个），
 * 而这个订阅只该建一次。传数组的话每次清单变化都要重建订阅，中间那段空窗
 * 里来的请求会全部超时。
 *
 * `handlers` 只多一条 `ask`（组件借平台的手）。**同一份订阅**：不管来的是
 * agent 端点、assistant 小窗还是某个组件，`act` 都走同一个执行器。
 */
export function startAgentBridge(
  getRecords: () => WidgetRecord[],
  handlers: AgentHandlers = {},
): () => void {
  if (!inTauri()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | undefined;

  void listen<{ id: string; request: AgentRequest }>(EVENT, (event) => {
    const { id, request } = event.payload;
    const answer = async (): Promise<AgentReply> => {
      if (request.op === "ask") {
        if (!handlers.ask) return fail("unknown_action", "this window cannot run assistant turns");
        return await handlers.ask(request, getRecords());
      }
      return runAgentRequest(request, getRecords());
    };
    void answer()
      .catch((error) => fail("internal", String(error)))
      .then((reply) =>
        invoke("agent_reply", { id, payload: JSON.stringify(reply) }).catch(() => {
          /* 后端已经超时走了，回话没人接 —— 不值得弹错 */
        }),
      );
  })
    .then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    })
    .catch(() => {
      /* 事件通道不可用就当没有这个功能，界面照常 */
    });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
