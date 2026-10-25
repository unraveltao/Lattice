/**
 * 浏览器预览里的 assistant 通道 —— 走 dev server 的 `/api/llm`。
 *
 * 为什么需要它：浏览器里没有 Rust，`isTauri()` 为 false，而 assistant 的每一条
 * 路都是 `invoke("llm_…")`。桌面小窗那条 `remoteSurface` 也是 IPC，所以同样不
 * 在这里 —— 浏览器里只有主窗口的抽屉（`variant="drawer"`），动作走 `localSurface`。
 *
 * 三条约定：
 *   1. **key 不进前端**。读写都发生在 Node（`scripts/dev-llm-proxy.mjs`）里，这里
 *      只看得见 `keyHint` 掩码。`llm_set_key` 那一条会把用户**刚粘进来的**明文
 *      发过去 —— 和桌面面板里打字是同一件事，发完就不回传。
 *   2. **reject 的是字符串**（不是 `Error`）。`invoke` 失败时 reject 的就是
 *      Rust 那句 `Err(String)`，面板直接把它印出来；这里保持同一种形状，失败
 *      文案就不用写两套。
 *   3. **命令名就是 Rust 的命令名**（`llm_profiles` / `llm_chat_stream` / …）。
 *      不另起一套名字：这一层是"同一条通道的另一种传输"，不是第二个 API。
 *
 * 到期不候的两件事，别以为坏了：**没有流式增量**（整句在结束时出现）和**六只手
 * 不执行**（回一句"桌面应用里才有"）。两条都要 Rust。
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../runtime/registry";

/** 正在飞的那几轮：用户按停止时要知道中断哪一条 `fetch` */
const inFlight = new Map<string, AbortController>();

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const text = await response.text();

  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }

  if (!response.ok) {
    const detail =
      value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : `the dev assistant proxy answered HTTP ${response.status}`;
    // 见文件开头第 2 条：抛字符串，不是 Error
    throw detail;
  }
  return value;
}

function get(path: string): Promise<unknown> {
  return request(path, { method: "GET", redirect: "error" });
}

function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    redirect: "error",
    signal,
  });
}

/**
 * 一轮对话。
 *
 * 和 Rust 的差别只有一处：**没有增量**。命令名仍然是 `llm_chat_stream`（调用方
 * 不用知道传输方式），返回的整条 `AssistantReply` 形状一模一样 —— 前端本来就
 * 拿返回值覆盖气泡，所以少了一串增量只是"字到最后一起出来"。
 */
async function chatInBrowser(args: Record<string, unknown>): Promise<unknown> {
  const requestId = String(args.requestId ?? "");
  const controller = new AbortController();
  if (requestId) inFlight.set(requestId, controller);
  try {
    return await post(
      "/api/llm/chat",
      {
        profileId: args.profileId ?? null,
        messages: args.messages,
        tools: args.tools ?? null,
      },
      controller.signal,
    );
  } catch (error) {
    // 用户按了停止：这不是错误。回一条空回应，循环顺着 `shouldStop` 收尾，
    // 界面上不该弹一句"请求失败"
    if (controller.signal.aborted) return { text: "", toolCalls: [], finish: "cancelled" };
    throw error;
  } finally {
    if (requestId) inFlight.delete(requestId);
  }
}

/** 浏览器预览下"这个命令在这儿跑不了"的答复。形状和 `HandsReply` 一致 */
function desktopOnly(name: string): string {
  return JSON.stringify({
    ok: false,
    code: "desktop-only",
    error: `the hands (${name}) only run in the desktop app — this is the browser preview`,
  });
}

/**
 * 一个 Rust 命令的浏览器版。
 *
 * 名字集合必须和 `llm.rs` 的命令表对得上（`assistant_tool` 那几个在这里是
 * **明确的拒绝**，不是"没实现"）—— 静默返回 `undefined` 会让面板显示成
 * "工具成功了但什么都没做"。
 */
export async function devCommand(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case "llm_profiles":
      return await get("/api/llm/profiles");

    case "llm_profile_save":
      return await post("/api/llm/profiles", {
        op: "save",
        id: args.id ?? null,
        label: args.label,
        baseUrl: args.baseUrl,
        auth: args.auth ?? null,
        model: args.model,
        temperature: args.temperature ?? null,
      });

    case "llm_profile_remove":
      return await post("/api/llm/profiles", { op: "remove", id: args.id });

    case "llm_profile_activate":
      return await post("/api/llm/profiles", { op: "activate", id: args.id });

    case "llm_set_key":
      return await post("/api/llm/profiles", { op: "key", id: args.id, key: args.key });

    case "llm_models":
      return await post("/api/llm/models", {
        profileId: args.profileId ?? null,
        baseUrl: args.baseUrl ?? null,
        auth: args.auth ?? null,
        key: args.key ?? null,
      });

    case "llm_chat":
      return await post("/api/llm/chat", {
        profileId: args.profileId ?? null,
        messages: args.messages,
        tools: args.tools ?? null,
      });

    case "llm_chat_stream":
      return await chatInBrowser(args);

    case "llm_chat_cancel": {
      const requestId = String(args.requestId ?? "");
      const controller = inFlight.get(requestId);
      if (!controller) return false;
      controller.abort();
      inFlight.delete(requestId);
      return true;
    }

    case "assistant_hands":
      return await get("/api/llm/hands");

    case "assistant_hands_save":
      return await post("/api/llm/hands", { hands: args.hands });

    case "assistant_tool":
      return desktopOnly(String(args.name ?? "tool"));

    case "hands_cancel":
      // 浏览器里根本没有在跑的手，所以"没叫停成功"是实话
      return false;

    default:
      throw `"${name}" needs the desktop app`;
  }
}

/** 有没有 Rust 在下面。事件（`lattice:llm-delta`）、小窗、六只手都只在这儿成立 */
export function hasRust(): boolean {
  return isTauri();
}

/** 同一个命令的两种传输。**唯一的分叉点**：两个窗口里的代码都只看见这一行 */
export async function callCommand<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) return await invoke<T>(name, args);
  return (await devCommand(name, args)) as T;
}
