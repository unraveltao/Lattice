/**
 * 画布总览面板（`OverviewPanel`）：缩略图、左栏、筛选、点一下回画布。
 *
 * 几何与分组由 `tests/overview.html` 钉着（纯函数），这一页只量**面板**：
 *
 *   1. 它真的画在 body 上（portal），有 `role=dialog`
 *   2. 每张卡按真实坐标摆（相对包围盒原点），整块平面被缩过且居中
 *   3. **筛选只改显示**：筛掉一层之后，剩下的卡位置不变 —— 用户要看的就是
 *      "置顶那几张压在哪里"，重新排会把这个信息抹掉
 *   4. 点卡 / 点左栏那一行，落到同一个动作上
 *   5. 清单里找不到的那一份画成虚线（和画布上那张坏卡一个意思）
 */

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { OverviewPanel } from "../src/platform/OverviewPanel";
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

function record(id: string, name: string): WidgetRecord {
  return {
    manifest: {
      id,
      name: { zh: name, en: name },
      description: { zh: "", en: "" },
      version: "1.0.0",
      author: "Lattice",
      permissions: [],
      entry: "index.html",
      layer: "desktop",
      interactive: true,
      shape: "rect",
    },
    source: "user",
    dir: `/widgets/${id}`,
    entryUrl: `http://localhost:1420/public/widgets/${id}/index.html`,
    iconUrl: null,
  } as WidgetRecord;
}

function at(instanceId: string, widgetId: string, x: number, y: number, w: number, h: number, layer: Placement["layer"]): Placement {
  return { instanceId, widgetId, x, y, w, h, layer, clickThrough: false, pinned: false };
}

const backdrop = () => document.querySelector<HTMLElement>(".lattice-overview-backdrop");
const panel = () => document.querySelector<HTMLElement>(".lattice-overview");
const plane = () => document.querySelector<HTMLElement>(".lattice-overview-plane");
const cards = () => [...document.querySelectorAll<HTMLElement>(".lattice-overview-card")];
const cardIds = () => cards().map((node) => node.getAttribute("data-instance-id"));
const chips = () => [...document.querySelectorAll<HTMLElement>(".lattice-overview-chip")];
const chipText = () => chips().map((node) => node.textContent?.trim() ?? "");
const rows = () => [...document.querySelectorAll<HTMLElement>(".lattice-overview-row")];
const sections = () =>
  [...document.querySelectorAll<HTMLElement>(".lattice-overview-rail .lattice-lib-section-name")].map(
    (node) => node.textContent?.trim() ?? "",
  );

async function main() {
  // 断言写在英文上：`systemLang()` 读的是浏览器语言，中文机器上量出来的文案不一样
  setLanguage("en");

  const KEY = "lattice.platform.v1";
  const before = localStorage.getItem(KEY);

  /*
   * 夹具：一个 900×600 的布局，两层层都有，另外留一份"清单里找不到"的。
   * 尺寸刻意做得比视口大，这样缩放比一定小于 1（不然验不出"缩过"）。
   */
  const placements = [
    at("clock#1", "lattice.clock", 0, 0, 400, 300, "desktop"),
    at("note#1", "lattice.note", 600, 100, 300, 500, "desktop"),
    at("pet#1", "lattice.pet", 100, 50, 200, 200, "top"),
    at("ghost#1", "lattice.ghost", 500, 400, 400, 200, "normal"),
  ];

  const records = new Map<string, WidgetRecord>([
    ["lattice.clock", record("lattice.clock", "Clock")],
    ["lattice.note", record("lattice.note", "Note")],
    ["lattice.pet", record("lattice.pet", "Big Fishy")],
  ]);

  await sleep(120);
  act(() => {
    useLattice.setState({ placements, selectedInstanceId: null });
  });

  let picks: string[] = [];
  let closed = 0;
  let root: Root | null = null;

  const mount = async () => {
    picks = [];
    closed = 0;
    root = createRoot(document.getElementById("stage")!);
    act(() => {
      root!.render(
        <OverviewPanel
          records={records}
          installedIds={new Set(["lattice.clock", "lattice.note", "lattice.pet"])}
          onPick={(instanceId) => picks.push(instanceId)}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });
    await sleep(120);
  };

  /*
   * ---- 1. 长在 body 上，是个对话框 ----
   */
  await mount();
  log(backdrop() !== null, "总览出现了");
  log(backdrop()?.parentElement === document.body, "portal 到 body（不受三栏布局裁切）");
  eq(panel()?.getAttribute("role"), "dialog", "有 role=dialog");
  eq(panel()?.getAttribute("aria-modal"), "true", "有 aria-modal");

  /*
   * ---- 2. 四张卡，按真实坐标摆 ----
   *
   * 包围盒是 (0,0) → (900,600)，所以卡片的内联 left/top 就是它自己的 x/y。
   */
  eq(cards().length, 4, "四张缩略卡");
  eq(cardIds(), ["clock#1", "note#1", "pet#1", "ghost#1"], "每张都带 data-instance-id（顺序 = placements 顺序）");
  eq(
    cards().map((node) => [node.style.left, node.style.top, node.style.width, node.style.height]),
    [
      ["0px", "0px", "400px", "300px"],
      ["600px", "100px", "300px", "500px"],
      ["100px", "50px", "200px", "200px"],
      ["500px", "400px", "400px", "200px"],
    ],
    "坐标和尺寸都照抄 placement（相对包围盒原点）",
  );
  eq(
    [plane()?.style.width, plane()?.style.height],
    ["900px", "600px"],
    "平面尺寸 = 包围盒尺寸",
  );

  /*
   * ---- 3. 缩过、且居中 ----
   *
   * 缩放比小于 1 是"真的缩了"；平面左上角等于 `fitOffset` 算出来的居中偏移
   * —— 这一条同时钉住 `transform-origin: 0 0`（默认的 50% 50% 会让它错位）。
   */
  const transform = plane()?.style.transform ?? "";
  const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? "0");
  log(scale > 0 && scale < 1, `平面被缩小了（${transform}）`);
  const stage = document.querySelector<HTMLElement>(".lattice-overview-stage")!;
  const box = stage.getBoundingClientRect();
  const left = Number.parseFloat(plane()?.style.left ?? "0");
  const top = Number.parseFloat(plane()?.style.top ?? "0");
  log(
    Math.abs(left - (box.width - 900 * scale) / 2) < 1.5,
    `平面横向居中（left=${left.toFixed(1)}，期望 ${((box.width - 900 * scale) / 2).toFixed(1)}）`,
  );
  log(
    Math.abs(top - (box.height - 600 * scale) / 2) < 1.5,
    `平面纵向居中（top=${top.toFixed(1)}，期望 ${((box.height - 600 * scale) / 2).toFixed(1)}）`,
  );

  /*
   * ---- 4. 左栏按层分组，从最上面那层开始 ----
   */
  eq(sections(), ["On top layer", "Normal window layer", "Desktop layer"], "三段：置顶 → 普通 → 桌面");
  eq(rows().length, 4, "左栏四行（和卡片一一对应）");
  /*
   * 清单里找不到的那一份，左栏写 **id**、缩略卡写「Widget missing」——
   * 两处各说各的那一半：卡片说"它现在什么状态"，左栏说"它是谁"。
   * 两边都写 id 的话卡片上会挤一串 `lattice.ghost`，两边都写 missing 的话
   * 就再也分不出少的是哪一个。
   */
  eq(
    rows().map((node) => node.querySelector(".lattice-overview-row-name")?.textContent),
    ["Big Fishy", "lattice.ghost", "Clock", "Note"],
    "行的顺序跟着分组走（没有清单的那一份退回用 id）",
  );

  /*
   * ---- 5. 筛选按钮：All + 有东西的那几层 ----
   */
  eq(chipText(), ["All", "On top layer1", "Normal window layer1", "Desktop layer2"], "四颗筛选按钮，各带数量");

  /*
   * ---- 6. 筛选只改显示，不改布局 ----
   *
   * 这是这一页最重要的一条：筛掉桌面层之后，置顶那几张卡**必须还在原位**。
   * 重新排的话，"置顶的卡压在哪里"这个信息就没了 —— 而那正是总览的用途。
   */
  const beforePlane = [plane()?.style.left, plane()?.style.top, plane()?.style.transform];
  act(() => {
    chips()[3].click();
  });
  await sleep(60);
  eq(cardIds(), ["clock#1", "note#1"], "选「桌面层」之后只剩那两张");
  eq(
    [plane()?.style.left, plane()?.style.top, plane()?.style.transform],
    beforePlane,
    "平面的位置和缩放没变（筛选不重排）",
  );
  eq(chips()[3].getAttribute("aria-pressed"), "true", "选中的那颗 aria-pressed");
  eq(chips()[0].getAttribute("aria-pressed"), "false", "All 那颗跟着松开");

  act(() => {
    chips()[3].click();
  });
  await sleep(60);
  eq(cards().length, 4, "再点一下同一颗：取消筛选（不用先点 All）");

  /*
   * ---- 7. 点卡 / 点左栏那一行，落到同一个动作上 ----
   */
  act(() => {
    cards()[1].click();
  });
  await sleep(60);
  eq(picks, ["note#1"], "点缩略卡 → 选中那一份");

  act(() => {
    rows()[0].click();
  });
  await sleep(60);
  eq(picks, ["note#1", "pet#1"], "点左栏那一行 → 同一个动作");

  /*
   * ---- 8. 清单里找不到的那一份画成虚线 ----
   */
  log(
    cards()[3].classList.contains("is-broken"),
    "清单里没有的那一份是虚线框（和画布上那张坏卡一个意思）",
  );
  log(
    (cards()[3].textContent ?? "").includes("Widget missing"),
    "卡片上写「Widget missing」，不是拿 id 糊过去",
  );
  eq(
    cards()[3].querySelector(".lattice-overview-initial")?.textContent,
    "l",
    "没有图标时退回名字首字（id 的 l），和库里那几行同一个规矩",
  );

  /*
   * ---- 9. Esc 关门 ----
   *
   * 总览没有输入框，所以 Esc 交给 `useOverlayDismiss` 默认那一条 —— 这一条
   * 顺带钉住"那个 hook 的 escape 选项在总览里没被关掉"。
   */
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  await sleep(60);
  eq(closed, 1, "Esc 关门");

  /*
   * ---- 10. 空画布 ----
   */
  act(() => root?.unmount());
  root = null;
  act(() => {
    useLattice.setState({ placements: [] });
  });
  await mount();
  eq(cards().length, 0, "空画布：一张卡都没有");
  eq(plane(), null, "空画布不画平面（不是画一个 0×0 的）");
  eq(
    document.querySelector(".lattice-overview-empty-title")?.textContent,
    "Nothing on the canvas yet",
    "空状态有一句话",
  );
  eq(sections(), [], "空画布时左栏没有分组");

  act(() => root?.unmount());
  root = null;

  // 跑完把 localStorage 还回原样
  if (before === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, before);

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

window.addEventListener("error", (event) => {
  document.getElementById("out")!.textContent = `THREW ${String(event.error?.stack ?? event.message)}`;
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { stack?: string } | undefined;
  document.getElementById("out")!.textContent = `THREW ${String(reason?.stack ?? reason)}`;
});

void main();
