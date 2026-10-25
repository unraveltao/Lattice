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
  mergeCatalogues,
  parseCatalogue,
  sourceLabel,
  type Catalogue,
  type CatalogueEntry,
  type CatalogueNotice,
  type CataloguePackage,
  type CatalogueSource,
  type MergeConflict,
  type SourceSnapshot,
} from "../runtime/catalogue";
import { t } from "../runtime/i18n";
import { appBaseUrl, isTauri } from "../runtime/registry";
import { isOfficialCatalogue } from "./store";

/**
 * 合并之后的那一份目录。
 *
 * 商店的其余部分（卡片、批量安装、搜索）只认这一份 —— 它们不需要知道"共有几个源"。
 * 每源的读况在 `CatalogueView.sources` 里，给设置页与那几行状态用。
 */
export interface CatalogueSnapshot {
  catalogue: Catalogue | null;
  /** 丢弃了哪些条目、为什么 —— 界面折叠显示，不刷屏。多源时前面带源名 */
  warnings: string[];
  /** 一个字都没有可显示的时候才有值 */
  error: string | null;
  /** 官方那份的地址（"从哪儿读的"这句话在多源下已经说不准了，留作兜底） */
  origin: string;
  at: number;
  /** 读到了，但不是最新那份 —— 界面要说出来 */
  notice: CatalogueNotice | null;
}

export interface CatalogueView {
  /** 合并后的目录，商店只认这一份 */
  snapshot: CatalogueSnapshot;
  /** 每源的读况（含停用的，界面要能说"停用了"） */
  sources: SourceSnapshot[];
  /** 同一个 id 被多个源提供：谁赢、谁被盖住 */
  conflicts: MergeConflict[];
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

function emptySource(source: CatalogueSource, error: string, origin: string, at: number): SourceSnapshot {
  return { source, catalogue: null, warnings: [], error, origin, at, notice: null };
}

/** 把取回来的文本变成一份源的读况。解析失败时 `error` 有值、`catalogue` 是 null */
function readSource(
  source: CatalogueSource,
  text: string,
  origin: string,
  at: number,
  notice: CatalogueNotice | null,
): SourceSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return emptySource(source, t("the catalogue is not valid JSON: {error}", { error: String(error) }), origin, at);
  }

  const parsed = parseCatalogue(raw, dirOf(origin));
  if (!parsed.catalogue) {
    return emptySource(source, parsed.warnings[0] ?? t("the catalogue could not be read"), origin, at);
  }
  return {
    source,
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

/**
 * 读一个源。
 *
 * **只有官方那一份**在读不到时退回随应用发的那份（`bundled`）。别的源读不到就
 * 显示"读不到 + 上次读到的时间" —— 一份自定义源的名字底下列着演示目录的包，
 * 等于把包挂在错误的发布者名下，而界面上看不出来（0010 §3 第 4 条）。
 */
async function loadSource(source: CatalogueSource): Promise<SourceSnapshot> {
  const at = Date.now();
  const bundledUrl = `${appBaseUrl()}store/registry.json`;
  const official = source.kind === "url" && isOfficialCatalogue(source.url);
  const useBundled = source.kind === "bundled" || !source.url.trim();

  if (useBundled) {
    const bundled = await readBundled(bundledUrl);
    return "error" in bundled
      ? emptySource(source, bundled.error, bundledUrl, at)
      : readSource(source, bundled.text, bundledUrl, at, null);
  }

  const url = source.url.trim();
  if (!isTauri()) {
    return emptySource(source, t("a remote catalogue needs the desktop app — run npm run tauri:dev"), url, at);
  }

  let fetched: CatalogueText;
  try {
    fetched = await invoke<CatalogueText>("store_load_catalogue", { url });
  } catch (error) {
    if (!official) return emptySource(source, String(error), url, at);
    /*
     * 官方那份彻底读不到：Rust 那边连缓存都没有（第一次装、或者缓存被清过）。
     * 这时候退回内置那份，**但要说出来** —— 那份里的包是另一把钥匙签的，
     * 用户待会儿看到"发布者钥匙变了"的确认，得有前因后果。
     */
    const fallback = await readBundled(bundledUrl);
    if ("error" in fallback) return emptySource(source, String(error), url, at);
    return readSource(source, fallback.text, bundledUrl, at, {
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

  return readSource(source, fetched.text, url, at, notice);
}

/**
 * 读全部源，再合并成一张表。
 *
 * 几条别改回去的：
 *
 * - **并发取，逐源 `try`**。串行会让三份目录叠成三次等待；而一个源的失败绝不能
 *   变成"整间商店空白" —— 那是"我订阅了两个，其中一个挂了"最常见的坏结果。
 * - **停用的源不发请求**，但仍然出现在 `sources` 里：界面要能显示它"停用了"。
 * - **只有合并空了才算 `error`**。任何一个源读成功，商店就照常显示别家的东西。
 * - `warnings` 前面带源名：坏条目本来就会说出组件 id，但不说是哪个源给的，
 *   多源之后就没法排查了。
 */
export async function loadCatalogues(sources: CatalogueSource[]): Promise<CatalogueView> {
  const enabled = sources.filter((item) => item.enabled);
  const settled = await Promise.all(
    enabled.map((source) =>
      loadSource(source).catch((error) => emptySource(source, String(error), source.url, Date.now())),
    ),
  );

  const idle: SourceSnapshot[] = sources
    .filter((item) => !item.enabled)
    .map((source) => ({
      source,
      catalogue: null,
      warnings: [],
      error: null,
      origin: source.url,
      at: 0,
      notice: null,
    }));

  // 顺序与 `sources` 一致：合并的"先到先得"靠的就是这个顺序
  const ordered = sources
    .map((source) => settled.find((item) => item.source.id === source.id))
    .filter((item): item is SourceSnapshot => Boolean(item));

  const merged = mergeCatalogues(ordered);

  const warnings = ordered.flatMap((item) =>
    item.warnings.map((line) => `${sourceLabel(item)}: ${line}`),
  );

  const live = ordered.filter((item) => item.catalogue);
  const failures = ordered.filter((item) => !item.catalogue && item.error);
  const notices = ordered.filter((item) => item.notice);

  const single = enabled.length === 1 ? live[0]?.catalogue ?? null : null;
  const updated = live
    .map((item) => item.catalogue?.updated ?? "")
    .filter(Boolean)
    .sort()
    .pop() ?? "";

  const snapshot: CatalogueSnapshot = {
    catalogue:
      live.length === 0
        ? null
        : {
            schema: 1,
            name: single?.name ?? t("{count} sources", { count: enabled.length }),
            updated,
            base: single?.base ?? "",
            entries: merged.entries,
          },
    warnings,
    error:
      live.length === 0
        ? failures.length > 0
          ? failures
              .map((item) => `${sourceLabel(item)}: ${item.error ?? ""}`)
              .join(" · ")
          : t("no catalogue sources are turned on")
        : null,
    origin: ordered[0]?.origin ?? "",
    at: Date.now(),
    notice:
      notices.length === 0
        ? null
        : {
            kind: notices.some((item) => item.notice?.kind === "fallback") ? "fallback" : "stale",
            message: notices.map((item) => item.notice?.message ?? "").join("\n"),
          },
  };

  return { snapshot, sources: [...ordered, ...idle], conflicts: merged.conflicts };
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
