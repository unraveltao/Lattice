/**
 * 棂 / Lattice —— 平台统一调度器
 *
 * 为什么要平台来管：组件自己 `setInterval` 的话，一个卡片里三个定时器就是三个
 * 计时器对象，而且窗口被藏起来、画布被最小化时它们照跑不误 —— 用户看不见的
 * 东西在后台烧电。这里把**同一个组件实例**的所有心跳收进一条时间轴：
 *
 *   - 一次只有一个 `setTimeout` 在飞（永远取最近的到期时刻），不是每条订阅一个
 *   - 页面不可见（`document.hidden` / 窗口被最小化）时整条时间轴停摆，
 *     回来只补一拍，不补一串
 *   - 最小 250ms、最多 8 条订阅 —— 挡住"每帧来一次"这种用法
 *
 * "统一"的粒度要说清：一个组件实例 = 一个宿主页（桌面窗口或画布 iframe），
 * 所以统一的是"这个组件里的所有定时器"，不是整个进程。跨进程统一要靠 Rust
 * 定时广播，代价远大于收益 —— 每个组件本来也就一两条心跳。
 *
 * # 为什么还要听一个自定义事件
 *
 * `document.visibilityState` 只在**整个 webview 被藏起来**时翻。窗口最小化不算：
 * 实测主窗口收进任务栏之后，画布里的 iframe 仍然是 `visible`，定时器照跑。
 * 所以窗口真实的可见性由 Rust 观测后发 `lattice:window-visible`（见
 * `src-tauri/src/visibility.rs`），这里把它和文档可见性合成同一个"能不能跑"。
 * 两者是"与"的关系：任何一个说不跑，就停。
 */

import { BRIDGE_TAG } from "./bridge";

/** 最细心跳。再密就是拿 postMessage 当 requestAnimationFrame 用，组件该自己开 rAF */
export const MIN_INTERVAL = 250;
/** 最粗心跳：一天。再长就别用调度器了 */
export const MAX_INTERVAL = 24 * 60 * 60 * 1000;
/** 一个组件实例最多几条订阅 */
export const MAX_SUBSCRIPTIONS = 8;

/**
 * 窗口可见性变化时在页面内广播的事件名。
 *
 * 和 Rust 发过来的 Tauri 事件同名，但**不是同一个通道**：Tauri 事件先到页面
 * 的一个监听器，由它转成这个 DOM 事件，页面上任意多个调度器再各自听。
 * 这样一个窗口只有一个 IPC 订阅，而不是每个组件实例一个。
 */
export const WINDOW_VISIBLE_EVENT = "lattice:window-visible";


export interface ScheduleGrant {
  id: number;
  /** 实际生效的间隔（可能被夹紧过），组件据此校准自己的显示 */
  every: number;
}

export interface Scheduler {
  /** 注册一条心跳；超出上限返回 null（调用方负责报错） */
  every(intervalMs: number): ScheduleGrant | null;
  clear(id: number): void;
  /** 宿主页换文档时调用：订阅全部作废，避免往已经销毁的文档里发消息 */
  reset(): void;
  /** 当前订阅数（测试与诊断用） */
  count(): number;
}

interface Subscription {
  id: number;
  every: number;
  /** 下一次到期时刻（`Date.now()` 毫秒） */
  next: number;
}

export interface TickMessage {
  [BRIDGE_TAG]: 1;
  type: "tick";
  payload: { id: number; at: number };
}

/* ------------------------------------------------------------------ *
 * 可见性：文档状态 + 窗口状态，两个来源合成一个
 * ------------------------------------------------------------------ */

/** 窗口自己报的可见性。一个页面就是一个窗口，所以它属于模块，不属于某个调度器 */
let windowVisible = true;
/** 每个页面只订一次 Tauri 事件，别让每个组件实例各订一份 */
let bridgeHooked = false;

/** 现在能不能跑：文档藏起来了、或者窗口被最小化/收起了，都不跑 */
function pageHidden(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return !windowVisible;
}

/**
 * 由窗口自己（或测试）报告"我现在看不看得见"。
 *
 * 只改状态并广播 —— 每个调度器持有自己的时间轴，停/起各管各的。
 */
export function setWindowVisible(visible: boolean): void {
  if (visible === windowVisible) return;
  windowVisible = visible;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WINDOW_VISIBLE_EVENT, { detail: visible }));
}

/**
 * 现在看不看得见：`document.hidden` 和窗口状态取"与"。
 *
 * 给**自己要开帧循环**的组件用。`schedule` 只管挂在时间轴上的定时器，组件里
 * 那条 `requestAnimationFrame` 它管不到 —— 窗口藏起来之后那条循环还在跑，
 * 实测一只桌宠空转就吃掉一整个核（它每帧整屏重绘）。所以宿主把这个状态当一条
 * 推送发给组件（`{ type: "visible" }`），由组件自己停/续它的帧循环。
 */
export function windowVisibleNow(): boolean {
  return !pageHidden();
}

/**
 * 订阅"看不看得见"，**并且立刻回调一次当前值**。
 *
 * 立刻回调那一半不能省：页面可能是在"窗口已经不可见"的时候加载的（热更新、
 * 权限变了重载、暂停期间新建的组件）。那一次"变成不可见"早就发生过了，只订
 * 事件的话组件会一直以为自己在屏幕上。
 *
 * 返回退订函数 —— 宿主卸载（画布卡片被删、窗口关掉）时要还回去，否则一个已经
 * 销毁的 iframe 还会被推送。
 */
export function subscribeWindowVisible(handler: (visible: boolean) => void): () => void {
  const onChange = () => handler(!pageHidden());
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange);
  if (typeof window !== "undefined") window.addEventListener(WINDOW_VISIBLE_EVENT, onChange);
  handler(!pageHidden());
  return () => {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onChange);
    if (typeof window !== "undefined") window.removeEventListener(WINDOW_VISIBLE_EVENT, onChange);
  };
}

/**
 * 接上 Rust 发来的窗口可见性。
 *
 * 动态 import：这一层只是"多一个触发源"，非 Tauri 环境（浏览器里跑测试、
 * vite 直接开页面）不该为了它把 IPC 那套模块拉进模块图。
 *
 * # 为什么要自己比对 label
 *
 * `emit_to(label)` 并不是"只发给那个窗口"：JS 侧 `listen()` 注册的 target 是
 * `Any`，Tauri 的匹配规则是 `target == Any || filter(target)`，于是**每一次**
 * emit 都会送到**每个**窗口的 `Any` 监听器上。实测主窗口最小化时四个桌面组件
 * 窗口全都收到了这条事件、跟着一起停摆 —— 桌面上的系统监控当场冻住。
 * 载荷里带着 label，这里比一次就干净了。
 */
function hookWindowVisibility(): void {
  if (bridgeHooked) return;
  bridgeHooked = true;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

  const label = currentLabel();
  if (!label) return;

  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<{ label?: string; visible?: boolean }>(WINDOW_VISIBLE_EVENT, (event) => {
      const payload = event.payload;
      if (!payload || payload.label !== label) return;
      setWindowVisible(payload.visible !== false);
    });
  });

  /*
   * 启动时主动问一次。
   *
   * 事件是"变了才发"，而页面可能是**在窗口已经不可见的时候**加载的（热更新、
   * 权限变了重载、改完 Rust 应用重启、暂停期间新建的组件）。那一次"变成不可见"
   * 早就发生过了，只订事件会永远以为自己是可见的 —— 组件就在看不见的窗口里照跳。
   *
   * **两个都要问**：`isMinimized()` 只回答"收进任务栏了没有"，窗口被 `hide()`
   * 藏起来时它是 false。只看这一个，暂停期间重载的组件会立刻恢复心跳 ——
   * 而"暂停"要的正是"一个定时器都别跑"。判定和 `visibility.rs::is_visible`
   * 保持一致：没最小化**且**真的显示着。
   */
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    void Promise.all([win.isMinimized(), win.isVisible()])
      .then(([minimized, visible]) => setWindowVisible(!minimized && visible))
      .catch(() => {
        // 拿不到就当可见：宁可多跑几拍，也别把组件的时钟停死
      });
  });
}

/** 这个页面所在的窗口 label。拿不到就返回空串（永远对不上任何事件） */
function currentLabel(): string {
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label;
    return typeof label === "string" ? label : "";
  } catch {
    return "";
  }
}

export function createScheduler(post: (payload: TickMessage) => void): Scheduler {
  const subscriptions = new Map<number, Subscription>();
  let seq = 0;
  let timer = 0;
  let paused = pageHidden();

  hookWindowVisibility();

  const stopTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };

  const arm = () => {
    stopTimer();
    if (paused || subscriptions.size === 0) return;

    let earliest = Number.POSITIVE_INFINITY;
    for (const subscription of subscriptions.values()) {
      if (subscription.next < earliest) earliest = subscription.next;
    }
    timer = window.setTimeout(fire, Math.max(0, earliest - Date.now()));
  };

  const fire = () => {
    timer = 0;
    const now = Date.now();
    for (const subscription of subscriptions.values()) {
      if (subscription.next > now) continue;
      /*
       * 一次只发一拍，然后把 next 直接推到"下一个未来时刻"。
       * 不按落后多少补发：页面被藏了十分钟再回来，补 2400 次心跳既没意义，
       * 还会把主线程堵死 —— 组件要的是"现在是什么样"，不是"这十分钟里每一拍"。
       */
      subscription.next = now + subscription.every;
      post({ [BRIDGE_TAG]: 1, type: "tick", payload: { id: subscription.id, at: now } });
    }
    arm();
  };

  const onVisibilityChange = () => {
    const hidden = pageHidden();
    if (hidden === paused) return;
    paused = hidden;
    if (paused) {
      stopTimer();
      return;
    }
    // 回到前台：到期的那几条立刻补一拍（fire 里会把 next 推到未来）
    arm();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window !== "undefined") {
    // 同一个处理函数，两个触发源：文档被藏起来 / 窗口被最小化或收起
    window.addEventListener(WINDOW_VISIBLE_EVENT, onVisibilityChange);
  }

  return {
    every(intervalMs: number): ScheduleGrant | null {
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) return null;
      const every = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(intervalMs)));
      seq += 1;
      const id = seq;
      subscriptions.set(id, { id, every, next: Date.now() + every });
      arm();
      return { id, every };
    },

    clear(id: number): void {
      if (!subscriptions.delete(id)) return;
      arm();
    },

    reset(): void {
      subscriptions.clear();
      stopTimer();
    },

    count(): number {
      return subscriptions.size;
    },
  };
}
