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
  | "shell:open";

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

  call<T = unknown>(method: string, params?: unknown): Promise<T>;

  on(event: "theme", handler: (tokens: ThemeTokens) => void): () => void;
  on(event: "config", handler: (config: ConfigValues) => void): () => void;
  on(event: "store", handler: (key: string | undefined) => void): () => void;
  on(event: "tick", handler: (payload: TickPayload) => void): () => void;
  on(event: string, handler: (payload: any) => void): () => void;
  off(event: string, handler: (payload: any) => void): void;

  readonly theme: ThemeTokens;
  applyTheme(tokens: ThemeTokens): void;

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
