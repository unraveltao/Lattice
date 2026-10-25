/**
 * 属性面板的结构检查：三段折叠 + 危险动作的位置。
 *
 * `tests/store-ui.tsx` 管的是组件库那一列；这一页只管 320px 的右栏，验两件事：
 *
 *   1. **一个面板只回答三件事**：它在哪儿（层级与尺寸）/ 它长什么样（外观）/
 *      它被允许做什么（权限与选项）。十一项控件平铺在一条滚不完的列里时，
 *      每一件看起来都同等要紧 —— 它们不是。
 *   2. **危险动作在最下面**：`Remove` 不许回到标题行。上一版它紧挨着"收起来"，
 *      想收面板的人点了它会删掉一个组件。
 *
 * 这两条都是"布局对了、某个星期一改又回去了"那一类：没有断言的话，谁把
 * `.lattice-danger-zone` 挪回 header 都不会报错，只会在用户那儿少一个组件。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { InspectorPanel } from "../src/platform/InspectorPanel";
import { useLattice, type Placement } from "../src/platform/store";
import { setLanguage } from "../src/runtime/i18n";
import type { WidgetRecord } from "../src/runtime/registry";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ID = "lattice.todo";

function record(): WidgetRecord {
  return {
    manifest: {
      id: ID,
      name: "Todo",
      version: "0.2.1",
      description: "待办",
      author: "Lattice",
      entry: "index.html",
      icon: "",
      size: { w: 240, h: 200, minW: 180, minH: 140 },
      layer: "desktop",
      interactive: true,
      permissions: ["storage"],
      config: [],
      /* 真实记录都过了一遍 normalizeManifest，所以帮助与变更记录一定在 */
      help: { sections: [{ title: "怎么用", items: ["点一下勾掉"] }] },
      changelog: [{ version: "0.2.1", changes: ["拖动排序"] }],
      appearance: undefined,
      network: undefined,
      sdk: undefined,
    } as never,
    source: "bundled",
    dir: "public/widgets/lattice.todo",
    entryUrl: `/widgets/${ID}/index.html`,
    iconUrl: null,
  };
}

function placement(instanceId: string): Placement {
  return {
    instanceId,
    widgetId: ID,
    x: 0,
    y: 0,
    w: 240,
    h: 200,
    layer: "desktop",
    clickThrough: false,
    pinned: false,
  };
}

const foldNames = () =>
  [...document.querySelectorAll(".lattice-panel-right .lattice-lib-section-name")].map(
    (node) => node.textContent?.trim() ?? "",
  );
const foldToggle = (label: string) => {
  const name = [...document.querySelectorAll(".lattice-panel-right .lattice-lib-section-name")].find(
    (node) => node.textContent?.trim() === label,
  );
  return name?.closest(".lattice-lib-section")?.querySelector<HTMLButtonElement>(
    ".lattice-lib-section-toggle",
  );
};
const expanded = (label: string) => foldToggle(label)?.getAttribute("aria-expanded");

async function main() {
  /*
   * 断言写在英文上，先固定语言：`systemLang()` 读的是浏览器语言，
   * 同一页在中文机器和英文机器上量出来的标题不是一个字符串。
   */
  setLanguage("en");

  /*
   * 属性面板读的是真 store（`useLattice`），浏览器里那份落在 localStorage。
   * 这一页只验布局，所以先存一份原样、跑完还回去 —— 否则跑完测试，
   * 开发服务器上那个应用会多出两个待办组件。
   */
  const KEY = "lattice.platform.v1";
  const before = localStorage.getItem(KEY);

  const records = new Map<string, WidgetRecord>([[ID, record()]]);

  /*
   * 水合是异步的：读完 localStorage 之前任何一次 set 都会写在沙子上 ——
   * 上面那行 `hydrated` 闸门拦住了写盘，但拦不住"读回来的空状态盖掉我的夹具"。
   * 所以等一拍再摆。
   */
  await sleep(150);
  act(() => {
    useLattice.setState({
      placements: [placement("i1"), placement("i2")],
      selectedInstanceId: "i1",
      grants: { [ID]: ["storage"] },
    });
  });
  await sleep(50);

  const stage = document.getElementById("stage")!;
  const root = createRoot(stage);
  act(() => {
    root.render(<InspectorPanel records={records} open onToggle={() => {}} />);
  });
  await sleep(80);

  const panel = document.querySelector<HTMLElement>(".lattice-panel-right")!;

  /*
   * ---- 1. 标题行只回答"收起来" ----
   *
   * 上一版这里并排两颗：移除（红的）+ 收起，中间 8px。危险动作和"关上这个东西"
   * 挨着，是整个面板里最贵的一次误触。
   */
  const headButtons = [...panel.querySelectorAll<HTMLElement>(".lattice-panel-head button")];
  eq(headButtons.length, 1, "标题行只剩一颗按钮");
  log(
    !headButtons.some((node) => node.classList.contains("is-danger")),
    "标题行里没有红色的危险按钮",
  );

  /*
   * ---- 2. 移除沉在面板最底部 ----
   *
   * 判据是**位置**，不是"有没有"：这颗按钮必须不在 header 里、在 danger zone 里、
   * 而 danger zone 是面板内容区的最后一个元素，并且上面有一条线把它和设置隔开。
   */
  const body = panel.querySelector<HTMLElement>(".lattice-panel-body")!;
  const dangerZone = body.querySelector<HTMLElement>(".lattice-danger-zone");
  log(Boolean(dangerZone), "面板底部有一条危险区");
  log(
    body.lastElementChild === dangerZone && parseFloat(getComputedStyle(dangerZone!).borderTopWidth) > 0,
    "危险区在内容区最后，并且和上面的设置隔了一条线",
  );
  log(
    dangerZone?.querySelector<HTMLElement>("button.lattice-btn.is-danger") !== null &&
      panel.querySelector(".lattice-panel-head .lattice-btn.is-danger") === null,
    "移除按钮在危险区里（不在标题行）",
  );

  /*
   * ---- 3. 三段折叠：第一段展开、后两段收着 ----
   *
   * 开合状态只活在这次会话里（不落盘），所以这里验的是"打开面板时的默认形状"。
   */
  eq(
    foldNames(),
    ["How to use", "Layer & size", "Appearance", "Permissions & options"],
    "面板分成四段：怎么用 + 三段设置",
  );
  eq(expanded("Layer & size"), "true", "层级与尺寸默认展开（选中最常做的事）");
  eq(expanded("Appearance"), "false", "外观默认收起");
  eq(expanded("Permissions & options"), "false", "权限与选项默认收起");
  log(
    panel.querySelector(".lattice-segment") !== null &&
      panel.querySelector(".lattice-tint-row") === null &&
      panel.querySelector(".lattice-perm-name") === null,
    "收着的段不渲染内容（不是画出来再藏起来）",
  );

  /*
   * ---- 4. 点开就展开，再点就收回去 ----
   *
   * 只验"能开"不够：收不回去的折叠等于一段永远占着位置的正文。
   */
  foldToggle("Appearance")!.click();
  await sleep(60);
  log(
    expanded("Appearance") === "true" && panel.querySelector(".lattice-tint-row") !== null,
    "点开外观：色板与浓度滑杆出现",
  );

  foldToggle("Appearance")!.click();
  await sleep(60);
  log(
    expanded("Appearance") === "false" && panel.querySelector(".lattice-tint-row") === null,
    "再点一次收回去（收起来是真的不画，不是藏一层）",
  );

  foldToggle("Permissions & options")!.click();
  await sleep(60);
  log(
    panel.querySelector(".lattice-perm-name") !== null &&
      panel.querySelector(".lattice-path") !== null,
    "点开权限与选项：权限开关和来源路径都在这一段里",
  );

  /*
   * ---- 5. 换选一个实例，折叠状态留着 ----
   *
   * 这是"只在会话里记"的具体含义：用户在调外观时点另一张卡片，面板不该
   * 把他刚摊开的那一段收回去 —— 那等于每次换选中都要重新点一遍。
   */
  act(() => {
    useLattice.setState({ selectedInstanceId: "i2" });
  });
  await sleep(80);
  log(
    expanded("Permissions & options") === "true" && expanded("Layer & size") === "true",
    "换选另一个实例之后，摊开的那几段还开着",
  );

  // 跑完把 localStorage 还回原样：这一页借的是真 store，别给开发服务器留脚印
  if (before === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, before);

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
