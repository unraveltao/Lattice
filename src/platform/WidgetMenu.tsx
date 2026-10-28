/**
 * 棂 / Lattice —— 卡片的右键菜单
 *
 * # 为什么「移除一份」搬到这里
 *
 * 它只对**这一份**成立，而右键点在哪张卡上，指向已经说清楚了 —— 不用先选中、
 * 再去右边那列里找按钮。属性检查器里那颗 `Remove` 因此搬了过来：同一个动作
 * 只留一个入口，才不会出现"面板里删过一次、菜单里又删一次"。
 *
 * 顺带补掉一个死胡同：**组件没装 / 找不到**的那张 `is-broken` 卡原来没有任何
 * 移除入口 —— 它没有清单，属性检查器根本打不开，只能去改 `state.json`。
 *
 * # 菜单里有什么（2026-10-27）
 *
 *   组件名            只读的一行，"对谁动手"的唯一凭据
 *   ─────
 *   提到最上层 / 沉到桌面层   一行**切换**，标签跟着当前层级翻
 *   复制一份                  挪一格摆第二份（几何 / 层级 / 配置都跟着原件），选中跟着新的那份
 *   ─────
 *   移除                      红的那一行，沉底
 *
 * 层级只放**一行**而不是两行：卡片标题条上那个 chip 已经写着现在在哪一层
 * （`Desktop` / `On top`），菜单再摆两行、把不适用的一条灰掉，等于让用户先读
 * 三个状态才敢点。一行的标签本身就是答案 —— 写着"提到最上层"，说明它现在在
 * 下面。
 *
 * 危险项沉底 + 一条分隔线：菜单里第一次有了"不危险"的动作，Remove 就不该再
 * 和它们挤在一起。
 *
 * # 只管卡片自己的框，不管组件内容
 *
 * 菜单挂在外层卡片上（标题条 / 边框 / 报错条 / 静态卡）。iframe 里面那一层
 * **不接管**：组件的右键是组件自己的（桌宠就是靠右键关窗，见 `widgetHost.ts`），
 * 平台抢过来等于把它唯一的退出方式弄没。所以右键组件内容弹的仍然是 WebView
 * 自己那个菜单 —— 那不是这一层能改的事，也别试着改。
 *
 * # 菜单自己关门
 *
 * Esc、点别处、窗口失焦、滚动、改尺寸，任意一件都关 —— 那一套在
 * `useOverlayDismiss` 里，和搜索浮层共用（两条"点别处就消失"的规矩必须逐字
 * 一致，写岔一次就是"按钮还没收到 click 就先关了"）。开之前不量尺寸（量不到），
 * 开之后 `useLayoutEffect` 里量一次再夹回窗口内 —— 右下角那一份的菜单不许被
 * 窗口边缘切掉一半。
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../runtime/i18n";
import { Glyph, ICON, WidgetIconMark } from "./icons";
import { useLattice } from "./store";
import { useOverlayDismiss } from "./useOverlayDismiss";

export interface WidgetMenuTarget {
  instanceId: string;
  /** 已经按当前语言取过一份的组件名（`useText` 那边取的） */
  name: string;
  iconUrl?: string | null;
  /** 右键那一下的视口坐标 */
  x: number;
  y: number;
}

/** 离窗口边缘留多少。8 是这套界面里浮层之间的惯用缝 */
const EDGE = 8;

export function WidgetMenu({ target, onClose }: { target: WidgetMenuTarget; onClose: () => void }) {
  const t = useT();
  const removePlacement = useLattice((state) => state.removePlacement);
  const updatePlacement = useLattice((state) => state.updatePlacement);
  const duplicatePlacement = useLattice((state) => state.duplicatePlacement);
  /*
   * 动作读**现在的**那一份，不用 `target` 里带过来的快照：菜单开着的时候
   * 层级可能被别处改掉（属性面板、桌面窗口同步），照着快照改会把人家刚做的
   * 改动盖回去。`find` 拿到的还是数组里那个对象，引用稳定，不会白重渲染。
   */
  const placement = useLattice((state) =>
    state.placements.find((item) => item.instanceId === target.instanceId),
  );
  const onTop = placement?.layer === "top";
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: target.x, top: target.y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setAt({
      left: Math.max(EDGE, Math.min(target.x, window.innerWidth - rect.width - EDGE)),
      top: Math.max(EDGE, Math.min(target.y, window.innerHeight - rect.height - EDGE)),
    });
    element.focus({ preventScroll: true });
  }, [target.x, target.y]);

  /*
   * 关门那一套在 `useOverlayDismiss` 里，和搜索浮层共用一份 —— 两条"点别处
   * 就消失"的规矩必须逐字一致。`scroll` 保持默认的"要关"：菜单钉在视口坐标
   * 上，画布一滚它就和卡片分家了，关掉比跟着跑诚实。
   */
  useOverlayDismiss(ref, onClose);

  return createPortal(
    <div
      ref={ref}
      className="lattice-menu is-cursor"
      style={{ left: at.left, top: at.top }}
      role="menu"
      aria-label={target.name}
      tabIndex={-1}
    >
      {/* 第一行是"对谁动手"，不可点。菜单里只有一件会真的动东西的事时，
          这一行是"我没点错那一份"的唯一凭据 */}
      <div className="lattice-menu-row is-static">
        {target.iconUrl && <WidgetIconMark url={target.iconUrl} size={12} />}
        <span className="lattice-menu-label">{target.name}</span>
      </div>

      <div className="lattice-menu-divider" />

      {/* 一行切换：标签说的是"点下去会变成什么"，不是"现在是什么" */}
      <button
        type="button"
        role="menuitem"
        className="lattice-menu-row"
        disabled={!placement}
        onClick={() => {
          updatePlacement(target.instanceId, { layer: onTop ? "desktop" : "top" });
          onClose();
        }}
      >
        <Glyph d={onTop ? ICON.down : ICON.up} />
        <span className="lattice-menu-label">{onTop ? t("Send to back") : t("Bring to top")}</span>
      </button>

      {/*
        复制一份：几何、层级、**每实例配置**都跟着原件，位置挪一格，选中跟着
        **新的**那一份走 —— `duplicatePlacement` 本来就是这个规矩（从库里拖
        一份出来也选中新的），复制完接着挪它是最顺的下一步；跟着原件反而要多
        点一次。

        这里不自己拼 placement 再 `addPlacement`：那样只搬一半，复制出来那份
        设置会悄悄回到出厂值。判据在 store 那边（`configs` 和摆放一起搬）。
      */}
      <button
        type="button"
        role="menuitem"
        className="lattice-menu-row"
        disabled={!placement}
        onClick={() => {
          duplicatePlacement(target.instanceId);
          onClose();
        }}
      >
        <Glyph d={ICON.copy} />
        <span className="lattice-menu-label">{t("Duplicate")}</span>
      </button>

      <div className="lattice-menu-divider" />

      <button
        type="button"
        role="menuitem"
        className="lattice-menu-row is-danger"
        onClick={() => {
          // 没有二次确认：`removePlacement` 留了 8 秒撤销条，那比弹窗更省事，
          // 也不会让"删一份"变成两次点击
          removePlacement(target.instanceId);
          onClose();
        }}
      >
        <Glyph d={ICON.trash} />
        <span className="lattice-menu-label">{t("Remove")}</span>
      </button>

      {/* 一行就够：菜单里放三行小字，等于把"这是菜单"变成"这是说明"。
          要说的只有一件用户会误读的事 —— 删的是这一份，不是这个组件 */}
      <div className="lattice-menu-hint">{t("Stays in your library.")}</div>
    </div>,
    document.body,
  );
}
