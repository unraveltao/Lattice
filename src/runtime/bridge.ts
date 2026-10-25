/**
 * 棂 / Lattice —— 宿主 ↔ 小组件 的 RPC 桥
 *
 * 安全模型：
 * 1. 小组件跑在 sandbox="allow-scripts"（不含 allow-same-origin）的 iframe 里，
 *    拿到的是不透明源：读不到宿主 DOM、没有可用的 localStorage、发不出同源请求。
 * 2. 因此组件的一切平台能力都必须走这条桥，桥是唯一出入口。
 * 3. 每个方法声明它需要的权限，未授予时返回结构化错误而不是抛异常，
 *    这样组件能优雅降级（例如不显示剪贴板按钮）。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Permission } from "./manifest";
import type { ConfigValues } from "./config";
import type { Scheduler } from "./schedule";
import { languagePayload } from "./i18n";
import { normalizeAskMessages } from "./assistant";

export const BRIDGE_TAG = "__lattice";

export interface BridgeRequestMessage {
  [BRIDGE_TAG]: 1;
  type: "request";
  id: number;
  method: string;
  params?: unknown;
}

export interface BridgeResponseMessage {
  [BRIDGE_TAG]: 1;
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: BridgeErrorCode;
  /** code 为 permission_denied 时，明确告诉宿主缺的是哪一项，便于就地提示授权 */
  permission?: Permission;
}

export type BridgeErrorCode = "unknown_method" | "permission_denied" | "bad_params" | "internal";

/**
 * 窗口轮廓里的一块。
 *
 * 坐标是**物理像素**、相对客户区左上角 —— 和 `desktop::clip_rounded` 同一个口径，
 * 所以组件要自己乘 `devicePixelRatio`。`w` / `h` 是宽高，不是右下角坐标。
 */
export interface RegionPart {
  kind?: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次上报最多认多少块（Rust 侧同一上限）。图片轮廓按 6px 网格合并后会到 100 上下 */
export const MAX_REGION_PARTS = 256;

export interface BridgeContext {
  /** 组件实例 id：同一个组件可以同时放多个实例 */
  instanceId: string;
  /** 组件清单 id：存储命名空间按它隔离，同一组件的多个实例共享数据 */
  widgetId: string;
  /** 用户已授予的权限 */
  granted: ReadonlySet<Permission>;
  /**
   * 平台调度器。一个宿主页一份，组件的心跳全挂在这一条时间轴上。
   * 宿主页换文档（重载 / 授权变化）时必须 `reset()`，否则会往已经销毁的
   * 文档里发 tick。
   */
  schedule: Scheduler;
  /**
   * 这个实例的配置，已经按清单 schema 归一化过（缺的键用出厂值补）。
   * 宿主页在配置变化时就地换掉这份对象，桥每次调用读最新值。
   */
  config: ConfigValues;
  /** 回话给组件（由宿主注入，负责 postMessage 到正确的窗口） */
  reply: (payload: BridgeResponseMessage) => void;
  /**
   * 这个组件清单里声明的联网白名单（`network.hosts`）。
   *
   * 桌面窗口那边 Rust 自己记着一份（建窗口时写进去的），所以这个字段在那里
   * 用不上；**画布上的实例不是窗口**，注册表里没有它的条目，出网时只能把
   * 名单随请求带过去。不带的话同一个组件会"桌面上能联网、设计器里不能"，
   * 而设计器正是用户第一次配置它的地方。
   */
  egress: readonly string[];
  /** 组件请求关闭自己 */
  close: () => void;
  /**
   * 把窗口裁成组件上报的形状（只有 `shape: "region"` 的窗口认）。
   *
   * 做成注入的回调而不是直接 `invoke`，理由和 `close` 一样：画布上的实例
   * **不是窗口**，没有轮廓可裁。画布那边不传这个字段，于是 `window.setRegion`
   * 回 `{ ok: true, applied: false }` —— 组件据此知道"这里只有预览"，
   * 不用 try/catch，也不会把桌面那条路当成坏了。
   */
  setRegion?: (parts: RegionPart[]) => Promise<void> | void;
  /**
   * 把这扇窗按 CSS 像素位移挪一下（功德桌宠走路 / 拖动自己）。
   *
   * 同样做成注入的回调：画布上的实例不是窗口，没有位置可挪。不传这个字段时
   * `window.moveBy` 回 `{ ok: true, applied: false }`。
   *
   * 返回**夹紧后**的物理像素落点；返回 `null` 表示这次没挪成（读不到窗口 /
   * 平台报错），组件据此停手，而不是每帧重试。
   */
  moveBy?: (dx: number, dy: number) => Promise<{ x: number; y: number } | null>;
  /**
   * 桥调用的观察者（调试面板用）。
   *
   * 放在每次调用的上下文里、而不是模块级的一个全局钩子：主窗口的画布上
   * 同时挂着好几个实例，全局钩子只会剩下最后挂上去的那个，别的实例的调用
   * 全记到它头上。挂在这里，谁发的请求就由谁的宿主记。
   */
  trace?: (entry: BridgeTrace) => void;
}

type Handler = (params: unknown, ctx: BridgeContext) => unknown | Promise<unknown>;

interface MethodSpec {
  permission: Permission | null;
  handler: Handler;
}

const methods = new Map<string, MethodSpec>();

export function defineMethod(name: string, permission: Permission | null, handler: Handler): void {
  methods.set(name, { permission, handler });
}

/**
 * 桥调用的观察者（调试面板用）。
 *
 * 做成注入的回调而不是直接 import 调试总线，是因为这个文件也被**组件作者**
 * 当成协议文档读 —— 桥的职责是"收请求、查权限、回话"，记日志是平台自己的
 * 事，不该混进来。
 */
export type BridgeTrace = {
  method: string;
  ok: boolean;
  /** 失败时的错误码；成功时为空 */
  code?: BridgeErrorCode;
  ms: number;
  /** 失败原因 */
  text?: string;
};

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 判断一条消息是不是本平台的桥请求 */
export function isBridgeRequest(data: unknown): data is BridgeRequestMessage {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  return candidate[BRIDGE_TAG] === 1 && candidate.type === "request" && typeof candidate.id === "number";
}

/**
 * 处理一次桥请求。
 * 来源校验由调用方完成（比对 event.source === iframe.contentWindow），
 * 比信任 origin 更可靠——沙箱 iframe 的 origin 是字符串 "null"，无法区分实例。
 */
export async function handleBridgeRequest(
  message: BridgeRequestMessage,
  ctx: BridgeContext,
): Promise<void> {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const reply = (
    body: Pick<BridgeResponseMessage, "ok" | "result" | "error" | "code" | "permission">,
  ) => {
    ctx.reply({ [BRIDGE_TAG]: 1, type: "response", id: message.id, ...body });
    // 记在回话之后：面板里的耗时是"组件真正等的那段"，不含之后的渲染
    ctx.trace?.({
      method: message.method,
      ok: body.ok,
      code: body.code,
      text: body.error,
      ms: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt) * 10) / 10,
    });
  };

  const spec = methods.get(message.method);
  if (!spec) {
    reply({ ok: false, code: "unknown_method", error: `unknown method ${message.method}` });
    return;
  }
  if (spec.permission && !ctx.granted.has(spec.permission)) {
    reply({
      ok: false,
      code: "permission_denied",
      error: `permission not granted: ${spec.permission}`,
      permission: spec.permission,
    });
    return;
  }

  try {
    reply({ ok: true, result: await spec.handler(message.params, ctx) });
  } catch (error) {
    if (error instanceof BridgeError) {
      reply({ ok: false, code: error.code, error: error.message });
    } else {
      reply({ ok: false, code: "internal", error: String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// 平台内置方法
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "lattice.widget.store.";

/**
 * 组件私有存储：一个包一个 JSON 文件。
 *
 * 这里刻意**不留内存缓存**。早先有一份模块级 Map，看起来省了几次 IPC，
 * 代价是每个 webview 各持一份、永不失效：在桌面窗口里写完便签，回主窗口
 * 看到的还是旧内容；更糟的是主窗口再存一次，会拿那份旧 map 把桌面刚写进去
 * 的内容整块盖掉 —— 旧值赢了新值。
 *
 * 现在读一律读盘（文件只有几 KB），写一律走 `widget_store_update` 的键级
 * 原子修改，让"谁后写谁生效"由文件系统的完成顺序决定，而不是由缓存决定。
 */
function bridgeInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function readStore(widgetId: string): Promise<Record<string, unknown>> {
  let raw: string | null = null;
  if (bridgeInTauri()) {
    raw = await invoke<string | null>("widget_store_read", { widgetId });
  } else {
    raw = localStorage.getItem(`${STORAGE_PREFIX}${widgetId}`);
  }

  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 文件被外部改坏了就当空的，别让组件白屏 */
  }
  return {};
}

/**
 * 改一个键。`value === null` 表示删除。
 *
 * 桌面端交给 Rust 在锁里做读-改-写，所以主窗口和桌面窗口同时保存时，
 * 两边改的是不同键也不会互相抹掉。浏览器预览没有这个原语，只能自己
 * 读-改-写 —— 单窗口内够用。
 */
async function patchStore(widgetId: string, key: string, value: unknown): Promise<void> {
  if (bridgeInTauri()) {
    await invoke("widget_store_update", { widgetId, key, value });
    return;
  }
  await patchLocal(widgetId, key, value);
}

/**
 * 浏览器预览下的读-改-写。
 *
 * localStorage 没有原子合并，两个并发写照样会丢键，所以按 widgetId 串一条
 * Promise 链。桌面端不需要这段 —— 那边由 Rust 的锁负责。
 */
const localPatchQueue = new Map<string, Promise<void>>();

function patchLocal(widgetId: string, key: string, value: unknown): Promise<void> {
  const previous = localPatchQueue.get(widgetId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const map = await readStore(widgetId);
    if (value === null) delete map[key];
    else map[key] = value;
    localStorage.setItem(`${STORAGE_PREFIX}${widgetId}`, JSON.stringify(map));
  });
  localPatchQueue.set(widgetId, next.catch(() => undefined));
  return next;
}

defineMethod("clock.now", "clock", () => ({
  now: new Date().toISOString(),
  epochMs: Date.now(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  utcOffsetMinutes: -new Date().getTimezoneOffset(),
}));

defineMethod("storage.get", "storage", async (params, ctx) => {
  const key = readKey(params);
  const map = await readStore(ctx.widgetId);
  return key in map ? map[key] : null;
});

defineMethod("storage.set", "storage", async (params, ctx) => {
  const key = readKey(params);
  // 存 null 等于删掉这个键：组件读回来同样是 null，但文件里不会留下空壳
  const value = (params as { value?: unknown }).value ?? null;
  await patchStore(ctx.widgetId, key, value);
  return { ok: true };
});

defineMethod("storage.remove", "storage", async (params, ctx) => {
  const key = readKey(params);
  await patchStore(ctx.widgetId, key, null);
  return { ok: true };
});

defineMethod("clipboard.write", "clipboard:write", async (params) => {
  const text = (params as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") {
    throw new BridgeError("bad_params", "clipboard.write requires a string parameter \"text\"");
  }
  await navigator.clipboard.writeText(text);
  return { ok: true };
});

/*
 * 把链接交给系统默认浏览器。
 *
 * 这是唯一一条"往外递东西"的桥方法，所以它要权限，而且**只放 http/https**。
 * 真正的门在 `src-tauri/src/open_policy.rs` —— opener 插件不认协议，
 * `file:` / `ms-settings:` / `search-ms:` 都会被 ShellExecuteW 执行，那是
 * 一条绕开 `egress.rs` 和 `network.rs` 的路。这里补一道形状检查，好让参数
 * 错误变成 `bad_params` 而不是一声不响。
 *
 * 为什么不让组件自己 `<a target="_blank">`：那会变成组件 frame 的一次导航，
 * 被 `egress.rs` 取消（白名单里没有外部站点，也永远不该有）。浏览器预览
 * （`npm run dev`）里没有 shell，这条路直接报 `internal`，不装作成功。
 */
defineMethod("shell.open", "shell:open", async (params) => {
  const url = (params as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string" || !url.trim() || url.length > 2048) {
    throw new BridgeError("bad_params", "shell.open requires a url string of 1–2048 characters");
  }
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "opening a link needs the desktop app");
  }
  await invoke("open_external", { url });
  return { ok: true };
});

defineMethod("theme.get", null, () => readThemeTokens());

/*
 * 现在是什么语言。
 *
 * 组件自己画的字（桌宠的气泡、按钮、她的回复）是**作者写的**，平台翻不了 ——
 * 只能把"现在是哪一门"告诉它，由它自己挑。`locale` 那一半是给 `Intl` /
 * `toLocaleString` 用的：那儿认 `zh-CN`，不认 `zh`。
 *
 * 不需要权限：界面语言不是系统能力，而且组件本来就看得见平台的字。
 * 推送那条（`{ type: "language" }`）在宿主页里发，两个宿主都要接 ——
 * 只读一次的话，用户切了语言组件不会跟着换，和 `config.get` 同一个坑。
 */
defineMethod("lang.get", null, () => languagePayload());

/*
 * 这个实例的配置。
 *
 * 不需要权限：配置是用户在这台机器上、为这一份组件亲手填的值，不是系统能力。
 * 返回的永远是**完整**对象 —— 没改过的键用清单里的出厂值补上，所以组件不用
 * 自己写 `?? 默认值`，也不会因为平台升级多了一个字段就拿到 undefined。
 *
 * 除了启动时读一次，配置变化时宿主还会推一条 `config-changed`（见 WIDGET_SPEC
 * 4.3）。只读一次是不够的：用户在属性面板里拨一下开关，组件不会自己知道。
 */
defineMethod("config.get", null, (_params, ctx) => ctx.config);

/*
 * 心跳交给平台管，不交给 setInterval。
 *
 * 组件自己开定时器的话，窗口被藏起来、画布被最小化时它照跑；同一个组件里
 * 有几处需要心跳，就有几个计时器。挂到 `ctx.schedule` 上之后，一个宿主页
 * 只有一条时间轴，页面不可见时整条停摆。
 *
 * 注册成功后，宿主会按间隔推 `{ type: "tick", payload: { id, at } }`。
 * `id` 是订阅号，组件用它区分是哪一条心跳 —— 一条消息就可能同时喂给
 * 时钟和指标轮询。
 */
defineMethod("schedule.every", null, (params, ctx) => {
  const every = (params as { every?: unknown } | undefined)?.every;
  if (typeof every !== "number" || !Number.isFinite(every)) {
    throw new BridgeError("bad_params", "schedule.every requires a number parameter \"every\"");
  }
  const grant = ctx.schedule.every(every);
  if (!grant) {
    throw new BridgeError("bad_params", "too many timers for this widget (max 8)");
  }
  return grant;
});

defineMethod("schedule.clear", null, (params, ctx) => {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new BridgeError("bad_params", "schedule.clear requires a number parameter \"id\"");
  }
  ctx.schedule.clear(id);
  return { ok: true };
});

/*
 * 系统指标：CPU / 内存 / 磁盘 / 网络。
 *
 * 采样在 Rust 侧（`metrics.rs`），带 1 秒缓存 —— 五个组件同一秒各拉一次，
 * 只会真采样一次。所以组件**不需要**自己去省，按自己的心跳调就行。
 *
 * 速率类字段（`cpu.usage`、`network.*PerSec`）靠两次采样做差，所以第一次
 * 调用一定是 0；第二次起才有意义。这不是 bug，别在组件里"修"它。
 */
defineMethod("system.metrics", "system:monitor", async () => {
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "system metrics are only available in the desktop app");
  }
  return await invoke("system_metrics");
});

defineMethod("window.close", null, (_params, ctx) => {
  ctx.close();
  return { ok: true };
});

/*
 * 把窗口裁成组件自己的形状（桌宠 / 悬浮挂件）。
 *
 * 为什么这是"组件能碰自己的窗口"的唯一一处：形状只影响**它自己**的可见像素与
 * 点击命中，碰不到别的窗口，所以不需要权限。而清单里的 `shape: "region"` 是
 * 一道门 —— 没写这一项的组件调用会被 Rust 拒掉，卡片不会因为一次误调用
 * 变成一块看不懂的剪影（右上角那颗 ✕ 是画在卡片上的，形状没了就点不到）。
 *
 * 返回 `applied: false` 表示"这里不是桌面窗口"（画布预览）。组件据此降级，
 * 不用 catch —— 画布上显示一只不透明的宠物是正常的，那不是错误。
 */
defineMethod("window.setRegion", null, async (params, ctx) => {
  const parts = normalizeRegionParts(
    (params as { parts?: unknown } | undefined)?.parts,
  );
  if (!ctx.setRegion) return { ok: true, applied: false, parts: parts.length };
  await ctx.setRegion(parts);
  return { ok: true, applied: true, parts: parts.length };
});

/**
 * 组件自己挪自己的窗口（桌宠走动、悬浮挂件被拖过来）。
 *
 * **不要权限**，和 `window.setRegion` 同一条理由：它只动**自己**这一扇窗，
 * 既改不了别人的位置，也读不到屏幕上的任何东西。位置本身归用户（placement），
 * 所以这里做的是"临时挪一下"—— 落盘那一步仍然由宿主补，组件拿它当持久化手段
 * 是不行的。
 *
 * 位移单位是**组件文档的 CSS 像素**，和 `pointermove` 的位移同一个口径：
 * 组件直接把 `movementX/movementY`（或两次 `screenX/screenY` 的差）传进来，
 * 由宿主乘一次 `scaleFactor` 换成物理像素。**别让组件自己乘 `devicePixelRatio`** ——
 * 跨屏时那个值和窗口的 scaleFactor 不是一回事（见 `screen-fit.ts` 的注释）。
 *
 * 返回 `applied: false` 表示"这里不是桌面窗口"（画布预览）：画布上那张卡片
 * 属于用户的布局，不该被组件自己推着走。组件据此关掉走动/拖动，不用 catch ——
 * 桌宠在画布上一动不动是正常的，那不是错误。
 *
 * 位置是**夹紧后**的真实落点：撞到工作区边缘就停在那儿，`x` / `y` 报的就是
 * 停住的位置，所以组件不会以为"我说了算"。
 */
defineMethod("window.moveBy", null, async (params, ctx) => {
  const step = normalizeMoveStep(params);
  if (!ctx.moveBy) return { ok: true, applied: false };
  const at = await ctx.moveBy(step.dx, step.dy);
  if (!at) return { ok: true, applied: false };
  return { ok: true, applied: true, x: at.x, y: at.y };
});

/**
 * 一次最多认多少位移（CSS 像素）。
 *
 * 不是保险丝，是**量纲**：一次调用代表"这一帧动了多少"，一帧走不了 32K 像素。
 * 超过它的数只可能来自算错的单位（比如把毫秒当像素、或者忘了除 `devicePixelRatio`），
 * 那种 bug 落在夹紧之后表现为"宠物瞬移到屏幕另一头"，比一条报错难查得多。
 */
export const MAX_MOVE_STEP = 32768;

export function normalizeMoveStep(raw: unknown): { dx: number; dy: number } {
  const box = (raw && typeof raw === "object" ? raw : {}) as { dx?: unknown; dy?: unknown };
  const pick = (value: unknown, name: string): number => {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BridgeError("bad_params", `window.moveBy needs a finite number in "${name}"`);
    }
    if (Math.abs(value) > MAX_MOVE_STEP) {
      throw new BridgeError(
        "bad_params",
        `window.moveBy accepts at most ${MAX_MOVE_STEP} css px per call in "${name}"`,
      );
    }
    return value;
  };
  return { dx: pick(box.dx, "dx"), dy: pick(box.dy, "dy") };
}

/**
 * 轮廓条目校验。坏数据一律 `bad_params`，不做"尽量理解"：
 * 一个 NaN 坐标交给 GDI 的结果是整个窗口区域失效，症状是"宠物突然变成
 * 一张实心卡片"，比一条明确的错误难查得多。
 */
export function normalizeRegionParts(raw: unknown): RegionPart[] {
  if (!Array.isArray(raw)) {
    throw new BridgeError("bad_params", "window.setRegion requires an array in \"parts\"");
  }
  if (raw.length > MAX_REGION_PARTS) {
    throw new BridgeError(
      "bad_params",
      `window.setRegion accepts at most ${MAX_REGION_PARTS} parts, got ${raw.length}`,
    );
  }
  const parts: RegionPart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new BridgeError("bad_params", "every region part must be an object");
    }
    const part = item as Record<string, unknown>;
    const kind = part.kind === "ellipse" ? "ellipse" : "rect";
    const x = part.x;
    const y = part.y;
    const w = part.w;
    const h = part.h;
    if (
      typeof x !== "number" || typeof y !== "number" ||
      typeof w !== "number" || typeof h !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(w) || !Number.isFinite(h) ||
      w < 1 || h < 1
    ) {
      throw new BridgeError("bad_params", "region parts need finite x / y and w / h >= 1");
    }
    parts.push({ kind, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }
  return parts;
}

/*
 * 媒体控制：读当前播放、按一下播放/暂停、上一首/下一首。
 *
 * `media.get` 和 `media.control` 共用 `media:control` 一项权限 —— 读和按是
 * 同一件事的两半：能读到"现在放的是谁的歌"，按一下的诱惑就在那儿了；拆成
 * 两项只会让授权面板多一行，而用户没法凭一行字分清区别。
 *
 * 没有会话时 `media.get` 返回 `null`（不是错误）：桌面上没开播放器是正常状态，
 * 组件该显示"没在放"，不该显示红字。
 */
defineMethod("media.get", "media:control", async () => {
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "media control is only available in the desktop app");
  }
  return await invoke("media_session");
});

defineMethod("media.control", "media:control", async (params) => {
  const action = (params as { action?: unknown } | undefined)?.action;
  if (typeof action !== "string") {
    throw new BridgeError("bad_params", "media.control requires a string parameter \"action\"");
  }
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "media control is only available in the desktop app");
  }
  return { ok: await invoke<boolean>("media_control", { action }) };
});

/*
 * 扬声器现在有多响。
 *
 * **单独一项权限，不搭 `media:control` 的便车。** 读会话拿的是"歌名 / 歌手"，
 * 而这条线拿的是**正在播出来的声音本身**（WASAPI 回环采集，见 `audio.rs`）。
 * 两者绑在一起的话，一个组件只要说"我要控制播放"，就顺带拿到了"听你电脑在放什么"
 * —— 授权面板上那行字不该替用户做这个决定。
 *
 * 回环采集**不需要系统级授权**：它采的是本机自己的输出混音，不弹"允许录音"，
 * 也拿不到单个应用的音轨。后端只算一个 RMS 就丢掉采样，不缓存、不落盘。
 *
 * 没有设备 / 设备被独占时返回 `running: false` + `level: 0`，**不是错误**：
 * 那正是"现在没声音"，组件该画平线。
 */
defineMethod("audio.level", "audio:level", async () => {
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "sound level is only available in the desktop app");
  }
  return await invoke("audio_level");
});

/*
 * agent 在本机做过什么。
 *
 * 读的是 `agent/audit.log`（一行一条 JSON），所以它**跨重启还在** —— 这正是
 * 这个方法存在的意义：桌面上放一块板子，看一眼 AI 刚才动了什么，不用去翻日志。
 *
 * 要权限是因为它泄露的是**你的操作历史**：一块同时有 `network` 权限的组件
 * 拿到它，就能把"这个人几点摆了什么"发出去。这不是理论风险，所以默认不授。
 *
 * 端点关着的时候返回的是历史记录（`enabled: false`），不是错误 —— 关掉端点
 * 之后板子还应该看得见之前发生过什么，那正是它存在的理由。
 */
defineMethod("agent.activity", "agent:activity", async (params) => {
  const limit = (params as { limit?: unknown } | undefined)?.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
    throw new BridgeError("bad_params", "\"limit\" must be a number");
  }
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "agent activity is only available in the desktop app");
  }
  return await invoke("agent_activity", { limit: limit ?? 20 });
});

/**
 * 联网。组件**不直连** —— 请求走这里，由 Rust 侧发出去。
 *
 * 为什么不做成"本地 HTTP 代理 + connect-src 指过去"：那样组件仍然可以直接
 * `fetch`，白名单就只剩一层自觉。走 IPC 之后组件文档的 `connect-src` 里
 * 只有它自己的协议源，浏览器层面就没有第二条出网的路。
 *
 * 三层闸门，从宽到严：
 *   1. 用户授予 `network`（这一层由上面的 `spec.permission` 挡掉）
 *   2. 清单里的 `network.hosts` —— 精确匹配主机（可钉端口），不支持通配符
 *   3. 形状：只允许 http/https，方法限于 GET/HEAD/POST/PUT/PATCH/DELETE，
 *      请求体 ≤ 256KB，响应 ≤ 1MB（超出截断并置 `truncated`）
 *
 * 重定向**不自动跟随**：`https://good.com` 302 到别处，跟着走就等于白名单
 * 只检查了第一跳。3xx 原样返回，组件要跟就再调一次，那时会重新过白名单。
 *
 * 用法：
 *   const res = await lattice.network.fetch({
 *     url: "https://api.example.com/v1/now",
 *     headers: { accept: "application/json" },
 *   });
 *   if (res.ok) render(JSON.parse(res.body));
 *
 * `headers` 收普通对象（组件作者写起来自然），这里转成 Rust 要的键值对数组。
 */
defineMethod("network.fetch", "network", async (params, ctx) => {
  const input = (params ?? {}) as {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };

  if (typeof input.url !== "string" || !input.url.trim()) {
    throw new BridgeError("bad_params", "network.fetch requires a string parameter \"url\"");
  }
  if (input.method !== undefined && typeof input.method !== "string") {
    throw new BridgeError("bad_params", "\"method\" must be a string");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    // 只收字符串：收对象就得在这里猜序列化方式，猜错了报错信息会很难懂
    throw new BridgeError("bad_params", "\"body\" must be a string (JSON.stringify it yourself)");
  }

  const headers: [string, string][] = [];
  if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    for (const [name, value] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      headers.push([name, value]);
    }
  }

  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "network.fetch is only available in the desktop app");
  }

  return await invoke("network_fetch", {
    url: input.url,
    method: input.method ?? null,
    headers,
    body: input.body ?? null,
    // 桌面窗口会忽略这份（它在 Rust 的注册表里），画布上的实例靠它出网
    hosts: [...ctx.egress],
  });
});

/**
 * 内置 assistant 的状态：用户到底配没配模型。
 *
 * **不需要权限**：知道"这台机器配了模型"本身不构成能力，而组件要靠它决定
 * 是显示输入框还是显示"先让用户去设置里填一把 key"。真正的调用在下面。
 */
defineMethod("llm.status", null, async () => {
  if (!bridgeInTauri()) return { configured: false, model: "" };
  // 组件只关心"现在用哪一档、它配好了没有" —— 档列表是平台自己的界面，
  // 这里只挑 active 那条出来（和 Rust 的 `llm_profiles` 同一份事实）
  const view = await invoke<{ activeId: string; profiles: Array<{ id: string; configured: boolean; model: string }> }>(
    "llm_profiles",
  );
  const active = view.profiles.find((profile) => profile.id === view.activeId);
  return { configured: active?.configured ?? false, model: active?.model ?? "" };
});

/**
 * 用用户配置的模型说一句话。要 `llm:chat`。
 *
 * 三条约束，每一条都对应一次真实的滥用：
 *
 * 1. **不带工具**。组件的 `llm.chat` 只有一张嘴，没有手：请求里不会出现
 *    `tools`，模型也就没法让它"顺手挪一下组件"。改桌面只有两条路 ——
 *    用户在 assistant 面板里说，或者外部 agent 端点（那条有自己的白名单）。
 * 2. **key 不进组件**。请求由 Rust 发、key 从本机的 `assistant.json` 读，
 *    组件全程看不见；它也没法换 baseUrl 把请求指向别处。
 * 3. **形状收窄**。消息条数 / 单条长度 / 总量都有上限（`llm_policy.rs`），
 *    role 只认 system / user / assistant。超了是**拒绝**，不是截断。
 *
 * 错误码沿用桥的四种：没授权 `permission_denied`、参数不对 `bad_params`、
 * 没配模型或者供应商报错 `internal`（`message` 里是人话，组件直接显示就行）。
 */
defineMethod("llm.chat", "llm:chat", async (params) => {
  const input = (params ?? {}) as { messages?: unknown };
  if (!Array.isArray(input.messages)) {
    throw new BridgeError("bad_params", "\"messages\" must be an array of {role, content}");
  }
  if (input.messages.length === 0) {
    throw new BridgeError("bad_params", "\"messages\" is empty");
  }
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "the assistant is only available in the desktop app");
  }

  const messages: { role: string; content: string }[] = [];
  for (const item of input.messages) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || typeof content !== "string") continue;
    if (!["system", "user", "assistant"].includes(role)) continue;
    messages.push({ role, content });
  }
  if (messages.length === 0) {
    throw new BridgeError("bad_params", "no usable message (role must be system / user / assistant)");
  }

  try {
    const reply = await invoke<{ text: string; toolCalls?: unknown[] }>("llm_chat", {
      messages: JSON.stringify(messages),
      // 组件这条路**永远**不带工具（见上面的第 1 条）
      tools: null,
    });
    // 没给它工具它却想调工具：说明这个模型不听话。别把空字符串当回答交回去，
    // 那会让组件显示一个空气泡，而用户完全看不出发生了什么
    if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0 && !reply.text) {
      throw new BridgeError("internal", "the model tried to call a tool, but widgets cannot use tools");
    }
    return { text: reply.text ?? "" };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("internal", String(error instanceof Error ? error.message : error));
  }
});

/**
 * 请平台替我说一句话 —— 而且让它动手。要 `desktop:control`。
 *
 * 这是组件能碰到桌面的**唯一**一条路，而且它摸不到执行器：`messages` 被打包送去
 * 主窗口，主窗口跑完整的一轮（`runWidgetTurn` → 同一个 `runAssistantTurn` →
 * 同一个 `runAgentAction`），回来的只有"她该说什么"和"我做了什么"。
 *
 * 五条约束：
 *
 * 1. **工具表是裁过的**。这一轮没有 `placement.remove`（`toolsFor("widget")`）：
 *    加、挪、缩放、钉、置顶、换主题都能撤销或手动复原，删掉的东西找不回来 ——
 *    撤销条只活 8 秒，一句"帮我收拾一下"不该有这个权力。
 * 2. **system 只能是一条语气，拼在平台提示之后**。位置和条数由
 *    `normalizeAskMessages` 挡：组件的提示词改不了平台那五条规则。
 * 3. **不传 key、不传地址**。请求照旧由 Rust 发，组件只知道"有一轮对话在跑"。
 * 4. **一轮就是一轮**。主窗口同时只接一条（第二条回 `a turn is already running`），
 *    否则一个组件刷屏就能绕开"每次都要用户按一下"的节奏。
 * 5. **画布和桌面行为必须一样**（不变量 2）。两边都是这条桥 → 同一个 IPC →
 *    同一个主窗口，没有任何"桌面窗口才有的能力"。
 */
defineMethod("assistant.ask", "desktop:control", async (params, ctx) => {
  if (!bridgeInTauri()) {
    throw new BridgeError("internal", "the assistant is only available in the desktop app");
  }
  const normalized = normalizeAskMessages((params as { messages?: unknown } | undefined)?.messages);
  if (!normalized.ok) throw new BridgeError("bad_params", normalized.error);

  try {
    const raw = await invoke<string>("assistant_ask", {
      widgetId: ctx.widgetId,
      messages: JSON.stringify(normalized.value.messages),
      persona: normalized.value.persona?.text ?? null,
    });
    const reply = JSON.parse(raw) as
      | { ok: true; result?: { text?: string; actions?: unknown } }
      | { ok: false; code?: string; error?: string };
    if (!reply.ok) {
      // 主窗口那一侧的错误话已经是给人看的（"no model configured" 那种），
      // 直接交给组件显示 —— 换成 "internal" 会让气泡只剩一句"出错了"
      throw new BridgeError(reply.code === "bad_args" ? "bad_params" : "internal", reply.error ?? "the turn failed");
    }
    const text = typeof reply.result?.text === "string" ? reply.result.text : "";
    const actions = Array.isArray(reply.result?.actions) ? reply.result.actions : [];
    return { text, actions };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("internal", String(error instanceof Error ? error.message : error));
  }
});

function readKey(params: unknown): string {
  const key = (params as { key?: unknown } | undefined)?.key;
  if (typeof key !== "string" || !key) {
    throw new BridgeError("bad_params", "missing string parameter \"key\"");
  }
  return key;
}

/** 把 CSS 变量读成普通对象，组件据此跟随平台主题，不必自己判断明暗 */
export function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of [
    "--lattice-bg",
    "--lattice-surface",
    "--lattice-text",
    "--lattice-text-muted",
    "--lattice-border",
    "--lattice-accent",
    "--lattice-radius",
    "--lattice-font",
  ]) {
    tokens[name] = style.getPropertyValue(name).trim();
  }
  return tokens;
}
