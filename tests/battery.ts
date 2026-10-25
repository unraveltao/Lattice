/**
 * 电池组件
 *
 * 这一页钉两件事：
 *
 *   1. **读数怎么解释**（纯逻辑）。Rust 那半已经按 `SYSTEM_POWER_STATUS` 的
 *      口径判过哨兵（`255` / `u32::MAX`，见 `power_policy.rs` 的 6 条），这里钉的是
 *      前端这一层：坏字段不许变成好看的数字、插着电不许报"还剩多久"、
 *      调子（正常 / 充电 / 低电 / 快关机 / 没读数）的优先顺序。
 *   2. **卡片真的按它画**（界面）。百分数、进度条宽度、两行字、节电标记、
 *      权限被拒时说的那句，各走一遍；`tick` 到点要重读，语言与配置推送要当场生效。
 *
 * 纯逻辑不复制一份：组件把 `window.__latticeBattery` 挂在自己的 window 上，
 * 这里从 iframe 的 contentWindow 取（和 habit 那一页同一个路子）。
 */

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reading = {
  ac?: unknown;
  percent?: unknown;
  charging?: unknown;
  noBattery?: unknown;
  critical?: unknown;
  saver?: unknown;
  minutesLeft?: unknown;
};

type Power = {
  ac: boolean | null;
  percent: number | null;
  charging: boolean;
  noBattery: boolean;
  critical: boolean;
  saver: boolean;
  minutesLeft: number | null;
};

type Logic = {
  parsePower: (raw: unknown) => Power;
  stateKey: (power: Power) => string;
  tone: (power: Power, warnBelow: number) => string;
  barWidth: (percent: number | null) => number;
  warnOf: (config: unknown) => number;
  formatMinutes: (minutes: number | null, lang: "zh" | "en") => string;
  detailText: (power: Power, lang: "zh" | "en", showTime: boolean, warnBelow: number) => string;
  EMPTY: Power;
  REFRESH_MS: number;
};

type Host = {
  frame: HTMLIFrameElement;
  readonly doc: Document;
  reading: unknown;
  /** 非空时下一次 `power.status` 按这个码拒绝 */
  fail: string | null;
  config: Record<string, unknown>;
  schedules: number[];
  ready: Promise<void>;
  logic: Logic;
  pushTick: () => Promise<void>;
  pushLanguage: (lang: "zh" | "en") => Promise<void>;
  pushConfig: (config: Record<string, unknown>) => Promise<void>;
};

function mount(options: { reading?: unknown; config?: Record<string, unknown>; lang?: "zh" | "en" } = {}): Host {
  const frame = document.createElement("iframe");

  const state: Host = {
    frame,
    get doc() {
      return frame.contentDocument as Document;
    },
    reading: options.reading ?? null,
    fail: null,
    config: { warnBelow: 20, showTime: true, ...(options.config ?? {}) },
    schedules: [],
    ready: Promise.resolve(),
    get logic() {
      return (frame.contentWindow as unknown as { __latticeBattery: Logic }).__latticeBattery;
    },
    pushTick: async () => {
      frame.contentWindow?.postMessage({ __lattice: 1, type: "tick", payload: { id: 1 } }, "*");
      await sleep(40);
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
  };

  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = "/widgets/lattice.battery/index.html";

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
        reply({
          ok: true,
          result: { lang: options.lang ?? "zh", locale: options.lang === "en" ? "en-US" : "zh-CN" },
        });
        return;
      }
      if (data.method === "schedule.every") {
        state.schedules.push(Number(params.every));
        reply({ ok: true, result: { id: 1, every: params.every } });
        return;
      }
      if (data.method === "power.status") {
        if (state.fail) {
          reply({ ok: false, code: state.fail, error: "denied" });
          return;
        }
        reply({ ok: true, result: state.reading });
        return;
      }
      reply({ ok: false, code: "unknown_method", error: "unknown" });
    });
  });

  document.body.appendChild(frame);
  return state;
}

const textOf = (host: Host, selector: string) => host.doc.querySelector(selector)?.textContent ?? null;
const widthOf = (host: Host) =>
  (host.doc.getElementById("fill") as HTMLElement | null)?.style.width ?? null;
const hasClass = (host: Host, name: string) =>
  host.doc.getElementById("card")?.classList.contains(name) ?? false;
const hiddenOf = (host: Host, id: string) => (host.doc.getElementById(id) as HTMLElement | null)?.hidden;

async function main(): Promise<void> {
  const probe = mount();
  await probe.ready;
  const logic = probe.logic;

  // ---- A. 读数归一化 ----
  eq(
    logic.parsePower({ ac: false, percent: 87, charging: false, noBattery: false, critical: false, saver: false, minutesLeft: 134 }),
    { ac: false, percent: 87, charging: false, noBattery: false, critical: false, saver: false, minutesLeft: 134 },
    "一份正常的读数原样通过",
  );
  eq(logic.parsePower(null), logic.EMPTY, "null 就是什么都不知道");
  eq(logic.parsePower("garbage"), logic.EMPTY, "非对象也是什么都不知道");
  eq(logic.parsePower({ ac: "false" }).ac, null, "ac 不是布尔的字符串当未知");
  eq(logic.parsePower({ percent: "87" }).percent, null, "percent 是字符串当未知（别偷偷 parseInt）");
  eq(logic.parsePower({ percent: 101 }).percent, null, "101% 是坏读数，不夹到 100");
  eq(logic.parsePower({ percent: -1 }).percent, null, "负数百分比也是坏读数");
  eq(logic.parsePower({ percent: 87.6 }).percent, 88, "百分比四舍五入到整数");
  eq(logic.parsePower({ minutesLeft: -5 }).minutesLeft, null, "负的剩余时间当未知");
  eq(logic.parsePower({ minutesLeft: 10081 }).minutesLeft, null, "超过一周的剩余时间当坏读数");
  eq(logic.parsePower({ minutesLeft: 59.4 }).minutesLeft, 59, "剩余分钟取整");
  eq(logic.parsePower({ charging: "yes" }).charging, false, "奇怪的充电标记当没有");
  eq(logic.parsePower({ saver: 1 }).saver, false, "节电标记只认 true");

  // ---- B. 现在是哪种状态 ----
  const mk = (patch: Partial<Reading>): Power => logic.parsePower({ ...logic.EMPTY, ...patch });
  eq(logic.stateKey(mk({ noBattery: true, ac: true, charging: true })), "noBattery", "没有电池压过一切");
  eq(logic.stateKey(mk({ ac: true, charging: true })), "charging", "接着电又在充电");
  eq(logic.stateKey(mk({ ac: true })), "plugged", "接着电但没在充电");
  eq(logic.stateKey(mk({ ac: false })), "battery", "用电池");
  eq(logic.stateKey(mk({})), "unknown", "交流电读不出来");

  // ---- C. 整张卡片的调子 ----
  eq(logic.tone(mk({ noBattery: true }), 20), "none", "没有电池不叫「低电」");
  eq(logic.tone(mk({}), 20), "unknown", "没有百分比就是未知");
  eq(logic.tone(mk({ ac: true, charging: true, percent: 5 }), 20), "charging", "充着电不报低电");
  eq(logic.tone(mk({ ac: true, percent: 50, critical: true }), 20), "critical", "系统说快关机压过阈值");
  eq(logic.tone(mk({ ac: false, percent: 20 }), 20), "low", "正好等于告警线也算低");
  eq(logic.tone(mk({ ac: false, percent: 21 }), 20), "ok", "高一个点就不算");
  eq(logic.tone(mk({ ac: false, percent: 0 }), 20), "low", "0% 是低电，不是未知");

  // ---- D. 进度条与水线 ----
  eq(logic.barWidth(null), 0, "没读数就是空条");
  eq(logic.barWidth(-10), 0, "负数夹到 0");
  eq(logic.barWidth(150), 100, "超过 100 夹到满");
  eq(logic.barWidth(42.4), 42, "宽度取整");
  eq(logic.warnOf({ warnBelow: 35 }), 35, "配置里的告警线");
  eq(logic.warnOf({}), 20, "没配就是出厂 20");
  eq(logic.warnOf(null), 20, "没有配置对象也是 20");
  eq(logic.warnOf({ warnBelow: "30" }), 20, "字符串不算数");
  eq(logic.warnOf({ warnBelow: 200 }), 99, "上限 99（100 等于永远告警）");
  eq(logic.warnOf({ warnBelow: -5 }), 0, "下限 0（等于关掉这条提醒）");

  // ---- E. 剩余时间怎么说 ----
  eq(logic.formatMinutes(null, "zh"), "", "没有时间就是空串");
  eq(logic.formatMinutes(0, "zh"), "不到 1 分钟", "0 分钟说「不到一分钟」");
  eq(logic.formatMinutes(0, "en"), "under a minute", "英文同理");
  eq(logic.formatMinutes(1, "zh"), "1 分钟", "一分钟");
  eq(logic.formatMinutes(59, "en"), "59 min", "不到一小时按分钟说");
  eq(logic.formatMinutes(60, "zh"), "1 小时", "整点不带零头");
  eq(logic.formatMinutes(134, "zh"), "2 小时 14 分", "一小时以上带分钟");
  eq(logic.formatMinutes(134, "en"), "2 h 14 min", "英文也带");
  eq(logic.formatMinutes(1440, "en"), "24 h", "一整天");

  // ---- F. 第二行怎么挑 ----
  eq(
    logic.detailText(mk({ ac: false, percent: 3, critical: true, minutesLeft: 5 }), "zh", true, 20),
    "马上就要关机",
    "快关机比剩余时间更急",
  );
  eq(
    logic.detailText(mk({ ac: false, percent: 60, minutesLeft: 134 }), "zh", true, 20),
    "还剩 2 小时 14 分",
    "有时间就说时间",
  );
  eq(
    logic.detailText(mk({ ac: false, percent: 60, minutesLeft: 134 }), "zh", false, 20),
    "",
    "关掉时间就不说（电量也不低）",
  );
  eq(
    logic.detailText(mk({ ac: false, percent: 12 }), "zh", true, 20),
    "该插电了",
    "低于告警线且没时间时提醒插电",
  );
  eq(
    logic.detailText(mk({ ac: false, percent: 12 }), "zh", true, 5),
    "",
    "告警线自己调到 5 之后就不提醒了",
  );
  eq(logic.detailText(mk({ ac: true, charging: true, percent: 60 }), "zh", true, 20), "", "充电时第二行是空的");
  eq(logic.detailText(mk({ noBattery: true }), "zh", true, 20), "", "没有电池也没有第二行");

  // ---- G. 界面 ----
  eq(probe.schedules, [logic.REFRESH_MS], "启动时按半分钟挂了一条时间轴");

  const host = mount({
    reading: { ac: false, percent: 87, charging: false, noBattery: false, critical: false, saver: false, minutesLeft: 134 },
  });
  await host.ready;
  eq(textOf(host, "#percent"), "87", "百分数画出来了");
  eq(widthOf(host), "87%", "进度条按百分比铺");
  eq(textOf(host, "#state"), "用电池", "状态那一行");
  eq(textOf(host, "#detail"), "还剩 2 小时 14 分", "第二行是剩余时间");
  eq(hiddenOf(host, "detail"), false, "有字就不藏");
  eq(hiddenOf(host, "saver"), true, "没开节电模式就藏起来");
  eq(hasClass(host, "is-low"), false, "87% 不该是警示色");
  eq(hasClass(host, "is-charging"), false, "没充电不带充电类");
  eq(host.doc.getElementById("bar")?.getAttribute("aria-valuenow"), "87", "无障碍读到同一个数");

  // 插上电：强调色、第二行消失
  host.reading = { ac: true, percent: 87, charging: true, noBattery: false, critical: false, saver: true };
  await host.pushTick();
  eq(textOf(host, "#state"), "充电中", "tick 之后重读，状态变了");
  eq(hasClass(host, "is-charging"), true, "充电中带充电类");
  eq(hiddenOf(host, "detail"), true, "插着电没有第二行");
  eq(hiddenOf(host, "saver"), false, "节电模式开着就露出来");
  eq(textOf(host, "#saver"), "省电模式", "标记上的字");

  // 低电：警示色 + 提醒插电
  host.reading = { ac: false, percent: 12, charging: false, noBattery: false, critical: false, saver: false };
  await host.pushTick();
  eq(hasClass(host, "is-low"), true, "低于告警线变警示色");
  eq(textOf(host, "#detail"), "该插电了", "并且提醒插电");
  eq(widthOf(host), "12%", "进度条跟着掉下来");

  // 系统说快关机
  host.reading = { ac: false, percent: 3, charging: false, noBattery: false, critical: true };
  await host.pushTick();
  eq(hasClass(host, "is-critical"), true, "critical 有自己的类");
  eq(textOf(host, "#detail"), "马上就要关机", "并且说清是快关机");

  // 台式机
  host.reading = { ac: true, percent: null, charging: false, noBattery: true, critical: false };
  await host.pushTick();
  eq(textOf(host, "#state"), "没有电池", "台式机直说没有电池");
  eq(textOf(host, "#percent"), "—", "不画一个 0%");
  eq(widthOf(host), "0%", "进度条是空的");
  eq(hasClass(host, "is-muted"), true, "整块退成灰的");

  // 读不出来（浏览器预览那条路：Rust 不在，回 null）
  host.reading = null;
  await host.pushTick();
  eq(textOf(host, "#state"), "没有读数", "null 读数说没有读数");
  eq(textOf(host, "#percent"), "—", "百分数还是不编");

  // 权限被拒
  host.fail = "permission_denied";
  await host.pushTick();
  eq(textOf(host, "#state"), "需要「系统指标」权限", "权限被拒时说清缺哪一项");
  eq(textOf(host, "#percent"), "—", "被拒时不画旧值");
  eq(hiddenOf(host, "detail"), true, "被拒时第二行也收起");
  host.fail = null;
  await host.pushTick();
  eq(textOf(host, "#state"), "没有读数", "恢复之后回到正常读数那一句");

  // 语言推送
  host.reading = { ac: false, percent: 87, charging: false, minutesLeft: 134 };
  await host.pushTick();
  await host.pushLanguage("en");
  eq(textOf(host, "#title"), "Battery", "英文下标题换掉");
  eq(textOf(host, "#state"), "On battery", "英文下状态也换");
  eq(textOf(host, "#detail"), "2 h 14 min left", "英文下剩余时间");
  await host.pushLanguage("zh");
  eq(textOf(host, "#state"), "用电池", "切回中文");

  // 配置推送：告警线抬高之后 40% 也算低
  await host.pushConfig({ warnBelow: 50, showTime: true });
  host.reading = { ac: false, percent: 40, charging: false, minutesLeft: 200 };
  await host.pushTick();
  eq(hasClass(host, "is-low"), true, "告警线 50：40% 算低电");
  await host.pushConfig({ warnBelow: 20, showTime: false });
  eq(textOf(host, "#detail"), "", "关掉剩余时间之后第二行空了");
  eq(hasClass(host, "is-low"), false, "告警线调回 20：40% 不算低");

  // 首帧与配置初值
  const startLow = mount({ reading: { ac: false, percent: 9, minutesLeft: null }, config: { warnBelow: 90 } });
  await startLow.ready;
  eq(hasClass(startLow, "is-low"), true, "config.get 回来的告警线首帧就生效");
  eq(textOf(startLow, "#detail"), "该插电了", "并且提醒插电");

  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = lines.some((line) => line.startsWith("FAIL")) ? "battery FAIL" : "battery OK";
}

main().catch((error) => {
  lines.push("FAIL 抛出异常：" + String(error && (error as Error).stack ? (error as Error).stack : error));
  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = "battery FAIL";
});
