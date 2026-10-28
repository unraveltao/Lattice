/**
 * 全局搜索浮层（`SearchOverlay`）：空查询、键盘、输入法、角标、四条关门的路。
 *
 * 这一页只管浮层本身 —— 数据从哪儿来（`runtime/global-search.ts`）由
 * `tests/global-search.html` 钉着，打分规则由 `tests/library-search.html` 钉着。
 * 这里给的是**手搓的一小张表**，因为要精确控制"第几行是什么"。
 *
 * 三处最容易写错、也就是这一页最想钉住的：
 *
 *   1. **空查询不列全部**。装了几十个组件时那是一屏噪音，而"我要找什么"
 *      用户还没说出口。空的时候只留一句范围说明。
 *   2. **组合期间放行 ↑↓ / Enter**。拼音打到一半按 Enter 是确认候选词，
 *      被抢走就是"打了三个字，第一条被打开"。
 *   3. **Esc 是"退一步"不是"全退"**：有词先清词，没词才关门。
 */

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { SearchOverlay } from "../src/platform/SearchOverlay";
import type { SearchTarget } from "../src/runtime/global-search";
import { setLanguage } from "../src/runtime/i18n";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
/*
 * 比 DOM 节点**别用这个**：`JSON.stringify` 一个元素会撞上循环引用
 * （`parentNode` 指回去），整页直接抛在第一条断言上 —— 表现是
 * "0 条断言（did it finish?）"，而真正的原因藏在 console 里。比节点用
 * `log(a === b, ...)`。
 */
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一行结果的夹具。默认"已装、没摆在画布上" —— 最普通的那一种 */
function mk(
  id: string,
  name: string,
  patch: Partial<SearchTarget> = {},
): SearchTarget {
  return {
    kind: "installed",
    id,
    manifest: {
      id,
      name: { zh: name, en: name },
      description: { zh: "", en: "" },
      author: "Lattice",
      permissions: [],
    },
    record: null,
    entry: null,
    placed: 0,
    update: null,
    ...patch,
  };
}

const backdrop = () => document.querySelector<HTMLElement>(".lattice-search-backdrop");
const panel = () => document.querySelector<HTMLElement>(".lattice-search-overlay");
const field = () => document.querySelector<HTMLInputElement>(".lattice-search-field input");
const rowNodes = () => [...document.querySelectorAll<HTMLElement>(".lattice-search-row")];
const rowNames = () =>
  rowNodes().map((node) => node.querySelector(".lattice-search-name")?.textContent ?? "");
const emptyText = () => document.querySelector(".lattice-search-empty")?.textContent ?? "";

/**
 * 往受控 input 里"真打一个字"。
 *
 * 直接 `el.value = "x"` 不行：React 在 input 元素上挂了一个被改写的 value
 * setter，绕过它写值，`onChange` 不会触发 —— 表现是"输入框里有字，列表空的"。
 * 用原型上的原生 setter 写，再发一个冒泡的 input 事件，React 才会认。
 */
function type(value: string) {
  const input = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    field()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

/** 键盘事件上的 `keyCode` 不在 init 字典里，要单独钉上去（老引擎的输入法判据） */
function pressKeyCode(key: string, keyCode: number) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  act(() => {
    field()!.dispatchEvent(event);
  });
}

async function main() {
  // 断言写在英文上：`systemLang()` 读的是浏览器语言，中文机器上量出来的文案不一样
  setLanguage("en");

  /*
   * 焦点还给谁 —— 浮层关掉之后焦点该回到"打开它之前那个东西"。
   * 这颗按钮放在 `#stage` 外面，免得被 `createRoot` 的渲染洗掉。
   */
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);

  const stage = document.getElementById("stage")!;
  let root: Root | null = null;
  let picks: SearchTarget[] = [];
  let closed = 0;

  const mount = async (targets: SearchTarget[]) => {
    picks = [];
    closed = 0;
    root = createRoot(stage);
    act(() => {
      root!.render(
        <SearchOverlay
          targets={targets}
          onPick={(target) => picks.push(target)}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });
    await sleep(60);
  };
  const unmount = async () => {
    act(() => root?.unmount());
    root = null;
    await sleep(40);
  };

  const fixture = [
    mk("lattice.clock", "Clock", { placed: 2 }),
    mk("lattice.clockwork", "Clockwork"),
    mk("lattice.note", "Note", { kind: "available" }),
    mk("com.acme.timer", "Timer", { kind: "store", update: null }),
    mk("lattice.weather", "Weather", { placed: 1, update: "2.0.0" }),
  ];

  /*
   * ---- 1. 长在 body 上，打开就聚焦 ----
   */
  act(() => opener.focus());
  log(document.activeElement === opener, "夹具：打开之前焦点在别处");

  await mount(fixture);
  log(backdrop() !== null, "浮层出现了");
  log(backdrop()?.parentElement === document.body, "portal 到 body（不受三栏布局裁切）");
  eq(panel()?.getAttribute("role"), "dialog", "有 role=dialog");
  eq(panel()?.getAttribute("aria-modal"), "true", "有 aria-modal（浮层是模态的）");
  log(document.activeElement === field(), "打开就聚焦到输入框");

  /*
   * ---- 2. 空查询：一行结果都不列，只留范围说明 ----
   *
   * 这是**故意的**。装到二十个组件时，空查询列全部等于打开就是一面墙，
   * 而用户连自己要找什么都没说。
   */
  eq(rowNodes().length, 0, "空查询不列全部");
  log(
    emptyText().includes("names, ids, descriptions, authors and permissions"),
    "空查询时说的是搜索范围（不是「没有结果」）",
  );

  /*
   * ---- 3. 打字：出现结果，且按打分器排序 ----
   *
   * `Clock` 是整串相等（exact），`Clockwork` 只是开头相同（prefix），
   * 所以前者必须排前面 —— 这条同时验"浮层真的在用那个打分器"。
   */
  act(() => type("clock"));
  await sleep(60);
  eq(rowNames(), ["Clock", "Clockwork"], "搜 clock：命中两条，整串相等的排前面");

  /*
   * ---- 4. ↑↓ 挪的是 aria-activedescendant，不是焦点 ----
   *
   * 焦点必须留在输入框里（combobox 那一套）：Tab 到某一行的话，在那一行上
   * 按 Esc 就没人接，浮层关不掉。
   */
  const input = field()!;
  eq(input.getAttribute("role"), "combobox", "输入框是 combobox");
  eq(input.getAttribute("aria-expanded"), "true", "有结果时 aria-expanded 是 true");
  eq(input.getAttribute("aria-activedescendant"), "lattice-search-opt-0", "默认高亮第一条");
  log(
    rowNodes()[0].getAttribute("aria-selected") === "true",
    "第一行 aria-selected",
  );
  log(rowNodes().every((node) => node.getAttribute("tabindex") === "-1"), "结果行不进 Tab 序列");

  press("ArrowDown");
  await sleep(40);
  eq(input.getAttribute("aria-activedescendant"), "lattice-search-opt-1", "↓ 挪到第二条");
  log(document.activeElement === input, "↓ 不把焦点挪走");
  press("ArrowUp");
  await sleep(40);
  eq(input.getAttribute("aria-activedescendant"), "lattice-search-opt-0", "↑ 挪回来");
  press("ArrowUp");
  await sleep(40);
  eq(input.getAttribute("aria-activedescendant"), "lattice-search-opt-0", "第一条上再 ↑ 不越界");

  /*
   * ---- 5. Enter 选中高亮那一条 ----
   */
  press("ArrowDown");
  await sleep(40);
  press("Enter");
  await sleep(40);
  eq(picks.map((item) => item.id), ["lattice.clockwork"], "Enter 选中的是高亮那一条（第二条）");

  /*
   * ---- 6. 组合期间放行 ----
   *
   * 两道判据一起用：Chromium 在提交候选词那次 keydown 上给 `isComposing: true`，
   * 老引擎只给 `keyCode 229`。少写一条，就是某一种输入法下"打拼音打到一半
   * 打开了第一条"。
   */
  picks = [];
  press("Enter", { isComposing: true });
  await sleep(40);
  eq(picks.length, 0, "组合期间 Enter 不选中（isComposing）");
  pressKeyCode("Enter", 229);
  await sleep(40);
  eq(picks.length, 0, "组合期间 Enter 不选中（keyCode 229，老引擎那条）");
  press("ArrowDown", { isComposing: true });
  await sleep(40);
  eq(input.getAttribute("aria-activedescendant"), "lattice-search-opt-1", "组合期间 ↓ 不动高亮（留给输入法翻候选词）");

  /*
   * ---- 7. Esc 是"退一步"：先清词，再关门 ----
   */
  press("Escape");
  await sleep(40);
  eq(field()!.value, "", "第一下 Esc 清空搜索词");
  eq(closed, 0, "清词那一下不关门");
  eq(rowNodes().length, 0, "清完词列表空了");

  press("Escape");
  await sleep(40);
  eq(closed, 1, "第二下 Esc 关门");

  await unmount();

  /*
   * ---- 8. 角标说清"这一条在哪儿" ----
   *
   * 三种状态必须分开：摆在画布上几份 / 装了没摆 / 压根没装。混成一句
   * "已安装"的话，用户会以为搜到的都在桌面上。
   */
  await mount(fixture);
  act(() => type("lattice"));
  await sleep(60);
  const badgeOf = (id: string) => {
    const row = document.querySelector(`[data-search-id="${id}"]`);
    return [...(row?.querySelectorAll(".lattice-search-badge") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
  };
  eq(badgeOf("lattice.clock"), ["2 on the canvas"], "摆在画布上两份 → 说份数");
  eq(badgeOf("lattice.note"), ["Not installed"], "能装没装 → 说没装（哪怕清单里有它）");
  eq(badgeOf("lattice.weather"), ["Update to 2.0.0", "1 on the canvas"], "商店有新版 → 额外一颗更新角标");

  /*
   * ---- 9. 一屏最多 50 行 ----
   *
   * 再多也不会有人往下翻，而 DOM 是有代价的。这里钉住"截断"这件事本身，
   * 免得哪天有人把 `.slice` 删了，二十个组件变成两百个节点。
   */
  await unmount();
  const many = Array.from({ length: 60 }, (_, index) => mk(`lattice.item${index}`, `Item ${index}`));
  await mount(many);
  act(() => type("item"));
  await sleep(60);
  eq(rowNodes().length, 50, "60 条命中只画 50 行");

  /*
   * ---- 10. 关门：点背景算，点浮层自己不算 ----
   *
   * "点自己不算"最容易漏：漏了的话点一行结果会先关门、再让 click 落在空气上 ——
   * 表现是"点了没反应"。
   */
  act(() => {
    panel()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await sleep(40);
  eq(closed, 0, "点在浮层里不关门");

  act(() => {
    backdrop()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await sleep(40);
  eq(closed, 1, "点背景关门（一次，不是两次）");

  /*
   * ---- 11. 关掉之后焦点还回去 ----
   *
   * 不还的话焦点落到 body 上，Tab 从窗口最开头重新数起 —— 用户刚才是从
   * 顶栏那颗按钮过来的，关掉之后应该还站在那儿。
   */
  await unmount();
  act(() => opener.focus());
  await mount(fixture);
  log(document.activeElement === field(), "重新打开：焦点进输入框");
  await unmount();
  log(document.activeElement === opener, "卸载后焦点回到打开它之前那个元素");

  opener.remove();

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

/*
 * 这一页是异步跑的，`main()` 里抛出来的东西默认只会进 console —— 而
 * `npm run test:browser` 用的是 `--dump-dom`，console 拿不到。结果是
 * "0 条断言（did it finish?）"，看不出到底哪儿炸了。这里把它写进 `#out`，
 * 至少 dump 出来能看见。
 */
window.addEventListener("error", (event) => {
  document.getElementById("out")!.textContent = `THREW ${String(event.error?.stack ?? event.message)}`;
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { stack?: string } | undefined;
  document.getElementById("out")!.textContent = `THREW ${String(reason?.stack ?? reason)}`;
});

void main();
