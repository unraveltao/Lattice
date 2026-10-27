/**
 * 听写的 IPC 面 —— 面板那一颗麦克风按钮只跟这个文件说话。
 *
 * # 为什么这里没有第二个状态
 *
 * "现在是不是在听"只有一份，在 Rust 里（`dictation.rs` 的 `LIVE`）。这个文件
 * 只是**订阅者**：`listening` / `partial` / `done` / `error` 四条事件从
 * `lattice:dictation` 来，本地不推断、不缓存。面板和浮钮各推一份的话，症状是
 * "浮钮亮着、面板里没反应"（0027 §5 最后一行）。
 *
 * # 为什么结果不一次性返回
 *
 * `RecognizeAsync()` 要阻塞到用户说完（几秒），而"按停"要从另一边把那次阻塞
 * 打断。所以 `dictation_start` 只回"开麦了"，字从事件里来（0027 §4）。
 *
 * # 浏览器预览
 *
 * 没有 Rust 的时候（`hasRust() === false`）：`status` 回"不可用"、`start` 直接
 * reject。**不退回 localStorage、不假装能听** —— 麦克风不在浏览器里这件事，
 * 用户看见一句"要在桌面应用里用"比看见一个点不动的钮要好。
 */

import { listen } from "@tauri-apps/api/event";

import { t } from "../runtime/i18n";
import { callCommand, hasRust } from "./devLlm";

/** 结果事件的名字。Rust 侧 `dictation.rs::EVENT` 是同一个字面量 */
export const DICTATION_EVENT = "lattice:dictation";

/** 字交给谁：面板输入框，还是开听时那个前台窗口 */
export type DictationTarget = "panel" | "system";

export interface DictationStatus {
  /** 这台机器能不能听写（系统语音语言是中文，或者装了中文听写） */
  available: boolean;
  /** 会用的语言 tag（`zh-CN` / `zh-Hans` / ...） */
  language: string;
  /** 总开关。默认关，和 agent 端点同一条规矩 */
  enabled: boolean;
  /** 规范写法的热键字符串，比如 `Ctrl+Alt+Space` */
  hotkey: string;
  /** 热键注册失败的原因（被别的程序占了）。`null` = 没配或注册成功 */
  hotkeyError: string | null;
}

export interface DictationSettings {
  enabled: boolean;
  hotkey: string;
  /** 浮钮要不要显示 */
  show: boolean;
  /** 浮钮相对工作区右下角的偏移 */
  dx: number;
  dy: number;
}

export interface DictationEvent {
  phase: "listening" | "partial" | "done" | "error";
  target?: DictationTarget;
  /** 交回面板的字（`focus_changed` 时也会带） */
  text?: string;
  /** 机器可读的原因：`wrong_language` / `no_microphone` / `focus_changed` / `too_long` / `input_blocked` / `cancelled` */
  code?: string;
  /** 给人看的一句话 */
  error?: string;
  /** 已经打进别人窗口的字数 */
  chars?: number;
}

/** 这台机器能不能听写。浏览器预览里恒 `available: false` */
export async function dictationStatus(): Promise<DictationStatus> {
  if (!hasRust()) {
    return {
      available: false,
      language: "",
      enabled: false,
      hotkey: "",
      hotkeyError: null,
    };
  }
  return await callCommand<DictationStatus>("dictation_status");
}

/** 开麦。失败时 reject 的是**错误码字符串**（`wrong_language` / ...），文案在事件里 */
export async function dictationStart(target: DictationTarget): Promise<void> {
  await callCommand<void>("dictation_start", { target });
}

/** 按停 → 出整句 */
export async function dictationStop(): Promise<void> {
  await callCommand<void>("dictation_stop");
}

/** 取消（Esc）→ 一个字都不落 */
export async function dictationCancel(): Promise<void> {
  await callCommand<void>("dictation_cancel");
}

export async function dictationSettings(): Promise<DictationSettings> {
  return await callCommand<DictationSettings>("dictation_settings");
}

/**
 * 改设置。**每一项都可选**（给什么改什么）—— 浮钮的开关和位置也走这一条，
 * 不新增命令（0027 §4「落盘」）。
 */
export async function dictationSettingsSet(
  patch: Partial<DictationSettings>,
): Promise<DictationSettings> {
  return await callCommand<DictationSettings>("dictation_settings_set", { patch });
}

/**
 * 订阅结果事件。返回值是注销函数 —— 组件卸载时必须调，否则关掉面板之后
 * 每次听写都会往一个已经不存在的闭包里写字。
 */
export function onDictation(handler: (event: DictationEvent) => void): () => void {
  if (!hasRust()) return () => {};
  let stop: (() => void) | null = null;
  let cancelled = false;
  void listen<DictationEvent>(DICTATION_EVENT, (event) => {
    if (cancelled) return;
    handler(event.payload);
  })
    .then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => {
      // 注册不上只意味着"这一轮没有实时反馈"，不影响用户手动点
    });
  return () => {
    cancelled = true;
    stop?.();
    stop = null;
  };
}

/**
 * 打开 Windows 自己的语音设置页。
 *
 * `ms-settings:` **不在** `open_policy` 的白名单里（那条只放 http/https，见
 * 不变量 14），所以不能借 `open_external` —— 这里是平台自己要跳系统页面，
 * 走的是 Rust 侧那条专用命令。
 */
export async function openDictationSettingsPage(page: "speech" | "microphone"): Promise<void> {
  await callCommand<void>("dictation_open_settings", { page });
}

/**
 * 面板照着做的那几件事。**判据全在这里**：界面只负责按着改状态，所以
 * `tests/dictation.html` 能用纯函数把"出字追加、取消一个字不落、错误回 idle"
 * 这些行为钉住，不用去渲染 React。
 */
export interface DictationView {
  /** 现在在不在听 */
  listening: boolean;
  /** 要追加进输入框的字（`null` = 这次不追加） */
  append: string | null;
  /** 提示行那一句话（`null` = 清掉提示） */
  notice: string | null;
  /** 要不要把焦点拿回输入框（说完了，多半要按回车发出去） */
  focus: boolean;
}

export const IDLE_DICTATION: DictationView = {
  listening: false,
  append: null,
  notice: null,
  focus: false,
};

/**
 * 一条事件 → 面板该做什么。
 *
 * 三条不变量：
 * - `partial` **不往输入框写**（逐字上屏是输入法该干的事，0027 §8）；
 * - `cancel` 一个字都不落，但状态照样回 idle（0027 §5：任何分支都要回 idle）；
 * - `focus_changed` 的文本**进输入框**而不是被丢掉 —— 用户切了窗口不代表那句话白说了。
 */
export function reduceDictation(view: DictationView, event: DictationEvent): DictationView {
  if (event.phase === "listening") {
    return { listening: true, append: null, notice: null, focus: false };
  }
  if (event.phase === "partial") return view;
  if (event.phase === "error") {
    return {
      listening: false,
      append: null,
      notice: event.error ?? event.code ?? null,
      focus: false,
    };
  }
  // done
  if (event.text) {
    return {
      listening: false,
      append: event.text,
      notice:
        event.code === "focus_changed"
          ? t("That window is gone — the text is in the box below")
          : null,
      focus: true,
    };
  }
  if (event.chars) {
    return {
      listening: false,
      append: null,
      notice: t("Typed {count} characters into the window you were in", { count: event.chars }),
      focus: false,
    };
  }
  if (event.code === "cancelled") {
    return { listening: false, append: null, notice: null, focus: false };
  }
  // 空文本 = 没听到。状态已经回 idle，这里只留一句话
  return { listening: false, append: null, notice: t("I did not hear anything"), focus: false };
}
