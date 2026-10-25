/**
 * 组件**作者写的**文案：一门，还是两门。
 *
 * # 为什么这类文字不走 `i18n/*` 那套表
 *
 * `t()` 那张表是**平台自己的字**（按钮、标题、提示），英文原句当 key，缺翻译
 * 退化成英文。组件名、说明、配置项标签、怎么用正文不是平台的 —— 它们是作者
 * 写的，跟着包走、跟着签名走。把它们塞进平台的表，等于要求平台认识每一个
 * 第三方组件的每一句话，那既做不到也不该做。
 *
 * # 那怎么让它们也是双语
 *
 * 作者在清单里直接给出两门写法，平台按当前语言挑一份：
 *
 * ```json
 * { "name": "大肥鱼", "description": { "zh": "一只住在桌面上…", "en": "A round blue whale…" } }
 * ```
 *
 * 三条边界：
 *
 * - **字符串仍然有效**，而且永远有效。只写一门（通常中文）的组件照旧能用，
 *   英文界面上看到的就是那句话本身 —— 这和 `t()` 缺翻译时退化成英文是同一个
 *   取舍：漏一门的代价是"这句还是原文"，不是空白。
 * - **写坏一门只丢那一门**。`{ "zh": 42 }` 里 `zh` 不合法就只当没写，`en` 还在。
 *   两门都不合法才等于没写。
 * - **上限按门算**。`help` 的一条正文限制 160 字符，是"这一门读到的人要能一眼
 *   扫完"，不是"两门加起来 160"。
 *
 * 短文案（组件名、配置项标签）不截断；长文案由调用方给 `limit`，超了补省略号
 * —— 断在半截的句子比截断更难读。
 */

import { useCallback } from "react";
import { lang, useLang, type Lang } from "./i18n";

/** 两门语言的代码。**只有这两门**：界面就这两门，多写的键在归一化时被丢掉 */
export const TEXT_LANGS: readonly Lang[] = ["zh", "en"] as const;

/**
 * 作者文案：一门写成一个字符串，两门写成 `{ zh, en }`。
 *
 * 两门都缺（或都写坏）时归一化成空串，所以调用方只需要判 `!value`，
 * 不用分别判"没写"和"写了但是空的"。
 */
export type LocalizedText = string | { zh?: string; en?: string };

/** 归一化一条作者文案。`limit` 是**每一门**的字符上限，0 表示不截断 */
export function normalizeText(raw: unknown, limit = 0): LocalizedText {
  if (typeof raw === "string") return clean(raw, limit);
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) return "";

  const out: { zh?: string; en?: string } = {};
  for (const code of TEXT_LANGS) {
    const value = clean(record[code], limit);
    if (value) out[code] = value;
  }
  return out.zh || out.en ? out : "";
}

/**
 * 取当前语言那一份。
 *
 * 缺这门时退到另一门 —— **不是**退到空串：只写了中文的第三方组件在英文界面上
 * 应该显示那句中文（作者没提供英文，但信息还在），而不是变成一个没有名字的卡片。
 */
export function pickText(value: LocalizedText | undefined, language: Lang = lang()): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const own = value[language];
  if (own) return own;
  return (language === "zh" ? value.en : value.zh) ?? "";
}

/** 组件里用这个：语言一变就重渲染（`useLang` 订阅的就是那件事） */
export function useText(): (value: LocalizedText | undefined) => string {
  const language = useLang();
  return useCallback((value: LocalizedText | undefined) => pickText(value, language), [language]);
}

/**
 * 所有语言的写法，给搜索用。
 *
 * 搜索框里打英文要能搜到只写了中文的组件、反过来也一样 —— 用户不记得自己
 * 当初看到的是哪一门，只记得那个词。
 *
 * 空的和全空白的都不进索引：它们搜不到任何东西，只会让命中判定多一次白跑。
 */
export function textVariants(value: LocalizedText | undefined): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return TEXT_LANGS.map((code) => (value[code] ?? "").trim()).filter(Boolean);
}

/** 去首尾空白、把连续空白收成一个空格，超长时留一个省略号 */
function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * 只该有一门的短文本（变更记录的日期、配置项的单位）。
 *
 * 这些是**语言无关**的标签，翻译它们只会让人看不懂 —— 但作者顺手写成两门也
 * 不该被丢掉，所以取第一门非空的。空白与截断规则和别的文案同一份实现。
 */
export function normalizeLine(raw: unknown, limit = 0): string {
  if (typeof raw === "string") return clean(raw, limit);
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) return "";
  for (const code of TEXT_LANGS) {
    const value = clean(record[code], limit);
    if (value) return value;
  }
  return "";
}
