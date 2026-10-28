/**
 * 浮层的"自己关门"：Esc、点别处、窗口失焦、改尺寸、滚动。
 *
 * 从 `WidgetMenu` 里抽出来的。抽的理由不是"两个地方用了"（那叫过早抽象），
 * 是这两处**必须逐字一致**：右键菜单和搜索浮层都是"点别处就该消失"的东西，
 * 而"点在浮层自己身上不算点别处"这一条写错一次，就会变成"按钮还没收到 click
 * 就先关了"—— 那种 bug 在菜单上和在搜索结果上长得一模一样。
 *
 * `tests/widget-menu.tsx` 钉着那几条路，所以抽出来之后立刻能验它没被改坏。
 */

import { useEffect, type RefObject } from "react";

export interface OverlayDismissOptions {
  /**
   * 滚动要不要关。默认关。
   *
   * 右键菜单钉在**视口坐标**上，画布一滚它就和卡片分家了，关掉比跟着跑诚实。
   * 居中的搜索浮层相反：它不指向任何东西，背后的画布滚一下不该把它带走。
   */
  scroll?: boolean;
  /**
   * Esc 要不要关。默认关。
   *
   * 搜索浮层自己处理 Esc（先清空输入、再关），所以这里得让位 —— 两处都听
   * Esc 的话，按一下会同时"清空"和"关闭"，而用户只想要前者。
   */
  escape?: boolean;
}

export function useOverlayDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: OverlayDismissOptions = {},
) {
  const { scroll = true, escape = true } = options;

  useEffect(() => {
    const away = (event: Event) => {
      // 点在浮层自己身上不算"点别处"，否则按钮还没收到 click 就先关了
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    if (escape) window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    if (scroll) window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      if (escape) window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      if (scroll) window.removeEventListener("scroll", onClose, true);
    };
  }, [ref, onClose, scroll, escape]);
}
