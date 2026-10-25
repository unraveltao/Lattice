/**
 * 秒表组件
 *
 * 存的是"按下去的那一刻"，不是"已经过了多久"。
 *
 * 这不是省事，是唯一的做法：存时长的话，卡片一关就不再有人给它加时间，
 * 重新打开显示的是关掉那一瞬间的读数 —— 一个撒谎的秒表。存起点的话，
 * 读数随时可以由 `now - 起点` 算出来，卡片关着、窗口最小化、机器睡眠，
 * 都只影响"什么时候重算"，不影响"算出来是多少"。
 *
 * 所以这里**不需要心跳**。跑着的时候用 requestAnimationFrame 刷新显示，
 * 卡片不可见时它自然停（浏览器自己会停），回到可见时按时间戳重算一次即可。
 * 平台的心跳最小间隔是 250ms，用它来刷百分秒会每帧跳 25 个数 —— 那看起来
 * 像卡了，而不像在计时。
 *
 * # 状态机是纯函数
 *
 * start / pause / reset / lap 都接 `(state, now)` 返回新 state，不碰 DOM。
 * 这样自检页可以直接把时间"快进"到任意毫秒验边界（59.999 → 01:00.00），
 * 不用真的等一分钟。
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // 桥
  // -------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage(
        { __lattice: 1, type: "request", id: id, method: method, params: params },
        "*",
      );
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        var error = new Error("Bridge call timed out: " + method);
        error.code = "timeout";
        reject(error);
      }, 3000);
    });
  }

  var THEME_MAP = {
    "--lattice-surface": "--surface",
    "--lattice-text": "--fg",
    "--lattice-text-muted": "--muted",
    "--lattice-accent": "--accent",
    "--lattice-border": "--border",
    "--lattice-radius": "--radius",
    "--lattice-font": "--font",
  };

  function applyTheme(tokens) {
    if (!tokens) return;
    Object.keys(THEME_MAP).forEach(function (source) {
      var value = tokens[source];
      if (value) document.documentElement.style.setProperty(THEME_MAP[source], value);
    });
  }

  /*
   * 界面语言。
   *
   * 按钮上的字是这个组件自己的 —— 平台不知道 "Lap" 对应哪句中文。所以两门都
   * 留在这儿，按 `lang.get` 挑一份；用户中途换语言，平台推一条 `language`，
   * 把已经画出去的字原地换掉（两件事都要做：只读一次 = 换语言卡片不动，只听
   * 推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文，中文界面看到的就是最终样子；
   * 英文界面要等 `lang.get` 回来那一趟（几十毫秒）才翻。`lang` 只有 `zh` / `en`
   * 两种 —— "跟随系统"是平台在设置里解析掉的。
   */
  var lang = "zh";

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("秒表", "Stopwatch");
    // 标题栏那一行字是 HTML 里写死的，换语言同样要换（`document.title` 只管标签页）
    var titleEl = document.querySelector(".sw-title");
    if (titleEl) titleEl.textContent = say("秒表", "Stopwatch");
    var lapList = document.getElementById("laps");
    if (lapList) lapList.setAttribute("aria-label", say("计次记录", "Lap times"));
    // 按钮和圈列表都已经画出去了，换语言要原地重画（圈号是数字，不用管）
    renderAll();
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    // 平台界面换了语言。`lang.get` 那条是"建文档那一刻"的答案，这条是"后来变了"
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type !== "response") return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      var error = new Error(data.error || "Bridge call failed");
      error.code = data.code;
      entry.reject(error);
    }
  });

  function noop() {}

  // -------------------------------------------------------------------------
  // 状态机（纯函数）
  // -------------------------------------------------------------------------

  /**
   * `startedAt` 为 null 表示停着；否则是"这一次开始跑"的时刻。
   * `accumulated` 是之前几段跑出来的总和 —— 暂停再继续时，前面那段要接上。
   */
  function blank() {
    return { startedAt: null, accumulated: 0, laps: [] };
  }

  function start(state, now) {
    if (state.startedAt !== null) return state;
    return { startedAt: now, accumulated: state.accumulated, laps: state.laps };
  }

  function pause(state, now) {
    if (state.startedAt === null) return state;
    /*
     * `Math.max(0, ...)`：系统时间被校准时 `now` 可能比 `startedAt` 还小，
     * 不挡的话累计值会变成负数，之后再也跑不到正数。
     */
    return {
      startedAt: null,
      accumulated: state.accumulated + Math.max(0, now - state.startedAt),
      laps: state.laps,
    };
  }

  function reset() {
    return blank();
  }

  function elapsedOf(state, now) {
    if (!state) return 0;
    var span = state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
    return Math.max(0, state.accumulated + span);
  }

  function isRunning(state) {
    return !!state && state.startedAt !== null;
  }

  /** 记一圈：存的是"这一圈结束时的总时长"，圈内用时由相邻两圈相减得出 */
  function lap(state, now) {
    if (state.startedAt === null) return state;
    return {
      startedAt: state.startedAt,
      accumulated: state.accumulated,
      laps: state.laps.concat([elapsedOf(state, now)]),
    };
  }

  /** 每一圈自己的用时（第一圈就是总时长） */
  function splits(laps) {
    var out = [];
    for (var i = 0; i < laps.length; i += 1) {
      out.push(laps[i] - (i === 0 ? 0 : laps[i - 1]));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 显示
  // -------------------------------------------------------------------------

  function pad(value, width) {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  /**
   * `MM:SS.cc`，过了一小时才变成 `H:MM:SS.cc`。
   *
   * 用 `floor` 而不是四舍五入：00:00.996 舍成 00:01.00 的话，秒表会在
   * 真正到达 1 秒之前就跳数。宁可让它晚一点跳，也不要提前。
   */
  function formatDuration(ms) {
    var total = Math.max(0, Math.floor(ms));
    var centis = Math.floor(total / 10) % 100;
    var seconds = Math.floor(total / 1000) % 60;
    var minutes = Math.floor(total / 60000) % 60;
    var hours = Math.floor(total / 3600000);
    var body = pad(minutes, 2) + ":" + pad(seconds, 2) + "." + pad(centis, 2);
    return hours > 0 ? hours + ":" + body : body;
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  var timeEl = document.getElementById("time");
  var runEl = document.getElementById("run");
  var lapEl = document.getElementById("lap");
  var lapsEl = document.getElementById("laps");

  var KEY = "stopwatch";
  var state = blank();
  /** 用户按过按钮之后，迟到的 storage.get 不许把界面倒回去 */
  var touched = false;
  var frameId = 0;

  function now() {
    return Date.now();
  }

  function save() {
    call("storage.set", { key: KEY, value: state }).catch(noop);
  }

  function renderTime() {
    var text = formatDuration(elapsedOf(state, now()));
    timeEl.textContent = text;
    /*
     * 过了 99 分钟读数会多出两位（`1:39:59.99`）。34px 字号在 200 宽的卡片里
     * 放不下十个字符，所以加长之后换小一号 —— 宁可字小一点，也不要横向溢出
     * 或者被省略号截掉（秒表读数被截掉就完全没用了）。
     */
    timeEl.className = text.length > 8 ? "sw-time is-long" : "sw-time";
  }

  function renderActions() {
    var running = isRunning(state);
    /*
     * "有没有进度"看的是**已经记下的东西**，不是 `elapsedOf > 0`。
     *
     * 用 `elapsed > 0` 判断时，按下 Start 又在同一毫秒按下 Pause，读数是 0，
     * 按钮就显示成 "Start" —— 明明刚跑过（可能还记了圈），却像从没开始。
     * 自检页正好撞上这一毫秒，才把这个不稳当的判断露出来。
     */
    var hasProgress = state.accumulated > 0 || state.laps.length > 0;
    runEl.textContent = running
      ? say("暂停", "Pause")
      : hasProgress
        ? say("继续", "Resume")
        : say("开始", "Start");
    lapEl.textContent = running ? say("计次", "Lap") : say("重置", "Reset");
    // aria-label 也是读得出来的字，跟着语言换
    lapsEl.setAttribute("aria-label", say("计次记录", "Laps"));
    // 停着、且一点进度都没有：Reset 没有意义，但也不隐藏（按钮跳动更难看）
    lapEl.disabled = !running && !hasProgress;
  }

  function renderLaps() {
    if (state.laps.length === 0) {
      lapsEl.innerHTML = "";
      lapsEl.hidden = true;
      return;
    }
    lapsEl.hidden = false;
    var splitList = splits(state.laps);
    var html = "";
    // 倒序：最新的一圈在最上面，不用滚就能看见
    for (var i = state.laps.length - 1; i >= 0; i -= 1) {
      html +=
        '<li class="sw-lap">' +
        '<span class="sw-lap-n">' + (i + 1) + "</span>" +
        '<span class="sw-lap-split">' + formatDuration(splitList[i]) + "</span>" +
        '<span class="sw-lap-total">' + formatDuration(state.laps[i]) + "</span>" +
        "</li>";
    }
    lapsEl.innerHTML = html;
  }

  function renderAll() {
    renderTime();
    renderActions();
    renderLaps();
  }

  // ---- 刷新循环 ----

  function tick() {
    frameId = 0;
    renderTime();
    if (!isRunning(state)) return;
    frameId = requestAnimationFrame(tick);
  }

  function ensureLoop() {
    if (frameId || !isRunning(state)) return;
    frameId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (!frameId) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  }

  /*
   * 卡片被藏起来时 rAF 会停 —— 这正是想要的：看不见的秒表不需要每秒画
   * 60 次。回来的时候按时间戳重算一次，读数就是对的，不用补帧。
   */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopLoop();
      return;
    }
    renderTime();
    ensureLoop();
  });

  // ---- 交互 ----

  runEl.addEventListener("click", function () {
    touched = true;
    if (isRunning(state)) {
      state = pause(state, now());
      stopLoop();
    } else {
      state = start(state, now());
      ensureLoop();
    }
    renderAll();
    save();
  });

  lapEl.addEventListener("click", function () {
    touched = true;
    if (isRunning(state)) {
      state = lap(state, now());
    } else {
      state = reset();
      stopLoop();
    }
    renderAll();
    save();
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /*
   * 先按"空白秒表"画一遍，再等桥回来接上存档。
   * 等桥的话，宿主慢一点卡片就是一块空白 —— 而第一帧要画的只是 00:00.00。
   */
  renderAll();

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住存档和按钮接线
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画：秒表不该因为问不到语言就不走 */
    });

  call("storage.get", { key: KEY })
    .then(function (saved) {
      /*
       * 存档里的 `startedAt` 可能是几小时前 —— 那正是它该有的样子，
       * 不用修正，直接接着跑。
       */
      if (touched || !saved || typeof saved !== "object") return;
      if (!Array.isArray(saved.laps)) return;
      state = {
        startedAt: typeof saved.startedAt === "number" ? saved.startedAt : null,
        accumulated: typeof saved.accumulated === "number" ? Math.max(0, saved.accumulated) : 0,
        laps: saved.laps.filter(function (value) {
          return typeof value === "number" && isFinite(value);
        }),
      };
      renderAll();
      ensureLoop();
    })
    .catch(noop)
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  /* 自检页用：状态机 + 格式化，全部是纯函数 */
  window.__latticeStopwatch = {
    blank: blank,
    start: start,
    pause: pause,
    reset: reset,
    lap: lap,
    splits: splits,
    elapsedOf: elapsedOf,
    isRunning: isRunning,
    formatDuration: formatDuration,
    snapshot: function () {
      return {
        startedAt: state.startedAt,
        accumulated: state.accumulated,
        laps: state.laps.slice(),
        elapsed: elapsedOf(state, now()),
      };
    },
  };
})();
