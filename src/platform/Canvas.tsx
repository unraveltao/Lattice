/**
 * 棂 / Lattice —— 桌面画布
 *
 * 主窗口里的这块区域是"桌面预览"：所见即桌面上摆出来的样子。
 * 拖拽、缩放、层级、穿透都在这里落到 Placement 上。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLattice } from "./store";
import { WidgetFrame } from "./WidgetFrame";
import { WidgetMenu, type WidgetMenuTarget } from "./WidgetMenu";
import { guideLines, type AlignGuideState } from "../runtime/align-guides";
import { canvasNeedsLiveFrame } from "../runtime/widget-tools";
import { useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import type { WidgetRecord } from "../runtime/registry";

/**
 * 全局搜索点名要看的那一份。
 *
 * `nonce` 不是给 React 用的 key，是给"同一个组件连搜两次"用的：第二次的
 * `instanceId` 和第一次一模一样，没有它 effect 不会重跑，用户点了却没反应。
 */
export interface CanvasFocus {
  instanceId: string;
  nonce: number;
}

interface CanvasProps {
  records: Map<string, WidgetRecord>;
  /** 当前已启用的组件 id；不在里面的包即使被摆放了也不该渲染 */
  installedIds: Set<string>;
  onDropWidget: (event: React.DragEvent) => void;
  /** 从全局搜索跳过来：滚到这张卡、选中、闪一下。null = 没有待办 */
  focus?: CanvasFocus | null;
}

/** 高亮闪多久。1.2s 够眼睛从浮层挪到卡片上，又不至于一直亮着像坏了 */
const FLASH_MS = 1200;

export function Canvas({ records, installedIds, onDropWidget, focus = null }: CanvasProps) {
  const t = useT();
  /** 组件名是作者写的（可能两门），右键菜单上那一行按当前语言取 */
  const text = useText();
  const placements = useLattice((state) => state.placements);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const desktopMode = useLattice((state) => state.desktopMode);
  const grants = useLattice((state) => state.grants);
  const suppressed = useLattice((state) => state.suppressed);
  const select = useLattice((state) => state.select);
  const hasInstalled = installedIds.size > 0;

  /*
   * 对齐参考线只活在这一层。
   *
   * 不放 store 里有两个原因：它每帧都变（store 一变就整份 `state.json` 落盘，
   * 拖一次组件等于写几百次盘），而且它不属于"用户摆好的布局" —— 松手就该没了。
   */
  const [guides, setGuides] = useState<AlignGuideState | null>(null);
  const onGuides = useCallback((next: AlignGuideState | null) => setGuides(next), []);

  /*
   * 右键菜单只活在这一层（和参考线同一个理由：它不属于"用户摆好的布局"，
   * 也不该跟着 store 一起落盘）。坐标记的是视口坐标，菜单自己 portal 到 body。
   */
  const [menu, setMenu] = useState<WidgetMenuTarget | null>(null);
  const openMenu = useCallback(
    (target: WidgetMenuTarget) => {
      select(target.instanceId);
      setMenu(target);
    },
    [select],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const canvasRef = useRef<HTMLDivElement>(null);

  /*
   * 全局搜索点中的那一份。**只活在这一层**：和参考线、右键菜单同一个理由 ——
   * 它不属于"用户摆好的布局"，不该跟着 store 落盘。
   *
   * 三件事一起做：滚进视野、选中、闪一圈。不调 `bringToFront` —— 那会把
   * placement 挪到数组末尾，而数组顺序就是 z 序、且整份落盘；一次只读的查找
   * 不该改写用户的布局。
   */
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    select(focus.instanceId);
    /*
     * 用属性选择器而不是 ref 表：卡片是 `placements.map` 出来的，ref 得再维护
     * 一份 `instanceId → node` 的映射并跟着增删同步。值里的 `.` / `@` 被引号
     * 包住就是字面量，不需要 `CSS.escape`。
     */
    const node = canvasRef.current?.querySelector<HTMLElement>(
      `[data-instance-id="${focus.instanceId}"]`,
    );
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setFlashId(focus.instanceId);
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [focus, select]);

  /*
   * 参考线是**局部**的：以被拖的那张卡片为中心、两端各伸出「半个卡片 + 48px」
   * （见 `guideLines`）。
   *
   * 以前它按 `scrollHeight` 画满整块内容 —— 一拖动就把画布从上到下切一道，
   * 看着比卡片本身还显眼。现在长度由共享的纯函数算，桌面那边用的是同一份规则。
   *
   * 传给 `guideLines` 的边界仍然按**整块内容**算（不是一屏）：画布是
   * `overflow: auto` 的，绝对定位的子元素以内容左上角为原点，用视口尺寸夹会把
   * 往下滚之后的那一段夹没。读 ref 是在渲染里做的一次性测量 —— 线的出现本来就
   * 伴随着一次 setState，不会因此多渲染一轮。
   */
  const contentW = canvasRef.current?.scrollWidth ?? 0;
  const contentH = canvasRef.current?.scrollHeight ?? 0;
  const lines = guides
    ? guideLines(
        guides.result,
        guides.rect,
        contentW > 0 && contentH > 0
          ? { x: 0, y: 0, w: contentW, h: contentH }
          : null,
      )
    : null;

  return (
    <div
      ref={canvasRef}
      className={`lattice-canvas${snapToGrid ? " has-grid" : ""}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) select(null);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDropWidget}
    >
      {lines?.vertical.map((seg) => (
        <div
          key={`v${seg.at}:${seg.from}`}
          className="lattice-guide is-v"
          style={{ left: seg.at, top: seg.from, height: seg.length }}
          aria-hidden
        />
      ))}
      {lines?.horizontal.map((seg) => (
        <div
          key={`h${seg.at}:${seg.from}`}
          className="lattice-guide is-h"
          style={{ top: seg.at, left: seg.from, width: seg.length }}
          aria-hidden
        />
      ))}
      {placements.length === 0 && (
        <div className="lattice-empty">
          <div className="lattice-empty-art" aria-hidden />
          {hasInstalled ? (
            <>
              <p className="lattice-empty-title">{t("The desktop is still empty")}</p>
              <p className="lattice-empty-hint">
                {t("Drag one from the library, or just click a widget card")}
              </p>
            </>
          ) : (
            <>
              <p className="lattice-empty-title">{t("Empty — exactly as intended")}</p>
              <p className="lattice-empty-hint">
                {t("The platform ships with no widgets. Install a pack on the left, or drop your own into the widgets/ folder.")}
              </p>
            </>
          )}
        </div>
      )}

      {placements.map((placement) => {
        const record = records.get(placement.widgetId);
        const live = record && installedIds.has(record.manifest.id);
        if (!live) {
          return (
            <div
              key={placement.instanceId}
              data-instance-id={placement.instanceId}
              className={`lattice-widget is-broken${flashId === placement.instanceId ? " is-flash" : ""}`}
              style={{
                left: placement.x,
                top: placement.y,
                width: placement.w,
                height: placement.h,
              }}
              /*
               * 坏卡也得能右键：它没有清单，属性检查器根本打不开 ——
               * 在此之前"删掉一份找不到的组件"只能去改 state.json
               */
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu({
                  instanceId: placement.instanceId,
                  name: record ? text(record.manifest.name) : placement.widgetId,
                  iconUrl: record?.iconUrl,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <div className="lattice-broken-body">
                <span className="lattice-broken-title">
                  {record ? t("Widget not installed") : t("Widget missing")}
                </span>
                <code className="lattice-mono">{placement.widgetId}</code>
              </div>
            </div>
          );
        }
        return (
          <WidgetFrame
            key={placement.instanceId}
            record={record}
            placement={placement}
            onGuides={onGuides}
            onMenu={openMenu}
            flash={flashId === placement.instanceId}
            /*
             * 桌面模式下桌面上的那个真窗口已经在跑，画布这份只画静态卡 ——
             * 不然同一个组件跑两遍（桌宠空转 0.3 核 × 每份）。三个例外（设计态、
             * 声明了工具的、窗口已经被自己关掉的）见 `canvasNeedsLiveFrame`。
             */
            poster={
              !canvasNeedsLiveFrame({
                desktopMode,
                toolCount: record.manifest.agent?.tools?.length ?? 0,
                granted: grants[record.manifest.id] ?? [],
                suppressed: suppressed.includes(placement.instanceId),
              })
            }
          />
        );
      })}

      {menu && <WidgetMenu target={menu} onClose={closeMenu} />}
    </div>
  );
}
