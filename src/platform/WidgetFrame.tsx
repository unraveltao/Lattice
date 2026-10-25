/**
 * 棂 / Lattice —— 组件宿主
 *
 * 一个组件实例 = 一个沙箱 iframe。
 * 这里做三件事：加载入口、接桥请求、把主题变化推给组件。
 *
 * v0.2 把 iframe 换成独立的 Tauri WebviewWindow 时，
 * 只需替换渲染部分，桥的协议与权限校验完全不用改。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
  type BridgeResponseMessage,
} from "../runtime/bridge";
import { permissionLabel, type Permission } from "../runtime/manifest";
import { normalizeAppearance } from "../runtime/appearance";
import { resolveConfig } from "../runtime/config";
import { createScheduler } from "../runtime/schedule";
import {
  ERROR_KIND_LABEL,
  errorSignature,
  isWidgetErrorReport,
  pickPrimary,
  type WidgetErrorReport,
} from "../runtime/diagnostics";
import { isTauri, type WidgetRecord } from "../runtime/registry";
import { computeAlign, type AlignGuideState } from "../runtime/align-guides";
import { languagePayload, useLang, useT } from "../runtime/i18n";
import { useText } from "../runtime/widget-text";
import { isWidgetLog, trace } from "../runtime/debug";
import { WidgetIconMark } from "./icons";
import { registerCanvasWidgetTools, unregisterCanvasWidgetTools } from "./widget-tools";
import { snap, useLattice, type Placement } from "./store";

/** 画布上最多记几条。这里只显示一条，其余靠 +N 提示，不需要留太多 */
const MAX_CANVAS_ERRORS = 6;

/**
 * 给入口地址加一个重载戳。
 *
 * 重挂 iframe（`key` 变了）只说明 React 重建了元素，浏览器那边照样可以命中
 * 缓存 —— 改完 CSS 一看没变化，人会去怀疑"是不是没存盘"。加上时间戳之后
 * 每次都是新 URL，缓存一定落空。
 *
 * 两种协议都忽略 query：内置组件走应用自己的源，用户组件走 `lattice-widget://`，
 * 而 `protocol.rs` 取的是 `uri().path()`，query 不参与文件解析。
 */
function withReloadStamp(url: string, stamp: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}__lattice_reload=${stamp}`;
}

interface WidgetFrameProps {
  record: WidgetRecord;
  placement: Placement;
  /** 拖拽中的对齐参考线，交给画布去画（见 runtime/align-guides.ts） */
  onGuides?: (guides: AlignGuideState | null) => void;
}

export function WidgetFrame({ record, placement, onGuides }: WidgetFrameProps) {
  const t = useT();
  /** 组件名是作者写的（可能两门），按当前语言取一份 */
  const text = useText();
  /** 组件自己画的字跟着它走（推给 iframe，见下面的 `language` 一条） */
  const language = useLang();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selected = useLattice((state) => state.selectedInstanceId === placement.instanceId);
  const grants = useLattice((state) => state.grants[record.manifest.id]);
  const theme = useLattice((state) => state.theme);
  const select = useLattice((state) => state.select);
  const remove = useLattice((state) => state.removePlacement);
  const update = useLattice((state) => state.updatePlacement);
  const grant = useLattice((state) => state.grant);

  /*
   * 这个实例的配置。
   *
   * 只存"改过的键"，缺的用清单里的出厂值补 —— 合并交给 `resolveConfig`，
   * 这样画布和桌面两个宿主拿到的是同一份规则，不会一个补默认值一个不补。
   */
  const configOverrides = useLattice((state) => state.configs[placement.instanceId]);
  const config = useMemo(
    () => resolveConfig(record.manifest.config, configOverrides),
    [record.manifest.config, configOverrides],
  );

  /** 组件撞到未授权的权限时记在这里，就地提示，不用去右边面板翻 */
  const [missing, setMissing] = useState<Permission[]>([]);

  /**
   * 权限集合变化后重挂 iframe，让组件重新走一遍初始化。
   * 不这么做的话，组件在授权前就把"权限被拒"写进了自己的状态，
   * 用户点完授权界面上还是旧样子 —— 组件没法知道权限变了。
   */
  const [reloadKey, setReloadKey] = useState(0);
  const grantSignature = [...(grants ?? [])].sort().join(",");
  const lastSignature = useRef(grantSignature);
  useEffect(() => {
    if (lastSignature.current === grantSignature) return;
    lastSignature.current = grantSignature;
    setReloadKey((value) => value + 1);
  }, [grantSignature]);

  /*
   * 组件报上来的错。换一份 iframe（授权变了、手动重载）就清空 ——
   * 不清的话旧错误会挂在新内容上面，看着像还没修好。
   */
  const [errors, setErrors] = useState<WidgetErrorReport[]>([]);
  useEffect(() => setErrors([]), [reloadKey]);

  /*
   * 授权变了，卡片上那句 "Needs …" 也得跟着走。
   *
   * `missing` 是组件撞到 `permission_denied` 时记下的，以前只有点卡片上那颗
   * `Grant` 才会清 —— 用户改去属性面板勾上同一项，提示就一直挂在那儿，明明
   * 已经能用了。这里按最新授权过滤一遍：已经有的划掉，仍然缺的留着。
   */
  useEffect(() => {
    const grantedNow = new Set(grants ?? []);
    setMissing((prev) => {
      const next = prev.filter((permission) => !grantedNow.has(permission));
      return next.length === prev.length ? prev : next;
    });
  }, [grantSignature]);

  // 权限会在运行期被用户改动，用 ref 让监听器始终读到最新值
  const grantedRef = useRef<ReadonlySet<Permission>>(new Set());
  grantedRef.current = new Set(grants ?? []);

  /** 配置同理：属性面板改一下就换一份，桥每次调用读最新的 */
  const configRef = useRef(config);
  configRef.current = config;

  const post = useCallback((payload: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(payload, "*");
  }, []);

  /*
   * 在飞的组件工具调用：`callId` → 兑现那次 Promise 的函数。
   *
   * 用 ref 而不是 state：这些 Promise 没人渲染，改动它们不该让组件重渲染
   * （一次调用进来就重画一次画布，代价比它解决的问题大得多）。
   */
  const agentCalls = useRef(new Map<string, (reply: unknown) => void>());

  /*
   * 数据平面（AGENT_ACCESS §2）：把"这一份实例"登记成一个能答话的东西。
   *
   * 登记的是"能把话送进 iframe"这件事本身，答复从下面那个消息监听器回来 ——
   * 也就是说组件工具和桥走**同一条** postMessage，只是方向相反：桥是组件问宿主，
   * 工具是宿主问组件。卸载时按 handler 身份删，见 `unregisterCanvasWidgetTools`。
   */
  useEffect(() => {
    let seq = 0;
    const handler = (tool: string, args: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        const frame = iframeRef.current;
        if (!frame?.contentWindow) {
          resolve({ ok: false, code: "not-running", error: "the widget frame is gone" });
          return;
        }
        seq += 1;
        const callId = `c${seq}`;
        agentCalls.current.set(callId, resolve);
        frame.contentWindow.postMessage(
          { [BRIDGE_TAG]: 1, type: "agent-call", payload: { callId, tool, args } },
          "*",
        );
      });
    registerCanvasWidgetTools(placement.instanceId, handler);
    return () => unregisterCanvasWidgetTools(placement.instanceId, handler);
  }, [placement.instanceId]);

  /*
   * 画布上的每个组件实例也有一条自己的时间轴。
   *
   * 主窗口最小化时整个文档变成 hidden，`createScheduler` 内部会把定时器
   * 停掉 —— 这正是"不可见就暂停"要的效果：桌面上还摆着的组件照常跳，
   * 画布里的这些不跳。
   */
  const scheduler = useMemo(() => createScheduler(post), [post]);

  /** 换一份 iframe（重载 / 授权变化 / 实例被删）就把旧订阅作废 */
  useEffect(() => {
    scheduler.reset();
    return () => scheduler.reset();
  }, [scheduler, reloadKey]);

  // 桥：来源窗口校验 → 权限校验 → 回话
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;

      const data = event.data as Record<string, unknown> | null;

      /*
       * 组件自己抛的错。桌面窗口那边由协议层注入的脚本报上来，
       * 画布这一份 iframe 走的是同一个入口地址，所以同样会报 ——
       * 以前这里没有读者，错误就静默丢了。
       */
      if (isWidgetErrorReport(data)) {
        const signature = errorSignature(data);
        setErrors((prev) =>
          prev.some((item) => errorSignature(item) === signature)
            ? prev
            : [...prev, data].slice(-MAX_CANVAS_ERRORS),
        );
        return;
      }

      /*
       * 组件的 console。画布这一份和桌面窗口那一份由同一段注入脚本转发，
       * 所以这里也要收 —— 否则"在设计态里调组件"反而看不到它的日志。
       */
      if (isWidgetLog(data)) {
        const level = String((data.payload as { level?: unknown })?.level ?? "log");
        trace({
          kind: "log",
          widgetId: record.manifest.id,
          instanceId: placement.instanceId,
          name: level,
          ok: level !== "error",
          ms: 0,
          text: String((data.payload as { text?: unknown })?.text ?? ""),
        });
        return;
      }

      if (data && data[BRIDGE_TAG] === 1 && data.type === "agent-result") {
        const payload = (data.payload ?? {}) as Record<string, unknown>;
        const callId = typeof payload.callId === "string" ? payload.callId : "";
        const settle = agentCalls.current.get(callId);
        if (settle) {
          agentCalls.current.delete(callId);
          // 整条载荷交回去：`normalizeToolReply` 认的是 `ok` / `result` / `error`，
          // 多一个 `callId` 它不当回事。这里不先拆一遍，是为了只有一处解释形状
          settle(payload);
        }
        return;
      }

      if (data && data[BRIDGE_TAG] === 1 && data.type === "ready") {
        post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
        post({ [BRIDGE_TAG]: 1, type: "language", payload: languagePayload() });
        return;
      }
      if (!isBridgeRequest(data)) return;

      void handleBridgeRequest(data, {
        instanceId: placement.instanceId,
        widgetId: record.manifest.id,
        granted: grantedRef.current,
        config: configRef.current,
        schedule: scheduler,
        reply: (payload: BridgeResponseMessage) => {
          const denied = payload.code === "permission_denied" ? payload.permission : undefined;
          if (denied) {
            setMissing((prev) => (prev.includes(denied) ? prev : [...prev, denied]));
          }
          post(payload);
        },
        egress: record.manifest.network.hosts,
        close: () => remove(placement.instanceId),
        trace: (entry) => {
          trace({
            kind: "call",
            widgetId: record.manifest.id,
            instanceId: placement.instanceId,
            name: entry.method,
            ok: entry.ok,
            ms: entry.ms,
            text: entry.text ?? entry.code ?? "",
          });
        },
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [placement.instanceId, record.manifest.id, post, remove, scheduler]);

  // 主题切换时主动通知组件，避免组件各自去猜明暗
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  }, [theme, post]);

  /*
   * 语言切换时也推一条。
   *
   * 组件自己画的话（桌宠的气泡、按钮）是作者写的，平台翻不了 —— 只能告诉它
   * "现在换成哪一门了"。和 `theme` 同一个形状，同样**只读一次是不够的**：
   * 用户切语言的那一刻组件已经在跑，不推它就一直是旧语言。
   *
   * 依赖是 `useLang()` 而不是 store 里的偏好：'跟随系统' 那一档下，偏好没变
   * 而系统语言变了也算换了一门。
   */
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "language", payload: languagePayload() });
  }, [language, post]);

  /*
   * 配置变了，推一份给组件。
   *
   * 组件启动时会 `config.get` 读一次，但用户接着在属性面板里拨开关时它不会
   * 自己知道 —— 那条路只有这个推送。不重载 iframe 是刻意的：配置是"调参"，
   * 不是"换权限"，重载会把组件里没落盘的草稿一起冲掉。
   */
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config } });
  }, [config, post]);

  /*
   * 组件存储被**别的实例**改了，转告这个 iframe。
   *
   * 同一个组件在画布上和桌面上各有一份内存副本，不转发的话两边各写各的：
   * 桌面那边加了两条，画布这边还是旧列表，随便动一下就把那两条写没了。
   * 事件由 Rust 在每次落盘后广播（见 widget_store.rs）。
   */
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void listen<{ widgetId: string; key: string }>("lattice:widget-store", (event) => {
      if (event.payload.widgetId !== record.manifest.id) return;
      post({
        [BRIDGE_TAG]: 1,
        type: "store-changed",
        payload: { key: event.payload.key },
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [post, record.manifest.id]);

  /*
   * 组件文件变了就重挂 iframe。
   *
   * 桌面窗口那条路早就这么做了（`widgetHost.ts` 听同一个事件，给 iframe 的
   * `src` 加一个时间戳），画布这边一直没接 —— 差别很难受：改一行 CSS，
   * 桌面上的卡片自己就变了，画布上那张一动不动。而画布恰好是"先在这儿把样子
   * 调好、再投到桌面"的地方，于是每改一次都要把组件删掉再拖一个回来。
   *
   * 只认自己那一份：桌面上摆五个组件，改一个另外四个一起闪的话，每次闪都
   * 意味着重建一次 iframe、重跑一遍组件脚本、丢掉它内存里的状态。
   */
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;
    const prefix = `${record.manifest.id}/`;

    void listen<{ files: string[] }>("lattice:widgets-changed", (event) => {
      const mine = event.payload.files.some(
        (file) => file === record.manifest.id || file.startsWith(prefix),
      );
      if (mine) setReloadKey((value) => value + 1);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [record.manifest.id]);

  // ---- 拖动 ----
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    /** 画布尺寸：对齐时 0 / 中 / 满 三条线也要能吸 */
    bounds: { w: number; h: number } | null;
  } | null>(null);

  const onDragStart = (event: React.PointerEvent) => {
    event.preventDefault();
    select(placement.instanceId);
    /*
     * 画布尺寸用 `closest` 找，不写死"父节点的父节点"：拖拽把手在
     * `.lattice-widget-bar` 里，它的父节点是卡片、不是画布 —— 拿父节点量出来
     * 的是卡片自己那 240×140，"对齐画布中线"就永远吸不上（这个错误写第一版时
     * 真的犯过，而探针页一跑就露馅）。
     */
    const canvas = (event.currentTarget as HTMLElement).closest(".lattice-canvas");
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: placement.x,
      originY: placement.y,
      bounds: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
    };
    /*
     * 合成事件没有真实指针，`setPointerCapture` 会抛 NotFoundError。
     * 拿不到就算了 —— document 上的监听照样收得到（真机上是真指针，
     * capture 保证指针移出窗口也不丢）。不吞这个异常的话，自检页里
     * 一拖就断，而那正是"拖动逻辑改了要验一下"时最想跑的场景。
     */
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      /* 没有活动指针 */
    }
  };

  const onDragMove = (event: React.PointerEvent) => {
    const state = dragState.current;
    if (!state) return;
    const { snapToGrid, placements } = useLattice.getState();
    /*
     * 先网格、后对齐。
     *
     * 网格把坐标量化到 8px（"看起来整齐"），对齐再把落点拉到别人的边上
     * （"和旁边那个齐"）。顺序反过来会让网格把刚吸好的位置又推走 3px ——
     * 而用户看到的是"明明对齐了，松手却差一点"。
     */
    const gridX = snap(Math.max(0, state.originX + (event.clientX - state.startX)), snapToGrid);
    const gridY = snap(Math.max(0, state.originY + (event.clientY - state.startY)), snapToGrid);
    const others = placements
      .filter((item) => item.instanceId !== placement.instanceId)
      .map((item) => ({ x: item.x, y: item.y, w: item.w, h: item.h }));
    const aligned = computeAlign(gridX, gridY, placement.w, placement.h, others, {
      bounds: state.bounds,
    });
    const nextX = Math.max(0, aligned.x);
    const nextY = Math.max(0, aligned.y);
    update(placement.instanceId, { x: nextX, y: nextY });
    /*
     * 线只盖住这一张卡片（`guideLines` 拿它算段长），所以要连矩形一起交出去。
     * 传的是**吸附之后**的位置：线标记的是最终落点。
     */
    onGuides?.(
      aligned.xs.length || aligned.ys.length
        ? {
            result: aligned,
            rect: { x: nextX, y: nextY, w: placement.w, h: placement.h },
          }
        : null,
    );
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragState.current = null;
    onGuides?.(null);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* 没 capture 过就别 release（合成事件走不到这里，真指针会） */
    }
  };

  // ---- 缩放 ----
  const resizeState = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const onResizeStart = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    select(placement.instanceId);
    resizeState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originW: placement.w,
      originH: placement.h,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const state = resizeState.current;
    if (!state) return;
    const { minW, minH } = record.manifest.size;
    const { snapToGrid } = useLattice.getState();
    update(placement.instanceId, {
      w: Math.max(minW, snap(state.originW + (event.clientX - state.startX), snapToGrid)),
      h: Math.max(minH, snap(state.originH + (event.clientY - state.startY), snapToGrid)),
    });
  };

  const onResizeEnd = (event: React.PointerEvent) => {
    resizeState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  /*
   * 画布上的底板预览。
   *
   * 画布没有壁纸可采样，所以只能算"底色盖在主题底色上"的合成色 —— 模糊和
   * 壁纸纹理都欠奉，只是让拖滑杆时能立刻看到颜色变了，别对着一个不动的卡片调。
   * 用 color-mix 而不是在 JS 里算：主题一换，CSS 自己就跟着重算，没有读不到
   * 新值的时序问题；浏览器不支持这条声明时会被丢掉，退回原来的主题底色。
   */
  /*
   * `shape: region` 的组件（桌宠）在画布上也不该有卡片。
   *
   * 桌面那边由 `SetWindowRgn` 裁成轮廓、宿主页一层底板都不画；画布这边要是一
   * 还在 `.lattice-widget` 那层底色 + 描边上，同一个组件就有了两个样子 ——
   * 而且"先在这儿把样子调好、再投到桌面"正是画布的用途，预览套着一个黑框
   * 是最容易让人以为桌面上也有一块底板的。
   *
   * 只去掉底色 / 描边 / 阴影，**不删标题条**：那是画布上唯一能拖的地方
   * （桌面窗口的拖拽走的是宿主页窗饰，不能用在这里）。它平时淡着，指到或选中
   * 才淡入，所以不挡她的脸。
   */
  const isRegion = record.manifest.shape === "region";
  const appearance = normalizeAppearance(placement.appearance ?? record.manifest.appearance);
  const previewBackdrop =
    isRegion || appearance.tint === "auto"
      ? undefined
      : `color-mix(in srgb, ${appearance.tint} ${Math.round(appearance.alpha * 100)}%, var(--lattice-surface))`;

  const primaryError = pickPrimary(errors);
  const otherErrors = primaryError ? errors.filter((item) => item !== primaryError) : [];

  return (
    <div
      className={`lattice-widget${selected ? " is-selected" : ""}${
        placement.layer === "top" ? " is-top" : ""
      }${isRegion ? " is-region" : ""}`}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.w,
        height: placement.h,
        background: previewBackdrop,
      }}
      onPointerDown={() => select(placement.instanceId)}
    >
      <div
        className="lattice-widget-bar"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        title={t("Drag to move")}
      >
        {record.iconUrl && <WidgetIconMark url={record.iconUrl} size={12} />}
        <span className="lattice-widget-title">{text(record.manifest.name)}</span>
        <span className={`lattice-chip${placement.layer === "top" ? " is-accent" : ""}`}>
          {placement.layer === "top" ? t("On top") : t("Desktop")}
        </span>
      </div>

      {record.entryUrl ? (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          className="lattice-widget-frame"
          title={text(record.manifest.name)}
          /*
           * 重挂时带一个时间戳，否则拿回来的还是缓存里那一份 ——
           * `key` 换了只说明 React 重建了元素，浏览器那边仍然可以命中缓存。
           * 内置组件走应用自己的源、用户组件走 `lattice-widget://`，两种协议
           * 都会忽略 query（`protocol.rs` 取的是 `uri().path()`），所以拼上去
           * 对文件解析没有影响。
           */
          src={reloadKey === 0 ? record.entryUrl : withReloadStamp(record.entryUrl, reloadKey)}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          style={{ pointerEvents: placement.clickThrough ? "none" : "auto" }}
        />
      ) : (
        <div className="lattice-pending">
          <span className="lattice-pending-title">{t("Entry URL is empty")}</span>
          <p className="lattice-hint">
            {t("The manifest entry could not be resolved — check manifest.json.")}
          </p>
          <code className="lattice-mono lattice-path">{record.dir}</code>
        </div>
      )}

      {primaryError && (
        /*
         * 绝对定位，不挤 iframe：组件该占多大还是多大，报错不该改变它自己的布局。
         * 画布上只给一行 —— 完整的堆栈在桌面窗口那张卡里，这里够判断"是不是它炸了"。
         */
        <div
          className="lattice-widget-error"
          title={[
            `${t(ERROR_KIND_LABEL[primaryError.kind])}: ${primaryError.message}`,
            primaryError.where,
            ...otherErrors.map((item) => `${t(ERROR_KIND_LABEL[item.kind])}: ${item.message}`),
          ]
            .filter(Boolean)
            .join("\n")}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="lattice-widget-error-kind">{t(ERROR_KIND_LABEL[primaryError.kind])}</span>
          <span className="lattice-widget-error-message">{primaryError.message}</span>
          {otherErrors.length > 0 && (
            <span className="lattice-widget-error-more">+{otherErrors.length}</span>
          )}
          <button
            type="button"
            className="lattice-widget-error-reload"
            title={t("Reload widget")}
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {t("Reload")}
          </button>
        </div>
      )}

      {missing.length > 0 && missing[0] !== undefined && (
        <div className="lattice-perm-prompt">
          <span className="lattice-perm-prompt-text">
            {t("Needs {permission}", { permission: permissionLabel(missing[0]) })}
            {missing.length > 1 ? ` ${t("+{count} more", { count: missing.length - 1 })}` : ""}
          </span>
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            onClick={(event) => {
              event.stopPropagation();
              // 一次给全，不然组件会一项一项撞过来，用户要点好几次
              for (const permission of missing) grant(record.manifest.id, permission);
              setMissing([]);
            }}
          >
            {missing.length > 1 ? t("Grant all") : t("Grant")}
          </button>
        </div>
      )}

      {selected && (
        <div
          className="lattice-resize-handle"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title={t("Drag to resize")}
        />
      )}
    </div>
  );
}
