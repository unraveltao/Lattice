/**
 * 专注计时器
 *
 * 这一页盯的是"时间对不对"，而不是"按钮能不能点"。
 *
 * 平台在窗口不可见时会把整条时间轴停掉 —— 所以"每秒减一"在这里必然出错：
 * 藏十分钟回来只补一拍，那十分钟就没了。组件因此不存"还剩多少"，存
 * **"什么时候结束"**。下面的断言全是围绕这一点：重载、藏起来、两个实例
 * 同时到点，剩余时间都得是对的。
 *
 * 时间由测试控制：把 iframe 自己的 `Date.now` 换掉，再手动发 tick。这样
 * "过了 25 分钟"不用真的等 25 分钟。
 *
 * 钉住的六件事：
 *
 *   1. 第一次打开种一份默认状态（`null` 是唯一可以种数据的情况）
 *   2. 跑起来之后剩余时间从 `endsAt` 算，不靠 tick 累加
 *   3. 到点只翻一页；离开期间到点也只翻一页（不补八轮）
 *   4. 暂停再继续，时间接着走，不回到起点
 *   5. 改配置：停着时跟着新时长走，跑着时不动它；暂停在一半时不许被重置
 *   6. 两个实例共享同一份状态、同一毫秒到点，只能记一轮
 */

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Timer = { id: number; every: number };

type Host = {
  frame: HTMLIFrameElement;
  readonly doc: Document;
  store: Record<string, unknown>;
  setCalls: number;
  timers: Map<number, Timer>;
  cleared: number[];
  config: Record<string, unknown>;
  now: number;
  setNow: (value: number) => void;
  tick: () => void;
  pushConfig: (next: Record<string, unknown>) => void;
  setLang: (next: "zh" | "en") => Promise<void>;
  ready: Promise<void>;
};

const MINUTE = 60000;

const hosts: Host[] = [];

function mount(options: {
  config?: Record<string, unknown>;
  store?: Record<string, unknown>;
  lang?: "zh" | "en";
} = {}): Host {
  const frame = document.createElement("iframe");
  const store = options.store ?? {};
  let nextTimerId = 1;

  const state: Host = {
    frame,
    get doc() {
      return frame.contentDocument as Document;
    },
    store,
    setCalls: 0,
    timers: new Map(),
    cleared: [],
    config: {
      workMinutes: 25,
      breakMinutes: 5,
      longBreakEvery: 4,
      longBreakMinutes: 15,
      autoStart: false,
      ...(options.config ?? {}),
    },
    now: Date.now(),
    setNow: (value) => {
      state.now = value;
      // 组件里所有的"现在"都走 Date.now()，换掉它就等于换了这台机器的钟
      (frame.contentWindow as unknown as { Date: { now: () => number } }).Date.now = () =>
        state.now;
    },
    tick: () => {
      for (const [id] of state.timers) {
        frame.contentWindow?.postMessage(
          { __lattice: 1, type: "tick", payload: { id, at: state.now } },
          "*",
        );
      }
    },
    pushConfig: (next) => {
      state.config = next;
      frame.contentWindow?.postMessage(
        { __lattice: 1, type: "config-changed", payload: { config: next } },
        "*",
      );
    },
    setLang: async (next) => {
      frame.contentWindow?.postMessage(
        { __lattice: 1, type: "language", payload: { lang: next } },
        "*",
      );
      await sleep(30);
    },
    ready: Promise.resolve(),
  };

  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = "/widgets/lattice.focus/index.html";

  state.ready = new Promise<void>((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__lattice !== 1) return;

      if (data.type === "ready") {
        /*
         * 组件默认按中文画。除了 A 段要先断中文，其余各段都推一条英文过去 ——
         * 等于顺带验了平台那条 language 推送真的被接住。
         */
        if (options.lang !== "zh") {
          frame.contentWindow?.postMessage(
            { __lattice: 1, type: "language", payload: { lang: "en" } },
            "*",
          );
        }
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
      if (data.method === "storage.get") {
        const key = String(params.key);
        reply({ ok: true, result: key in store ? store[key] : null });
        return;
      }
      if (data.method === "storage.set") {
        state.setCalls += 1;
        store[String(params.key)] = params.value;
        reply({ ok: true, result: { ok: true } });
        // 平台在落盘后广播给同一个组件的所有实例
        broadcast(store, String(params.key));
        return;
      }
      if (data.method === "schedule.every") {
        const timerId = nextTimerId++;
        state.timers.set(timerId, { id: timerId, every: Number(params.every) });
        reply({ ok: true, result: { id: timerId, every: params.every } });
        return;
      }
      if (data.method === "schedule.clear") {
        const timerId = Number(params.id);
        state.cleared.push(timerId);
        state.timers.delete(timerId);
        reply({ ok: true, result: { ok: true } });
        return;
      }
      reply({ ok: false, code: "unknown_method", error: "unknown" });
    });
  });

  document.body.appendChild(frame);
  hosts.push(state);
  return state;
}

function broadcast(store: Record<string, unknown>, key: string) {
  for (const host of hosts) {
    if (host.store !== store) continue;
    host.frame.contentWindow?.postMessage(
      { __lattice: 1, type: "store-changed", payload: { key } },
      "*",
    );
  }
}

const settle = () => sleep(260);

const text = (host: Host, id: string) => host.doc.getElementById(id)?.textContent ?? "";
const phase = (host: Host) => host.doc.getElementById("root")?.getAttribute("data-phase") ?? "";
const timer = (host: Host) => host.store["timer"] as Record<string, unknown> | undefined;
const doneCount = (host: Host) => ((timer(host)?.done as number[] | undefined) ?? []).length;
const click = (host: Host, id: string) => (host.doc.getElementById(id) as HTMLElement).click();

/** 只留一个 1 秒心跳 */
const hasSecondTick = (host: Host) =>
  [...host.timers.values()].some((item) => item.every === 1000);

// ---------------------------------------------------------------------------

// ---- A. 第一次打开 ----
{
  const host = mount({ lang: "zh" });
  await host.ready;
  await settle();

  eq(text(host, "time"), "25:00", "第一次打开是整 25 分钟");
  eq(phase(host), "work", "阶段是专注");

  // 没有宿主推语言时，首帧就是中文
  eq(text(host, "phase"), "专注", "阶段名默认是中文");
  eq([text(host, "toggle"), text(host, "reset")], ["开始", "重置"], "按钮默认是中文");

  await host.setLang("en");
  eq(text(host, "phase"), "Focus", "切到英文后阶段名是 Focus");

  eq(text(host, "toggle"), "Start", "按钮是 Start");
  eq(text(host, "rounds"), "0 / 4", "轮次 0 / 4");
  eq(host.setCalls, 1, "种了一份默认状态，写盘一次");
  eq(timer(host)?.endsAt ?? null, null, "没有在跑");
  eq(host.timers.size, 0, "停着的时候不挂心跳");

  host.frame.remove();
}

// ---- B. 开始 / 推进 / 暂停 ----
{
  const host = mount();
  await host.ready;
  await settle();
  host.setNow(Date.now());

  const startedAt = host.now;
  click(host, "toggle");
  await settle();

  eq(text(host, "toggle"), "Pause", "跑起来之后按钮变 Pause");
  eq(timer(host)?.endsAt, startedAt + 25 * MINUTE, "endsAt = 现在 + 25 分钟");
  log(hasSecondTick(host), "挂了一个 1 秒心跳");

  // 过 1 秒
  host.setNow(startedAt + 1000);
  host.tick();
  await sleep(80);
  eq(text(host, "time"), "24:59", "过一秒显示 24:59");

  // 过 10 分 30 秒（中间**没有** tick —— 模拟窗口藏起来、时间轴停摆）
  host.setNow(startedAt + 630000);
  host.tick();
  await sleep(80);
  eq(text(host, "time"), "14:30", "跳过一堆心跳也能算对，因为剩余时间是 endsAt - now");

  // 暂停
  click(host, "toggle");
  await settle();
  eq(text(host, "toggle"), "Resume", "暂停后按钮变 Resume");
  eq(timer(host)?.endsAt ?? null, null, "暂停后 endsAt 清空");
  const paused = (timer(host)?.remainingMs as number) ?? 0;
  log(Math.abs(paused - 870000) < 1200, `剩余时间记成 ${Math.round(paused / 1000)} 秒（应约 870）`);
  eq(host.timers.size, 0, "停着就不该再有心跳");

  // 继续：时间接着走，不回到起点
  host.setNow(host.now + 5 * MINUTE);
  click(host, "toggle");
  await settle();
  eq(
    text(host, "time"),
    "14:30",
    "继续之后是暂停时的那一段，不是重新开始",
  );
  log(hasSecondTick(host), "又挂回 1 秒心跳");

  host.frame.remove();
}

// ---- C. 到点翻页（不自动开始）----
{
  const host = mount();
  await host.ready;
  await settle();
  host.setNow(Date.now());

  click(host, "toggle");
  await settle();

  host.setNow(host.now + 25 * MINUTE);
  host.tick();
  await settle();

  eq(phase(host), "short", "专注结束进短休息");
  eq(text(host, "time"), "05:00", "休息是整 5 分钟");
  eq(text(host, "rounds"), "1 / 4", "记了一轮");
  eq(text(host, "toggle"), "Start", "没开 autoStart 时停在这一页等用户");
  eq(doneCount(host), 1, "落盘里有 1 条完成记录");
  eq(host.timers.size, 0, "停着不挂心跳");

  host.frame.remove();
}

// ---- D. 重载时还在跑 ----
{
  const now = Date.now();
  const host = mount({
    store: {
      timer: {
        v: 1,
        phase: "work",
        endsAt: now + 10 * MINUTE,
        remainingMs: 25 * MINUTE,
        done: [],
      },
    },
  });
  await host.ready;
  await settle();

  log(
    text(host, "time") === "10:00" || text(host, "time") === "09:59",
    `从 endsAt 恢复出剩余时间：「${text(host, "time")}」`,
  );
  eq(text(host, "toggle"), "Pause", "恢复成跑着的状态");
  log(hasSecondTick(host), "恢复后重新挂上心跳");

  host.frame.remove();
}

// ---- E. 重载时已经过期 ----
{
  const now = Date.now();
  const host = mount({
    store: {
      timer: {
        v: 1,
        phase: "work",
        endsAt: now - 8 * MINUTE,
        remainingMs: 25 * MINUTE,
        done: [],
      },
    },
  });
  await host.ready;
  await settle();

  eq(phase(host), "short", "离开期间到点，只翻一页");
  eq(text(host, "time"), "05:00", "停在新一页的起点，不是负时间");
  eq(text(host, "toggle"), "Start", "不替不在场的人自动开始");
  eq(doneCount(host), 1, "只记一轮 —— 走了八小时也不补八轮");
  log(/away/i.test(text(host, "hint")), `说明白发生了什么：「${text(host, "hint")}」`);

  host.frame.remove();
}

// ---- F. 长休息 ----
{
  const now = Date.now();
  const host = mount({
    config: { longBreakEvery: 2 },
    store: {
      timer: {
        v: 1,
        phase: "work",
        endsAt: now - 1000,
        remainingMs: 25 * MINUTE,
        done: [now - 60 * MINUTE],
      },
    },
  });
  await host.ready;
  await settle();

  eq(phase(host), "long", "第二轮结束进长休息");
  eq(text(host, "time"), "15:00", "长休息是 15 分钟");
  eq(text(host, "rounds"), "2 / 2", "长休息期间显示满轮，不是 0 / 2");

  host.frame.remove();
}

// ---- G. autoStart ----
{
  const host = mount({ config: { autoStart: true } });
  await host.ready;
  await settle();
  host.setNow(Date.now());

  click(host, "toggle");
  await settle();

  host.setNow(host.now + 25 * MINUTE);
  host.tick();
  await settle();

  eq(phase(host), "short", "到点照样翻页");
  eq(text(host, "toggle"), "Pause", "开了 autoStart 就接着跑");
  log(hasSecondTick(host), "心跳没断");
  log(
    typeof timer(host)?.endsAt === "number",
    `新的 endsAt 已经写下去了（${String(timer(host)?.endsAt)}）`,
  );

  host.frame.remove();
}

// ---- H. Reset ----
{
  const now = Date.now();
  const host = mount({
    store: {
      timer: {
        v: 1,
        phase: "short",
        endsAt: now + 2 * MINUTE,
        remainingMs: 5 * MINUTE,
        done: [now - 30 * MINUTE, now - 60 * MINUTE],
      },
    },
  });
  await host.ready;
  await settle();

  eq(phase(host), "short", "先确认在休息里");

  click(host, "reset");
  await settle();

  eq(phase(host), "work", "Reset 回到专注");
  eq(text(host, "time"), "25:00", "整 25 分钟");
  eq(text(host, "toggle"), "Start", "并且是停着的");
  eq(doneCount(host), 2, "完成记录不清 —— 那是今天做了几个，不是这一轮的进度");

  host.frame.remove();
}

// ---- I. 改配置 ----
{
  const host = mount();
  await host.ready;
  await settle();

  host.pushConfig({
    workMinutes: 50,
    breakMinutes: 5,
    longBreakEvery: 4,
    longBreakMinutes: 15,
    autoStart: false,
  });
  await settle();
  eq(text(host, "time"), "50:00", "停着、没动过的时候，时长跟着配置走");

  // 跑起来，再改配置：不能动正在跑的 endsAt
  host.setNow(Date.now());
  click(host, "toggle");
  await settle();
  const before = timer(host)?.endsAt;

  host.pushConfig({
    workMinutes: 90,
    breakMinutes: 5,
    longBreakEvery: 4,
    longBreakMinutes: 15,
    autoStart: false,
  });
  await settle();
  eq(timer(host)?.endsAt, before, "跑着的时候改时长，不打断正在进行的那一轮");

  // 暂停在一半，再改配置：不许被重置回整段
  host.setNow(host.now + 10 * MINUTE);
  click(host, "toggle");
  await settle();
  const paused = (timer(host)?.remainingMs as number) ?? 0;

  host.pushConfig({
    workMinutes: 60,
    breakMinutes: 5,
    longBreakEvery: 4,
    longBreakMinutes: 15,
    autoStart: false,
  });
  await settle();
  eq(
    (timer(host)?.remainingMs as number) ?? 0,
    paused,
    "暂停在一半时改时长，剩余时间原地不动",
  );

  host.frame.remove();
}

// ---- J. 两个实例同时到点 ----
{
  const shared: Record<string, unknown> = {};
  const now = Date.now();

  const a = mount({ store: shared });
  const b = mount({ store: shared });
  await a.ready;
  await b.ready;
  await settle();

  // 两边都按开始（共享同一份状态，按一次就够；再按一次是"暂停"，所以只按 A）
  a.setNow(now);
  click(a, "toggle");
  await settle();

  // 让 B 也拿到"正在跑"的状态（store-changed 会推过去）
  await settle();
  eq(text(b, "toggle"), "Pause", "B 跟着变成跑着的状态");
  log(hasSecondTick(b), "B 也挂上了自己的心跳");

  // 同一毫秒到点：两边各发一拍
  a.setNow(now + 25 * MINUTE);
  b.setNow(now + 25 * MINUTE);
  a.tick();
  b.tick();
  await settle();

  eq(doneCount(a), 1, "两个实例同时到点，只记一轮（不是两轮）");
  eq(phase(a), "short", "只翻一页");
  eq(phase(b), "short", "B 看到的是同一页");
  eq(text(b, "time"), "05:00", "B 的时间也对得上");

  a.frame.remove();
  b.frame.remove();
}

// ---- K. 一个实例改了，另一个跟着变 ----
{
  const shared: Record<string, unknown> = {};
  const a = mount({ store: shared });
  const b = mount({ store: shared });
  await a.ready;
  await b.ready;
  await settle();

  a.setNow(Date.now());
  click(a, "toggle");
  await settle();
  eq(text(b, "toggle"), "Pause", "A 开始，B 跟着开始");

  // 走一分钟再暂停：否则剩余仍是整段，按钮会是 Start 而不是 Resume
  a.setNow(a.now + MINUTE);
  click(a, "toggle");
  await settle();
  eq(text(b, "toggle"), "Resume", "A 暂停，B 跟着暂停");
  eq(text(b, "time"), "24:00", "B 的时间也跟着停在 24:00");

  a.frame.remove();
  b.frame.remove();
}

document.getElementById("out")!.innerHTML = lines
  .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
  .join("\n");
(window as unknown as { __done: boolean }).__done = true;
