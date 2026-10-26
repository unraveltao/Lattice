/**
 * 终端组件（`lattice.term`）
 *
 * 这一页钉两件事：
 *
 *   1. **事件怎么接成屏幕**（纯逻辑）。一段 chunk 落在半行中间要接上去、
 *      换行归一、哨兵万一漏进来要切掉、上限 2000 行、历史去重与 200 条、
 *      提示符怎么按宽度缩写。哨兵**真正的切分**在 Rust（`term_policy.rs`，
 *      14 条 `rustc --test`），这里只钉"Rust 切完之后卡片这边还对不对"。
 *   2. **卡片真的按它画**（界面 + 假宿主）。回显、stdout / stderr 的颜色、
 *      done 之后的退出码与截断提示、lost、停、权限被拒、语言推送、历史翻页。
 *
 * 纯逻辑不复制一份：组件把 `window.__latticeTerm` 挂在自己的 window 上，
 * 这里从 iframe 的 contentWindow 取（和 battery / habit 同一个路子）。
 */

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Line = { text: string; stream: string };

type TermState = {
  status: string;
  cwd: string;
  shell: string;
  seq: number;
  lines: Line[];
  atLineStart: boolean;
  dropped: number;
  active: string | null;
  lastCode: number | null;
  truncated: boolean;
  history: string[];
  denied: boolean;
};

type Logic = {
  feed: (state: TermState, event: Record<string, unknown>) => TermState;
  appendLines: (
    state: TermState,
    text: string,
    stream: string,
  ) => { lines: Line[]; atLineStart: boolean; dropped: number };
  stripMarker: (text: string) => string;
  historyPush: (history: string[], command: string) => string[];
  promptText: (state: TermState) => string;
  fitPrompt: (cwd: string, columns: number) => string;
  columnsFor: (width: number, charWidth: number) => number;
  blankState: () => TermState;
  MAX_LINES: number;
  HISTORY_MAX: number;
};

type Reply = { running: boolean; cwd: string; shell: string; seq: number };

type Host = {
  frame: HTMLIFrameElement;
  readonly doc: Document;
  readonly logic: Logic;
  stateReply: Reply;
  stateFail: string | null;
  writeDelay: number;
  writes: string[];
  stops: number;
  savedHistory: string[] | null;
  ready: Promise<void>;
  pushTerm: (event: Record<string, unknown>) => Promise<void>;
  pushLanguage: (lang: "zh" | "en") => Promise<void>;
};

function mount(
  options: { cwd?: string; running?: boolean; fail?: string; history?: string[]; writeDelay?: number } = {},
): Host {
  const frame = document.createElement("iframe");

  const host: Host = {
    frame,
    get doc() {
      return frame.contentDocument as Document;
    },
    get logic() {
      return (frame.contentWindow as unknown as { __latticeTerm: Logic }).__latticeTerm;
    },
    stateReply: {
      running: options.running ?? true,
      cwd: options.cwd ?? "C:\\Windows",
      shell: "powershell",
      seq: 3,
    },
    stateFail: options.fail ?? null,
    writeDelay: options.writeDelay ?? 0,
    writes: [],
    stops: 0,
    savedHistory: null,
    ready: Promise.resolve(),
    pushTerm: async (event) => {
      frame.contentWindow?.postMessage({ __lattice: 1, type: "term", payload: event }, "*");
      await sleep(60);
    },
    pushLanguage: async (lang) => {
      frame.contentWindow?.postMessage({ __lattice: 1, type: "language", payload: { lang } }, "*");
      await sleep(30);
    },
  };

  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = "/widgets/lattice.term/index.html";

  host.ready = new Promise<void>((resolve) => {
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
      const params = (data.params ?? {}) as Record<string, unknown>;
      const reply = (payload: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ __lattice: 1, type: "response", id, ...payload }, "*");

      if (data.method === "lang.get") {
        reply({ ok: true, result: { lang: "zh", locale: "zh-CN" } });
        return;
      }
      if (data.method === "term.state") {
        if (host.stateFail) {
          reply({ ok: false, code: host.stateFail, error: "permission not granted: terminal:exec" });
          return;
        }
        reply({ ok: true, result: host.stateReply });
        return;
      }
      if (data.method === "term.write") {
        host.writes.push(String(params.command ?? ""));
        const answer = () => reply({ ok: true, result: { id: "c1" } });
        if (host.writeDelay > 0) setTimeout(answer, host.writeDelay);
        else answer();
        return;
      }
      if (data.method === "term.stop") {
        host.stops += 1;
        reply({ ok: true, result: { ok: true } });
        return;
      }
      if (data.method === "storage.get") {
        reply({ ok: true, result: options.history ?? null });
        return;
      }
      if (data.method === "storage.set") {
        host.savedHistory = (params.value as string[]) ?? null;
        reply({ ok: true, result: { ok: true } });
        return;
      }
      reply({ ok: false, code: "unknown_method", error: "unknown" });
    });
  });

  document.body.appendChild(frame);
  return host;
}

const textOf = (host: Host, selector: string) => host.doc.querySelector(selector)?.textContent ?? null;
const renderedLines = (host: Host) =>
  Array.from(host.doc.querySelectorAll(".term-line")).map((node) => ({
    text: node.textContent ?? "",
    cls: node.className,
  }));
const inputEl = (host: Host) => host.doc.getElementById("input") as HTMLInputElement;
const stopEl = (host: Host) => host.doc.getElementById("stop") as HTMLButtonElement;
const dotState = (host: Host) => host.doc.getElementById("dot")?.getAttribute("data-state") ?? null;

/** 在输入框里敲一条命令并回车 */
async function run(host: Host, command: string): Promise<void> {
  const input = inputEl(host);
  input.value = command;
  host.doc.getElementById("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await sleep(80);
}

async function main(): Promise<void> {
  const probe = mount();
  await probe.ready;
  const logic = probe.logic;

  // ---- A. 一段段输出怎么接成行 ----
  const blank = logic.blankState();
  eq(blank.lines, [], "空白状态一行都没有");
  eq(blank.status, "idle", "空白状态是 idle");

  const two = logic.appendLines(blank, "a\nb\n", "stdout");
  eq(two.lines.map((line) => line.text), ["a", "b"], "两条换行就是两行");
  eq(two.atLineStart, true, "末尾换行之后下一段另起一行");

  const half = logic.appendLines(blank, "abc", "stdout");
  eq(half.atLineStart, false, "没有换行的一段：这一行还没写完");
  const joined = logic.appendLines({ ...blank, lines: half.lines, atLineStart: half.atLineStart }, "def\n", "stdout");
  eq(joined.lines.map((line) => line.text), ["abcdef"], "下一段接在同一行末尾，不是另起一行");

  const crlf = logic.appendLines(blank, "10%\r20%\r\n30%", "stdout");
  eq(crlf.lines.map((line) => line.text), ["10%", "20%", "30%"], "CRLF 和孤立的 CR 都归一成换行");

  // ---- B. 哨兵万一漏进来 ----
  eq(logic.stripMarker("out\x1eLATTICE:c1:0:C:\\Windows\nnext"), "outnext", "漏进来的哨兵连它那一行一起切掉");
  eq(logic.stripMarker("a\x1eLATTICE:c1:0:C:\\x\nb\x1eLATTICE:c2:1:C:\\y\nc"), "abc", "两段哨兵都切掉");
  eq(logic.stripMarker("a\x1eb"), "a\x1eb", "别的记录分隔符不是我们的，照原样显示");

  // ---- C. 上限 ----
  const many = logic.appendLines(blank, "x\n".repeat(logic.MAX_LINES + 5), "stdout");
  eq(many.lines.length, logic.MAX_LINES, `最多留 ${logic.MAX_LINES} 行`);
  eq(many.dropped, 5, "多出来的从头部丢掉，并且报出丢了几条");

  // ---- D. 事件 → 状态 ----
  let state = logic.feed(blank, { kind: "chunk", id: "c1", seq: 4, stream: "stdout", text: "hello\n" });
  eq(state.lines.map((line) => line.text), ["hello"], "chunk 进到行数组里");
  eq(state.seq, 4, "seq 跟着事件走");
  eq(state.active, "c1", "还没 done，这一条算在飞");

  state = logic.feed(state, { kind: "done", id: "c1", seq: 5, code: 0, truncated: false });
  eq(state.active, null, "done 之后没有在飞的命令了");
  eq(state.status, "idle", "done 之后状态回到 idle");
  eq(state.lastCode, 0, "退出码记下来");
  eq(state.truncated, false, "没截断");

  const stale = logic.feed(
    { ...blank, active: "c2", seq: 9 },
    { kind: "done", id: "c1", seq: 10, code: 0 },
  );
  eq(stale.active, "c2", "别的命令的 done 不清当前这一条");
  eq(stale.seq, 10, "但 seq 照样往前走");

  const lost = logic.feed({ ...blank, active: "c1" }, { kind: "lost", id: "c1", seq: 6 });
  eq(lost.status, "lost", "lost 之后状态是 lost");
  eq(lost.active, null, "lost 也要把在飞的那条放掉");

  // 快命令的输出可以比 `term.write` 的回话先到（真机上量到 5ms）：
  // 那时候 `active` 还是空的，编号只能从事件里认领
  const early = logic.feed(blank, { kind: "chunk", id: "c7", seq: 2, stream: "stdout", text: "C:\\Windows\n" });
  eq(early.active, "c7", "回话还没到，从第一条事件里认领编号");
  eq(early.lines.map((line) => line.text), ["C:\\Windows"], "这一段的正文照样进到行里");
  eq(
    logic.feed(early, { kind: "done", id: "c7", seq: 3, code: 0 }).active,
    null,
    "认领来的编号照样会被 done 放掉",
  );

  // ---- E. 历史 ----
  eq(logic.historyPush([], "  "), [], "空命令不记");
  eq(logic.historyPush(["a"], "a"), ["a"], "连敲两次同一条只留一条");
  eq(logic.historyPush(["a", "b", "c"], "a"), ["b", "c", "a"], "翻出来再敲一次的挪到末尾");
  const longHistory = logic.historyPush(
    Array.from({ length: logic.HISTORY_MAX }, (_, i) => `c${i}`),
    "latest",
  );
  eq(longHistory.length, logic.HISTORY_MAX, `历史最多 ${logic.HISTORY_MAX} 条`);
  eq(longHistory[longHistory.length - 1], "latest", "新的在末尾");
  eq(longHistory[0], "c1", "最旧的那条被挤掉");

  // ---- F. 提示符 ----
  eq(logic.promptText({ ...blank, cwd: "C:\\Windows" }), "PS C:\\Windows>", "提示符带目录");
  eq(logic.promptText(blank), "PS>", "没有目录时只留 PS>");
  eq(logic.fitPrompt("C:\\Windows", 40), "C:\\Windows>", "放得下就原样");
  const short = logic.fitPrompt("C:\\Users\\iron tom\\AppData\\Local\\Microsoft", 20);
  log(short.length <= 21 && short.endsWith(">"), `放不下时剪短并保住结尾（得到 ${short}）`);
  log(short.indexOf("…") === 0, "剪短时从左边砍，前面用省略号");
  eq(logic.columnsFor(320, 7.2), 44, "320px ÷ 7.2px = 44 列");
  eq(logic.columnsFor(0, 7.2), 0, "没有宽度就没有列");
  eq(logic.columnsFor(320, 0), 0, "量不出字符宽度就不猜");

  // ---- G. 界面 ----
  const host = mount();
  await host.ready;
  eq(textOf(host, "#prompt"), "PS C:\\Windows>", "启动时提示符读的是 shell 的目录");
  eq(dotState(host), "idle", "没在跑时状态点是 idle");
  eq(stopEl(host).hidden, true, "没在跑时不显示停止方块");

  await run(host, "dir");
  eq(host.writes, ["dir"], "回车把命令发给平台");
  const echo = renderedLines(host).find((line) => line.cls.includes("is-echo"));
  log(Boolean(echo && echo.text.endsWith(" dir")), "回显那一行带着目录和命令");
  eq(host.savedHistory, ["dir"], "命令进了组件自己的存储");
  eq(stopEl(host).hidden, false, "有命令在飞时出现停止方块");

  await host.pushTerm({ kind: "chunk", id: "c1", seq: 4, stream: "stdout", text: "hello\n" });
  const outLine = renderedLines(host).find((line) => line.text === "hello");
  log(Boolean(outLine), "stdout 的 chunk 画出来了");
  eq(outLine?.cls, "term-line", "stdout 用普通文字色");

  await host.pushTerm({ kind: "chunk", id: "c1", seq: 5, stream: "stderr", text: "boom\n" });
  const errLine = renderedLines(host).find((line) => line.text === "boom");
  log(Boolean(errLine && errLine.cls.includes("is-err")), "stderr 的行上警示色");

  await host.pushTerm({ kind: "done", id: "c1", seq: 6, code: 0, truncated: false });
  eq(stopEl(host).hidden, true, "done 之后停止方块收起来");
  log(
    !renderedLines(host).some((line) => line.text.includes("退出码")),
    "退出码 0 不该冒出一条提示",
  );

  await run(host, "boom");
  await host.pushTerm({ kind: "done", id: "c1", seq: 7, code: 3, truncated: true });
  log(
    renderedLines(host).some((line) => line.text.includes("退出码 3")),
    "非零退出码说出来",
  );
  log(
    renderedLines(host).some((line) => line.text.includes("已截断")),
    "截断也说一句",
  );

  await run(host, "ping");
  await host.pushTerm({ kind: "lost", id: "c1", seq: 8 });
  log(
    renderedLines(host).some((line) => line.text.includes("shell 退出了")),
    "shell 退出了要说清楚",
  );
  eq(dotState(host), "lost", "退出之后状态点是警示色");
  eq(stopEl(host).hidden, true, "退出之后没有在飞的命令");

  await run(host, "ping");
  eq(stopEl(host).hidden, false, "下一条命令又让方块出现");
  stopEl(host).click();
  await sleep(80);
  eq(host.stops, 1, "按方块会真的发 term.stop");

  // 事件比 write 的回话先到：输出照样落到屏幕上，回话到了才轮到"在飞"
  const slow = mount({ writeDelay: 150 });
  await slow.ready;
  const input = inputEl(slow);
  input.value = "ping -n 10 127.0.0.1";
  slow.doc.getElementById("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await slow.pushTerm({ kind: "chunk", id: "c1", seq: 2, stream: "stdout", text: "Reply\n" });
  log(
    renderedLines(slow).some((line) => line.text === "Reply"),
    "write 还没回话，先到的输出也画得出来",
  );
  await sleep(160);
  eq(stopEl(slow).hidden, false, "回话到了之后这条命令算在飞");

  // 空的回车不该发出去
  const before = slow.writes.length;
  const blankInput = inputEl(slow);
  blankInput.value = "   ";
  slow.doc.getElementById("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
  await sleep(60);
  eq(slow.writes.length, before, "空命令不发");

  // 权限被拒
  const denied = mount({ fail: "permission_denied" });
  await denied.ready;
  eq(dotState(denied), "denied", "权限被拒时状态点变警示色");
  eq(denied.doc.getElementById("card")?.classList.contains("is-denied"), true, "卡片整体标成被拒");
  log(
    renderedLines(denied).some((line) => line.text.includes("在终端里跑命令")),
    "被拒时说清缺的是哪一项权限",
  );

  // 语言
  await host.pushLanguage("en");
  eq(textOf(host, "#title"), "Terminal", "英文下标题换掉");
  await host.pushLanguage("zh");
  eq(textOf(host, "#title"), "终端", "切回中文");

  // 历史翻页（storage.get 拿回来的那两条）
  const history = mount({ history: ["git status", "dir"] });
  await history.ready;
  const box = inputEl(history);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  eq(box.value, "dir", "上箭头翻出最近一条");
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  eq(box.value, "git status", "再上一条");
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  eq(box.value, "dir", "下箭头回来");

  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = lines.some((line) => line.startsWith("FAIL")) ? "term FAIL" : "term OK";
}

main().catch((error) => {
  lines.push("FAIL 抛出异常：" + String(error && (error as Error).stack ? (error as Error).stack : error));
  document.getElementById("out")!.textContent = lines.join("\n");
  document.title = "term FAIL";
});
