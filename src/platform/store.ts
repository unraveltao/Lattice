/**
 * 棂 / Lattice —— 平台状态
 *
 * 只存"用户配置"这一层：组件摆放、层级、已授权权限、主题。
 * 组件自己的业务数据不在这里，走 storage 桥按 widgetId 隔离。
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Permission, WidgetLayer } from "../runtime/manifest";
import type { LangPref } from "../runtime/i18n";
import { normalizeKey, normalizeSources, sourceIdFor, type CatalogueSource } from "../runtime/catalogue";
import type { Appearance } from "../runtime/appearance";
import type { ConfigValues } from "../runtime/config";

/**
 * 状态存哪儿。
 *
 * 桌面端存文件（见 src-tauri/src/state.rs）：这台机器上 WebView2 的
 * localStorage 只活在内存里，进程一退布局就没了。浏览器里预览时退回
 * localStorage，至少刷新页面不丢。
 */
const STATE_FILE = "lattice.platform.v1";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 水合完成前不许写盘。
 *
 * 读状态是异步的，这中间只要有一次 set，persist 就会把"默认空状态"盖到
 * 磁盘上，把用户上次的布局冲掉。所以先读后写。
 */
let hydrated = false;

const platformStorage: StateStorage = {
  getItem: async (name) => {
    if (!inTauri()) return localStorage.getItem(name);
    try {
      return await invoke<string | null>("state_read");
    } catch (error) {
      console.error("Failed to read platform state", error);
      return null;
    }
  },
  setItem: async (name, value) => {
    if (!hydrated) return;
    if (!inTauri()) {
      localStorage.setItem(name, value);
      return;
    }
    try {
      await invoke("state_write", { json: value });
    } catch (error) {
      console.error("Failed to save platform state", error);
    }
  },
  removeItem: async (name) => {
    if (!inTauri()) {
      localStorage.removeItem(name);
      return;
    }
    try {
      await invoke("state_clear");
    } catch (error) {
      console.error("Failed to clear platform state", error);
    }
  },
};

export interface Placement {
  /** 实例 id，同一个组件可以摆多份 */
  instanceId: string;
  /** 清单 id */
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: WidgetLayer;
  /** 是否穿透鼠标事件（只展示不交互的组件可以开） */
  clickThrough: boolean;
  /**
   * 别针：锁住位置与大小。
   *
   * 桌面态下组件是可以随便拖、随便缩的，锁住之后宿主页会把拖拽与缩放手柄收掉。
   * 老版本存下来的 placement 没有这个字段，读的时候按 false 处理。
   */
  pinned: boolean;
  /**
   * 底板外观的实例覆盖（颜色 / 浓度 / 磨砂）。
   *
   * 没设过就走清单里的出厂值；设过就整个覆盖 —— 不存"只改了哪一项"，
   * 因为三个值是一起调的，部分覆盖只会让"重置"变得没法解释。
   */
  appearance?: Appearance;
}

/** 桌面态下某个实例的真实窗口矩形（屏幕坐标，逻辑像素） */
export interface DesktopRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ThemeMode = "light" | "dark" | "system";

/**
 * 目录源的形状住在 `runtime/catalogue.ts`（0010）：那一侧要拿它做合并的纯逻辑，
 * 而纯逻辑不该反过来 import 平台层。这里只把默认值与判定留下。
 *
 * `bundled` 是跟着应用一起发的 `public/store/registry.json` —— 断网时的兜底，
 * 用的是仓库里那把公开的演示钥匙。它现在**也是列表里可以加的一项**，
 * 不再是"空地址"的隐式退路。
 */
export type { CatalogueSource } from "../runtime/catalogue";

/**
 * 官方目录的地址。
 *
 * 它就是一个静态文件（GitHub Pages），没有服务端。**默认只订这一份**：
 * 内置那份是演示目录、用公开的 `dev-publisher.key` 签，和线上这份的发布者
 * 钥匙不是同一把 —— 让用户一上手就读线上，就不会在切源时连着吃几个
 * "发布者钥匙变了"的确认。
 */
export const OFFICIAL_CATALOGUE_URL = "https://unraveltao.github.io/lattice-registry/registry.json";

/** 官方那一份源的完整形状（id 固定 `official`：迁移与"同 id 冲突"都按它认） */
export const OFFICIAL_CATALOGUE_SOURCE: CatalogueSource = {
  id: "official",
  kind: "url",
  url: OFFICIAL_CATALOGUE_URL,
  enabled: true,
};

/** 这个地址是不是官方目录（设置里要显示成 "Official" 而不是一长串 URL） */
export function isOfficialCatalogue(url: string): boolean {
  return url.trim().replace(/\/+$/, "") === OFFICIAL_CATALOGUE_URL;
}

/** 用户给一个组件打的星。本地记录，随举报一起导出（平台没有服务端） */
export interface Rating {
  stars: number;
  /** 打星时的版本，版本变了要重新看一遍 */
  version: string;
  at: string;
}

/**
 * 一次"新版本多要了权限"的待确认状态。
 *
 * 更新之后**不会**自动授予新权限（`grants` 里本来就没有），这个字段存在的意义
 * 是让界面**一直**提醒到用户处理为止 —— 只在日志里说一句"新增了权限"，
 * 用户永远看不到。
 */
export interface PermissionReview {
  version: string;
  added: Permission[];
  at: string;
}

/**
 * 刚被删掉的那一个组件，留着给人反悔。
 *
 * 只活在内存里，**不进 `state.json`**：它是"这一次操作还能撤回"的状态，
 * 不是用户配置。重启之后还弹一条"撤销刚才的删除"只会莫名其妙。
 *
 * `rect` 一起存下来，是因为桌面窗口的位置在 `desktopRects` 里，删 placement
 * 时那份也跟着删了 —— 只把 placement 塞回去，组件会掉到画布坐标推算的位置上，
 * 用户看到的还是"位置变了"。
 */
export interface ClosedPlacement {
  placement: Placement;
  rect?: DesktopRect;
  /**
   * 这个实例的配置。跟 `rect` 一样必须一起存：删 placement 时 `configs` 那条
   * 也删了，只把 placement 塞回去的话，撤销回来的组件会变回出厂设置 ——
   * 用户看到的还是"东西回来了，但我的设置没了"。
   */
  config?: ConfigValues;
  /** 删除发生的时刻，提示条用它算"该消失了没有" */
  at: number;
}

/**
 * 本机档案。
 *
 * 平台没有账号体系：这是一个纯本地应用，布局、授权、组件数据全部落在
 * 这台机器的 `%APPDATA%\lattice` 里。所以这里的"登录"只是给这台机器
 * 起一个名字，用来在界面上区分"谁在用"，不会上传任何东西。
 *
 * 真要做多设备同步，得有一个后端（账号 + 布局快照），那时把
 * `signIn` / `signOut` 换成走网络的实现即可，其余界面不用动。
 */
export interface Profile {
  name: string;
  email: string;
  /** 首次登录时间，ISO 字符串 */
  since: string;
}

interface LatticeState {
  placements: Placement[];
  /**
   * 已启用的组件包 id。
   *
   * 平台开箱是空白的 —— 随应用分发的组件包只是"发现到了"，不等于"已安装"。
   * 只有这里列出的包才会出现在画布上。用户目录里的包由磁盘状态决定，
   * 不走这个列表（装上去就是装上了）。
   */
  installedIds: string[];
  /** 已授予的权限，按 widgetId 聚合 */
  grants: Record<string, Permission[]>;
  theme: ThemeMode;
  /**
   * 界面语言：中文 / English / 跟随系统。
   *
   * 存"偏好"而不是"结果"（见 `runtime/i18n.ts` 的 `LangPref`）：选了"跟随
   * 系统"的人，换了 Windows 语言就该跟着换。真正生效的语言在 i18n 模块里，
   * 这里只是它的落盘位置 —— 和 `theme` 同一条分工。
   */
  language: LangPref;
  snapToGrid: boolean;
  /** 本机档案，未登录为 null */
  profile: Profile | null;
  selectedInstanceId: string | null;
  /**
   * 是否已把组件投放到真实桌面（运行态）。
   *
   * **要持久化**：桌面组件平台如果每次重启都把组件收回去，等于用户每天
   * 早上都要重新摆一遍。下次启动时 `App` 看到这里还是 true 就自动把窗口
   * 建回来（受 `restoreOnLaunch` 控制）。
   */
  desktopMode: boolean;
  /**
   * 启动时要不要自动把组件放回桌面。
   *
   * 有人把 Lattice 当纯设计工具用，不想一开就有一堆窗口；也有人开机就要
   * 看见自己的组件。默认开着，设置里能关。
   */
  restoreOnLaunch: boolean;
  /**
   * 桌面态下每个实例的窗口矩形，按 instanceId 索引。
   *
   * 为什么不复用 placement.x/y：画布坐标是相对画布的，窗口坐标是相对屏幕的，
   * 两者基准不同。用户在桌面上把组件拖到哪儿，只有这里知道；下次再投放时
   * 优先用它，否则才从画布坐标推。
   */
  desktopRects: Record<string, DesktopRect>;
  /**
   * 每个实例的配置（清单 `config` 里声明的那些项）。
   *
   * **按 instanceId 存，不按 widgetId** —— 这一条跟 `grants` 正好相反，
   * 因为它回答的是两个不同的问题：
   *   - 权限问"你信不信任这段代码"，同一组件的两份当然一样
   *   - 配置问"这一份要怎么显示"，两个时钟可以一个 24 小时制、一个 12 小时制
   *
   * 只存改过的键，没改过的由清单的 default 补（`resolveConfig` 负责合并）。
   * 这样清单以后新增一项配置，老用户的实例会自动拿到出厂值，不需要迁移。
   */
  configs: Record<string, ConfigValues>;
  /**
   * 左右两栏是不是展开的。
   *
   * 收起之后面板退成一条 40px 的竖条（按钮还在，随时能拉开），画布拿走剩下的
   * 全部宽度 —— 摆组件的时候经常需要这个视野。状态要持久化：用户把它收起来，
   * 就是不想每次开应用再收一次。
   */
  libraryOpen: boolean;
  inspectorOpen: boolean;
  /**
   * 最近一次被删掉的组件，用来做"撤销"。
   *
   * 那两颗 ✕（宿主页窗饰上的、画布卡片上的）都是**不可逆删除**，而 ✕ 只有
   * 22×22、还挂在会淡入的窗饰上 —— 手滑一次，用户的布局就少一块。所以删的
   * 时候留一份快照，主窗口底部弹 8 秒的撤销条。
   */
  lastClosed: ClosedPlacement | null;
  /**
   * 桌面上那批组件窗口是不是被"暂停"了（藏起来了）。
   *
   * **不持久化**，和 `lastClosed` 一个道理：暂停是"现在先别动"，不是配置。
   * 用户关掉应用、明天开机，期待是"组件在那儿"，不是"上次点了暂停所以还是空的"。
   * 真相在 Rust 那边（`Runner::paused`），这里只是它的镜像，靠 `lattice:paused`
   * 事件同步 —— 托盘菜单改了状态，主窗口得跟着变。
   */
  paused: boolean;
  /**
   * 订阅的组件目录源，**一个列表，按顺序生效**（0010）。
   *
   * 顺序决定同一时刻"同一个 `widgetId` 被两个源提供时谁赢"；`enabled` 决定参不参与
   * 合并。列表**不许空** —— 空商店是一个用户无法自愈的状态，删到最后一个时
   * `removeCatalogueSource` 会明确拒绝（界面那颗按钮也是灰的）。
   */
  sources: CatalogueSource[];
  /**
   * 每个组件第一次安装时记下的发布者公钥。
   *
   * 这是签名信任链的第三环（见 `runtime/catalogue.ts`）：目录可以被改，
   * 包可以被换，只有"这把钥匙和上次一样"是本地才知道的事。换了钥匙必须
   * 由用户点一次确认，否则一次目录劫持就等于一次静默的换包。
   */
  trustedKeys: Record<string, string>;
  /**
   * 用户拉黑的发布者公钥（归一化后的 64 位 hex）。
   *
   * 钉住一把钥匙只挡"换人"，挡不住"钥匙本身泄露" —— 偷来的私钥签出来的包
   * 每一步校验都合法。这份名单是唯一能挡住那种情况的东西，所以它必须由用户
   * 自己维护（平台没有服务端，也没有"谁来签吊销清单"的答案）。
   *
   * 语义是**按钥匙**、不是按组件：拉黑一个人，他的所有包都不装。
   */
  blockedKeys: string[];
  /** 本地评分，按 widgetId */
  ratings: Record<string, Rating>;
  /** 待处理的"新版本多要了权限"，按 widgetId */
  permissionReviews: Record<string, PermissionReview>;

  setPanelOpen: (panel: "library" | "inspector", open: boolean) => void;

  addPlacement: (placement: Placement) => void;
  removePlacement: (instanceId: string) => void;
  /** 把 `lastClosed` 塞回画布（含桌面窗口的矩形），然后清空它 */
  restoreLastClosed: () => void;
  /** 用户点了"不用了"或者提示条自己过期 */
  dismissLastClosed: () => void;
  updatePlacement: (instanceId: string, patch: Partial<Omit<Placement, "instanceId" | "widgetId">>) => void;
  bringToFront: (instanceId: string) => void;
  select: (instanceId: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (language: LangPref) => void;
  toggleSnap: () => void;
  signIn: (name: string, email: string) => void;
  signOut: () => void;
  setDesktopMode: (enabled: boolean) => void;
  toggleRestoreOnLaunch: () => void;
  /** 只改镜像，别在这里调 Rust —— 状态由托盘/设置菜单发起，再由事件回流 */
  setPaused: (paused: boolean) => void;
  setDesktopRect: (instanceId: string, rect: DesktopRect) => void;
  /** 改一项配置。值非法不用管：`resolveConfig` 会退回出厂值 */
  setConfig: (instanceId: string, key: string, value: ConfigValues[string]) => void;
  /** 清掉这个实例的全部配置，回到清单的出厂值 */
  resetConfig: (instanceId: string) => void;
  installWidget: (widgetId: string) => void;
  /** 卸载时连带清掉这个组件在画布上的所有实例，避免留下"组件缺失" */
  uninstallWidget: (widgetId: string) => void;
  grant: (widgetId: string, permission: Permission) => void;
  revoke: (widgetId: string, permission: Permission) => void;
  /** 加一个目录源。id 与"同地址去重"都由 `normalizeSources` 定，调用方只管给地址 */
  addCatalogueSource: (source: { kind: "url" | "bundled"; url: string }) => void;
  /** 改一个源（地址 / 启用）。改地址会重算 id 之外的一切，缓存按地址分文件，不用清 */
  updateCatalogueSource: (id: string, patch: Partial<Pick<CatalogueSource, "kind" | "url" | "enabled">>) => void;
  /** 删一个源。**最后一个不许删** —— 空商店无法自愈，界面那颗按钮也是灰的 */
  removeCatalogueSource: (id: string) => void;
  /** 调顺序（-1 上移 / 1 下移）。顺序决定同 id 冲突谁赢 */
  moveCatalogueSource: (id: string, delta: -1 | 1) => void;
  /** 记住这个组件的发布者公钥（第一次装、或者用户确认了换人之后） */
  trustKey: (widgetId: string, key: string) => void;
  /** 拉黑一把发布者公钥：之后任何由它签的包都不装（不管版本、不管装没装过） */
  blockKey: (key: string) => void;
  /** 解除拉黑。名单里没有它就当没发生 */
  unblockKey: (key: string) => void;
  /** 打星。0 分等于取消评分 */
  rateWidget: (widgetId: string, stars: number, version: string) => void;
  /** 记一条"新版本多要了权限"，界面据此一直提醒 */
  flagPermissionReview: (widgetId: string, version: string, added: Permission[]) => void;
  /** 用户处理过了（同意或拒绝都算处理过） */
  resolvePermissionReview: (widgetId: string) => void;
}

export const GRID = 8;

export function snap(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / GRID) * GRID : Math.round(value);
}

/**
 * 状态版本。改默认值、改字段含义时抬它，并在 `migrateState` 里补一条迁移。
 *
 * 1：目录的默认源从"内置演示目录"改成"官方远端目录"。
 *    不迁的话，这个改动只对新装的机器生效 —— 已经用过的人会一直停在演示目录上。
 * 2：目录源从单值 `catalogueSource` 变成列表 `sources`（0010）。
 *    单值那份迁成一条源，id 照同一套规则算（官方那条固定 `official`）。
 */
const STATE_VERSION = 2;

export function migrateState(persisted: unknown, version: number): Record<string, unknown> {
  let state = (persisted ?? {}) as Record<string, unknown>;

  if (version < 1) {
    const source = state.catalogueSource as Partial<CatalogueSource> | undefined;
    // 旧默认就是"内置 + 空地址"，它和"用户主动选了 Bundled"在盘上长得一样，
    // 分不开，所以一起迁到官方目录。真想留在内置那份的，设置里还能加回来
    if (!source || (source.kind === "bundled" && !String(source.url ?? "").trim())) {
      state = { ...state, catalogueSource: { kind: "url", url: OFFICIAL_CATALOGUE_URL } };
    }
  }

  if (version < 2) {
    const legacy = state.catalogueSource as Partial<CatalogueSource> | undefined;
    const kind = legacy?.kind === "bundled" ? "bundled" : "url";
    const url = kind === "bundled" ? "" : String(legacy?.url ?? "").trim() || OFFICIAL_CATALOGUE_URL;
    const rest = { ...state };
    delete rest.catalogueSource;
    // 迁移只负责"变成列表"，把 id 与去重交给同一份归一化 —— 两处各写一遍迟早对不上
    return {
      ...rest,
      sources: normalizeSources(
        [{ id: kind === "bundled" ? "bundled" : isOfficialCatalogue(url) ? "official" : sourceIdFor(url), kind, url, enabled: true }],
        OFFICIAL_CATALOGUE_URL,
      ),
    };
  }

  return state;
}

export const useLattice = create<LatticeState>()(
  persist(
    (set) => ({
      placements: [],
      installedIds: [],
      grants: {},
      theme: "system",
      language: "system",
      snapToGrid: true,
      profile: null,
      selectedInstanceId: null,
      desktopMode: false,
      restoreOnLaunch: true,
      desktopRects: {},
      configs: {},
      libraryOpen: true,
      inspectorOpen: true,
      lastClosed: null,
      paused: false,
      sources: [{ ...OFFICIAL_CATALOGUE_SOURCE }],
      trustedKeys: {},
      blockedKeys: [],
      ratings: {},
      permissionReviews: {},

      setPanelOpen: (panel, open) =>
        set(panel === "library" ? { libraryOpen: open } : { inspectorOpen: open }),

      addPlacement: (placement) =>
        set((state) => ({
          placements: [...state.placements, placement],
          selectedInstanceId: placement.instanceId,
        })),

      removePlacement: (instanceId) =>
        set((state) => {
          const target = state.placements.find((item) => item.instanceId === instanceId);
          const nextRects = { ...state.desktopRects };
          const rect = nextRects[instanceId];
          delete nextRects[instanceId];
          const nextConfigs = { ...state.configs };
          const config = nextConfigs[instanceId];
          delete nextConfigs[instanceId];
          return {
            placements: state.placements.filter((item) => item.instanceId !== instanceId),
            desktopRects: nextRects,
            configs: nextConfigs,
            selectedInstanceId:
              state.selectedInstanceId === instanceId ? null : state.selectedInstanceId,
            // 留一份快照给人反悔。找不到目标（已经被删过）就保持原样，
            // 别把上一次的撤销机会顺手丢掉
            lastClosed: target ? { placement: target, rect, config, at: Date.now() } : state.lastClosed,
          };
        }),

      restoreLastClosed: () =>
        set((state) => {
          const last = state.lastClosed;
          if (!last) return state;
          const { instanceId } = last.placement;
          // 可能已经通过别的路回来了（重装、重新投放），别加出两份
          if (state.placements.some((item) => item.instanceId === instanceId)) {
            return { lastClosed: null };
          }
          return {
            placements: [...state.placements, last.placement],
            desktopRects: last.rect
              ? { ...state.desktopRects, [instanceId]: last.rect }
              : state.desktopRects,
            configs: last.config
              ? { ...state.configs, [instanceId]: last.config }
              : state.configs,
            selectedInstanceId: instanceId,
            lastClosed: null,
          };
        }),

      dismissLastClosed: () => set({ lastClosed: null }),

      updatePlacement: (instanceId, patch) =>
        set((state) => ({
          placements: state.placements.map((item) =>
            item.instanceId === instanceId ? { ...item, ...patch } : item,
          ),
        })),

      bringToFront: (instanceId) =>
        set((state) => {
          const target = state.placements.find((item) => item.instanceId === instanceId);
          if (!target) return state;
          return {
            placements: [...state.placements.filter((item) => item.instanceId !== instanceId), target],
          };
        }),

      select: (instanceId) => set({ selectedInstanceId: instanceId }),

      setTheme: (theme) => set({ theme }),

      setLanguage: (language) => set({ language }),

      toggleSnap: () => set((state) => ({ snapToGrid: !state.snapToGrid })),

      signIn: (name, email) =>
        set((state) => ({
          // 重复登录只改资料，保留最早的 since —— 那是"这台机器用多久了"的记号
          profile: {
            name: name.trim(),
            email: email.trim(),
            since: state.profile?.since ?? new Date().toISOString(),
          },
        })),

      signOut: () => set({ profile: null }),

      setDesktopMode: (enabled) => set({ desktopMode: enabled }),

      toggleRestoreOnLaunch: () => set((state) => ({ restoreOnLaunch: !state.restoreOnLaunch })),

      setPaused: (paused) =>
        set((state) => (state.paused === paused ? state : { paused })),

      setDesktopRect: (instanceId, rect) =>
        set((state) => {
          const current = state.desktopRects[instanceId];
          if (
            current &&
            current.x === rect.x &&
            current.y === rect.y &&
            current.w === rect.w &&
            current.h === rect.h
          ) {
            return state;
          }
          return { desktopRects: { ...state.desktopRects, [instanceId]: rect } };
        }),

      setConfig: (instanceId, key, value) =>
        set((state) => {
          const current = state.configs[instanceId] ?? {};
          if (current[key] === value) return state;
          return { configs: { ...state.configs, [instanceId]: { ...current, [key]: value } } };
        }),

      resetConfig: (instanceId) =>
        set((state) => {
          if (!(instanceId in state.configs)) return state;
          const next = { ...state.configs };
          delete next[instanceId];
          return { configs: next };
        }),

      installWidget: (widgetId) =>
        set((state) =>
          state.installedIds.includes(widgetId)
            ? state
            : { installedIds: [...state.installedIds, widgetId] },
        ),

      uninstallWidget: (widgetId) =>
        set((state) => {
          const removed = state.placements.filter((item) => item.widgetId === widgetId);
          const nextPlacements = state.placements.filter((item) => item.widgetId !== widgetId);
          const nextGrants = { ...state.grants };
          delete nextGrants[widgetId];
          const nextRects = { ...state.desktopRects };
          const nextConfigs = { ...state.configs };
          for (const item of removed) {
            delete nextRects[item.instanceId];
            delete nextConfigs[item.instanceId];
          }
          const keepSelection = nextPlacements.some(
            (item) => item.instanceId === state.selectedInstanceId,
          );
          return {
            installedIds: state.installedIds.filter((id) => id !== widgetId),
            placements: nextPlacements,
            desktopRects: nextRects,
            configs: nextConfigs,
            grants: nextGrants,
            selectedInstanceId: keepSelection ? state.selectedInstanceId : null,
          };
        }),

      grant: (widgetId, permission) =>
        set((state) => {
          const current = state.grants[widgetId] ?? [];
          if (current.includes(permission)) return state;
          return { grants: { ...state.grants, [widgetId]: [...current, permission] } };
        }),

      revoke: (widgetId, permission) =>
        set((state) => {
          const current = state.grants[widgetId] ?? [];
          return {
            grants: { ...state.grants, [widgetId]: current.filter((item) => item !== permission) },
          };
        }),

      /*
       * 源的那几个动作全部收在 `normalizeSources` 后面（和"值只在
       * `resolveConfig` 里合并"同一条规矩）：地址去重、id 撞名加后缀、
       * 空列表补官方 —— 一处判据，四个入口共用。别在某个入口里自己拼一条。
       */
      addCatalogueSource: (source) =>
        set((state) => {
          const kind = source.kind === "bundled" ? "bundled" : "url";
          const url = kind === "bundled" ? "" : source.url.trim();
          if (kind === "url" && !url) return state;
          const id = kind === "bundled" ? "bundled" : sourceIdFor(url);
          return {
            sources: normalizeSources([...state.sources, { id, kind, url, enabled: true }], OFFICIAL_CATALOGUE_URL),
          };
        }),

      updateCatalogueSource: (id, patch) =>
        set((state) => {
          const next = state.sources.map((item) => {
            if (item.id !== id) return item;
            const kind = patch.kind === "bundled" ? "bundled" : patch.kind === "url" ? "url" : item.kind;
            const raw = patch.url ?? item.url;
            const url = kind === "bundled" ? "" : raw.trim();
            return { ...item, kind, url, enabled: patch.enabled ?? item.enabled };
          });
          return { sources: normalizeSources(next, OFFICIAL_CATALOGUE_URL) };
        }),

      removeCatalogueSource: (id) =>
        set((state) => {
          // 最后一个不许删：空商店用户没法自己修好，而"至少留一个"是零成本的
          if (state.sources.length <= 1) return state;
          return {
            sources: normalizeSources(
              state.sources.filter((item) => item.id !== id),
              OFFICIAL_CATALOGUE_URL,
            ),
          };
        }),

      moveCatalogueSource: (id, delta) =>
        set((state) => {
          const from = state.sources.findIndex((item) => item.id === id);
          const to = from + delta;
          if (from < 0 || to < 0 || to >= state.sources.length) return state;
          const next = [...state.sources];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { sources: next };
        }),

      trustKey: (widgetId, key) =>
        set((state) =>
          state.trustedKeys[widgetId] === key
            ? state
            : { trustedKeys: { ...state.trustedKeys, [widgetId]: key } },
        ),

      /*
       * 名单写进去之前先归一化（小写 + 只留 hex）。
       * 存原样的话，同一把钥匙换个大小写就能出现在名单里两次，而比较的时候
       * 又各自归一化 —— 界面上看着有两条，实际是同一条，怎么删都删不干净。
       */
      blockKey: (key) =>
        set((state) => {
          const clean = normalizeKey(key);
          const current = state.blockedKeys ?? [];
          if (!clean || current.includes(clean)) return state;
          return { blockedKeys: [...current, clean].sort() };
        }),

      unblockKey: (key) =>
        set((state) => {
          const clean = normalizeKey(key);
          const current = state.blockedKeys ?? [];
          if (!current.includes(clean)) return state;
          return { blockedKeys: current.filter((item) => item !== clean) };
        }),

      rateWidget: (widgetId, stars, version) =>
        set((state) => {
          const next = { ...state.ratings };
          if (stars <= 0) delete next[widgetId];
          else next[widgetId] = { stars, version, at: new Date().toISOString() };
          return { ratings: next };
        }),

      flagPermissionReview: (widgetId, version, added) =>
        set((state) =>
          added.length === 0
            ? state
            : {
                permissionReviews: {
                  ...state.permissionReviews,
                  [widgetId]: { version, added, at: new Date().toISOString() },
                },
              },
        ),

      resolvePermissionReview: (widgetId) =>
        set((state) => {
          if (!(widgetId in state.permissionReviews)) return state;
          const next = { ...state.permissionReviews };
          delete next[widgetId];
          return { permissionReviews: next };
        }),
    }),
    {
      name: STATE_FILE,
      storage: createJSONStorage(() => platformStorage),
      version: STATE_VERSION,
      migrate: migrateState,
      onRehydrateStorage: () => (_state, error) => {
        if (error) console.error("Failed to hydrate platform state", error);
        hydrated = true;
      },
      partialize: (state) => ({
        placements: state.placements,
        installedIds: state.installedIds,
        grants: state.grants,
        theme: state.theme,
        language: state.language,
        snapToGrid: state.snapToGrid,
        profile: state.profile,
        desktopRects: state.desktopRects,
        configs: state.configs,
        desktopMode: state.desktopMode,
        restoreOnLaunch: state.restoreOnLaunch,
        libraryOpen: state.libraryOpen,
        inspectorOpen: state.inspectorOpen,
        sources: state.sources,
        trustedKeys: state.trustedKeys,
        blockedKeys: state.blockedKeys,
        ratings: state.ratings,
        permissionReviews: state.permissionReviews,
      }),
    },
  ),
);

/** 默认把新组件放在画布左上角附近的空位，避免叠在一起 */
export function nextFreeSlot(placements: Placement[], w: number, h: number): { x: number; y: number } {
  const gap = 16;
  /*
   * 换行的位置按画布**实际**宽度算。
   * 以前写死 1600：窄窗口下第三个组件会被摆到可视区右边，
   * 用户点完「安装」什么都没发生 —— 其实它在，只是要横向滚才看得见。
   */
  const canvas = typeof document === "undefined" ? null : document.querySelector(".lattice-canvas");
  const rightEdge = Math.max(w + 48, (canvas?.clientWidth ?? 1600) - 24);

  let x = 24;
  let y = 24;
  for (let guard = 0; guard < 200; guard += 1) {
    const collides = placements.some(
      (item) =>
        x < item.x + item.w + gap &&
        x + w + gap > item.x &&
        y < item.y + item.h + gap &&
        y + h + gap > item.y,
    );
    if (!collides) return { x, y };
    x += w + gap;
    if (x + w > rightEdge) {
      x = 24;
      y += h + gap;
    }
  }
  return { x, y };
}
