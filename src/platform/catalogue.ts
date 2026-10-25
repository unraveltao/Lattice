/**
 * 棂 / Lattice —— 组件目录的客户端
 *
 * `runtime/catalogue.ts` 只做纯逻辑（校验、选版本、算安装计划），这里负责
 * 真正跑起来的那一半：取目录、下载包、验签安装、回滚、写举报。
 *
 * # 两条路
 *
 * - **远端目录**（默认）：`store_load_catalogue` 走 Rust 的 WinHTTP，带磁盘缓存
 *   和 ETag。**必须走 Rust**：主窗口 `fetch` 一个第三方域名会被 CORS 挡掉，
 *   而目录作者没理由为了 Lattice 去配响应头。
 * - **内置目录**：`<应用源>/store/registry.json`，包也在同一个目录下，是随应用
 *   一起发的演示目录。走浏览器 `fetch`（同源），拿到字节后 base64 送进 Rust。
 *
 * 远端读不到时**退回内置那份**，但界面上必须写明"这是随应用带的那份" ——
 * 悄悄换一份内容给用户看，比空白更糟。
 *
 * 两条路最后都汇到 `store_install`：**校验只在 Rust 里做一次**。
 * 前端不做验签 —— 前端跑的是不可信代码的宿主页，让它"顺便校验一下"
 * 只会让人以为多了一道保险。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  parseCatalogue,
  type Catalogue,
  type CatalogueEntry,
  type CataloguePackage,
} from "../runtime/catalogue";
import { t } from "../runtime/i18n";
import { appBaseUrl, isTauri } from "../runtime/registry";
import type { CatalogueSource } from "./store";

/**
 * 这一份目录是"怎么读到的"。
 *
 * `stale` 和 `fallback` 都会让界面多一行说明。两者的区别是**内容来自谁**：
 * 前者还是那个远端目录（只是旧了），后者已经换成内置那份了 —— 里面的包
 * 是另一把钥匙签的，装的时候会多一次确认。
 */
export interface CatalogueNotice {
  kind: "stale" | "fallback";
  message: string;
}

export interface CatalogueSnapshot {
  catalogue: Catalogue | null;
  /** 丢弃了哪些条目、为什么 —— 界面折叠显示，不刷屏 */
  warnings: string[];
  /** 一个字都没有可显示的时候才有值 */
  error: string | null;
  /** 目录地址，界面上显示"从哪儿读的" */
  origin: string;
  at: number;
  /** 读到了，但不是最新那份 —— 界面要说出来 */
  notice: CatalogueNotice | null;
}

/** Rust 那边 `store_load_catalogue` 的返回 */
interface CatalogueText {
  text: string;
  /** unix 秒 */
  at: number;
  stale: boolean;
  error: string | null;
  notModified: boolean;
}

export interface StoreInstallResult {
  id: string;
  version: string;
  previousVersion: string | null;
  backedUp: boolean;
}

export interface BackupInfo {
  version: string | null;
  at: number | null;
}

export interface RollbackResult {
  version: string | null;
  replaced: string | null;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
}

function dirOf(url: string): string {
  const cut = url.lastIndexOf("/");
  return cut >= 0 ? url.slice(0, cut + 1) : url;
}

/**
 * "3 小时前" 这种人话。
 *
 * 不引日期库：这里只有四档，而且**故意不精确** —— 用户要判断的是"这份东西
 * 是不是我刚才看的"，不需要知道是 3 小时 12 分还是 3 小时 47 分。
 */
export function describeAge(atSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(now / 1000 - atSeconds));
  if (seconds < 90) return t("just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return t("{minutes} minutes ago", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 36) return t("{hours} hours ago", { hours });
  const days = Math.round(hours / 24);
  return t("{days} days ago", { days });
}

function empty(error: string, origin: string, at: number): CatalogueSnapshot {
  return { catalogue: null, warnings: [], error, origin, at, notice: null };
}

/** 把取回来的文本变成快照。解析失败时 `error` 有值、`catalogue` 是 null */
function read(text: string, origin: string, at: number, notice: CatalogueNotice | null): CatalogueSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return empty(t("the catalogue is not valid JSON: {error}", { error: String(error) }), origin, at);
  }

  const parsed = parseCatalogue(raw, dirOf(origin));
  if (!parsed.catalogue) {
    return empty(parsed.warnings[0] ?? t("the catalogue could not be read"), origin, at);
  }
  return {
    catalogue: parsed.catalogue,
    warnings: parsed.warnings,
    error: null,
    origin,
    at,
    notice,
  };
}

/** 取随应用一起发的那份目录。同源，不走 Rust，也没有缓存可言 */
async function readBundled(url: string): Promise<{ text: string } | { error: string }> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return {
        error: t("the bundled catalogue is missing (HTTP {status}) — run npm run store:index", {
          status: response.status,
        }),
      };
    }
    return { text: await response.text() };
  } catch (error) {
    return { error: String(error) };
  }
}

export async function loadCatalogue(source: CatalogueSource): Promise<CatalogueSnapshot> {
  const at = Date.now();
  const bundledUrl = `${appBaseUrl()}store/registry.json`;
  const useBundled = source.kind === "bundled" || !source.url.trim();

  if (useBundled) {
    const bundled = await readBundled(bundledUrl);
    return "error" in bundled ? empty(bundled.error, bundledUrl, at) : read(bundled.text, bundledUrl, at, null);
  }

  const url = source.url.trim();
  if (!isTauri()) {
    return empty(t("a remote catalogue needs the desktop app — run npm run tauri:dev"), url, at);
  }

  let fetched: CatalogueText;
  try {
    fetched = await invoke<CatalogueText>("store_load_catalogue", { url });
  } catch (error) {
    /*
     * 远端彻底读不到：Rust 那边连缓存都没有（第一次装、或者缓存被清过）。
     * 这时候退回内置那份，**但要说出来** —— 那份里的包是另一把钥匙签的，
     * 用户待会儿看到"发布者钥匙变了"的确认，得有前因后果。
     */
    const fallback = await readBundled(bundledUrl);
    if ("error" in fallback) return empty(String(error), url, at);
    return read(fallback.text, bundledUrl, at, {
      kind: "fallback",
      message: t("{url} could not be reached ({reason}). This is the catalogue that ships with the app.", {
        url,
        reason: String(error),
      }),
    });
  }

  const notice: CatalogueNotice | null = fetched.stale
    ? {
        kind: "stale",
        message: t("{url} could not be reached ({reason}). Showing the copy from {age}.", {
          url,
          reason: fetched.error ?? t("no reason given"),
          age: describeAge(fetched.at),
        }),
      }
    : null;

  return read(fetched.text, url, at, notice);
}

function toBase64(bytes: Uint8Array): string {
  // 分块拼接：`String.fromCharCode(...bytes)` 在几十 KB 上就会爆调用栈
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 装一个来自目录的包。
 *
 * **怎么取包由包的地址决定，不看目录来源**。目录退回内置那份之后，
 * `source.kind` 仍然是 `"url"`，但条目里的地址已经指向应用自己的源了 ——
 * 按来源判断的话，这条路会让 WinHTTP 去连 `http://tauri.localhost`，
 * 而那个域名只活在 WebView2 里，必然失败。判据只有一条：**和应用同源就
 * 在渲染进程里 `fetch`，否则交给 Rust**（跨域 + 大小上限 + 形状约束都在那边）。
 *
 * `entry.publisher.key` 必须存在：`planInstall` 已经把"没签名"挡在界面外了，
 * 这里是第二道 —— 万一哪天有人绕过界面直接调，也不该装进一个没签名的包。
 */
export async function installCataloguePackage(
  entry: CatalogueEntry,
  pkg: CataloguePackage,
): Promise<StoreInstallResult> {
  const key = entry.publisher?.key;
  if (!key) {
    throw new Error(t("{id} has no publisher key — refusing to install an unsigned package", { id: entry.id }));
  }

  const common = {
    id: entry.id,
    version: pkg.version,
    sha256: pkg.sha256,
    signature: pkg.signature,
    publicKey: key,
  };

  if (pkg.url.startsWith(appBaseUrl())) {
    const response = await fetch(pkg.url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(t("could not download {url} (HTTP {status})", { url: pkg.url, status: response.status }));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return invoke<StoreInstallResult>("store_install", { ...common, bytes: toBase64(bytes) });
  }

  const download = await invoke<DownloadResult>("store_download", { url: pkg.url });
  return invoke<StoreInstallResult>("store_install", { ...common, path: download.path });
}

export async function backupInfo(id: string): Promise<BackupInfo | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<BackupInfo | null>("widget_backup_info", { id });
  } catch {
    return null;
  }
}

export async function rollbackWidget(id: string): Promise<RollbackResult> {
  return invoke<RollbackResult>("widget_rollback", { id });
}

export interface ReportInput {
  id: string;
  version: string;
  reason: string;
  note: string;
  stars: number | null;
}

/** 写一份举报文件，返回它的路径（界面把它显示出来，让用户自己去发） */
export async function reportWidget(input: ReportInput): Promise<string> {
  return invoke<string>("store_report", {
    id: input.id,
    version: input.version,
    reason: input.reason,
    note: input.note,
    stars: input.stars,
  });
}
