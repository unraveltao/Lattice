/**
 * 习惯组件
 *
 * 这一页钉两件事：
 *
 *   1. **日期从哪儿来**（纯逻辑）。平台在窗口不可见时会停掉时间轴，所以这个组件
 *      不存"还剩多少"，存的是本地日键，连续天数每次现算。要钉的是：日键是本地
 *      日期不是 UTC、跨月跨年跨闰日都对、一周从哪天起排、连续天数在"今天还没记"
 *      时从昨天数。
 *   2. **点一下 → 磁盘 → 别的实例**（界面）。点格、加、改名、删各走一遍，并且
 *      每次都确认落盘的形状是对的 —— 只在界面上对、磁盘上是另一回事，是这个
 *      平台最贵的一类 bug。
 *
 * 纯逻辑不复制一份：组件把 `window.__latticeHabit` 挂在自己的 window 上，
 * 这里从 iframe 的 contentWindow 取（和 `tests/agent-widget.html` 同一个路子）。
 */

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Habit = { id: string; name: string; days: string[] };

type Logic = {
  dayKey: (date: Date) => string;
  addDays: (key: string, n: number) => string | null;
  weekdayOf: (key: string) => number;
  weekStartKey: (key: string, start: string) => string | null;
  weekKeys: (startKey: string) => string[];
  streak: (days: string[], today: string) => number;
  toggleDay: (days: string[], key: string) => string[];
  cleanName: (raw: unknown) => string;
  newId: (items: { id: string }[]) => string;
  parseHabits: (raw: unknown) => { items: Habit[] };
  MAX_HABITS: number;
  MAX_DAYS: number;
  MAX_NAME: number;
};

type Store = { habits?: { items: Habit[] } } & Record<string, unknown>;

type Host = {
  frame: HTMLIFrameElement;
  readonly doc: Document;
  store: Store;
  setCalls: number;
  config: Record<string, unknown>;
  ready: Promise<void>;
  logic: Logic;
  pushLanguage: (lang: "zh" | "en") => Promise<void>;
  pushConfig: (config: Record<string, unknown>) => Promise<void>;
  pushStoreChanged: (key: string) => Promise<void>;
};

/** 测试这一侧自己算的"今天"，和组件在同一台机器、同一个时区上 */
function todayKey(): string {
  const now = new Date();
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function mount(options: { store?: Store; config?: Record<string, unknown>; lang?: "zh" | "en" } = {}): Host {
  const frame = document.createElement("iframe");
  const store: Store = options.store ?? {};

  const state: Host = {
    frame,
    get doc() {
      return frame.contentDocument as Document;
    },
    store,
    setCalls: 0,
    config: { weekStart: "monday", ...(options.config ?? {}) },
    ready: Promise.resolve(),
    get logic() {
      return (frame.contentWindow as unknown as { __latticeHabit: Logic }).__latticeHabit;
    },
    pushLanguage: async (lang) => {
      frame.contentWindow?.postMessage({ __lattice: 1, type: "language", payload: { lang } }, "*");
      await sleep(30);
    },
    pushConfig: async (config) => {
      state.config = config;
      frame.contentWindow?.postMessage({ __lattice: 1, type: "config-changed", payload: { config } }, "*");
      await sleep(30);
    },
    pushStoreChanged: async (key) => {
      frame.contentWindow?.postMessage({ __lattice: 1, type: "store-changed", payload: { key } }, "*");
      await sleep(40);
    },
  };

  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = "/widgets/lattice.habit/index.html";

  state.ready = new Promise<void>((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__lattice !== 1) return;

      if (data.type === "ready") {
        resolve();
        return;
      }
      if (data.type !== "request") return;

      const id = data.id as number;
      const reply = (payload: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ __lattice: 1, type: "response", id, ...payload }, "*");
      const params = (data.params ?? {}) as Record<string, unknown>;

      if (data.method === "config.get") {
        reply({ ok: true, result: state.config });
        return;
      }
      if (data.method === "lang.get") {
        reply({ ok: true, result: { lang: options.lang ?? "zh", locale: options.lang === "en" ? "en-US" : "zh-CN" } });
        return;
      }
      if (data.method === "storage.get") {
        const key = String(params.key);
        reply({ ok: true, result: key in store ? store[key] : null });
        return;
      }
      if (data.method === "storage.set") {
        state.setCalls += 1;
        store[String(params.key)] = params.value;
        reply({ ok: true, result: { ok: true } });
        return;
      }
      if (data.method === "schedule.every") {
        reply({ ok: true, result: { id: 1, every: params.every } });
        return;
      }
      reply({ ok: false, code: "unknown_method", error: "unknown" });
    });
  });

  document.body.appendChild(frame);
  return state;
}

const rowsOf = (host: Host) => Array.from(host.doc.querySelectorAll(".habit-row"));
const nameOf = (row: Element | undefined) =>
  row?.querySelector(".habit-name")?.textContent ?? null;
const cellOf = (row: Element | undefined, key: string) =>
  row?.querySelector(`.habit-cell[data-key="${key}"]`) as HTMLElement | undefined;
const textOf = (host: Host, selector: string) => host.doc.querySelector(selector)?.textContent ?? null;

async function main(): Promise<void> {
  const today = todayKey();
  const host = mount({
    store: {
      habits: {
        items: [
          { id: "h-1", name: "Read", days: [today] },
          { id: "h-2", name: "Walk", days: [] },
        ],
      },
    },
  });
  await host.ready;
  const logic = host.logic;

  // ---- A. 日键 ----
  eq(logic.dayKey(new Date(2026, 0, 5, 0, 5)), "2026-01-05", "dayKey 取本地日期（凌晨）");
  eq(logic.dayKey(new Date(2026, 0, 5, 23, 55)), "2026-01-05", "dayKey 取本地日期（深夜，不能变成第二天）");
  eq(logic.dayKey(new Date(2026, 11, 31, 12)), "2026-12-31", "dayKey 年末");
  eq(logic.addDays("2026-12-31", 1), "2027-01-01", "往后一天跨年");
  eq(logic.addDays("2028-02-28", 1), "2028-02-29", "闰年的 2 月 29 日存在");
  eq(logic.addDays("2026-03-01", -1), "2026-02-28", "往前一天到 2 月末");
  eq(logic.addDays("2026-02-31", 0), null, "2026-02-31 不是一天");
  eq(logic.addDays("nope", 1), null, "坏形状返回 null");

  // ---- B. 一周从哪天起 ----
  eq(logic.weekdayOf("2026-10-26"), 1, "2026-10-26 是周一");
  eq(logic.weekStartKey("2026-10-29", "mon"), "2026-10-26", "周四所在那一周的周一是 26 号");
  eq(logic.weekStartKey("2026-10-25", "mon"), "2026-10-19", "周日属于上一周（周一起排）");
  eq(logic.weekStartKey("2026-10-25", "sun"), "2026-10-25", "周日起排时周日就是起点");
  eq(logic.weekStartKey("2026-10-26", "sun"), "2026-10-25", "周一起排换成周日起排，起点跟着往前走一天");
  const keys = logic.weekKeys("2026-10-26");
  eq(keys.length, 7, "一周七格");
  eq([keys[0], keys[6]], ["2026-10-26", "2026-11-01"], "七格首尾相接，跨月也对");

  // ---- C. 连续天数 ----
  eq(logic.streak([], "2026-10-26"), 0, "一天都没记是 0");
  eq(logic.streak(["2026-10-26"], "2026-10-26"), 1, "只有今天");
  eq(logic.streak(["2026-10-25", "2026-10-26"], "2026-10-26"), 2, "今天 + 昨天");
  eq(logic.streak(["2026-10-24", "2026-10-25"], "2026-10-26"), 2, "今天还没记就从昨天数");
  eq(logic.streak(["2026-10-23", "2026-10-24"], "2026-10-26"), 0, "昨天也没记就是断了");
  eq(logic.streak(["2026-10-24", "2026-10-26"], "2026-10-26"), 1, "中间缺一天不算连着");
  eq(logic.streak(["2026-09-30", "2026-10-01"], "2026-10-01"), 2, "跨月的连续天数");

  // ---- D. 点一格 ----
  eq(logic.toggleDay([], "2026-10-26"), ["2026-10-26"], "点一下记上");
  eq(logic.toggleDay(["2026-10-26"], "2026-10-26"), [], "再点一下取消");
  eq(
    logic.toggleDay(["2026-10-25", "2026-10-27"], "2026-10-26"),
    ["2026-10-25", "2026-10-26", "2026-10-27"],
    "插进去也保持排序",
  );
  eq(logic.toggleDay(["2026-10-26"], "nope"), ["2026-10-26"], "坏日键进不去");
  const many = Array.from({ length: 401 }, (_, i) => logic.addDays("2024-01-01", i) as string);
  const trimmed = logic.toggleDay(many, "2026-10-26");
  eq(trimmed.length, logic.MAX_DAYS, "超过 400 天丢最老的");
  eq(trimmed[trimmed.length - 1], "2026-10-26", "留下来的最后一条是刚点的");

  // ---- E. 存档归一化 ----
  eq(logic.parseHabits(null).items, [], "没有存档就是空清单");
  const parsed = logic.parseHabits({
    items: [
      {
        id: "h-1",
        name: "  Read   daily  ",
        days: ["2026-10-26", "2026-10-25", "2026-10-25", "nope", "2026-02-31"],
      },
      { id: "h-1", name: "dup", days: [] },
      { id: "H-2", name: "bad id", days: [] },
      { id: "h-3", name: "   ", days: [] },
      "garbage",
    ],
  });
  eq(parsed.items.length, 1, "坏条目逐条丢：重复 id / 大写 id / 空名字 / 非对象");
  eq(parsed.items[0].name, "Read daily", "名字压空白");
  eq(
    parsed.items[0].days,
    ["2026-10-25", "2026-10-26"],
    "日期去重、排序，2 月 31 日与非日键丢掉",
  );
  const capped = logic.parseHabits({
    items: Array.from({ length: 8 }, (_, i) => ({ id: `h-${i + 1}`, name: `n${i}`, days: [] })),
  });
  eq(capped.items.length, logic.MAX_HABITS, "最多六个习惯");

  // ---- F. 名字与 id ----
  eq(logic.cleanName("  a   b  "), "a b", "cleanName 压空白");
  eq(Array.from(logic.cleanName("x".repeat(60))).length, logic.MAX_NAME, "名字按码点截断");
  eq(logic.cleanName(null), "", "null 就是空名字");
  eq(logic.newId([]), "h-1", "空清单从 h-1 开始");
  eq(logic.newId([{ id: "h-1" }, { id: "h-2" }]), "h-3", "撞了就往后找");
  eq(logic.newId([{ id: "h-2" }]), "h-1", "中间空着就补空");

  // ---- G. 界面：画出来的样子 ----
  eq(rowsOf(host).length, 2, "存档里两个习惯就画两行");
  eq(rowsOf(host)[0].querySelectorAll(".habit-cell.is-on").length, 1, "记过的那天是填上的");
  eq(cellOf(rowsOf(host)[0], today)?.classList.contains("is-on"), true, "今天那格在 h-1 上是填上的");
  eq(rowsOf(host)[0].querySelector(".habit-streak")?.textContent, "1", "记了今天就是 1 天");
  eq(rowsOf(host)[1].querySelector(".habit-streak")?.textContent, "·", "一天没记显示一个点");
  eq(rowsOf(host)[0].querySelector(".habit-cell.is-today")?.getAttribute("data-key"), today, "今天那格带 is-today");
  eq(host.doc.querySelectorAll(".habit-cell").length, 14, "两行各七格");

  // ---- H. 点一格 → 磁盘 ----
  cellOf(rowsOf(host)[1], today)?.click();
  await sleep(30);
  eq(host.store.habits?.items[1].days, [today], "点一格写进磁盘");
  eq(cellOf(rowsOf(host)[1], today)?.classList.contains("is-on"), true, "界面上那格也填上了");
  eq(rowsOf(host)[1].querySelector(".habit-streak")?.textContent, "1", "连续天数跟着变");
  cellOf(rowsOf(host)[1], today)?.click();
  await sleep(30);
  eq(host.store.habits?.items[1].days, [], "再点一下取消，磁盘里也没了");

  // ---- I. 加一行、改名、删除 ----
  (host.doc.getElementById("add") as HTMLElement).click();
  await sleep(30);
  eq(rowsOf(host).length, 3, "+ 之后多一行");
  const fresh = host.doc.querySelector(".habit-input") as HTMLInputElement | null;
  log(Boolean(fresh), "新加的那一行直接进改名状态");
  if (fresh) {
    fresh.value = "Stretch";
    fresh.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await sleep(30);
  eq(nameOf(rowsOf(host)[2]), "Stretch", "回车提交新名字");
  eq(host.store.habits?.items[2].name, "Stretch", "新名字也落盘了");

  (rowsOf(host)[0].querySelector(".habit-name") as HTMLElement).click();
  await sleep(20);
  const rename = host.doc.querySelector(".habit-input") as HTMLInputElement | null;
  log(Boolean(rename), "点名字就地进改名");
  if (rename) {
    rename.value = "Read 20 min";
    rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await sleep(30);
  eq(nameOf(rowsOf(host)[0]), "Read 20 min", "改名写回界面");
  eq(host.store.habits?.items[0].name, "Read 20 min", "改名写回磁盘");

  (rowsOf(host)[2].querySelector(".habit-remove") as HTMLElement).click();
  await sleep(30);
  eq(rowsOf(host).length, 2, "× 删掉一行");
  eq(host.store.habits?.items.length, 2, "删除也落盘");

  // ---- J. 语言 ----
  await host.pushLanguage("en");
  eq(textOf(host, "#title"), "This week", "英文下标题换掉");
  eq(textOf(host, ".habit-weekday"), "M", "英文下周一显示 M");
  await host.pushLanguage("zh");
  eq(textOf(host, "#title"), "本周", "切回中文，标题也回来");
  eq(textOf(host, ".habit-weekday"), "一", "中文下周一是「一」");

  // ---- K. 配置：一周从周日开始 ----
  await host.pushConfig({ weekStart: "sunday" });
  eq(textOf(host, ".habit-weekday"), "日", "周日起排时第一列是周日");
  await host.pushConfig({ weekStart: "monday" });
  eq(textOf(host, ".habit-weekday"), "一", "改回周一起排");

  // ---- L. 别的实例改了同一份清单 ----
  host.store.habits = { items: [{ id: "h-9", name: "Hydrate", days: [] }] };
  await host.pushStoreChanged("habits");
  eq(rowsOf(host).length, 1, "收到 store-changed 就重读");
  eq(nameOf(rowsOf(host)[0]), "Hydrate", "重读到的是新的那一份");

  // ---- M. 空态与上限 ----
  const empty = mount({ store: {} });
  await empty.ready;
  eq(textOf(empty, ".habit-empty"), "还没有习惯，按 + 加一个", "空清单说清怎么加");
  await empty.pushLanguage("en");
  eq(textOf(empty, ".habit-empty"), "No habits yet — press +", "空态也跟着换语言");

  const full = mount({
    store: {
      habits: {
        items: Array.from({ length: 6 }, (_, i) => ({ id: `h-${i + 1}`, name: `n${i}`, days: [] })),
      },
    },
  });
  await full.ready;
  (full.doc.getElementById("add") as HTMLElement).click();
  await sleep(30);
  eq(rowsOf(full).length, 6, "第七个被挡住");
  eq(textOf(full, "#status"), "最多六个习惯", "并且说明原因");

  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = lines.some((line) => line.startsWith("FAIL")) ? "habit FAIL" : "habit OK";
}

main().catch((error) => {
  lines.push("FAIL 抛出异常：" + String(error && (error as Error).stack ? (error as Error).stack : error));
  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = "habit FAIL";
});
