/**
 * 棂 / Lattice —— 画布总览（只读）
 *
 * 「退后一步看全」：把画布上所有摆放按真实位置缩成一张缩略图，左边一栏按
 * **层级**分组列出来。装到十几个组件、卡片互相压着的时候，"我到底摆了些什么"
 * 在画布上已经看不出来了 —— 那正是这一层存在的理由。
 *
 * # 只读，这是产品定义
 *
 * 这里**不能拖、不能缩、不能删**，点了只做一件事：选中那一份、关掉总览、回到
 * 画布上那张卡。理由不是"实现省事"：
 *
 *   - 缩略图里拖一张卡，1px 的手抖等于 8px 的真实位移（缩放比是倒数关系），
 *     而 `state.json` 立刻落盘。手滑一次，用户精心摆的布局就歪了。
 *   - 一旦能编辑，它就得回答"为什么这里能改、画布上也能改"，而两边的吸附、
 *     参考线、层级顺序全得再来一遍 —— 那是第二个画布，不是总览。
 *
 * 所以这里**不 `bringToFront`、不写 store**（选中除外，那是一次点击的本来意思）。
 *
 * # 缩略图不是 iframe
 *
 * 每张卡都是静态方块（图标 + 名字 + 尺寸），不是活着的组件：二十个 iframe
 * 同时跑起来是二十份定时器、二十次首屏、几百兆内存 —— 而总览的全部用途就是
 * "看形状和位置"。要看内容，点一下回画布。
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useLattice } from "./store";
import { Glyph, ICON, WidgetIconMark } from "./icons";
import { LibSection } from "./LibSection";
import { useOverlayDismiss } from "./useOverlayDismiss";
import {
  filterByLayer,
  fitOffset,
  fitScale,
  layerCounts,
  layerGroups,
  overviewBounds,
} from "../runtime/overview";
import { WINDOW_LAYERS, type WindowLayer } from "../runtime/layer";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import type { WidgetRecord } from "../runtime/registry";
import type { Placement } from "./store";

/** 层级在总览里的叫法。三条都是现成的 key（`chrome-state.ts` 那颗按钮的 aria） */
const LAYER_LABEL: Record<WindowLayer, string> = {
  top: "On top layer",
  normal: "Normal window layer",
  desktop: "Desktop layer",
};

export interface OverviewPanelProps {
  records: Map<string, WidgetRecord>;
  installedIds: Set<string>;
  /** 点了一张卡 / 一栏里的一行：选中它，回画布 */
  onPick: (instanceId: string) => void;
  onClose: () => void;
}

export function OverviewPanel({ records, installedIds, onPick, onClose }: OverviewPanelProps) {
  const t = useT();
  const text = useText();
  const placements = useLattice((state) => state.placements);
  /*
   * ref 挂在背景上，理由和搜索浮层一样：这一层铺满视口，"点别处"根本到不了，
   * 关门由背景自己的 `onPointerDown` 负责。差别是总览没有输入框，所以 Esc
   * 交给 `useOverlayDismiss` 默认那一条（不用自己再写一遍）。
   */
  const backdropRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useOverlayDismiss(backdropRef, onClose);

  /** 只看某一层。`null` = 全部 */
  const [layer, setLayer] = useState<WindowLayer | null>(null);
  /** stage 量出来的尺寸。0 表示还没量到 —— 那时不画缩略图，免得先闪一下错的缩放 */
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  /*
   * 量一次就够：窗口一改尺寸，`useOverlayDismiss` 就把总览关了（和右键菜单
   * 同一个判据）—— 所以这里不用 `ResizeObserver`，也就没有"量到一半又变"的事。
   * `useLayoutEffect` 而不是 `useEffect`：要在第一帧画出来之前拿到尺寸，否则
   * 缩略图会先按 `w:0` 画一遍再跳。
   */
  useLayoutEffect(() => {
    const box = stageRef.current?.getBoundingClientRect();
    if (box) setViewport({ w: box.width, h: box.height });
  }, []);

  const bounds = useMemo(() => overviewBounds(placements), [placements]);
  const counts = useMemo(() => layerCounts(placements), [placements]);
  const groups = useMemo(() => layerGroups(placements), [placements]);
  const shown = useMemo(() => filterByLayer(placements, layer), [placements, layer]);

  const scale = fitScale(bounds, viewport);
  const offset = fitOffset(bounds, viewport, scale);
  const ready = viewport.w > 0 && viewport.h > 0 && bounds !== null;

  /*
   * 缩放比小到一定程度就**不画名字**。名字要看清得把字号按 `1/scale` 放大
   * （见下面 `labelSize`），缩到 0.3 时字要放大三倍多，一张 240 宽的卡只剩
   * 72 屏幕像素 —— 名字会挤出卡片。那时缩略图只负责"形状和位置"，名字在
   * 左边那栏里，一栏一个，比挤在方块里清楚。
   */
  const showNames = scale >= 0.35;
  /** 缩略图里的字号（平面坐标系）。除以 scale 之后屏幕上正好 11px */
  const labelSize = Math.round(11 / scale);

  const cardOf = (placement: Placement) => {
    const record = records.get(placement.widgetId);
    const live = record && installedIds.has(record.manifest.id);
    const name = record ? text(record.manifest.name) : placement.widgetId;
    return (
      <button
        key={placement.instanceId}
        type="button"
        className={`lattice-overview-card${live ? "" : " is-broken"}`}
        style={{
          left: placement.x - (bounds?.x ?? 0),
          top: placement.y - (bounds?.y ?? 0),
          width: placement.w,
          height: placement.h,
        }}
        onClick={() => onPick(placement.instanceId)}
        title={`${name} · ${placement.w}×${placement.h} · ${t(LAYER_LABEL[placement.layer])}`}
        data-instance-id={placement.instanceId}
      >
        {record?.iconUrl ? (
          <WidgetIconMark url={record.iconUrl} size={showNames ? 16 : 22} />
        ) : (
          <span className="lattice-overview-initial" style={{ fontSize: showNames ? 14 : 20 }}>
            {name.slice(0, 1)}
          </span>
        )}
        {showNames && (
          <span className="lattice-overview-name" style={{ fontSize: labelSize }}>
            {live ? name : t("Widget missing")}
          </span>
        )}
      </button>
    );
  };

  return createPortal(
    <div className="lattice-overview-backdrop" ref={backdropRef} onPointerDown={onClose}>
      <div
        className="lattice-overview"
        role="dialog"
        aria-modal="true"
        aria-label={t("Overview")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="lattice-overview-head">
          <h2 className="lattice-overview-title">{t("Overview")}</h2>
          <span className="lattice-overview-sub">
            {placements.length === 0
              ? t("Nothing on the canvas yet")
              : `${t("{count} on the canvas", { count: placements.length })} · ${Math.round(scale * 100)}%`}
          </span>

          {/*
            筛选：只看某一层。**只改显示不改布局** —— 筛掉置顶层之后剩下的卡不
            重新排，因为"置顶那几张压在哪里"正是用户想看的东西（见
            `runtime/overview.ts::filterByLayer`）。
          */}
          <div className="lattice-overview-chips" role="group" aria-label={t("Filter by layer")}>
            <button
              type="button"
              className={`lattice-overview-chip${layer === null ? " is-active" : ""}`}
              aria-pressed={layer === null}
              onClick={() => setLayer(null)}
            >
              {t("All")}
            </button>
            {[...WINDOW_LAYERS].reverse().map((item) =>
              counts[item] === 0 ? null : (
                <button
                  key={item}
                  type="button"
                  className={`lattice-overview-chip${layer === item ? " is-active" : ""}`}
                  aria-pressed={layer === item}
                  onClick={() => setLayer(layer === item ? null : item)}
                >
                  {t(LAYER_LABEL[item])}
                  <span className="lattice-overview-chip-count">{counts[item]}</span>
                </button>
              ),
            )}
          </div>

          <button
            type="button"
            className="lattice-icon-btn is-large lattice-overview-close"
            onClick={onClose}
            title={t("Close")}
            aria-label={t("Close")}
          >
            <Glyph d={ICON.close} />
          </button>
        </header>

        <div className="lattice-overview-body">
          {/*
            左边那一栏按层分组，从最上面那层开始排（`layerGroups` 里定的顺序）。
            行是**导航**不是清单：点一行等于点那张卡，两条路落到同一个动作上。
          */}
          <aside className="lattice-overview-rail">
            {groups.length === 0 ? (
              <p className="lattice-overview-rail-empty">{t("Nothing on the canvas yet")}</p>
            ) : (
              groups.map((group) => (
                <LibSection
                  key={group.layer}
                  title={LAYER_LABEL[group.layer]}
                  count={group.items.length}
                  defaultOpen
                  className="is-overview"
                >
                  {group.items.map((item) => {
                    const record = records.get(item.widgetId);
                    const name = record ? text(record.manifest.name) : item.widgetId;
                    return (
                      <button
                        key={item.instanceId}
                        type="button"
                        className="lattice-overview-row"
                        onClick={() => onPick(item.instanceId)}
                        title={`${name} · ${item.w}×${item.h}`}
                      >
                        <span className="lattice-overview-row-name">{name}</span>
                        <span className="lattice-overview-row-size">
                          {item.w}×{item.h}
                        </span>
                      </button>
                    );
                  })}
                </LibSection>
              ))
            )}
          </aside>

          <div className="lattice-overview-stage" ref={stageRef}>
            {placements.length === 0 ? (
              <div className="lattice-overview-empty">
                <p className="lattice-overview-empty-title">{t("Nothing on the canvas yet")}</p>
                <p className="lattice-overview-empty-hint">
                  {t("Install a widget from the library, then it shows up here at its real size and place.")}
                </p>
              </div>
            ) : ready ? (
              <div
                className="lattice-overview-plane"
                /*
                 * 边框宽度按 `1/scale` 反算，屏幕上永远是 2px 左右：平面整体被
                 * `transform: scale()` 缩过，写死的 `1px` 在 0.3 倍时只剩 0.3 个
                 * 物理像素，卡片之间就分不出边界了。字号（`labelSize`）是同一个
                 * 道理，两处都写在这儿，别在 CSS 里再猜一个数。
                 */
                style={
                  {
                    left: offset.left,
                    top: offset.top,
                    width: bounds.w,
                    height: bounds.h,
                    transform: `scale(${scale})`,
                    "--ov-border": `${Math.max(1, Math.round(2 / scale))}px`,
                  } as React.CSSProperties
                }
              >
                {shown.map(cardOf)}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
