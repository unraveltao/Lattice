/**
 * 组件库（含目录段）的组件级检查。
 *
 * `tests/catalogue.html` 钉的是纯逻辑（校验、选版本、安装计划）；这一页把
 * **真正的 LibraryPanel** 挂起来，验的是接线：
 *
 *   1. 目录条目该显示哪个按钮（Install / Update to x / Up to date / Unsigned / 换钥匙）
 *   2. 更新时"多要的权限"有没有被标出来
 *   3. 已安装卡片上的评分、回滚、举报真的接到了回调上
 *   4. 目录里有的条目不在"可安装"里重复出现（同一件事不能有两个说法）
 *   5. 搜索会同时过滤目录段
 *
 * 这些都属于"纯函数对了、界面还是不对"那一类：按钮没接上回调、文案用了
 * 未过滤的那份数据。纯函数测试一条都抓不到。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { LibraryPanel } from "../src/platform/LibraryPanel";
import type { StoreBinding } from "../src/platform/CatalogueSection";
import type { Catalogue, CatalogueEntry, CataloguePackage } from "../src/runtime/catalogue";
import { DEMO_PUBLISHER_KEY } from "../src/runtime/catalogue";
import type { WidgetRecord } from "../src/runtime/registry";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = "11".repeat(32);
const OTHER_KEY = "44".repeat(32);
const SIG = "22".repeat(64);
const SHA = "33".repeat(32);

function record(
  id: string,
  name: string,
  version: string,
  permissions: string[] = [],
  help: { title: string; items: string[] }[] = [],
  changelog: { version: string; date?: string; changes: string[] }[] = [],
): WidgetRecord {
  return {
    manifest: {
      id,
      name,
      version,
      description: `${name} description`,
      author: "Lattice",
      entry: "index.html",
      icon: "",
      size: { w: 240, h: 140, minW: 120, minH: 80 },
      layer: "desktop",
      interactive: true,
      permissions: permissions as never,
      config: [],
      /*
       * 真实记录都过了一遍 `normalizeManifest`，所以 `help` / `changelog`
       * 一定存在（哪怕内容是空的）。手搓的 fixture 也得照这个形状来，
       * 否则组件里 `hasHelp(undefined)` 会当场炸 —— 而这正是它该炸的地方。
       */
      help: { sections: help },
      changelog,
      appearance: undefined,
      network: undefined,
      sdk: undefined,
    } as never,
    source: "bundled",
    dir: `public/widgets/${id}`,
    entryUrl: `/widgets/${id}/index.html`,
    iconUrl: null,
  };
}

function pkg(version: string, permissions: string[] = ["clock"]): CataloguePackage {
  return {
    version,
    url: `http://x/store/packages/a-${version}.lattice`,
    sha256: SHA,
    size: 2048,
    signature: SIG,
    permissions: permissions as never,
    notes: "",
  };
}

function entry(
  id: string,
  name: string,
  versions: CataloguePackage[],
  publisherKey: string | null = KEY,
): CatalogueEntry {
  return {
    id,
    name,
    description: `${name} from the catalogue`,
    author: "Lattice",
    icon: null,
    homepage: null,
    publisher: publisherKey ? { name: "Lattice", key: publisherKey } : null,
    versions,
  };
}

const catalogue: Catalogue = {
  schema: 1,
  name: "Test catalogue",
  updated: "2026-10-24",
  base: "http://x/store/",
  entries: [
    // 已装 1.0.0 → 更新到 1.1.0，并且多要一项权限
    entry("lattice.clock", "Clock", [pkg("1.1.0", ["clock", "network"]), pkg("1.0.0", ["clock"])]),
    // 没装过 → Install
    entry("lattice.note", "Note", [pkg("0.1.0", ["storage"])]),
    // 已装且同版本 → Up to date
    entry("lattice.todo", "Todo", [pkg("0.2.0", ["storage"])]),
    // 没签名 → 不能装
    entry("lattice.media", "Media", [pkg("0.1.0", ["media:control"])], null),
    // 换过钥匙 → 必须点一次确认
    entry("lattice.sysmon", "System", [pkg("0.1.0", ["system:monitor"])], OTHER_KEY),
  ],
};

const widgets = [
  record("lattice.clock", "Clock", "1.0.0", ["clock"]),
  // 只有待办带说明：用来验"没写说明的组件不画那颗 ?"
  record(
    "lattice.todo",
    "Todo",
    "0.2.0",
    ["storage"],
    [{ title: "Typing", items: ["Text saves as you type"] }],
    [{ version: "0.2.0", date: "2026-10-24", changes: ["Drag to reorder"] }],
  ),
  record("lattice.sysmon", "System", "0.1.0", ["system:monitor"]),
  record("lattice.note", "Note", "0.1.0", ["storage"]),
];

const calls: string[] = [];

const store: StoreBinding = {
  snapshot: {
    catalogue,
    warnings: ["lattice.media 0.1.0: dropped (signature must be 128 hex characters)"],
    error: null,
    origin: "http://x/store/registry.json",
    at: Date.now(),
    notice: null,
  },
  // 单一源的常态：不铺"每源读况"那一段，卡片上也不带来源角标
  sources: [],
  conflicts: [],
  sourceLabels: {},
  busy: false,
  busyId: null,
  installedVersions: new Map([
    ["lattice.clock", "1.0.0"],
    ["lattice.todo", "0.2.0"],
    ["lattice.sysmon", "0.1.0"],
  ]),
  installedPermissions: new Map([
    ["lattice.clock", ["clock"]],
    ["lattice.todo", ["storage"]],
    ["lattice.sysmon", ["system:monitor"]],
  ]),
  pinnedKeys: { "lattice.sysmon": KEY },
  blockedKeys: [],
  reviews: {},
  onRefresh: () => calls.push("refresh"),
  onInstall: (item, version, acceptNewKey) =>
    calls.push(`install:${item.id}:${version.version}:${acceptNewKey ? "trust" : "normal"}`),
  onBlockKey: (key) => calls.push(`block:${key}`),
  onUnblockKey: (key) => calls.push(`unblock:${key}`),
};

const root = createRoot(document.getElementById("stage")!);

/**
 * 目录段默认是收着的（真实界面就这样），卡片要等用户点开才铺出来。
 * 断言前得像用户那样点一下 —— 顺便也就把"点得开"这件事本身验了。
 *
 * "Cannot be installed" 是套在目录段里的第二层，也要单独点开：
 * 没签名的那几条收在那一层里。
 */
function expandSections() {
  for (const label of ["Test catalogue", "Cannot be installed"]) {
    const toggle = [...document.querySelectorAll<HTMLButtonElement>(".lattice-lib-section-toggle")].find(
      (node) => node.querySelector(".lattice-lib-section-name")?.textContent === label,
    );
    if (toggle && toggle.getAttribute("aria-expanded") === "false") {
      act(() => toggle.click());
    }
  }
}

/** 把两段重新收起来（验"搜索强制展开"时要用） */
function collapseSections() {
  for (const label of ["Test catalogue", "Cannot be installed"]) {
    const toggle = [...document.querySelectorAll<HTMLButtonElement>(".lattice-lib-section-toggle")].find(
      (node) => node.querySelector(".lattice-lib-section-name")?.textContent === label,
    );
    if (toggle && toggle.getAttribute("aria-expanded") === "true") {
      act(() => toggle.click());
    }
  }
}

function render(
  overrides: Partial<Parameters<typeof LibraryPanel>[0]> = {},
  { expand = true }: { expand?: boolean } = {},
) {
  const props = {
    widgets,
    /*
     * sysmon **故意不装**：它和目录里的钥匙不一致，装了就只会进统计行
     * （已装 + 没有新版本 = 不出卡片），那张"信任新钥匙"的卡就测不到了。
     */
    installedIds: new Set(["lattice.clock", "lattice.todo"]),
    errors: [],
    loading: false,
    notice: null,
    onDismissNotice: () => {},
    onOpenWidgetsDir: () => {},
    onAdd: () => {},
    onInstall: () => {},
    onInstallPack: () => {},
    onUninstall: (item: WidgetRecord) => calls.push(`uninstall:${item.manifest.id}`),
    store,
    backups: { "lattice.clock": { version: "0.9.0", at: 1 } },
    ratings: { "lattice.todo": { stars: 3, version: "0.2.0", at: "2026-10-24" } },
    onRollback: (item: WidgetRecord) => calls.push(`rollback:${item.manifest.id}`),
    onRate: (item: WidgetRecord, stars: number) => calls.push(`rate:${item.manifest.id}:${stars}`),
    onReport: (item: WidgetRecord) => calls.push(`report:${item.manifest.id}`),
    /*
     * 首次引导（0011）默认按"按过知道了"渲染：这一页大部分断言验的是商店那几段，
     * 一进来顶上多一张三步卡只会让下面每一处的位置都变。要验引导本身的两条
     * 断言自己把它翻过来（`onboarded: false` + 清空 `installedIds`）。
     */
    onboarded: true,
    onDismissOnboarding: () => calls.push("dismiss-onboarding"),
    /* 回收站默认空着：这一页验的是商店那几段，多一段"最近删除"只会挪位置 */
    trash: [],
    onRestoreTrash: (instanceId: string) => calls.push(`restore-trash:${instanceId}`),
    onDeleteTrash: (instanceId: string) => calls.push(`delete-trash:${instanceId}`),
    onEmptyTrash: () => calls.push("empty-trash"),
    onAddSource: () => calls.push("add-source"),
    open: true,
    onToggle: () => {},
    ...overrides,
  };
  act(() => {
    root.render(<LibraryPanel {...props} />);
  });
  if (expand) expandSections();
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter((node) =>
    (node.textContent ?? "").trim().toLowerCase().includes(label.toLowerCase()),
  ) as HTMLButtonElement[];

async function main() {
  /*
   * 折叠是这一版新加的默认状态：面板一打开只摊开"已安装"，
   * 目录和可安装两段收着。先验这条，再像用户那样点开继续往下测。
   */
  render({}, { expand: false });
  await sleep(60);

  eq(
    document.querySelector(".lattice-store .lattice-lib-section-toggle")?.getAttribute("aria-expanded"),
    "false",
    "目录段默认收起（aria-expanded 也要跟着说）",
  );
  eq(document.querySelectorAll(".lattice-card.is-store").length, 0, "收起时不铺卡片");
  log(
    document.querySelector(".lattice-store .lattice-lib-count")?.textContent === "5",
    "收起时标题上仍然写着这一段有几条",
  );

  expandSections();
  await sleep(40);
  log(document.querySelectorAll(".lattice-card.is-store").length > 0, "点开之后卡片才出现");

  // ---- 1. 目录段 ----
  eq(text(".lattice-store .lattice-lib-section-title")[0], "Test catalogue5", "目录段用的是目录自己的名字");
  log(text(".lattice-store-warnings summary")[0]?.includes("1 entries were skipped") ?? false, "丢弃的条目折叠显示");

  /*
   * 分堆规则：已安装且没有新版本的条目**一张卡都不出**（它在 Installed 里
   * 已经有一张了），只留一行统计。剩下的按"要不要动手"分两堆。
   */
  eq(
    text(".lattice-lib-group-name")[0]?.replace(/\d+$/, ""),
    "Needs a decision",
    "有换钥匙的条目时，这一堆不叫 Can be installed（那会是假话）",
  );
  eq(
    [...document.querySelectorAll(".lattice-card.is-store")].length,
    4,
    "5 条里 1 条已装且最新 -> 只出 4 张卡（去重）",
  );
  eq(
    text(".lattice-lib-section-name").includes("Cannot be installed"),
    true,
    "没签名的条目单独收一层（它装不了，但得说清为什么）",
  );
  eq(
    text(".lattice-lib-section-name").includes("Nothing to install"),
    false,
    "那一层不再叫 Nothing to install（已安装的重复卡片已经从这里拿掉了）",
  );
  /*
   * 目录段没有"全部安装"。更新可能多要权限，批量更新等于把"逐条确认"那道闸
   * 绕过去 —— 而那道闸正是权限变更提示存在的理由。这条以前只在"能装的不足两条"
   * 时才成立，现在一条都没有：那颗按钮已经拿掉了。
   */
  eq(buttons("Install all").length, 0, "目录段不给“全部安装”（每一条都要单独确认）");

  /*
   * 去重：已安装且没有新版本的条目只能出现一次。
   *
   * 唯一允许的重复是"已安装 + 目录里真有新版" —— 目录段那张是**更新卡**，
   * 上面写着 `Update to 1.1.0`，不是把同一张卡再摆一遍。所以这里不只数次数，
   * 还要求重复的那张确实是更新卡：否则"去重"会退化成"什么都不显示"。
   */
  const panelIds = [...document.querySelectorAll(".lattice-card-id")].map((node) => node.textContent);
  const duplicated = [...new Set(panelIds.filter((id, index) => panelIds.indexOf(id) !== index))];
  eq(duplicated, ["lattice.clock"], "只有“已装且真有新版”的时钟允许再出现一次");
  log(
    [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")]
      .filter((node) => node.textContent?.includes("lattice.clock"))
      .every((node) => node.textContent?.includes("Update to") ?? false),
    "允许重复的那张必须是更新卡（不然就是同一张卡摆了两遍）",
  );

  // 已装 + 最新：不出卡片，只在统计行里交代一句
  const quiet = document.querySelector(".lattice-store-quiet")?.textContent?.replace(/\s+/g, " ") ?? "";
  log(
    ![...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].some((node) =>
      node.textContent?.includes("lattice.todo"),
    ),
    "已装且最新的条目不重复出卡",
  );
  log(quiet.includes("1 up to date"), "统计行里说清有几条已经是最新的");
  log(quiet.includes("under Installed"), "统计行指明去上面那段看");

  const clockCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.clock"),
  );
  log(Boolean(clockCard), "时钟出现在目录段");
  log(clockCard?.textContent?.includes("Update to 1.1.0") ?? false, "已装旧版本 -> Update to 1.1.0");
  log(
    clockCard?.querySelector(".lattice-perm.is-new")?.textContent === "Network access",
    "多要的权限被单独标出来",
  );
  log(clockCard?.textContent?.includes("Adds Network access") ?? false, "更新按钮下面说清会多要什么");

  const noteCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.note"),
  );
  log(noteCard?.textContent?.includes("Install") ?? false, "没装过 -> Install");

  const mediaCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.media"),
  );
  log(
    mediaCard?.textContent?.includes("No publisher signature") ?? false,
    "没签名的条目不能装（不是藏起来，而是说明为什么）",
  );

  const sysmonCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.sysmon"),
  );
  log(
    sysmonCard?.textContent?.includes("Publisher key changed") ?? false,
    "换钥匙要说出来",
  );
  log(
    sysmonCard?.textContent?.includes("Block the old key instead") ?? false,
    "换钥匙的对话框里有“旧的那把别再用了”这条路",
  );

  /*
   * ---- 1b. 目录条目也是一行：静止只留名字，详情按需 ----
   *
   * 和组件库那几行同源：十几条目录摊成十几张卡时，一屏只放得下三张，而其中
   * 大多数只是"哦，还有这么个东西"。但**三种情况必须默认摊开** —— 换钥匙、
   * 被拉黑、更新多要权限。那三件事得先读再点，收起来等于把"要不要信它"
   * 变成一次盲点，而这一段存在的全部理由就是让人先看一眼。
   */
  /*
   * 51px 是"一行 + 一行说明 + 一颗 28px 的 Install"量出来的。上限给到 56 是为了
   * 不把行高钉死在某一次字号调整上 —— 钉住的是"它是一行"，不是某个具体像素。
   */
  const noteRowHeight = Math.round(noteCard?.getBoundingClientRect().height ?? 0);
  log(noteRowHeight > 0 && noteRowHeight <= 56, `能装的目录条目是一行（量到 ${noteRowHeight}px）`);
  eq(
    [".lattice-card-meta", ".lattice-perm-list", ".lattice-store-key"].map(
      (selector) => getComputedStyle(noteCard!.querySelector(selector)!).display,
    ),
    ["none", "none", "none"],
    "静止时不画版本 / 权限 / 指纹（节点还在，展开不用重建）",
  );
  log(
    getComputedStyle(noteCard!.querySelector(".lattice-card-desc")!).display !== "none",
    "说明留一行 —— 装不装它，取决于它是干什么的",
  );
  noteCard!.querySelector<HTMLButtonElement>(".lattice-card-more")!.click();
  await sleep(60);
  log(
    getComputedStyle(noteCard!.querySelector(".lattice-perm-list")!).display !== "none" &&
      getComputedStyle(noteCard!.querySelector(".lattice-store-key")!).display !== "none",
    "点开之后权限和发布者指纹一起出现",
  );
  log(
    clockCard!.classList.contains("is-expanded") &&
      getComputedStyle(clockCard!.querySelector(".lattice-perm-list")!).display !== "none",
    "更新会多要权限的那张默认摊开（先读再点）",
  );
  log(sysmonCard!.classList.contains("is-expanded"), "换了钥匙的那张默认摊开");

  calls.length = 0;
  sysmonCard
    ?.querySelectorAll<HTMLButtonElement>(".lattice-btn")
    .forEach((node) => {
      if ((node.textContent ?? "").includes("Block the old key")) node.click();
    });
  await sleep(20);
  eq(calls, [`block:${KEY}`], "拉黑旧钥匙时带的是钉住的那把，不是目录里新的那把");

  // ---- 2. 目录条目不在"可安装"里重复 ----
  const allIds = text(".lattice-card-id");
  eq(
    allIds.filter((id) => id === "lattice.clock").length,
    2,
    "时钟只出现两次：已安装一份、目录一份（不在可安装里再来一份）",
  );

  // ---- 3. 点按钮 ----
  calls.length = 0;
  clockCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-primary")?.click();
  noteCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-primary")?.click();
  sysmonCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-danger")?.click();
  await sleep(20);
  eq(
    calls,
    [
      "install:lattice.clock:1.1.0:normal",
      "install:lattice.note:0.1.0:normal",
      "install:lattice.sysmon:0.1.0:trust",
    ],
    "三个按钮各自带着正确的包与信任标记",
  );

  // ---- 4. 已安装卡片：评分 / 回滚 / 举报 ----
  const installedClock = [...document.querySelectorAll<HTMLElement>(".lattice-card")].find(
    (node) =>
      node.textContent?.includes("lattice.clock") && !node.classList.contains("is-store"),
  );
  log(Boolean(installedClock), "已安装段里也有时钟");

  calls.length = 0;
  installedClock?.querySelectorAll<HTMLButtonElement>(".lattice-star")[3]?.click();
  installedClock
    ?.querySelector<HTMLButtonElement>(".lattice-link-btn.is-tiny")
    ?.click();
  buttons("report")[0]?.click();
  await sleep(20);
  eq(
    calls,
    ["rate:lattice.clock:4", "rollback:lattice.clock", "report:lattice.clock"],
    "评分、回滚、举报都接上了",
  );

  // 已有 3 星的待办：再点第 3 颗应该是"取消"，不是"打 3 星"
  const installedTodo = [...document.querySelectorAll<HTMLElement>(".lattice-card")].find(
    (node) => node.textContent?.includes("lattice.todo") && !node.classList.contains("is-store"),
  );
  calls.length = 0;
  installedTodo?.querySelectorAll<HTMLButtonElement>(".lattice-star")[2]?.click();
  await sleep(20);
  eq(calls, ["rate:lattice.todo:0"], "点同一颗星是取消评分");

  // ---- 5. 待复核的组件带 Review 标记 ----
  render({ store: { ...store, reviews: { "lattice.clock": { version: "1.1.0", added: ["network"], at: "" } } } });
  await sleep(60);
  const reviewChip = [...document.querySelectorAll(".lattice-card")].find(
    (node) => node.textContent?.includes("lattice.clock") && node.textContent?.includes("Review"),
  );
  log(Boolean(reviewChip), "有待复核权限的组件在卡片上带 Review");

  // ---- 5b. 被拉黑的发布者 / 目录落后 ----
  /*
   * 这两条都只能在界面上验：纯函数只回答"该不该装"，
   * 而这里要看的是"卡片有没有把那句话说出来、按钮是不是真的没了"。
   */
  const BLOCKED_KEY = "77".repeat(32);
  render({
    store: {
      ...store,
      snapshot: {
        ...store.snapshot!,
        catalogue: {
          ...catalogue,
          entries: [
            ...catalogue.entries,
            entry("lattice.weather", "Weather", [pkg("1.0.0", ["network"])], BLOCKED_KEY),
            entry("lattice.legacy", "Legacy", [pkg("1.0.0", ["clock"])], KEY),
          ],
        },
      },
      blockedKeys: [BLOCKED_KEY],
      installedVersions: new Map([...store.installedVersions, ["lattice.legacy", "2.0.0"]]),
    },
    /*
     * legacy 要真的"已安装"，否则这个状态在现实里不存在 ——
     * `older`（目录比本地旧）本来就只可能发生在装过的组件上。
     * 装了之后它进的是统计行，不再出卡片。
     */
    installedIds: new Set(["lattice.clock", "lattice.todo", "lattice.legacy"]),
  });
  await sleep(60);

  const cardOf = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
      node.textContent?.includes(id),
    );

  const weatherCard = cardOf("lattice.weather");
  log(weatherCard?.textContent?.includes("Blocked") ?? false, "被拉黑的发布者：卡片上写 Blocked");
  log(
    weatherCard?.textContent?.includes("You blocked this publisher key") ?? false,
    "被拉黑的发布者：说清为什么不能装（不是灰一颗按钮了事）",
  );
  log(
    !weatherCard?.querySelector(".lattice-btn.is-primary"),
    "被拉黑的发布者：没有安装按钮",
  );

  calls.length = 0;
  weatherCard
    ?.querySelectorAll<HTMLButtonElement>(".lattice-btn")
    .forEach((node) => {
      if ((node.textContent ?? "").includes("Unblock")) node.click();
    });
  await sleep(20);
  eq(calls, [`unblock:${BLOCKED_KEY}`], "解黑带着完整钥匙（界面只显示指纹，回调要拿全的）");

  /*
   * 目录比本地旧：这条现在只在统计行里出现（已装的条目不再单独出卡）。
   * 关键在于**不能说成"最新"** —— "我有 2.0.0、目录只到 1.0.0"和
   * "我和目录一样新"是两件事。
   */
  const legacyQuiet = document.querySelector(".lattice-store-quiet")?.textContent ?? "";
  log(!cardOf("lattice.legacy"), "已装且目录落后的条目也不重复出卡");
  log(legacyQuiet.includes("1 older than your copy"), "目录比本地旧：统计行里点名，不谎称 up to date");

  // 旧钥匙已经被拉黑时，就别再给一次"拉黑旧钥匙"的按钮
  render({
    store: { ...store, blockedKeys: [KEY] },
  });
  await sleep(60);
  const sysmonBlocked = cardOf("lattice.sysmon");
  log(
    sysmonBlocked?.textContent?.includes("The old key is blocked") ?? false,
    "旧钥匙已拉黑：换钥匙卡片改成陈述，不再给按钮",
  );
  log(
    !(sysmonBlocked?.textContent?.includes("Block the old key instead") ?? false),
    "旧钥匙已拉黑：按钮消失",
  );

  // ---- 6. 卡片上的 `?` 只在写了说明的组件上出现 ----
  render();
  await sleep(60);

  /*
   * 按 `.lattice-card-id` 认卡片，不按整段文字：便签卡片的说明文字里就写着
   * "lattice.note"，`textContent.includes(id)` 会认错人 —— 这种坑只在
   * 真的把界面挂起来的时候才会露出来。
   */
  const idOf = (node: HTMLElement) => node.querySelector(".lattice-card-id")?.textContent?.trim() ?? "";
  const cardById = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(".lattice-card")].find((node) => idOf(node) === id);

  eq(document.querySelectorAll(".lattice-card-help").length, 1, "只有写了说明的组件才有 ?");
  log(Boolean(cardById("lattice.todo")?.querySelector(".lattice-card-help")), "? 长在写了说明的那张卡上");
  log(
    !cardById("lattice.clock")?.querySelector(".lattice-card-help"),
    "没写说明的组件不画 ?（按钮不该是个空入口）",
  );

  cardById("lattice.todo")?.querySelector<HTMLButtonElement>(".lattice-card-help")?.click();
  await sleep(40);
  const helpDialog = document.querySelector(".lattice-modal.is-help");
  log(Boolean(helpDialog), "点 ? 打开说明框");
  log(helpDialog?.textContent?.includes("Typing") ?? false, "说明框里是清单里的那一节");
  log(
    helpDialog?.textContent?.includes("Text saves as you type") ?? false,
    "条目也照原样带过来",
  );
  log(helpDialog?.textContent?.includes("What changed") ?? false, "变更记录收在 What changed 里");
  helpDialog?.querySelector<HTMLButtonElement>(".lattice-icon-btn")?.click();
  await sleep(40);
  eq(document.querySelector(".lattice-modal.is-help"), null, "关掉之后框就没了");

  /*
   * ---- 8. 公开的演示钥匙不算身份 ----
   *
   * 内置目录（随应用发的那份）用仓库里那把公开钥匙签，远端目录用发布者自己的
   * 钥匙。同一条目在两处有两把钥匙，于是"从内置目录装过"的人一切源就会看到
   * "Publisher key changed" —— 而那是一次没发生过的换人。
   *
   * 钉住公开钥匙不该产生这个提示；钉住**别的**钥匙当然还要提示（下面第二条）。
   */
  render({ store: { ...store, pinnedKeys: { "lattice.note": DEMO_PUBLISHER_KEY } } });
  await sleep(60);
  const noteDemoPin = cardById("lattice.note");
  log(
    noteDemoPin?.textContent?.includes("Install") ?? false,
    "钉的是公开演示钥匙 -> 照常 Install，不弹换钥匙",
  );
  log(
    !(noteDemoPin?.textContent?.includes("Publisher key changed") ?? false),
    "钉的是公开演示钥匙 -> 不说\"换人了\"",
  );

  render({ store: { ...store, pinnedKeys: { "lattice.note": OTHER_KEY } } });
  await sleep(60);
  const noteRealPin = cardById("lattice.note");
  log(
    noteRealPin?.textContent?.includes("Publisher key changed") ?? false,
    "钉的是别的发布者钥匙 -> 照样要人点头（这道闸没被上面的例外拆掉）",
  );

  /*
   * ---- 9. 组件库的行：静止一行，详情按需 ----
   *
   * 这一段的判据是**量出来的**，不是"看起来更安静"：行高多少、静止时哪几块
   * 不画、行尾那几颗动作能不能误触、展开之后版本和来源出不出来。
   *
   * 为什么要钉：这一列的本职是让人一行行扫过去。谁要是哪天把说明、权限、
   * 五星重新摊回每一行，界面不会报错 —— 它只会悄悄从"一屏十几行"退回"一屏四行"。
   */
  render();
  await sleep(60);

  const rowOf = (id: string) =>
    [...document.querySelectorAll<HTMLElement>(".lattice-card.is-row")].find((node) => idOf(node) === id);
  const todoRow = rowOf("lattice.todo");
  log(Boolean(todoRow), "已安装的组件在组件库里是一行（不是一张卡）");

  const rowHeight = todoRow?.getBoundingClientRect().height ?? 0;
  log(rowHeight > 0 && rowHeight <= 40, `静止的行高 ≤ 40px（量到 ${Math.round(rowHeight)}）`);

  eq(
    [".lattice-card-desc", ".lattice-card-meta", ".lattice-card-rating"].map(
      (selector) => getComputedStyle(todoRow!.querySelector(selector)!).display,
    ),
    ["none", "none", "none"],
    "静止时不画说明 / 版本 / 评分（节点还在，展开不用重建）",
  );

  /*
   * 行尾只留 `⋯`：`?` / 举报 / 卸载都按用途下到了展开区，最底下是危险区。
   *
   * 钉住的是"主行动和危险动作不挨着"。上一版五颗挤在行尾（还靠 hover 才亮），
   * 一列十五行就是七十五个按钮悬在名字边上等着误点 —— 而"读它"和"卸载它"
   * 长成一排时，手指分不出来。
   */
  const stripButtons = [...todoRow!.querySelectorAll<HTMLElement>(".lattice-card-actions button")];
  log(
    stripButtons.length === 1 && stripButtons[0].classList.contains("lattice-card-more"),
    "已安装的行尾只剩一颗 ⋯（举报 / 卸载都不在行尾）",
  );
  log(
    todoRow!.querySelector(".lattice-card-actions .lattice-card-danger") === null &&
      todoRow!.querySelector(".lattice-card-danger") !== null,
    "危险动作在展开区里，不挂在行尾那排上",
  );

  todoRow!.querySelector<HTMLButtonElement>(".lattice-card-more")!.click();
  await sleep(60);
  const expandedMeta = todoRow!.querySelector(".lattice-card-meta");
  log(
    getComputedStyle(expandedMeta!).display !== "none" &&
      (expandedMeta?.textContent ?? "").includes("Bundled"),
    "点开之后版本、作者和来源一起出现",
  );

  const dangerZone = todoRow!.querySelector<HTMLElement>(".lattice-card-danger");
  log(
    dangerZone !== null &&
      todoRow!.lastElementChild === dangerZone &&
      getComputedStyle(dangerZone).display === "flex" &&
      parseFloat(getComputedStyle(dangerZone).borderTopWidth) > 0,
    "举报与卸载沉在展开区的最后一行，和上面的信息隔一条线",
  );

  // 一次只开一行：开第二行，第一行自己收回去
  rowOf("lattice.clock")!.querySelector<HTMLButtonElement>(".lattice-card-more")!.click();
  await sleep(60);
  log(!todoRow!.classList.contains("is-expanded"), "展开第二行时第一行自己收回去");

  // ---- 7. 搜索同时过滤目录段，而且无视折叠 ----
  render();
  await sleep(60);
  collapseSections();
  await sleep(40);
  eq(document.querySelectorAll(".lattice-card.is-store").length, 0, "搜索前先把目录段收起来");

  const search = document.querySelector<HTMLInputElement>(".lattice-lib-search-input");
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(search, "media");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(80);
    eq(
      document.querySelector(".lattice-store .lattice-lib-section-toggle")?.getAttribute("aria-expanded"),
      "true",
      "搜索强制展开：收着的时候也能看见命中项（搜到了看不见比搜不到更像坏了）",
    );
    eq(text(".lattice-card-id"), ["lattice.media"], "搜索后只剩命中的目录条目");
  } else {
    log(false, "找不到搜索框");
  }

  /*
   * ---- 10. 左栏的开合入口只剩一个，而且收起后整条竖条都能点 ----
   *
   * 三线在顶栏（`App.tsx`），所以这里验的是这一栏的两端：标题行不许再有
   * 第二颗"收起"，收起之后也不许只剩一个 16px 的箭头让人去瞄。
   */
  render();
  await sleep(60);
  eq(
    [...document.querySelectorAll<HTMLElement>(".lattice-panel-left .lattice-panel-head button")].map(
      (node) => node.getAttribute("aria-label"),
    ),
    ["Open widgets folder"],
    "标题行只剩打开文件夹一颗（收起挪去顶栏三线，同一件事不说两遍）",
  );

  render({ open: false });
  await sleep(60);
  const rail = document.querySelector<HTMLElement>(".lattice-panel-left.is-collapsed .lattice-panel-rail");
  log(
    rail !== null &&
      rail.tagName === "BUTTON" &&
      (rail.textContent ?? "").includes("Widgets") &&
      rail.getBoundingClientRect().height > 100,
    "收起后整条竖条就是那颗按钮（命中区是 40px × 面板高，不是一个 16px 的箭头）",
  );

  /*
   * ---- 11. 首次引导卡（0011）----
   *
   * 判据本身在 `tests/onboarding.html` 钉着；这里只验接线：什么时候画出来、
   * 卡里有什么、两颗按钮真的调到了那两件事。
   */
  const guide = () => document.querySelector<HTMLElement>(".lattice-firstrun");

  render({ installedIds: new Set(), onboarded: false });
  await sleep(60);

  /*
   * 上一节（第 7 段）在搜索框里留了"media"，而 `render()` 复用同一个挂载点 ——
   * 组件状态不会跟着 props 重置。引导卡在搜索中**本来就不该出现**，先白拿这一条，
   * 再把搜索清掉验它该出现。
   */
  log(guide() === null, "搜索中不铺引导卡（那时候“装一个”连对象都没有）");
  const searchInput = document.querySelector<HTMLInputElement>(".lattice-lib-search-input");
  if (searchInput) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(searchInput, "");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(60);
  }

  log(guide() !== null, "空机器上库面板顶部有引导卡");
  eq(document.querySelectorAll(".lattice-firstrun-steps li").length, 3, "三步，一步不多");
  const guideButtons = [...(guide()?.querySelectorAll("button") ?? [])].map((node) =>
    (node.textContent ?? "").trim(),
  );
  log(guideButtons.includes("Add another source"), "卡里有“加一个别的源”");
  log(guideButtons.includes("Got it"), "卡里有“知道了”（不装也能收掉它）");
  log(
    !text(".lattice-lib-note-title").includes("The platform is empty"),
    "引导出现时那段“平台还是空的”不再铺（同一句话不说两遍）",
  );

  // 点两颗按钮，验它真的叫到了 callback 上
  const byLabel = (label: string) =>
    [...(guide()?.querySelectorAll("button") ?? [])].find(
      (node) => (node.textContent ?? "").trim() === label,
    );
  const addSource = byLabel("Add another source");
  const gotIt = byLabel("Got it");
  if (addSource) {
    act(() => addSource.click());
  }
  if (gotIt) {
    act(() => gotIt.click());
  }
  log(calls.includes("add-source"), "点“加一个别的源”调到了送你去源列表的那个回调");
  log(calls.includes("dismiss-onboarding"), "点“知道了”调到了记下这件事的那个回调");

  // 装过就不出现；按过也不出现 —— 两个条件任缺一个都不该铺这张卡
  render({ installedIds: new Set(["lattice.clock"]), onboarded: false });
  await sleep(60);
  log(guide() === null, "装了一件之后卡自己退场");
  render({ installedIds: new Set(), onboarded: true });
  await sleep(60);
  log(guide() === null, "按过“知道了”之后不再出现");

  /*
   * 目录区见底时那一句：源里一条都没有 → 说"这个目录是空的"，并给一颗
   * "加一个来源"。判据在 `runtime/onboarding.ts`，这里验它真的铺出来了、按钮接上了。
   */
  render({
    installedIds: new Set(),
    onboarded: true,
    store: { ...store, snapshot: { ...store.snapshot!, catalogue: { ...catalogue, entries: [] } } },
  });
  await sleep(60);
  const emptyNote = [...document.querySelectorAll<HTMLElement>(".lattice-lib-note.is-more")].find(
    (node) => (node.textContent ?? "").includes("This catalogue is empty."),
  );
  log(emptyNote !== undefined, "源里一条都没有 → 目录区底下说“这个目录是空的”");
  log(
    emptyNote !== undefined &&
      [...emptyNote.querySelectorAll("button")].some(
        (node) => (node.textContent ?? "").trim() === "Add a source",
      ),
    "那句话旁边就是“加一个来源”，不是只让人自己去翻设置",
  );

  /*
   * ---- 12. 回收站（有内容才画）----
   *
   * 判据（7 天 / 20 条 / 同一实例一个坑 / `canRestore`）在 `tests/trash.html` 里
   * 钉着；这一段验的是接线：空着连标题都不出、恢复按钮按"组件还装着"变灰、
   * 两颗删除按钮真的叫到了回调、以及清空是两段式（第一下只换文案）。
   */
  const trashSection = () =>
    [...document.querySelectorAll<HTMLElement>(".lattice-lib-section")].find((node) =>
      (node.querySelector(".lattice-lib-section-name")?.textContent ?? "").includes(
        "Recently removed",
      ),
    );
  const sectionAction = () =>
    [
      ...(trashSection()?.querySelectorAll<HTMLButtonElement>(
        ".lattice-lib-section-action button",
      ) ?? []),
    ].map((node) => (node.textContent ?? "").trim());
  const pressAction = (label: string) => {
    const button = [
      ...(trashSection()?.querySelectorAll<HTMLButtonElement>(
        ".lattice-lib-section-action button",
      ) ?? []),
    ].find((node) => (node.textContent ?? "").trim() === label);
    if (button) act(() => button.click());
    return button !== undefined;
  };

  render({ trash: [] });
  await sleep(60);
  log(trashSection() === undefined, "回收站空着时连标题都不出");

  const nowMs = Date.now();
  render({
    trash: [
      { placement: { instanceId: "clock#a", widgetId: "lattice.clock" }, at: nowMs - 30_000 },
      { placement: { instanceId: "gone#b", widgetId: "demo.gone" }, at: nowMs - 3_600_000 },
    ],
  });
  await sleep(60);

  log(trashSection() !== undefined, "里面有东西才铺这一段");
  eq(
    trashSection()?.querySelector(".lattice-lib-count")?.textContent,
    "2",
    "标题行右边是条数",
  );

  // 和别的段一样默认收着，点标题才画行
  const trashToggle = trashSection()?.querySelector<HTMLButtonElement>(
    ".lattice-lib-section-toggle",
  );
  if (trashToggle) {
    act(() => trashToggle.click());
    await sleep(60);
  }
  eq(
    [...document.querySelectorAll(".lattice-trash-row .lattice-card-name")].map(
      (node) => node.textContent?.trim() ?? "",
    ),
    ["Clock", "demo.gone"],
    "装着的显示名字，没装的回落到 id（不是一条空行）",
  );
  const whens = [...document.querySelectorAll(".lattice-trash-when")].map(
    (node) => node.textContent?.trim() ?? "",
  );
  log(whens.length === 2 && whens.every((line) => line.length > 0), "每条都写着多久以前删的");
  log(
    whens[1]?.includes("Its widget isn't installed") === true,
    "组件不在的时候，说明行写清了为什么不能恢复",
  );

  const restoreButtons = [
    ...document.querySelectorAll<HTMLButtonElement>(".lattice-trash-row button"),
  ].filter((node) => (node.textContent ?? "").trim() === "Restore");
  eq(restoreButtons.length, 2, "两条各有一颗 Restore");
  log(restoreButtons[0]?.disabled === false, "组件还装着 → Restore 可点");
  log(restoreButtons[1]?.disabled === true, "组件没装 → Restore 是灰的");
  const firstRestore = restoreButtons[0];
  if (firstRestore) {
    act(() => firstRestore.click());
  }
  log(calls.includes("restore-trash:clock#a"), "点 Restore 调到的是那一条的 instanceId");

  const trashGlyphs = [
    ...document.querySelectorAll<HTMLButtonElement>(".lattice-trash-row .lattice-icon-btn"),
  ];
  eq(trashGlyphs.length, 2, "每条还有一个彻底删掉的垃圾桶");
  const firstGlyph = trashGlyphs[0];
  if (firstGlyph) {
    act(() => firstGlyph.click());
  }
  log(calls.includes("delete-trash:clock#a"), "垃圾桶调到的是彻底删除，不是恢复");

  eq(sectionAction(), ["Empty"], "“清空”一开始只有一颗按钮");
  log(pressAction("Empty"), "第一下只把按钮换掉");
  await sleep(60);
  eq(sectionAction(), ["Empty?", "Keep"], "第一下之后是“确定清空？”加“留着”");
  log(!calls.includes("empty-trash"), "第一下还没真的清（这一栏本身就是最后一层撤销）");
  log(pressAction("Keep"), "旁边那颗“留着”也在");
  await sleep(60);
  eq(sectionAction(), ["Empty"], "按“留着”就退回去");
  pressAction("Empty");
  await sleep(60);
  pressAction("Empty?");
  await sleep(60);
  log(calls.includes("empty-trash"), "两下之后才真的清空");

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
