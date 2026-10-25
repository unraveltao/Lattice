/**
 * 棂 / Lattice —— 小组件注册表
 *
 * 两个来源，合并成一个列表：
 *   - bundled：随应用分发的内置组件，文件在 public/widgets 里，
 *              构建时由 scripts/widget-index.mjs 生成 index.json
 *   - user   ：用户安装的组件，位于 %APPDATA%/<identifier>/widgets，由 Rust 扫描
 *
 * 两者入口地址的协议不一样，这是这一层最需要注意的地方：
 *   - bundled 在前端资源里，走应用自己的源（dev 是 vite，打包后是 tauri 协议）
 *   - user 是运行期出现在磁盘上的文件，走自定义协议 lattice-widget://
 *     （见 src-tauri/src/protocol.rs）
 * 两条路都解析成**绝对地址**，下游（画布 iframe、桌面宿主页）直接用，不再拼接。
 */

import { invoke } from "@tauri-apps/api/core";
import { ManifestError, normalizeManifest, type WidgetManifest } from "./manifest";
import { pickText } from "./widget-text";

export type WidgetSource = "bundled" | "user";

export interface WidgetRecord {
  manifest: WidgetManifest;
  source: WidgetSource;
  /** 磁盘目录，用于展示与排错 */
  dir: string;
  /** iframe 可直接加载的绝对地址 */
  entryUrl: string;
  /** 图标绝对地址；清单没声明图标时为 null，调用方退回"名字首字" */
  iconUrl: string | null;
}

export interface WidgetLoadError {
  dir: string;
  message: string;
}

export interface RegistrySnapshot {
  widgets: WidgetRecord[];
  errors: WidgetLoadError[];
}

/** Rust 侧 list_widgets 的返回结构 */
interface RawInstalledWidget {
  manifest: unknown;
  dir: string;
  source: WidgetSource;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function assetBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * 应用自己的源。
 *
 * 主窗口和桌面宿主页同源（宿主页是 `WebviewUrl::App("widget-host.html")`），
 * 所以这里算出来的地址在两边都能用。极端情况下 `origin` 是字符串 `"null"`
 * （比如以 file:// 打开），那就退回相对路径。
 */
function appOrigin(): string {
  if (typeof window === "undefined") return "";
  const { origin } = window.location;
  return origin === "null" ? "" : origin;
}

/**
 * 应用自己的资源根地址（以 `/` 结尾）。
 *
 * 组件库、目录（`store/registry.json`）、内置组件包都在这个根下面 ——
 * 它们跟应用一起发，不走自定义协议。导出是因为目录那边也要用同一份算法：
 * 各算一份的话，dev（vite 的 BASE_URL）和打包后（tauri 协议）迟早对不上。
 */
export function appBaseUrl(): string {
  return `${appOrigin()}${assetBase()}`;
}

/**
 * 自定义协议的前缀。
 *
 * Windows / Android 上 Tauri 把自定义 scheme 挂在 `http://<scheme>.localhost/`，
 * 其它平台才是 `<scheme>://localhost/`。写错了的后果不是报错，是 iframe 白屏。
 */
export function widgetSchemeBase(): string {
  const windows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return windows ? `http://lattice-widget.localhost/` : `lattice-widget://localhost/`;
}

export async function loadRegistry(): Promise<RegistrySnapshot> {
  const [bundled, user] = await Promise.all([loadBundled(), loadUser()]);

  const widgets: WidgetRecord[] = [];
  const errors: WidgetLoadError[] = [];

  for (const raw of [...bundled, ...user]) {
    try {
      const manifest = normalizeManifest(raw.manifest, dirName(raw.dir));
      widgets.push({
        manifest,
        source: raw.source,
        dir: raw.dir,
        entryUrl: resolveEntryUrl(manifest, raw.source),
        iconUrl: manifest.icon ? resolveAssetUrl(manifest, raw.source, manifest.icon) : null,
      });
    } catch (error) {
      errors.push({
        dir: raw.dir,
        message: error instanceof ManifestError ? error.message : String(error),
      });
    }
  }

  /*
   * 同名时用户装的那份顶掉内置的。
   *
   * 从商店装一个内置组件会把它落到 `%APPDATA%`（走的是同一条验签解包的路），
   * 于是磁盘上就同时存在两份 id 相同的包。两份都画出来的话，组件库里会出现
   * 两张一模一样的卡片，而点哪一张都不确定 —— 留一份，并且以**用户目录**为准：
   * 那是他刚装的那一份，内置那份只是随应用发来的原件。
   */
  const userIds = new Set(
    widgets.filter((item) => item.source === "user").map((item) => item.manifest.id),
  );
  const unique = widgets.filter(
    (item) => item.source === "user" || !userIds.has(item.manifest.id),
  );

  // 按界面上看到的那个名字排 —— 双语的组件用当前语言那一份
  unique.sort((a, b) => pickText(a.manifest.name).localeCompare(pickText(b.manifest.name), "zh-CN"));
  return { widgets: unique, errors };
}

/**
 * 组件的入口地址（绝对地址，可以直接塞进 iframe.src）。
 *
 * - bundled：`<应用源>/widgets/<id>/<entry>`
 * - user   ：`<协议前缀><id>/<entry>` —— 第一段是组件 id，
 *            协议处理器据此定位目录（见 protocol.rs 的 split_path）
 *
 * 注意组件内部的相对引用：`./style.css` 会解析成 `/<id>/style.css`，
 * 仍然落在自己的目录里，所以组件作者只管用相对路径就行。
 */
export function resolveEntryUrl(manifest: WidgetManifest, source: WidgetSource): string {
  return resolveAssetUrl(manifest, source, manifest.entry);
}

/**
 * 组件目录里任意一个文件（入口 HTML、图标……）的绝对地址。
 * 两条源的分流规则见文件头；这里只负责拼，不负责校验。
 */
export function resolveAssetUrl(
  manifest: WidgetManifest,
  source: WidgetSource,
  relative: string,
): string {
  const path = relative.replace(/^\.\//, "").replace(/^\/+/, "");
  if (source === "user") return `${widgetSchemeBase()}${manifest.id}/${path}`;
  return `${appOrigin()}${assetBase()}widgets/${manifest.id}/${path}`;
}

async function loadBundled(): Promise<RawInstalledWidget[]> {
  let ids: string[];
  try {
    const response = await fetch(`${assetBase()}widgets/index.json`, { cache: "no-store" });
    if (!response.ok) return [];
    ids = (await response.json()) as string[];
  } catch {
    return [];
  }

  const out: RawInstalledWidget[] = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${assetBase()}widgets/${id}/manifest.json`, { cache: "no-store" });
      if (!response.ok) continue;
      out.push({
        manifest: await response.json(),
        dir: `public/widgets/${id}`,
        source: "bundled",
      });
    } catch {
      // 单个内置组件清单坏掉不该拖垮整个注册表
    }
  }
  return out;
}

async function loadUser(): Promise<RawInstalledWidget[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<RawInstalledWidget[]>("list_widgets");
  } catch {
    return [];
  }
}

function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}
