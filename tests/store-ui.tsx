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
  eq(
    buttons("Install all").length,
    0,
    "只有 1 条能装时不给批量按钮（批量是给一堆新包的）",
  );

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

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
