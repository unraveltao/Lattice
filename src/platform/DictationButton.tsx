/**
 * 顶栏那颗麦克风 —— 听写的**第四个入口**（0027 §4）。
 *
 * # 它为什么在顶栏，不在组件里
 *
 * 组件够不到麦克风：没有 `speech` 权限，桥的方法表里也搜不到 `dictation`
 * （这条是 `tests/dictation.html` 钉着的断言）。听写是平台自己的一份能力，
 * 所以它的入口也活在平台这一层：**面板里一颗、顶栏一颗、桌面上一颗浮钮、
 * 一个全局热键** —— 四个入口同一套引擎、同一份状态。
 *
 * 顶栏这颗的用处是"我正在这个窗口里打字"：光标停在搜索框、组件配置、
 * 设置项里，按下它，说出来的字就落进那个框（`target: "system"` 打给前台窗口，
 * 而前台窗口此刻就是这个窗口）。
 *
 * # 顶栏和浮钮的分工
 *
 * - 手在键盘上、人不在这个窗口 → 全局热键；
 * - 人在桌面、想对别的应用说 → 浮钮（它点了不抢焦点）；
 * - 人已经在这个窗口里、光标在某个框里 → 这颗。
 *
 * # 说错了怎么办
 *
 * 不自己做撤销（0027 §8）：字是打进目标应用的，`Ctrl+Z` 的粒度归它。
 * 唯一要兜的是"刚才那个窗口没了" —— 那时 Rust 把整句交回来，这里连同
 * "复制"一起冒一条提示，**不让一句话凭空消失**。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../runtime/i18n";
import {
  dictationReasonText,
  dictationStart,
  dictationStatus,
  dictationStop,
  dictationTooltip,
  IDLE_DICTATION,
  onDictation,
  openDictationSettingsPage,
  reduceDictation,
  type DictationStatus,
  type DictationView,
} from "./dictation";
import { Glyph, ICON } from "./icons";

/** 提示挂多久。6 秒够读完一句"已经往刚才那个窗口打了 42 个字" */
const TOAST_MS = 6000;

export function DictationButton() {
  const t = useT();
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [view, setView] = useState<DictationView>(IDLE_DICTATION);
  /** 事件里的状态给按钮读，不给闭包读：订阅只装一次 */
  const viewRef = useRef<DictationView>(IDLE_DICTATION);

  const [toast, setToast] = useState<string | null>(null);
  /** 交回来的整句话（面板没开时至少能复制走） */
  const [returned, setReturned] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const say = useCallback((text: string | null, copyable: string | null) => {
    setToast(text);
    setReturned(copyable);
    setCopied(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (text) {
      timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  /**
   * 能不能听写。窗口重新获得焦点时也读一次 —— 用户很可能是刚去设置里
   * 装完语音语言回来，那时候这颗按钮得自己亮起来。
   */
  useEffect(() => {
    let alive = true;
    const load = () => {
      void dictationStatus()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, []);

  useEffect(() => {
    return onDictation((event) => {
      const next = reduceDictation(viewRef.current, event);
      viewRef.current = next;
      setView(next);
      if (next.notice) {
        say(next.notice, next.append);
        return;
      }
      if (next.append) {
        // 没有提示但有字 = 正常交回面板（浮钮那条也会走到这里）
        say(t("That window is gone — the text is in the box below"), next.append);
        return;
      }
      // 开始听、或者"已输入 N 字"：都已经在提示里了，这里只管把旧提示收掉
      if (next.listening) say(null, null);
    });
  }, [say, t]);

  const toggle = useCallback(async () => {
    if (!status) return;
    if (!status.available) {
      // 灰着的时候点它 = "我想用，但不知道差什么"：直接把系统语音设置打开
      void openDictationSettingsPage("speech").catch(() => {});
      return;
    }
    try {
      if (viewRef.current.listening) await dictationStop();
      else await dictationStart("system");
    } catch {
      // 失败原因走事件（面板/浮钮那两条已经把它们变成提示），这里不再重复
    }
  }, [status]);

  const copy = useCallback(async () => {
    if (!returned) return;
    try {
      await navigator.clipboard.writeText(returned);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [returned]);

  const hint = dictationTooltip(status, view.listening);
  const title =
    hint === "unavailable"
      ? (dictationReasonText(status) ?? t("Dictation is not available"))
      : hint === "listening"
        ? t("Stop dictation")
        : hint === "ready"
          ? t("Dictation — speak into the field you are in")
          : t("Dictation");

  return (
    <>
      <button
        type="button"
        className={`lattice-icon-btn is-large${view.listening ? " is-active" : ""}`}
        data-dictation={hint}
        onClick={() => void toggle()}
        title={title}
        aria-label={title}
        aria-pressed={view.listening}
      >
        <Glyph d={ICON.mic} />
      </button>

      {toast && (
        <div className="lattice-dictation-toast" role="status">
          <span className="lattice-dictation-toast-text">{toast}</span>
          {returned && (
            <button type="button" onClick={() => void copy()}>
              {copied ? t("Copied") : t("Copy the text")}
            </button>
          )}
          <button
            type="button"
            className="lattice-dictation-toast-close"
            aria-label={t("Dismiss")}
            onClick={() => say(null, null)}
          >
            <Glyph d={ICON.close} size={12} />
          </button>
        </div>
      )}
    </>
  );
}
