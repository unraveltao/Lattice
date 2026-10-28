/**
 * 目录缓存 / 断网兜底 / 默认源迁移。
 *
 * 这一页钉的是三件"平时看不见、坏了很难解释"的事：
 *
 *   1. **默认源是官方目录**，而旧盘上的状态（内置 + 空地址）会被迁移过去。
 *      不迁的话这个改动只对新装的机器生效 —— 用了一阵的人永远停在演示目录上。
 *   2. **旧的/兜底的目录要明说**。`notice` 有值时界面上必须出现那一条，
 *      而且**条目照常渲染**（不是整段变成错误块）—— 断网时还能装已经缓存的
 *      东西，这才是缓存的意义。
 *   3. **时间要写成人话**。"3 小时前"和 "3 小时 12 分前"对用户的判断没区别。
 *
 * 真正的网络与磁盘那一半在 `catalogue_policy.rs`（编解码、ETag、文件名）
 * 和 `store.rs::store_load_catalogue`（304 / 200 / 失败 + 缓存），
 * 那些只能在真机验，见 AGENTS 的验收清单。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { CatalogueSection, type StoreBinding } from "../src/platform/CatalogueSection";
import { describeAge, type CatalogueSnapshot } from "../src/platform/catalogue";
import {
  isOfficialCatalogue,
  migrateState,
  OFFICIAL_CATALOGUE_URL,
  useLattice,
  type CatalogueSource,
} from "../src/platform/store";
import type { Catalogue, CatalogueEntry, CataloguePackage } from "../src/runtime/catalogue";
import { sourceIdFor } from "../src/runtime/catalogue";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = "11".repeat(32);
const SIG = "22".repeat(64);
const SHA = "33".repeat(32);

function pkg(version: string): CataloguePackage {
  return {
    version,
    url: `http://x/store/packages/a-${version}.lattice`,
    sha256: SHA,
    size: 2048,
    signature: SIG,
    permissions: ["clock"] as never,
    notes: "",
  };
}

function entry(id: string, name: string): CatalogueEntry {
  return {
    id,
    name,
    description: `${name} from the catalogue`,
    author: "Lattice",
    icon: null,
    homepage: null,
    publisher: { name: "Lattice", key: KEY },
    versions: [pkg("1.0.0")],
  };
}

const catalogue: Catalogue = {
  schema: 1,
  name: "Test catalogue",
  updated: "2026-10-24",
  base: "http://x/store/",
  entries: [entry("lattice.clock", "Clock"), entry("lattice.note", "Note")],
};

function snapshot(notice: CatalogueSnapshot["notice"]): CatalogueSnapshot {
  return {
    catalogue,
    warnings: [],
    error: null,
    origin: "http://x/store/registry.json",
    at: Date.now(),
    notice,
  };
}

function binding(notice: CatalogueSnapshot["notice"]): StoreBinding {
  return {
    snapshot: snapshot(notice),
    sources: [],
    conflicts: [],
    sourceLabels: {},
    busy: false,
    busyId: null,
    installedVersions: new Map(),
    installedPermissions: new Map(),
    pinnedKeys: {},
    blockedKeys: [],
    reviews: {},
    onRefresh: () => {},
    onInstall: () => {},
    onBlockKey: () => {},
    onUnblockKey: () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. 官方目录的判定
// ---------------------------------------------------------------------------

eq(isOfficialCatalogue(OFFICIAL_CATALOGUE_URL), true, "官方地址认成官方");
eq(isOfficialCatalogue(` ${OFFICIAL_CATALOGUE_URL}/ `), true, "前后空格和尾斜杠不影响判定");
eq(isOfficialCatalogue(`${OFFICIAL_CATALOGUE_URL}?x=1`), false, "带 query 的不是官方那一份");
eq(isOfficialCatalogue(""), false, "空地址不是官方");
eq(
  isOfficialCatalogue("https://example.com/registry.json"),
  false,
  "别人的目录不是官方",
);

// ---------------------------------------------------------------------------
// 2. 老状态迁移：单值 catalogueSource → 源列表（0010）
// ---------------------------------------------------------------------------

const sourcesOf = (state: Record<string, unknown>) => state.sources as CatalogueSource[];

const migrated = migrateState({ catalogueSource: { kind: "bundled", url: "" } }, 0);
eq(
  sourcesOf(migrated).map((item) => [item.id, item.url]),
  [["official", OFFICIAL_CATALOGUE_URL]],
  "旧默认（内置 + 空地址）迁成官方那一条源",
);

const custom = migrateState({ catalogueSource: { kind: "url", url: "https://me.example/reg.json" } }, 0);
eq(
  sourcesOf(custom).map((item) => item.url),
  ["https://me.example/reg.json"],
  "用户自己填过的地址一个字都不动",
);
eq(
  sourcesOf(custom)[0].id,
  sourceIdFor("https://me.example/reg.json"),
  "自定义源的 id 由地址算出来（不是随便编一个）",
);
eq(
  "catalogueSource" in custom,
  false,
  "旧字段删掉了：一份事实不许有两个家，留着它下次读又会被当真",
);

eq(
  sourcesOf(migrateState({ placements: [] }, 0)).length,
  1,
  "连 catalogueSource 都没有的更早状态，也落到官方目录（不许出现空列表）",
);

const kept = migrateState({ catalogueSource: { kind: "bundled", url: "" } }, 1);
eq(
  sourcesOf(kept)[0].kind,
  "bundled",
  "v1 盘上主动选了内置的那份，迁成一条 bundled 源（不悄悄改成官方）",
);

// 新装：没有盘上状态时，store 的默认值本身就是官方那一份
eq(
  useLattice.getState().sources.map((item) => [item.id, item.url]),
  [["official", OFFICIAL_CATALOGUE_URL]],
  "默认只有一个源，就是官方那一份",
);

// 那一列动作：加 / 停用 / 排序 / 删，以及"最后一个删不掉"
const store = useLattice.getState();
store.addCatalogueSource({ kind: "url", url: "https://a.example/r.json" });
eq(
  useLattice.getState().sources.map((item) => item.id),
  ["official", "src-a-example-r-json"],
  "加一个源：排在后面",
);
eq(
  useLattice.getState().sources[1].enabled,
  true,
  "新加的源默认是启用的（不启用等于加了没用）",
);

store.addCatalogueSource({ kind: "url", url: "https://a.example/r.json" });
eq(useLattice.getState().sources.length, 2, "同一个地址再加一次不会多出一行");

store.updateCatalogueSource("official", { enabled: false });
eq(useLattice.getState().sources[0].enabled, false, "能停用一个源（地址留着，只是不参与合并）");

store.moveCatalogueSource("src-a-example-r-json", -1);
eq(
  useLattice.getState().sources.map((item) => item.id),
  ["src-a-example-r-json", "official"],
  "上移一格：顺序决定同 id 冲突谁赢",
);
store.moveCatalogueSource("src-a-example-r-json", -1);
eq(
  useLattice.getState().sources[0].id,
  "src-a-example-r-json",
  "已经在最上面时再上移什么也不做（不越界）",
);

store.removeCatalogueSource("official");
eq(useLattice.getState().sources.length, 1, "能删掉一个源");
store.removeCatalogueSource("src-a-example-r-json");
eq(useLattice.getState().sources.length, 1, "最后一个删不掉 —— 空商店用户没法自己修好");

// ---------------------------------------------------------------------------
// 3. 状态迁移：电池并进系统（0030，`STATE_VERSION` 3）
// ---------------------------------------------------------------------------

const v2 = {
  placements: [
    { instanceId: "b1", widgetId: "lattice.battery", x: 40, y: 60, w: 208, h: 132, layer: "top", clickThrough: false, pinned: false },
    { instanceId: "s1", widgetId: "lattice.sysmon", x: 300, y: 60, w: 268, h: 240, layer: "top", clickThrough: false, pinned: false },
    { instanceId: "n1", widgetId: "lattice.note", x: 10, y: 10, w: 240, h: 200, layer: "normal", clickThrough: false, pinned: false },
  ],
  configs: { b1: { warnBelow: 20 }, s1: { trace: true } },
  desktopRects: {
    b1: { x: 900, y: 40, w: 208, h: 132 },
    s1: { x: 1100, y: 40, w: 268, h: 240 },
  },
  trash: [
    { placement: { instanceId: "b9", widgetId: "lattice.battery", x: 0, y: 0, w: 240, h: 146, layer: "top", clickThrough: false, pinned: false }, at: 1 },
    { placement: { instanceId: "n9", widgetId: "lattice.note", x: 0, y: 0, w: 240, h: 200, layer: "normal", clickThrough: false, pinned: false }, at: 2 },
  ],
  installedIds: ["lattice.battery", "lattice.sysmon"],
  selectedInstanceId: "b1",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const v3 = migrateState(v2 as any, 2) as any;
const migratedBattery = v3.placements.find((item: any) => item.instanceId !== "b1" && item.widgetId === "lattice.sysmon");

eq(v3.placements.length, 3, "电池卡是被改写，不是被删掉（数量不变）");
eq(
  v3.placements.some((item: any) => item.widgetId === "lattice.battery"),
  false,
  "迁完之后盘上不再有 lattice.battery 的摆放",
);
eq(
  migratedBattery?.instanceId,
  v3.selectedInstanceId,
  "改写出来的那份拿到了新 instanceId，选中也跟着走",
);
eq(
  [migratedBattery?.w, migratedBattery?.h],
  [220, 176],
  "尺寸抬到装得下：208×132 → 220×176（宽抬到 minW，高留 16px 余量）",
);
eq(
  v3.configs[migratedBattery?.instanceId],
  { trace: false, cores: false, gpu: false, disk: false, network: false },
  "新实例带的是「只留电池」那几个开关",
);
eq("b1" in v3.configs, false, "老实例的配置删掉了 —— 留着它下次改开关会读到一份没人认领的值");
eq(
  v3.desktopRects[migratedBattery?.instanceId],
  { x: 900, y: 40, w: 220, h: 176 },
  "桌面上那次摆放跟着改指向，尺寸一起抬 —— 桌面窗口按它开，只抬 placement 的话真机上照样切半行",
);
eq("b1" in v3.desktopRects, false, "老矩形删掉了（不然下次投放会捡到一个孤儿）");

const migratedSysmon = v3.placements.find((item: any) => item.instanceId === "s1");
eq(migratedSysmon?.h, 328, "老系统卡 240 高装不下 0.3 的 278，抬到 328");
eq(v3.desktopRects.s1, { x: 1100, y: 40, w: 268, h: 328 }, "它的桌面矩形同样抬（同一条理由）");
eq(
  v3.placements.find((item: any) => item.instanceId === "n1"),
  v2.placements[2],
  "不认识的组件一个字都不动",
);
eq(v3.trash.length, 1, "回收站里指向电池的那条丢掉（恢复出来会是一张破卡）");
eq(v3.trash[0].placement.instanceId, "n9", "别的回收站条目留着");
eq(v3.installedIds, ["lattice.sysmon"], "已装列表里去掉电池");

const tall = migrateState(
  {
    placements: [
      { instanceId: "s2", widgetId: "lattice.sysmon", x: 0, y: 0, w: 268, h: 300, layer: "top", clickThrough: false, pinned: false },
    ],
    desktopRects: { s2: { x: 0, y: 0, w: 268, h: 420 } },
  } as any,
  2,
) as any;
eq(tall.placements[0].h, 300, "本来就够高的卡片不动（只抬不放）");
eq(tall.desktopRects.s2.h, 420, "桌面上被拖得更高的也不动");

const again = migrateState(v3, 3) as any;
eq(again.placements, v3.placements, "v3 再读一遍什么都不变（迁移只跑一次）");

// ---------------------------------------------------------------------------
// 4. 时间写成人话
// ---------------------------------------------------------------------------

const now = Date.UTC(2026, 9, 24, 12, 0, 0);
const ago = (seconds: number) => describeAge(now / 1000 - seconds, now);
eq(ago(30), "just now", "半分钟前是 just now");
eq(ago(300), "5 minutes ago", "5 分钟");
eq(ago(3 * 3600), "3 hours ago", "3 小时");
eq(ago(3 * 86400), "3 days ago", "3 天");

// ---------------------------------------------------------------------------
// 5. 界面：旧的/兜底的目录要说出来，但条目照常渲染
// ---------------------------------------------------------------------------

const stage = document.getElementById("stage")!;
const root = createRoot(stage);

async function render(notice: CatalogueSnapshot["notice"]): Promise<void> {
  await act(async () => {
    root.render(
      <CatalogueSection store={binding(notice)} tokens={[]} installedIds={new Set()} />,
    );
  });
  await sleep(40);
  /*
   * 目录段默认收着。这一页验的是"旧目录的条目照常渲染"，
   * 所以渲染完像用户那样点开一下 —— 折叠本身在 `store-ui` 里钉着。
   */
  const toggle = document.querySelector<HTMLButtonElement>(".lattice-lib-section-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") {
    act(() => toggle.click());
    await sleep(30);
  }
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");

async function main() {
  await render({
    kind: "stale",
    message: "https://x/registry.json could not be reached (timeout). Showing the copy from 3 hours ago.",
  });

  eq(text(".lattice-lib-note.is-stale .lattice-lib-note-title"), ["Showing an older copy"], "断网时标题写明是旧的一份");
  log(
    (document.querySelector(".lattice-lib-note.is-stale")?.textContent ?? "").includes("3 hours ago"),
    "提示里带上了这份目录有多旧",
  );
  eq(text(".lattice-card-id"), ["lattice.clock", "lattice.note"], "有旧目录时条目照常渲染（不是整段错误）");

  await render({
    kind: "fallback",
    message: "https://x/registry.json could not be reached. This is the catalogue that ships with the app.",
  });
  eq(text(".lattice-lib-note.is-stale .lattice-lib-note-title"), ["Offline"], "退回内置那份时标题写 Offline");

  await render(null);
  eq(document.querySelector(".lattice-lib-note.is-stale"), null, "正常读到目录时不显示这条提示");
  eq(text(".lattice-card-id"), ["lattice.clock", "lattice.note"], "正常状态下条目还在");

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
