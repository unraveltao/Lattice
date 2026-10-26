/**
 * `@lattice/sdk` 的类型声明。
 *
 * 这份文件不给构建用 —— 组件里不打包、不 import 类型。它的唯一用途是让
 * 编辑器（VS Code / WebStorm）在你写组件时能补全：把 `lattice.js` 和
 * `lattice.d.ts` 一起拷进组件目录，写 `/** @type {import("./lattice.js").Lattice} *\/`
 * 或者直接 `// @ts-check` 就有提示了。
 */

/** 桥返回的结构化错误码，见 WIDGET_SPEC 4.4 */
export type BridgeErrorCode = "unknown_method" | "permission_denied" | "bad_params" | "internal";

export type Permission =
  | "clock"
  | "storage"
  | "clipboard:write"
  | "network"
  | "system:monitor"
  | "media:control"
  | "audio:level"
  | "shell:open"
  | "agent:activity"
  | "llm:chat"
  | "desktop:control";

export interface LlmStatus {
  /** 地址 / 模型 / key 三样齐了才是 true */
  configured: boolean;
  /** 正在用的模型名（没配就是空串） */
  model: string;
}

export interface LlmReply {
  text: string;
}

/** 一轮 `assistant.ask` 里平台真做了的一件事。`ok: false` 的带 `error`。 */
export interface AssistantAction {
  /** 动作名，如 `moveWidget` / `resizeWidget` / `pinWidget` / `setTheme` */
  detail: string;
  ok: boolean;
  error?: string;
}

export interface AssistantReply {
  /** 模型这一轮说完的那句话（给你显示用） */
  text: string;
  /** 已经发生的事实，不是计划。别拿它当真值去驱动 UI 状态 */
  actions: AssistantAction[];
}

/**
 * 一条组件工具的实现（清单 `agent.tools` 里的 `name`）。
 *
 * **返回什么就交回什么**，抛错就是 `ok: false`（错误信息原样交给模型）——
 * 不用自己拼 `{ ok, result }` 那层信封。
 */
export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: { callId?: string; tool: string },
) => unknown | Promise<unknown>;

/** 工具名 → 实现。名字必须和清单里声明的一致，否则那条工具会回 `unknown tool` */
export type AgentToolHandlers = Record<string, AgentToolHandler>;

export declare class LatticeError extends Error {
  constructor(code: BridgeErrorCode, message: string, permission?: Permission);
  readonly code: BridgeErrorCode;
  /** 只有 `code === "permission_denied"` 时才有值 */
  readonly permission?: Permission;
}

export declare function isPermissionDenied(error: unknown): boolean;

/** 配置值：清单里声明的字段，按实例存。值已经合并过出厂值。 */
export type ConfigValues = Record<string, string | number | boolean | null>;

/** 主题令牌，键是 `--lattice-*` 长名 */
export type ThemeTokens = Record<string, string>;

/** 界面语言：`zh` 或 `en`（"跟随系统"在平台那边就已经解析成其中之一） */
export type Lang = "zh" | "en";

/** 平台当前的界面语言。组件按 `lang` 挑自己写的那一份文案 */
export interface LanguageInfo {
  lang: Lang;
  /** 具体地区，如 `zh-CN` / `en-US`。只用来排版日期数字时才需要 */
  locale: string;
}

export type MediaStatus = "playing" | "paused" | "stopped" | "changing" | "opened" | "closed";

export interface MediaSession {
  title: string;
  artist: string;
  album: string;
  /** 播放器的 AUMID，例如 `Spotify.exe` */
  source: string;
  status: MediaStatus;
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  positionMs: number;
  durationMs: number;
}

export interface AudioLevel {
  /** 0..1，已经做过分贝映射和释放曲线 */
  level: number;
  /** 采集线程是否在跑。false 时 level 恒为 0（没设备 / 被独占 / 正在重连） */
  running: boolean;
}

export interface SystemMetrics {
  cpu: {
    /** 0–1，整机。第一次采样没有前值，返回 0 */
    usage: number;
    /** 逻辑核数 */
    cores: number;
    /**
     * 每个逻辑核的占用，0–1，长度等于 `cores`。
     * 第一拍、或者核数刚变过（休眠唤醒 / 热插拔）时是**空数组**，
     * 别按索引硬对 —— 那会把 A 核的计数减到 B 核头上。
     */
    perCore: number[];
  };
  memory: {
    used: number;
    total: number;
    /** 0–1 */
    usage: number;
    /** 已提交量（含页面文件），字节 */
    commitUsed: number;
    /** 提交上限，字节。撞到它系统会直接拒绝分配 */
    commitLimit: number;
  };
  disk: {
    /** 系统盘盘符，例如 `C:` */
    mount: string;
    used: number;
    total: number;
    /** 0–1 */
    usage: number;
  };
  network: {
    /** 每秒字节数。第一次采样没有前值，返回 0 */
    rxPerSec: number;
    txPerSec: number;
    /** 开机以来的累计字节数 */
    rxTotal: number;
    txTotal: number;
  };
  system: {
    /** 开机至今的秒数 */
    uptimeSec: number;
    processes: number;
    threads: number;
    handles: number;
  };
  /** 采样时刻（Unix 毫秒）。据此判断这份数据有多旧 */
  sampledAt: number;
}

export interface NetworkRequest {
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

export interface NetworkResponse {
  status: number;
  ok: boolean;
  headers: [string, string][];
  body: string;
  /** 响应超过 1MB 时被截断，这里为 true */
  truncated: boolean;
}

export interface ClockInfo {
  now: string;
  epochMs: number;
  timeZone: string;
  utcOffsetMinutes: number;
}

export interface TickPayload {
  id: number;
  at: number;
}

export interface TimerHandle {
  id: number;
  stop(): Promise<void>;
}

export interface Lattice {
  /** 是否真的在宿主页里（顶层窗口为 false） */
  readonly hosted: boolean;
  /** 启动完成：配置和主题已经应用过一次 */
  readonly ready: Promise<Lattice>;

  call<T = unknown>(
    method: string,
    params?: unknown,
    options?: {
      /** 盖掉这一条的默认超时（毫秒）。慢方法（`assistant.ask`）要用它 */
      timeout?: number;
    },
  ): Promise<T>;

  on(event: "theme", handler: (tokens: ThemeTokens) => void): () => void;
  on(event: "language", handler: (info: LanguageInfo) => void): () => void;
  on(event: "config", handler: (config: ConfigValues) => void): () => void;
  on(event: "store", handler: (key: string | undefined) => void): () => void;
  on(event: "tick", handler: (payload: TickPayload) => void): () => void;
  /**
   * 窗口看不看得见。**自己开帧循环的组件必须接这条**：平台的时间轴在不可见时
   * 会停，但 `requestAnimationFrame` 不归它管 —— 不接就一直每帧重绘。
   */
  on(event: "visible", handler: (visible: boolean) => void): () => void;
  on(event: string, handler: (payload: any) => void): () => void;
  off(event: string, handler: (payload: any) => void): void;

  readonly theme: ThemeTokens;
  applyTheme(tokens: ThemeTokens): void;

  /** 界面语言。`await ready` 之后就是准确的；换语言会推 `on("language")` */
  readonly language: LanguageInfo;

  readonly config: ConfigValues;
  reloadConfig(): Promise<ConfigValues>;

  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<{ ok: true }>;
    remove(key: string): Promise<{ ok: true }>;
    onChange(handler: (key: string | undefined) => void): () => void;
  };

  schedule: {
    every(every: number, handler: (payload: TickPayload) => void): Promise<TimerHandle>;
    clear(id: number): Promise<{ ok: true }>;
  };

  system: {
    metrics(): Promise<SystemMetrics>;
  };

  media: {
    get(): Promise<MediaSession | null>;
    playPause(): Promise<{ ok: boolean }>;
    next(): Promise<{ ok: boolean }>;
    previous(): Promise<{ ok: boolean }>;
    stop(): Promise<{ ok: boolean }>;
  };

  audio: {
    level(): Promise<AudioLevel>;
  };

  network: {
    fetch(input: NetworkRequest): Promise<NetworkResponse>;
  };

  llm: {
    /** 用用户配的模型说一句话（要 `llm:chat`；key 不进组件，也没有工具） */
    chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<LlmReply>;
    /** 用户配没配模型（不需要权限） */
    status(): Promise<LlmStatus>;
  };

  assistant: {
    /**
     * 让平台的 assistant **替你动桌面**：平台跑完一整轮带工具的对话，你只拿
     * 回话和这次真做了什么（要 `desktop:control`；没有删除动作）。
     */
    ask(input: {
      /** 对话本身；`system` 位置只当人设用，覆盖不了平台的规则 */
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      /** 人设（语气 / 性格），最多 1200 字 */
      persona?: string;
    }): Promise<AssistantReply>;
  };

  /**
   * 把清单 `agent.tools` 里声明的那几条工具**挂上实现**（要 `agent:tools`）。
   *
   * 返回值就是 `result`，抛错就是 `error`；没注册的工具名会回一条
   * `unknown tool: <名字>` 而不是让模型干等 8 秒。返回的函数摘掉这次注册。
   */
  agentTools(handlers: AgentToolHandlers): () => void;

  now(): Promise<ClockInfo>;
  copy(text: string): Promise<{ ok: true }>;
  /** 用系统默认浏览器打开一个 http/https 链接（要 `shell:open`） */
  open(url: string): Promise<{ ok: true }>;
  close(): Promise<{ ok: true }>;
}

export interface CreateLatticeOptions {
  /** 单次调用超时（毫秒），默认 3000 */
  timeout?: number;
  /** 启动时读配置/主题的超时（毫秒），默认 1200 */
  bootTimeout?: number;
  /** 收到主题就自动写到 CSS 变量上，默认 true */
  autoTheme?: boolean;
  /** 启动完自动向宿主报 ready，默认 true */
  autoReady?: boolean;
}

export declare function createLattice(options?: CreateLatticeOptions): Lattice;
export default createLattice;
