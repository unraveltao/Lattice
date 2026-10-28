/**
 * 全局搜索（第一层）：把「已装组件」和「商店目录条目」投影成同一张表，
 * 交给 `library-search.ts` 的打分器排序。
 *
 * 这一层**只搜清单里的元数据**（名字 / id / 描述 / 作者 / 权限），不搜用户数据。
 * 边界不是偷懒：组件 `storage` 里的正文宿主根本读不到 —— 桥是"组件问宿主"的
 * 单向通道，要搜就得先加一条"把正文吐出来"的跨进程协议，那是另一件事
 * （而且真做了的话，全局浮层里会显示便签正文，截图和旁人一眼就能看到）。
 *
 * # 为什么不塞进 `library-search.ts`
 *
 * 那个文件承诺"没有清单校验、没有 React"，所以 `tests/library-search.html` 能
 * 直接 import 它。把 `catalogue.ts` 拉进去会让"怎么打分"和"给什么打分"耦合。
 * 这里只做投影与合并，打分仍然只有 `matchScore` 一处 —— 别在这里再写一套
 * 命中规则，那正是 `CatalogueSection` 之前犯过的错。
 */

import { isNewer, latestPackage, type CatalogueEntry } from "./catalogue";
import { rankWidgets, type SearchableWidget } from "./library-search";
import type { WidgetRecord } from "./registry";

/** 一条搜索结果落在哪儿 —— 决定"选中之后跳去哪里" */
export type SearchKind =
  /** 已装（清单里有，`installedIds` 也有）：可能已经摆在画布上 */
  | "installed"
  /** 能装但没装，而且不在目录里（随包发的那些） */
  | "available"
  /** 商店目录里的条目（没装） */
  | "store";

export interface SearchTarget extends SearchableWidget {
  kind: SearchKind;
  /** 清单 id。两个来源都有，是去重的键 */
  id: string;
  /** 已装 / 能装才有：图标、版本、入口 */
  record: WidgetRecord | null;
  /** 商店才有：跳转和"装哪个版本"要靠它 */
  entry: CatalogueEntry | null;
  /** 画布上摆了几份。商店条目恒为 0 */
  placed: number;
  /** 商店里有更高的版本时是那个号，否则 `null` */
  update: string | null;
}

/**
 * 目录条目借一层 `manifest` 的皮去打分。
 *
 * 权限取**最新版本**（`versions` 按版本降序，见 `catalogue.ts:72`）：那是点
 * "安装"真会装下去的那份。旧版本要联网、新版本不要，搜 `network` 就不该命中它。
 * `CatalogueSection` 之前把所有版本的权限拍平成一个大字符串，正好是反例 ——
 * 那样搜到的是一个你装不上的权限。
 *
 * 没有 `layer`：层是**摆放**的属性（`Placement.layer`），商店条目还没摆过。
 */
export function searchableFromEntry(entry: CatalogueEntry): SearchableWidget {
  const pkg = latestPackage(entry);
  return {
    manifest: {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      permissions: pkg?.permissions ?? [],
    },
  };
}

export interface BuildSearchInput {
  /** 清单（`loadRegistry` 的结果），已装与能装的都从这里来 */
  records: readonly WidgetRecord[];
  /** 已装的是哪些 id —— 和 `LibraryPanel` 用同一个判据，否则搜索和面板会各说各话 */
  installedIds: ReadonlySet<string>;
  placements: readonly { widgetId: string }[];
  entries: readonly CatalogueEntry[];
}

/**
 * 合成一张表。
 *
 * **同一个 id 只出一条，已装优先。** 理由三条：
 *
 * 1. 用户对"这个组件"只有一个心智对象。同屏出现"Clock（已装）"和"Clock（商店）"
 *    等于问他"你要哪个 Clock"，而答案是同一个。
 * 2. 已装那条能做的事更多（定位到画布），商店那条只能跳商店。
 * 3. 仓库里已有同一判据的两处先例：`LibraryPanel.tsx:154`（目录里有的不进
 *    "可安装"）、`CatalogueSection.tsx:222`（已装且无新版的静默掉）。
 *
 * 已装那条**顺带报商店里的新版本**（`update`），这样"该更新了"不会因为去重而
 * 消失 —— 否则用户搜索时看到的是"已装"，而面板里写着"有新版本"。
 *
 * 同分时已装自然压过商店：`rankWidgets` 是稳定排序，而这里已装的先 push。
 * **不要**为此改 `MATCH_TIERS` 或 `FIELD_WEIGHTS` —— 那会同时改变库里两段的排序。
 */
export function buildSearchTargets(input: BuildSearchInput): SearchTarget[] {
  const byId = new Map<string, CatalogueEntry>();
  for (const entry of input.entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);

  const placed = new Map<string, number>();
  for (const item of input.placements) {
    placed.set(item.widgetId, (placed.get(item.widgetId) ?? 0) + 1);
  }

  const out: SearchTarget[] = [];
  const seen = new Set<string>();

  for (const record of input.records) {
    const id = record.manifest.id;
    const installed = input.installedIds.has(id);
    if (!installed && byId.has(id)) continue; // 目录里有的留给下面那条（同一个 id 只出一条）
    const entry = byId.get(id) ?? null;
    const latest = entry ? latestPackage(entry) : null;
    seen.add(id);
    out.push({
      kind: installed ? "installed" : "available",
      id,
      manifest: record.manifest,
      record,
      entry,
      placed: placed.get(id) ?? 0,
      update:
        installed && latest && isNewer(latest.version, record.manifest.version)
          ? latest.version
          : null,
    });
  }

  for (const entry of byId.values()) {
    if (seen.has(entry.id)) continue;
    out.push({
      kind: "store",
      id: entry.id,
      ...searchableFromEntry(entry),
      record: null,
      entry,
      placed: 0,
      update: null,
    });
  }

  return out;
}

/** 过滤 + 排序。和库里那两段走同一个打分器，只是喂的东西不同 */
export function rankTargets(targets: readonly SearchTarget[], tokens: string[]): SearchTarget[] {
  return rankWidgets(targets, tokens);
}

/**
 * 选中一条结果之后去哪儿。
 *
 * 两个去处，按"离用户想去的地方多近"排：
 *
 *   - `canvas`：已装**且摆在画布上** → 滚到那张卡。这是绝大多数情况 ——
 *     搜索的第一用途就是"我记得桌面上有它，在哪儿来着"。
 *   - `library`：其余全部（装了没摆 / 能装没装 / 商店条目）→ 翻组件库并把
 *     搜索词设成那个 id。这三种对用户是同一件事："去那一屏找它"，分三个分支
 *     只会有三种说法。
 *
 * 多份摆放时取**数组最后一个**：`placements` 的顺序就是 z 序（`store.ts`
 * 的 `bringToFront` 靠挪数组位置实现），最后一份在最上面。滚到被压在下面
 * 那份等于没滚。
 *
 * 判据放在这个纯函数里而不是 `App.tsx` 里，是因为它是**搜索的语义**的一部分：
 * 断言页能直接钉住"哪种结果去画布、多份时选哪一份"，不用挂整个应用。
 */
export type SearchHop =
  | { kind: "canvas"; instanceId: string }
  | { kind: "library"; widgetId: string };

export function hopFor(
  target: SearchTarget,
  placements: readonly { instanceId: string; widgetId: string }[],
): SearchHop {
  if (target.kind === "installed") {
    const same = placements.filter((item) => item.widgetId === target.id);
    const top = same[same.length - 1];
    if (top) return { kind: "canvas", instanceId: top.instanceId };
  }
  return { kind: "library", widgetId: target.id };
}
