/**
 * 能力体检的读法 —— 纯逻辑，`tests/capabilities.html` 钉着。
 *
 * # 为什么这张表在前端
 *
 * Rust 那边给的是 `{ id, available, reason, detail }`：`reason` 是一个 `snake_case`
 * 的码，`detail` 是具体那个名字（缺的命令、坏在哪儿的服务器）。**码翻成人话这一步
 * 必须在这里**，不能在 Rust 里写死一句英文 —— 中文界面上冒出一句英文，和没有
 * 说明一样糟（和 `dictationReasonText` 同一个形状）。
 *
 * # `detail` 的含义由 `reason` 决定
 *
 * 同一个字段，`missing_command` 时是命令名、`blocked` 时是系统那句话、
 * `not_configured` 时是缺的那一栏（`address` / `model`）。所以**读法**也在这里：
 * 拿 `detail` 之前先看 `reason`，别拿一个裸字符串直接往句子里塞。
 */

import { t } from "./i18n";

/** 一行体检结果。字段名和 `capability_probe::Row` 的 serde 输出一致 */
export interface CapabilityRow {
  id: string;
  available: boolean;
  reason: string | null;
  detail: string | null;
}

/** 一次体检。`probedAt` 是 Unix 毫秒 —— 界面上要写"最后检查：09:41" */
export interface CapabilityReport {
  probedAt: number;
  rows: CapabilityRow[];
}

/** 三块。服务器单独一块，因为它们是用户自己加的，数量不固定 */
export interface CapabilityGroups {
  hands: CapabilityRow[];
  servers: CapabilityRow[];
  platform: CapabilityRow[];
}

/**
 * 按前缀分块。
 *
 * 认不出来的 id **不丢**：落进 `platform` 那一段。丢掉的后果是"新加了一条能力，
 * 界面上没有它"，而那种缺失永远不会有人报 bug —— 用户不知道自己少了什么。
 */
export function groupRows(rows: readonly CapabilityRow[]): CapabilityGroups {
  const groups: CapabilityGroups = { hands: [], servers: [], platform: [] };
  for (const row of rows) {
    if (row.id.startsWith("hands.")) groups.hands.push(row);
    else if (row.id.startsWith("mcp.")) groups.servers.push(row);
    else groups.platform.push(row);
  }
  return groups;
}

/** 静态 id → 界面上那个名字（英文当 key，中文在 `i18n/settings.ts` 里） */
const LABELS: Record<string, string> = {
  "hands.files": "Files",
  "hands.shell": "Commands",
  "hands.web": "Web pages",
  "hands.screen": "Screen",
  "hands.input": "Keyboard and mouse",
  "hands.mcp": "MCP servers",
  "platform.llm": "Model access",
  "platform.audio": "Audio level",
  "platform.secrets": "Key store",
};

/**
 * 一行的标题。
 *
 * `mcp.<server>` 是动态的（用户自己起的名字），所以单独一条路 —— 拿它去查表会
 * 落空，然后把内部 id 原样显示出来。
 */
export function capabilityLabel(id: string): string {
  if (id.startsWith("mcp.")) return t("MCP: {name}", { name: id.slice(4) });
  const key = LABELS[id];
  return key ? t(key) : id;
}

/**
 * 一行"为什么不能用"。可用时返回 `null` —— 调用方据此决定要不要画那一行小字。
 *
 * 每个 `reason` 都必须有一句话（Rust 那边 `REASONS` 是封闭集合，两边一一对应）。
 * 认不出来的码给一句兜底的"不可用"，而不是空字符串：空白比一句笼统的话更让人
 * 无从下手 —— 至少那句话说明"这是平台自己也没料到的情况"。
 */
export function capabilityReasonText(row: CapabilityRow): string | null {
  if (row.available) return null;
  const detail = row.detail ?? "";
  switch (row.reason) {
    case "switched_off":
      return t("Switched off in Assistant settings");
    case "missing_command":
      return t("Missing command: {name}", { name: detail });
    case "not_configured":
      // 模型档那一条带的是缺哪一栏，不是"某个东西的名字"
      if (detail === "address") return t("The active model profile has no base URL");
      if (detail === "model") return t("The active model profile has no model name");
      return t("Not set up yet");
    case "no_key":
      return t("No API key for the current model");
    case "no_device":
      return t("No audio output device");
    case "bad_config":
      return t("This setting cannot work: {detail}", { detail });
    case "blocked":
      return t("Windows refused: {detail}", { detail });
    case "unreadable":
      return t("The key store cannot be opened: {detail}", { detail });
    default:
      return t("Not available");
  }
}

/** 几好几坏。设置导航上那个小圆点用它 */
export function tally(rows: readonly CapabilityRow[]): { ok: number; bad: number } {
  let bad = 0;
  for (const row of rows) if (!row.available) bad += 1;
  return { ok: rows.length - bad, bad };
}

/**
 * 时间戳 → `09:41`。
 *
 * 只到分钟：这份结果本来就是"启动时探的"，秒级精度会让人以为它是实时的。
 * 跨天的话补上日期 —— "最后检查 09:41" 在第二天早上读起来像是刚探过。
 */
export function stampOf(at: number, now = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === new Date(now).getFullYear() &&
    date.getMonth() === new Date(now).getMonth() &&
    date.getDate() === new Date(now).getDate();
  if (sameDay) return clock;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
