/**
 * 棂 / Lattice —— 组件的"怎么用"与"改了什么"
 *
 * # 为什么写在清单里，而不是一份 Markdown
 *
 * 组件是纯静态目录，平台零依赖、不引 Markdown 渲染器。更要紧的是**跟着包走**：
 * 写在包外的东西一定会和代码脱节，而脱节的说明比没有说明更糟 —— 用户照着它
 * 做，得到的是另一个结果。写进 `manifest.json` 之后，它和代码在同一个目录、
 * 同一次提交、同一个签名里，想漂也漂不开。
 *
 * 代价是只能写"小标题 + 若干条短句"，写不了长文。这个限制是对的：卡片只有
 * 240×140，属性面板 320px 宽，"怎么用"该是一眼能扫完的东西，不是手册。
 * 真需要长篇的组件，说明也不该挤在属性面板里。
 *
 * # 写坏了怎么办
 *
 * 和 `config` / 图标同一条规矩：**丢那一条，不丢整包**。说明是锦上添花，
 * 不该因为作者多打一个逗号就让组件装不上。丢掉的部分界面上直接不显示，
 * 组件照常能用。
 *
 * # 上限是刻意的
 *
 * 6 节 × 6 条 × 160 字符；变更记录 12 条 × 8 项。超了就截断。
 * 没有上限的话，这个字段会变成"作者把 README 塞进来"的地方，而没人会在
 * 一个 320px 的面板里读 README。
 */

import { isValidVersion } from "./semver";
import { normalizeLine, normalizeText, type LocalizedText } from "./widget-text";

/**
 * 说明里的一节，例如 "Priorities"。
 *
 * 文案类型是 `LocalizedText`：作者可以只写一门（字符串），也可以写成
 * `{ zh, en }` 让平台按界面语言挑 —— 规则见 `runtime/widget-text.ts`。
 */
export interface HelpSection {
  title: LocalizedText;
  items: LocalizedText[];
}

export interface WidgetHelp {
  /** 空数组 = 这个组件没写说明 */
  sections: HelpSection[];
}

/** 一条变更记录。`date` 可以空着 —— 有些版本就是没记日子 */
export interface ChangelogEntry {
  version: string;
  /** 语言无关的标签（`2026-10` / `Oct 2026`），不翻 */
  date: string;
  changes: LocalizedText[];
}

export const MAX_HELP_SECTIONS = 6;
export const MAX_HELP_ITEMS = 6;
export const MAX_HELP_ITEM_CHARS = 160;
export const MAX_HELP_TITLE_CHARS = 40;
export const MAX_CHANGELOG_ENTRIES = 12;
export const MAX_CHANGELOG_CHANGES = 8;
const MAX_CHANGELOG_CHANGE_CHARS = 160;

const EMPTY_HELP: WidgetHelp = { sections: [] };

/** 这个组件有没有可显示的说明 */
export function hasHelp(help: WidgetHelp): boolean {
  return help.sections.length > 0;
}

/**
 * 归一化 `help`。
 *
 * 只认 `{ sections: [{ title, items: [] }] }` 这一种形状。`items` 里非字符串
 * 的条目直接跳过 —— 宁可少一行，也不要往界面上塞 `[object Object]`。
 */
export function normalizeHelp(raw: unknown): WidgetHelp {
  if (!raw || typeof raw !== "object") return EMPTY_HELP;
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.sections)) return EMPTY_HELP;

  const sections: HelpSection[] = [];
  for (const item of input.sections) {
    if (sections.length >= MAX_HELP_SECTIONS) break;
    if (!item || typeof item !== "object") continue;
    const section = item as Record<string, unknown>;
    const title = normalizeText(section.title, MAX_HELP_TITLE_CHARS);
    if (!title) continue;
    if (!Array.isArray(section.items)) continue;

    const lines: LocalizedText[] = [];
    for (const line of section.items) {
      if (lines.length >= MAX_HELP_ITEMS) break;
      // `normalizeText` 两门都不合法时返回 ""，所以这里一句就够，不用再判空串
      const text = normalizeText(line, MAX_HELP_ITEM_CHARS);
      if (text) lines.push(text);
    }
    // 有标题没内容的一节不画：它会变成一个点开什么都没的折叠条
    if (lines.length === 0) continue;
    sections.push({ title, items: lines });
  }
  return { sections };
}

/**
 * 归一化 `changelog`。
 *
 * 版本号必须能解析（`isValidVersion`），否则这一条丢掉 —— 变更记录的作用是
 * "对照版本看改了什么"，版本号写错的那条既对不上也读不懂。
 *
 * **不排序**：作者写的顺序就是他希望被读的顺序（通常新的在前）。这里按原样
 * 保留，免得"我明明写在最前面"变成第 5 条。
 */
export function normalizeChangelog(raw: unknown): ChangelogEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: ChangelogEntry[] = [];
  for (const item of raw) {
    if (entries.length >= MAX_CHANGELOG_ENTRIES) break;
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const version = typeof entry.version === "string" ? entry.version.trim() : "";
    if (!isValidVersion(version)) continue;
    if (!Array.isArray(entry.changes)) continue;

    const changes: LocalizedText[] = [];
    for (const line of entry.changes) {
      if (changes.length >= MAX_CHANGELOG_CHANGES) break;
      const text = normalizeText(line, MAX_CHANGELOG_CHANGE_CHARS);
      if (text) changes.push(text);
    }
    if (changes.length === 0) continue;

    entries.push({
      version,
      // 日期只当标签用，不做严格校验：写 `2026-10` 或 `Oct 2026` 都不该让整条消失
      date: normalizeLine(entry.date, 24),
      changes,
    });
  }
  return entries;
}
