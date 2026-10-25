/**
 * 专注计时器（番茄钟）
 *
 * # 为什么这个组件比看起来难
 *
 * 平台在窗口不可见时会把整条时间轴停掉（那是设计：看不见的东西不烧电）。
 * 所以"每秒减一"这种写法在这里是错的 —— 窗口藏了十分钟，回来只补一拍，
 * 那十分钟就凭空消失了。
 *
 * 正确的形状是**不存"还剩多少"，存"什么时候结束"**：`endsAt` 是一个绝对
 * 时刻，任何时候算一下 `endsAt - now` 就是真剩余。这样藏多久都不怕，重载、
 * 重启、换实例都一样。
 *
 * `remainingMs` 只在**暂停**时有意义。两个字段一个是跑着的真相，一个是停住
 * 的真相，混着用一个字段就必然出现"暂停再继续之后时间对不上"。
 *
 * # 两个实例同时到点怎么办
 *
 * 组件的存储是按 widgetId 的，桌面上放两个专注计时器，它们共享同一份状态 ——
 * 这正是想要的（同一个番茄钟，两个视图）。但两条心跳会在同一毫秒到点，
 * 于是两边都想"翻到下一页、记一轮"。
 *
 * 平台没有 CAS，所以不能靠"先读再写"保证只写一次。这里的办法是让翻页成为
 * **输入状态的纯函数**：两个实例看到的旧状态相同、`endsAt` 相同，算出来的
 * 新状态就一模一样 —— 谁最后写都无所谓，因为两次写的内容是同一份。
 * `done` 用"完成时刻的数组"而不是计数器，就是为了这个：`[t, ...old]` 幂等，
 * 而 `count + 1` 不幂等。
 *
 * 另外每次翻页前会重读一次：如果 `endsAt` 已经不是我们正在结束的那个了，
 * 说明别人先翻过了，直接采纳对方的结果（别再记一轮）。
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

  function noop() {}

  /*
   * 界面语言。
   *
   * 阶段名、按钮和提示都是这个组件自己的字 —— 平台不知道 "Break" 对应哪句中文。
   * 所以两门都留在这儿，按 `lang.get` 挑一份；用户中途换语言，平台推一条
   * `language`，把已经画出去的字原地换掉（两件事都要做：只读一次 = 换语言卡片
   * 不动，只听推送 = 语言停在建文档那一刻）。
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
    document.title = say("专注", "Focus");
    // 阶段名、按钮和提示都跟语言有关，重画一次比逐个替换稳
    if (state) render();
    else paintHint();
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  var KEY = "timer";
  var SCHEMA = 1;
  /** 只留最近这些轮。`done` 是用来数"这一轮里第几个"的，不是日志 */
  var KEEP = 20;

  var PHASES = {
    work: { zh: "专注", en: "Focus" },
    short: { zh: "休息", en: "Break" },
    long: { zh: "长休息", en: "Long break" },
  };

  /** 阶段名：`decode` 用键验状态，画的时候取当前语言那一份 */
  function phaseName(phase) {
    var pair = PHASES[phase] || PHASES.work;
    return say(pair.zh, pair.en);
  }

  function clampInt(value, min, max, fallback) {
    var number = Math.round(Number(value));
    if (!isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function durations(config) {
    var safe = config || {};
    return {
      work: clampInt(safe.workMinutes, 5, 90, 25) * 60000,
      short: clampInt(safe.breakMinutes, 1, 30, 5) * 60000,
      long: clampInt(safe.longBreakMinutes, 5, 60, 15) * 60000,
      every: clampInt(safe.longBreakEvery, 0, 8, 4),
    };
  }

  function fresh(config) {
    return {
      v: SCHEMA,
      phase: "work",
      endsAt: null,
      remainingMs: durations(config).work,
      done: [],
    };
  }

  /*
   * 读回来的东西一律过一遍这里。
   *
   * 盘上的数据是上一版组件写的（或者被外部改过），不能假设形状对。
   * 返回 null 表示"没有可用的数据" —— 和"读失败"是两件事：
   * 前者可以种一份默认值，后者绝对不许。
   */
  function decode(raw, config) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.v !== SCHEMA) return null; // 换了 schema 就当没有，别硬猜旧字段

    var phase = PHASES[raw.phase] ? raw.phase : "work";
    var endsAt =
      typeof raw.endsAt === "number" && isFinite(raw.endsAt) ? raw.endsAt : null;
    var fallback = durations(config)[phase];
    var remainingMs =
      typeof raw.remainingMs === "number" && isFinite(raw.remainingMs) && raw.remainingMs >= 0
        ? raw.remainingMs
        : fallback;

    var done = Array.isArray(raw.done)
      ? raw.done
          .filter(function (item) {
            return typeof item === "number" && isFinite(item);
          })
          .slice(0, KEEP)
      : [];

    return { v: SCHEMA, phase: phase, endsAt: endsAt, remainingMs: remainingMs, done: done };
  }

  /*
   * 翻到下一页 —— 纯函数，只依赖"旧状态 + 结束时刻 + 配置"。
   *
   * 这个"纯"是并发正确性的基础：两个实例同时到点时算出的新状态必须一模一样。
   */
  function advance(state, endsAt, config, autoStart) {
    var d = durations(config);
    var done = state.done.slice();

    var nextPhase;
    if (state.phase === "work") {
      // 同一次完成只记一次：`endsAt` 就是这一轮的身份证
      if (done[0] !== endsAt) done = [endsAt].concat(done).slice(0, KEEP);
      nextPhase = d.every > 0 && done.length % d.every === 0 ? "long" : "short";
    } else {
      nextPhase = "work";
    }

    var length = d[nextPhase];
    var now = Date.now();
    return {
      v: SCHEMA,
      phase: nextPhase,
      endsAt: autoStart ? now + length : null,
      remainingMs: length,
      done: done,
    };
  }

  // -------------------------------------------------------------------------
  // 展示状态
  // -------------------------------------------------------------------------

  var config = null;
  var state = null;
  var tickId = 0;
  /** 提示存两门写法，换语言时能原地说一遍；null 表示没有提示 */
  var hintPair = null;
  /** 正在翻页（见 `complete`）：挡住同一毫秒里重复的到点处理 */
  var completing = false;

  var el = {
    root: document.getElementById("root"),
    phase: document.getElementById("phase"),
    rounds: document.getElementById("rounds"),
    time: document.getElementById("time"),
    toggle: document.getElementById("toggle"),
    reset: document.getElementById("reset"),
    hint: document.getElementById("hint"),
  };

  function left() {
    if (!state) return 0;
    if (state.endsAt !== null) return Math.max(0, state.endsAt - Date.now());
    return Math.max(0, state.remainingMs);
  }

  function pad(value) {
    return (value < 10 ? "0" : "") + value;
  }

  /*
   * 用 ceil 而不是 floor：刚开始那一刻是 25:00，不是 24:59。
   * 到 0 才显示 0:00 —— 显示 0:00 的时候它就真的该结束了。
   */
  function format(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
  }

  function signature(value) {
    if (!value) return "";
    return [value.phase, value.endsAt, Math.round(value.remainingMs), value.done.length].join("|");
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function renderTime() {
    el.time.textContent = format(left());
  }

  function render() {
    if (!state) return;
    var d = durations(config);

    el.root.dataset.phase = state.phase;
    el.root.dataset.running = state.endsAt !== null ? "true" : "false";
    el.phase.textContent = phaseName(state.phase);

    /*
     * "这一轮里的第几个"。第 4 次完成会立刻进入长休息，那时 done.length % 4
     * 是 0，显示"0 / 4"很怪 —— 长休息期间应该显示 4 / 4。
     */
    if (d.every <= 0) {
      el.rounds.textContent = "";
    } else {
      var inCycle = state.done.length % d.every;
      if (inCycle === 0 && state.phase === "long") inCycle = d.every;
      el.rounds.textContent = inCycle + " / " + d.every;
    }

    if (state.endsAt !== null) {
      el.toggle.textContent = say("暂停", "Pause");
    } else {
      // 停在一半和停在起点是两件事，按钮上要说出来
      el.toggle.textContent =
        left() < d[state.phase] - 500 ? say("继续", "Resume") : say("开始", "Start");
    }
    // 休息时按它是"跳过这次休息"，但按钮始终只有一个心智模型：回到专注
    el.reset.textContent = say("重置", "Reset");

    renderTime();
    paintHint();
  }

  function setHint(zh, en) {
    hintPair = zh ? { zh: zh, en: en } : null;
    paintHint();
  }

  function paintHint() {
    el.hint.textContent = hintPair ? say(hintPair.zh, hintPair.en) : "";
    el.hint.classList.toggle("is-visible", !!hintPair);
  }

  /*
   * 采纳一份状态。
   *
   * 内容没变就不重画 —— 自己的写入会以 `store-changed` 的形式回声过来，
   * 每次都重画等于每秒白做一次布局。心跳该不该在跑则每次都要校一遍。
   */
  function apply(next, options) {
    var changed = signature(next) !== signature(state);
    state = next;
    if (changed || (options && options.force)) render();
    syncTicker();
  }

  // -------------------------------------------------------------------------
  // 落盘 / 读盘
  // -------------------------------------------------------------------------

  function load() {
    return call("storage.get", { key: KEY });
  }

  function save(value) {
    return call("storage.set", { key: KEY, value: value }).catch(noop);
  }

  // -------------------------------------------------------------------------
  // 心跳
  // -------------------------------------------------------------------------

  /*
   * 只有"正在跑"才需要心跳。停着的时候每秒醒一次纯属浪费，而且会让
   * 平台那条时间轴永远处于"有活要干"的状态。
   */
  function syncTicker() {
    var running = !!state && state.endsAt !== null;

    if (running && !tickId) {
      call("schedule.every", { every: 1000 })
        .then(function (grant) {
          tickId = grant.id;
          // 等回来的时候可能已经不需要了（用户点了暂停）
          if (!state || state.endsAt === null) {
            call("schedule.clear", { id: tickId }).catch(noop);
            tickId = 0;
          }
        })
        .catch(noop);
      return;
    }

    if (!running && tickId) {
      call("schedule.clear", { id: tickId }).catch(noop);
      tickId = 0;
    }
  }

  function onTick() {
    if (!state) return;
    if (state.endsAt === null) return;

    if (state.endsAt - Date.now() <= 0) {
      complete(state.endsAt);
      return;
    }
    renderTime();
  }

  /*
   * 到点了：先重读，确认"这一页还没被别人翻过"，再翻页。
   *
   * 重读这一步是关键。两个实例会在同一毫秒到点，谁先写谁后写不重要（写进去
   * 的内容一样），但**不能各翻一次** —— 所以先看盘上的 `endsAt` 还是不是
   * 我们正在结束的那个。
   */
  function complete(endsAt) {
    /*
     * 一次到点只走一遍。`complete` 里有几次 IPC，往返期间心跳还会再来 ——
     * 不挡住的话，同一毫秒会发四五次"翻页"，每次都读一遍盘。
     */
    if (completing) return Promise.resolve();
    completing = true;

    return load()
      .then(function (raw) {
        var current = decode(raw, config);
        if (!current || current.endsAt !== endsAt) {
          // 别人已经翻过页了，采纳对方的结果
          if (current) apply(current);
          return null;
        }
        var next = advance(current, endsAt, config, !!(config && config.autoStart));
        apply(next);
        return save(next);
      })
      .catch(noop)
      .then(function () {
        completing = false;
      });
  }

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  function toggle() {
    if (!state) return;
    setHint();

    if (state.endsAt !== null) {
      var remaining = Math.max(0, state.endsAt - Date.now());
      var paused = Object.assign({}, state, { endsAt: null, remainingMs: remaining });
      apply(paused);
      save(paused);
      return;
    }

    /*
     * 下限 1 秒：停在 0 的那一刻按开始，`endsAt = now + 0` 会让下一拍立刻
     * 判成"到点"，于是原地翻页 —— 看着像按钮坏了。
     */
    var running = Object.assign({}, state, {
      endsAt: Date.now() + Math.max(1000, state.remainingMs),
    });
    apply(running);
    save(running);
  }

  /*
   * 回到一个干净的专注阶段。休息时按它就是"跳过这次休息" ——
   * 一个按钮，一个心智模型：回到专注。
   *
   * `done` 不清：今天做了几个番茄是累积的，清掉等于把记录也一起扔了。
   */
  function reset() {
    if (!state) return;
    setHint();
    var next = Object.assign({}, state, {
      phase: "work",
      endsAt: null,
      remainingMs: durations(config).work,
    });
    apply(next);
    save(next);
  }

  el.toggle.addEventListener("click", toggle);
  el.reset.addEventListener("click", reset);

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /*
   * 启动时补账。
   *
   * `endsAt` 已经过去了，说明"到点那一刻我们不在场"（窗口藏起来、应用关着、
   * 组件被重载）。这时只翻**一页**，并且停在新一页的起点等用户按开始 ——
   * 走了八小时就补八轮是编故事：番茄钟记的是"你打算专注多久"，不是
   * "时间过去了多久"。autoStart 也不在这里生效，理由同上：它不能替一个
   * 不在场的人开始下一轮。
   */
  function recover(stored) {
    if (stored.endsAt === null) return { state: stored, note: "" };
    if (stored.endsAt > Date.now()) return { state: stored, note: "" };

    var next = advance(stored, stored.endsAt, config, false);
    return {
      state: next,
      note:
        stored.phase === "work"
          ? {
              zh: "你不在的时候专注结束了。",
              en: "Focus finished while you were away.",
            }
          : {
              zh: "这次休息结束了 —— 准备好了就开始。",
              en: "That break is over — ready when you are.",
            },
    };
  }

  function start(nextConfig) {
    config = nextConfig;

    load()
      .then(function (raw) {
        var stored = decode(raw, config);
        if (!stored) {
          /*
           * `null` 是"这个键不存在"—— 唯一可以种默认值的情况。
           * 读失败走下面的 catch，那条路一行 storage.set 都不许有。
           */
          var seeded = fresh(config);
          apply(seeded, { force: true });
          return save(seeded);
        }

        var recovered = recover(stored);
        apply(recovered.state, { force: true });
        if (recovered.note) setHint(recovered.note.zh, recovered.note.en);
        if (signature(recovered.state) !== signature(stored)) return save(recovered.state);
        return null;
      })
      .catch(function () {
        apply(fresh(config), { force: true });
        setHint("读不到存下来的计时。", "Couldn't read the saved timer.");
      });
  }

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------

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

    if (data.type === "tick") {
      if (data.payload && data.payload.id === tickId) onTick();
      return;
    }

    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (key && key !== KEY) return;
      /*
       * 别的实例改了状态（按了暂停、翻了页）。重读、采纳。
       *
       * 不做"本地优先"那套：这个组件每次改动都立刻落盘，没有"还没写下去的
       * 草稿"需要保护。内容没变时 apply 不会重画，所以自己的回声是无害的。
       */
      load()
        .then(function (raw) {
          var next = decode(raw, config);
          if (next) apply(next);
        })
        .catch(noop);
      return;
    }

    if (data.type === "config-changed") {
      var before = durations(config);
      config = data.payload && data.payload.config;
      var after = durations(config);
      if (!state) return;

      if (state.endsAt === null) {
        /*
         * 停着的时候剩余时间要跟着新时长走。但只在"没动过"的情况下整段换掉 ——
         * 暂停在 12:30 的人改了个时长，不该被重置回 25:00。
         */
        var untouched = Math.abs(state.remainingMs - before[state.phase]) < 1000;
        var target = untouched
          ? after[state.phase]
          : Math.min(state.remainingMs, after[state.phase]);
        apply(Object.assign({}, state, { remainingMs: target }), { force: true });
      } else {
        // 正在跑：不动它的 endsAt，只重画（"第几个 / 共几个"可能变了）
        render();
      }
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

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和状态
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画：计时器不该因为问不到语言就不走 */
    });

  call("config.get")
    .then(start)
    .catch(function () {
      apply(fresh(null), { force: true });
      setHint("这个组件读不到自己的设置。", "This widget could not read its own settings.");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
