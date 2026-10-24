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
  | "audio:level";

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
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number; usage: number };
  disk: { total: number; free: number; usage: number };
  network: { rxPerSec: number; txPerSec: number; rxTotal: number; txTotal: number };
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
