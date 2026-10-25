/**
 * 界面文案的双语表 —— 中文 / English 一份开关。
 *
 * # 为什么 key 就是那句话本身
 *
 * `t("Snap to grid")`。英文原文当 key（gettext 的老办法），理由三条：
 *
 * 1. **缺翻译时退化成英文，而不是露出 `settings.snap` 这种键**。这张表是会
 *    边写边漏的 —— 漏一条的代价应该是"这句还是英文"，不是"界面上出现一串
 *    点分命名"。
 * 2. **改文案不用同步改两个地方**。`settings.snap` 这种键和它对应的那句
 *    "Align to 8px grid" 之间没有约束：改了句子忘了改键、或者键名和句子各说
 *    各的，都不会报错。原话当键就没这个问题。
 * 3. **grep 得到**。想知道某句在哪儿被用到，直接搜那句话（中文也一样，中文
 *    那句在表里，一眼能搜到）。
 *
 * 代价是表里只能存"中文"，英文就是代码里那句 —— 所以**英文必须写好**，
 * 它就是 en 这一门的成品。这一条写进 AGENTS.md 的配方里了。
 *
 * # 怎么用
 *
 * ```tsx
 * const t = useT();            // 组件里：语言一变就重渲染
 * <span>{t("Snap to grid")}</span>
 * <span>{t("Install v{version}", { version })}</span>
 * ```
 *
 * 非组件的模块（`platform/assistant.ts` 那种）直接用 `t(...)` —— 它在**调用
 * 那一刻**看当前语言，所以语言切了以后再调就是新的。
 */

import { useCallback, useSyncExternalStore } from "react";

import { ASSISTANT_ZH } from "./i18n/assistant";
import { COMMON_ZH } from "./i18n/common";
import { LIBRARY_ZH } from "./i18n/library";
import { MISC_ZH } from "./i18n/misc";
import { PANELS_ZH } from "./i18n/panels";
import { SETTINGS_ZH } from "./i18n/settings";
import { SHELL_ZH } from "./i18n/shell";

export type Lang = "zh" | "en";

/**
 * 设置里存的那一档。`system` = 跟 Windows 走（`navigator.language`）。
 *
 * 存的是"偏好"而不是"结果"：用户选了"跟随系统"，下次开机换了系统语言，
 * 界面就该跟着换 —— 存结果的话那天不会变。
 */
export type LangPref = "system" | Lang;

/**
 * 中文表的**分片**。分成七个文件只为了好改：谁动哪一块就只碰那一块，
 * 两份改动不会在同一行上打架。合并顺序无关紧要 —— `tests/i18n.html` 会查
 * 同一句在两处给了不同译法的情况，那才是真正的错。
 */
export const ZH_TABLES: Record<string, Record<string, string>> = {
  common: COMMON_ZH,
  shell: SHELL_ZH,
  library: LIBRARY_ZH,
  panels: PANELS_ZH,
  settings: SETTINGS_ZH,
  assistant: ASSISTANT_ZH,
  misc: MISC_ZH,
};

/** 中文表。英文表是空的：英文原文就是 key，直接用它自己 */
const TABLES: Record<Lang, Record<string, string>> = {
  en: {},
  zh: { ...COMMON_ZH, ...SHELL_ZH, ...LIBRARY_ZH, ...PANELS_ZH, ...SETTINGS_ZH, ...ASSISTANT_ZH, ...MISC_ZH },
};

/** 系统语言。拿不到（SSR / 老引擎）就当英文 */
function systemLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  const tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag) continue;
    // zh / zh-CN / zh-Hans-CN / zh-TW 都算中文
    return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "en";
}

export function resolveLang(pref: LangPref): Lang {
  return pref === "system" ? systemLang() : pref;
}

let currentPref: LangPref = "system";
let current: Lang = systemLang();
const listeners = new Set<() => void>();

/** 当前生效的界面语言 */
export function lang(): Lang {
  return current;
}

/** 当前存的那一档（设置界面拿它画选中态） */
export function langPref(): LangPref {
  return currentPref;
}

/** 当前语言的 BCP-47 标签：日期、数字、排序用它 */
export function locale(): string {
  return current === "zh" ? "zh-CN" : "en-US";
}

function announce(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  }
  for (const listener of listeners) listener();
}

export function setLanguage(pref: LangPref): void {
  const next = resolveLang(pref);
  const prefChanged = pref !== currentPref;
  const changed = next !== current;
  currentPref = pref;
  current = next;
  /*
   * 偏好变了也要通知。`zh` 和 `system`（系统正好是中文）解析出来是同一个
   * 语言 —— 这时界面上一句话都不变，但设置里那颗"跟随系统"得亮起来。
   * 只按"语言变了"通知的话，点了没反应，用户会以为点失败了。
   */
  if (changed || prefChanged) announce();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 组件里订阅语言变化；非组件代码用 `t()` 就行 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, lang, lang);
}

/**
 * 取一句话的当前语言版本。
 *
 * `{name}` 是插值：两个值都在表里，替换发生在取词之后 —— 这样中文可以把
 * 变量放在句子中间（"把 {name} 收起来"），英文可以放别的顺序。
 */
export function translate(text: string, vars?: Record<string, string | number>, language: Lang = current): string {
  let out = TABLES[language][text] ?? text;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}

/** 非组件代码用这个；组件里请用 `useT()`，否则语言切了它不会重渲染 */
export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(text, vars);
}

export function useT(): (text: string, vars?: Record<string, string | number>) => string {
  const language = useLang();
  return useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(text, vars, language),
    [language],
  );
}

/**
 * 注册"系统语言变了"的监听（只有偏好是 `system` 时才有意义）。
 *
 * 返回一个取消函数。`App` 挂一次就够 —— 这是**整个平台**的语言来源，
 * 别在组件里各挂一份。
 */
export function watchSystemLanguage(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  // `navigator.languages` 变了不会发事件，但"中文/英文"这个二分会跟着
  // `prefers-color-scheme` 同类的东西变 —— 这里挂 `languagechange`，
  // 引擎支持就收，不支持就只在启动时算一次（可接受）。
  const onChange = () => {
    if (currentPref !== "system") return;
    const next = systemLang();
    if (next === current) return;
    current = next;
    announce();
  };
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}
