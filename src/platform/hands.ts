/**
 * 手 —— **IPC 这一半**（`assistant_tool` / `hands_cancel` / 开关读写）。
 *
 * 只有三个约定要记住：
 *   - 参数**序列化成一个字符串**递过去：Rust 那边不重新认识对话的形状，和
 *     `assistant_act` 同一条规矩（少一层转译，少一处会不一致的地方）
 *   - 返回是 `AgentReply` 形状的 JSON，**成功和失败形状不同但都是数据** ——
 *     失败要原样回给模型（`code` 比"抛异常"有用：它看得见 `denied` 就能改主意）
 *   - `requestId` 必须带：用户按停止时要知道叫停哪一只（`emit` 是广播，不变量 9
 *     的同一条理由）
 */

import type { HandsSettings, McpServer, McpServerTools } from "../runtime/hands";
import { callCommand } from "./devLlm";

/** 和 `platform/agent.ts` 的 `AgentReply` 同形，但多了几只新手才会有的 code */
export type HandsReply =
  | { ok: true; result?: unknown }
  | { ok: false; code: string; error: string };

export async function readHands(): Promise<HandsSettings> {
  return await callCommand<HandsSettings>("assistant_hands");
}

export async function saveHands(hands: HandsSettings): Promise<HandsSettings> {
  return await callCommand<HandsSettings>("assistant_hands_save", { hands });
}

/**
 * 跑一只手。
 *
 * **审批不在这里**：调用方（`platform/assistant.ts` 的循环）必须先 await
 * `approve`，用户点了 Allow 才走到这一行。把审批放进这个函数看起来更"安全"，
 * 实际上会让"谁在执行"和"谁在问"变成两个地方的事。
 */
export async function callHand(
  requestId: string,
  name: string,
  args: unknown,
): Promise<HandsReply> {
  const raw = await callCommand<string>("assistant_tool", {
    requestId,
    name,
    args: JSON.stringify(args ?? {}),
  });
  try {
    return JSON.parse(raw) as HandsReply;
  } catch {
    // Rust 那边只会返回 JSON；真走到这儿说明 IPC 坏了，报清楚比假装成功好
    return { ok: false, code: "internal", error: "the tool returned something that is not JSON" };
  }
}

/** 叫停正在跑的那只手（命令会被真的 kill）。**幂等** */
export async function cancelHand(requestId: string): Promise<boolean> {
  try {
    return await callCommand<boolean>("hands_cancel", { requestId });
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ MCP */

export async function readMcpServers(): Promise<McpServer[]> {
  return await callCommand<McpServer[]>("mcp_servers");
}

/** 存整份列表。Rust 会洗一遍（id / 去空白 / 传输只认两种），返回洗过的 */
export async function saveMcpServers(servers: McpServer[]): Promise<McpServer[]> {
  return await callCommand<McpServer[]>("mcp_servers_save", { servers });
}

/**
 * 问服务要工具表。
 *
 * 第一次（`refresh = false`）走 Rust 的内存缓存 —— 一个 `npx` 服务器可能要几秒
 * 才回话，每轮对话都重问一遍等于每轮都卡一下。界面上那个 Refresh 传 `true`。
 */
export async function discoverMcpTools(refresh = false): Promise<McpServerTools[]> {
  const result = await callCommand<{ servers: McpServerTools[] }>("mcp_tools", { refresh });
  return result.servers;
}
