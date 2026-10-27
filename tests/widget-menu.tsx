/**
 * 卡片右键菜单（`WidgetMenu`）：三条动作、四条关门的路、不出屏。
 *
 * 这一页只管菜单本身，不挂画布也不挂 iframe —— 菜单是个独立组件，给它一个
 * `target` 就能验。
 *
 *   1. **它真的在 body 上**（portal）。卡片是 `overflow: hidden` 的，菜单要是
 *      长在卡片里，靠近边缘的那一份会被自己的圆角切掉一半。
 *   2. **三条动作各自落到 store 上**：层级是**一行切换**（标签跟着当前层级翻）、
 *      复制是"再多一份、挪 16px、选中新的那份"、移除是"少一份 + 留撤销快照"。
 *   3. **关门的四条路**：Esc / 点别处 / 点菜单自己不算 / 贴边时夹回窗口内。
 *
 * 第 3 条里"点菜单自己不算"最容易漏：`pointerdown` 在捕获阶段就监听的话，
 * 点任何一行都会先把菜单关掉，然后那次 click 落在空气上 —— 看起来像按钮失灵。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { WidgetMenu, type WidgetMenuTarget } from "../src/platform/WidgetMenu";
import { useLattice, type Placement } from "../src/platform/store";
import { setLanguage } from "../src/runtime/i18n";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ID = "lattice.todo";

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

const target = (patch: Partial<WidgetMenuTarget> = {}): WidgetMenuTarget => ({
  instanceId: "i1",
  name: "Todo",
  iconUrl: null,
  x: 120,
  y: 120,
  ...patch,
});

const menu = () => document.querySelector<HTMLElement>(".lattice-menu.is-cursor");
const rowText = () =>
  [...(menu()?.querySelectorAll(".lattice-menu-label") ?? [])].map((node) =>
    node.textContent?.trim(),
  );

async function main() {
  // 断言写在英文上：`systemLang()` 读的是浏览器语言，中文机器上量出来的文案不一样
  setLanguage("en");

  /*
   * 菜单读的是真 store（`useLattice`），浏览器里那份落在 localStorage。
   * 借一份、跑完还回去 —— 否则跑完测试，开发服务器上那个应用会多出两个组件。
   */
  const KEY = "lattice.platform.v1";
  const before = localStorage.getItem(KEY);

  await sleep(150);
  act(() => {
    useLattice.setState({
      placements: [placement("i1"), placement("i2")],
      selectedInstanceId: "i1",
      lastClosed: null,
      // 上一轮跑完留下的配置不许漏进这一轮：下面要验"复制把配置也带走了"
      configs: {},
    });
  });
  // 原件先改一项设置，才验得出"复制出来那份是不是回到了出厂值"
  act(() => {
    useLattice.getState().setConfig("i1", "title", "Hello");
  });
  await sleep(50);

  const root = createRoot(document.getElementById("stage")!);
  let closed = 0;
  const onClose = () => {
    closed += 1;
  };
  const open = async (next: WidgetMenuTarget) => {
    act(() => {
      root.render(<WidgetMenu target={next} onClose={onClose} />);
    });
    await sleep(60);
  };

  /*
   * ---- 1. 长在 body 上，形状对 ----
   */
  await open(target());
  log(menu() !== null, "菜单出现了");
  log(menu()?.parentElement === document.body, "菜单 portal 到 body（不受卡片 overflow 裁切）");
  eq(menu()?.getAttribute("role"), "menu", "有 role=menu");
  eq(
    rowText(),
    ["Todo", "Bring to top", "Duplicate", "Remove"],
    "四行：组件名 / 层级 / 复制 / 移除",
  );
  log(
    menu()?.querySelector(".lattice-menu-row.is-static") !== null,
    "组件名那一行是 is-static（点它不该有反应）",
  );
  log(
    menu()?.querySelector(".lattice-menu-row.is-danger") !== null,
    "移除那一行是 is-danger（红的那一档）",
  );
  eq(
    menu()?.querySelector(".lattice-menu-hint")?.textContent?.trim(),
    "Stays in your library.",
    "移除下面一行小字：删的是这一份，不是这个组件",
  );

  /*
   * ---- 2. 点菜单自己身上不算"点别处" ----
   *
   * 判据是 `closed` 还是 0：如果 pointerdown 把菜单关了，后面那次 click 就落在
   * 空气上 —— 表现是"按钮点了没反应"，而这条断言先把这个坑钉住。
   */
  const danger = menu()!.querySelector<HTMLElement>(".lattice-menu-row.is-danger")!;
  act(() => {
    danger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await sleep(40);
  eq(closed, 0, "在菜单里按下不会先把它关掉");

  /*
   * ---- 3. 层级：一行切换，标签说的是"点下去会变成什么" ----
   *
   * 不摆两行、也不灰掉一行：卡片标题条上那个 chip 已经写着现在在哪一层，
   * 所以这里钉的是"标签跟着翻"。
   */
  const layerRow = () =>
    [...menu()!.querySelectorAll<HTMLElement>(".lattice-menu-row")].find((node) =>
      /^(Bring to top|Send to back)$/.test(node.textContent?.trim() ?? ""),
    )!;
  eq(
    useLattice.getState().placements[0].layer,
    "desktop",
    "夹具那一份在桌面层（所以菜单该说「提到最上层」）",
  );
  act(() => {
    layerRow().click();
  });
  await sleep(60);
  eq(useLattice.getState().placements[0].layer, "top", "点一下：提到最上层");
  eq(closed, 1, "改完层级自己关门");

  await open(target());
  eq(layerRow().textContent?.trim(), "Send to back", "已经在最上层时，标签翻成「沉到桌面层」");
  act(() => {
    layerRow().click();
  });
  await sleep(60);
  eq(useLattice.getState().placements[0].layer, "desktop", "再点一下：沉回桌面层");
  eq(closed, 2, "改完层级自己关门（第二次）");

  /*
   * ---- 4. 复制：多一份、挪一格、配置跟着、选中新的那一份 ----
   */
  await open(target());
  const prior = useLattice.getState().placements;
  const duplicateRow = [...menu()!.querySelectorAll<HTMLElement>(".lattice-menu-row")].find(
    (node) => node.textContent?.trim() === "Duplicate",
  )!;
  act(() => {
    duplicateRow.click();
  });
  await sleep(80);
  const after = useLattice.getState().placements;
  eq(after.length, prior.length + 1, "多了一份");
  const copy = after[after.length - 1];
  log(copy.instanceId !== "i1" && copy.instanceId.startsWith(`${ID}#`), "新的那一份有自己的实例 id");
  eq(
    [copy.widgetId, copy.x - prior[0].x, copy.y - prior[0].y, copy.layer],
    [ID, 16, 16, "desktop"],
    "复制的是同一个组件，位置挪一格，层级跟着原件",
  );
  eq(
    useLattice.getState().configs[copy.instanceId],
    { title: "Hello" },
    "每实例配置也跟着走（不然复制出来那份悄悄回到出厂值）",
  );
  log(
    useLattice.getState().configs.i1 !== useLattice.getState().configs[copy.instanceId],
    "配置是复制一份、不是同一个对象（改新的那份不该动到原件）",
  );
  eq(useLattice.getState().selectedInstanceId, copy.instanceId, "选中跟着新的那一份（和从库里拖一份出来同一个规矩）");
  eq(closed, 3, "复制完自己关门");

  /*
   * ---- 5. 点移除：那一份真的没了，还留了撤销快照 ----
   *
   * 这里重新取一次那一行：上面几段各自 `open()` 过，手里那个 DOM 节点是哪一次
   * 渲染留下的说不清。按现在的选择器再拿一遍，才不会点到一棵已经摘下来的树。
   */
  const removeRow = menu()!.querySelector<HTMLElement>(".lattice-menu-row.is-danger")!;
  act(() => {
    removeRow.click();
  });
  await sleep(60);
  eq(
    useLattice.getState().placements.map((item) => item.instanceId),
    ["i2", copy.instanceId],
    "移除只拿走被右键的那一份（第 4 段复制出来的那份还在）",
  );
  eq(useLattice.getState().lastClosed?.placement.instanceId, "i1", "留了一份撤销快照（8 秒反悔）");
  eq(closed, 4, "点完自己关门");

  /*
   * ---- 6. Esc / 点别处 ----
   */
  await open(target({ instanceId: "i2" }));
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await sleep(40);
  eq(closed, 5, "Esc 关门");

  await open(target({ instanceId: "i2" }));
  act(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await sleep(40);
  eq(closed, 6, "点别处关门");

  /*
   * ---- 7. 贴着右下角右键：夹回窗口内，不许被切掉 ----
   */
  await open(target({ x: window.innerWidth - 4, y: window.innerHeight - 4 }));
  const box = menu()!.getBoundingClientRect();
  log(box.right <= window.innerWidth, `右边缘在窗口内（${Math.round(box.right)} ≤ ${window.innerWidth}）`);
  log(box.bottom <= window.innerHeight, `下边缘在窗口内（${Math.round(box.bottom)} ≤ ${window.innerHeight}）`);
  log(box.left >= 0 && box.top >= 0, "左上也不会被推出窗口");

  // 跑完把 localStorage 还回原样
  if (before === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, before);

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
