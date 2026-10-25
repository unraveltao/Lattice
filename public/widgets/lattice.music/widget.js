/**
 * Music 组件
 *
 * 两件事：读 / 控制 Windows 的媒体会话（SMTC），以及画一条"现在有多响"的折线。
 *
 * 几个决定：
 *
 *   1. **媒体是轮询，声音是采样。** 会话走平台调度器（`schedule.every`，间隔可在
 *      属性面板里调），因为"现在放的是谁的歌"每两秒问一次就够了。声音那条线不一样：
 *      它要 80ms 一个点，比调度器的下限（250ms）密得多，所以它用自己的
 *      `setInterval` —— 它要的是"传感器读数"，不是"平台要保持的节奏"。
 *
 *   2. **没会话不是错误。** `media.get` 在没有播放器时返回 `null`，这里显示
 *      "Nothing playing" 并把按钮灰掉 —— 桌面上没开播放器是常态，不该红字警告。
 *
 *   3. **按钮按下去立刻自己拨一下。** `media.control` 是异步的，等下一次轮询回来
 *      才更新图标的话，用户会以为没按到。所以先在本地翻转状态，轮询回来再校正。
 *
 *   4. **进度条只做展示。** SMTC 给的位置是"上次报告的时间戳"，播放中它会自己
 *      走。为了不每秒问一次系统，这里用本地时间插值：拿到位置的那一刻记下
 *      `at`，之后按经过的毫秒自己往前推。
 *
 *   5. **播放器名要翻译。** SMTC 的 `source` 是 AUMID（`Spotify.exe`、
 *      `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`），原样摆在卡片上
 *      就是 "SPOTIFY.EXE" —— 那是最像"这组件坏了"的一处，见 `sourceLabel`。
 *
 *   6. **折线滚动靠 rAF，数据靠 80ms 采样。** 每个采样点之间用帧时间插值出
 *      "最新那个点已经走了多远"，12.5Hz 的数据看上去是连续滚动的。
 *      窗口藏起来时 rAF 自己会停，回来接着画 —— 正确性不依赖它跑几拍。
 */
(function () {
  "use strict";

  // ---------- 桥 ----------

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
        reject(new Error("Bridge call timed out: " + method));
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
   * 卡片上作者写的字（空态、按钮标题、提示行）是这个组件自己的 —— 平台不知道
   * 「没有在播放」对应哪句英文。所以两门都留在这儿，按 `lang.get` 挑一份；用户
   * 中途换语言，平台推一条 `language`，把已经画出去的字原地换掉（两件事都要做：
   * 只读一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
   *
   * **歌名、歌手、专辑、播放器名不翻**：那是系统给的，不是作者写的。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文；英文界面要等 `lang.get` 回来
   * 那一趟（几十毫秒）才翻。`lang` 只有 `zh` / `en` 两种 —— "跟随系统"是平台
   * 在设置里解析掉的。
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
    document.title = say("音乐", "Music");
    // 按钮的 title / aria-label、空态、播放 / 暂停图标和提示行都得当场换，
    // 不能等下一拍轮询 —— 那一拍在 2 秒后
    paintChrome();
    render(lastSession);
    paintHint();
  }

  // ---------- 纯逻辑（自检页直接调，别在测试里抄一份） ----------

  function clamp01(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    if (number < 0) return 0;
    if (number > 1) return 1;
    return number;
  }

  /** 毫秒 → `3:07` / `1:02:03`。超过一小时才出现小时位，卡片窄，能省则省 */
  function clock(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "0:00";
    var total = Math.floor(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    var pad = function (value) {
      return value < 10 ? "0" + value : String(value);
    };
    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
    return minutes + ":" + pad(seconds);
  }

  /**
   * 常见播放器的 AUMID → 人看的名字。
   *
   * 键是小写的可执行文件名（去掉 `.exe`）。没列到的走通用清理：砍掉 `!` 后面那段、
   * 去掉 `.exe`、去掉 `Microsoft.` / `Google.` 这种厂商前缀 —— 宁可显示
   * "ZuneMusic" 也别显示 "Microsoft.ZuneMusic_8wekyb3d8bbwe!App"。
   */
  var PLAYER_NAMES = {
    spotify: "Spotify",
    chrome: "Chrome",
    msedge: "Edge",
    firefox: "Firefox",
    brave: "Brave",
    opera: "Opera",
    vlc: "VLC",
    wmplayer: "Media Player",
    zunemusic: "Media Player",
    "mpc-hc64": "MPC-HC",
    "mpc-be64": "MPC-BE",
    potplayermini64: "PotPlayer",
    potplayermini: "PotPlayer",
    foobar2000: "foobar2000",
    musicbee: "MusicBee",
    aimp: "AIMP",
    "qqmusic": "QQ Music",
    cloudmusic: "NetEase Music",
    kugou: "Kugou",
    kuwo: "Kuwo",
  };

  function sourceLabel(raw) {
    if (raw === null || raw === undefined) return "";
    var text = String(raw).trim();
    if (!text) return "";

    // `App.exe!App` / `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`
    var app = text.split("!").pop();
    // 完整路径（有些播放器给的是 exe 全路径）
    app = app.split(/[\\/]/).pop();
    app = app.replace(/\.exe$/i, "");
    // `Microsoft.ZuneMusic_8wekyb3d8bbwe` 这种带包族的：砍掉下划线后面那截
    app = app.split("_")[0];
    if (!app) return text;

    var known = PLAYER_NAMES[app.toLowerCase()];
    if (known) return known;

    // 厂商前缀：`Microsoft.ZuneMusic` → `ZuneMusic`
    var parts = app.split(".");
    if (parts.length > 1) {
      var tail = parts[parts.length - 1];
      var byTail = PLAYER_NAMES[tail.toLowerCase()];
      if (byTail) return byTail;
      if (/^(microsoft|google|apple|meta|spotify)$/i.test(parts[0])) app = tail;
    }

    return app;
  }

  /**
   * 环形缓冲 → 一条折线的 `points`。
   *
   * `samples` 是老 → 新，值 0..1；`fraction` 是"最新那个点已经往下走了多远"
   * （0..1），有了它，12.5Hz 的采样看上去是连续往左滚的。
   *
   * 上下各留 2px：贴边画的线会被 `overflow` 切掉半个描边。
   */
  function tracePoints(samples, width, height, fraction) {
    if (!samples || !samples.length || !(width > 0) || !(height > 0)) return "";
    var top = 2;
    var bottom = height - 2;
    var y = function (value) {
      return (bottom - clamp01(value) * (bottom - top)).toFixed(1);
    };

    // 只有一个点：画一条横线。让第一个 80ms 里也看得见东西
    if (samples.length === 1) {
      return "0.0," + y(samples[0]) + " " + width.toFixed(1) + "," + y(samples[0]);
    }

    var span = width / (samples.length - 1);
    var offset = clamp01(fraction === undefined ? 0 : fraction) * span;
    var points = [];
    for (var i = samples.length - 1; i >= 0; i -= 1) {
      var x = width - offset - (samples.length - 1 - i) * span;
      if (x < -0.5) break;
      points.push(x.toFixed(1) + "," + y(samples[i]));
    }
    return points.reverse().join(" ");
  }

  // 自检页拿这几个跑断言（`tests/music.html`）
  window.__latticeMusic = {
    clock: clock,
    sourceLabel: sourceLabel,
    tracePoints: tracePoints,
    clamp01: clamp01,
  };

  // ---------- DOM ----------

  var el = {
    source: document.getElementById("source"),
    track: document.getElementById("track"),
    artist: document.getElementById("artist"),
    progress: document.getElementById("progress"),
    bar: document.getElementById("bar"),
    position: document.getElementById("position"),
    duration: document.getElementById("duration"),
    wave: document.getElementById("wave"),
    svg: document.getElementById("wave-svg"),
    base: document.getElementById("wave-base"),
    line: document.getElementById("wave-line"),
    prev: document.getElementById("prev"),
    toggle: document.getElementById("toggle"),
    toggleGlyph: document.getElementById("toggle-glyph"),
    next: document.getElementById("next"),
    hint: document.getElementById("hint"),
  };

  /** 上一帧画出来的会话：属性面板改了"显示进度条"要拿它重画一遍 */
  var lastSession = null;

  var PLAY_ICON = '<path d="M5 3.2 12.4 8 5 12.8z" />';
  var PAUSE_ICON = '<path d="M5.2 3.4h1.8v9.2H5.2zM9 3.4h1.8v9.2H9z" />';

  var HINTS = {
    media: ["需要「媒体控制」权限", "Needs the Media control permission"],
    level: ["需要「声音响度」权限", "Needs the Sound level permission"],
    desktop: ["媒体控制要在桌面应用里用", "Media control needs the desktop app"],
    unavailable: ["读不到媒体会话", "Media session unavailable"],
    scheduler: ["调度器不可用", "Scheduler unavailable"],
  };

  /**
   * 提示行留的是**原因**，不是那句已经翻好的话 —— 换语言时重挑一次就行。
   * 空串表示不显示。
   */
  var hintCode = "";

  function paintHint() {
    var pair = HINTS[hintCode];
    var text = pair ? say(pair[0], pair[1]) : "";
    el.hint.textContent = text;
    el.hint.classList.toggle("is-visible", !!text);
  }

  function setHint(code) {
    hintCode = code || "";
    paintHint();
  }

  /** 按钮上那几个固定的字：跟数据无关，换语言时单独重画一次 */
  function paintChrome() {
    el.prev.title = say("上一首", "Previous");
    el.prev.setAttribute("aria-label", say("上一首", "Previous"));
    el.next.title = say("下一首", "Next");
    el.next.setAttribute("aria-label", say("下一首", "Next"));
    el.toggle.setAttribute("aria-label", say("播放或暂停", "Play or pause"));
    // 主按钮的 title 跟着"现在按下去会发生什么"走，由 render 写；这里只兜住
    // 还没拿到会话时的那一帧
    if (!lastSession) el.toggle.title = say("播放 / 暂停", "Play / pause");
  }

  /**
   * 本地对"当前该不该显示暂停图标"的判断。
   *
   * 点一下之后系统那边可能还要几百毫秒才真的开始播，而下一轮轮询在两秒后。
   * 不本地翻转的话，那两秒里按钮一直是旧图标 —— 用户会以为点空了，再点一次，
   * 结果把它又按回去。
   */
  var optimistic = null;
  /** 进度插值用：上次从系统拿到位置的那一刻 */
  var positionAt = 0;
  var positionMs = 0;
  var playing = false;

  function render(session) {
    lastSession = session;
    if (!session) {
      el.source.textContent = "";
      el.track.textContent = say("没有在播放", "Nothing playing");
      el.track.title = "";
      el.artist.textContent = "";
      // 没有会话就整条收起来：留一条空槽加 "--:--" 看着像还没加载完
      el.progress.hidden = true;
      el.bar.style.width = "0%";
      el.position.textContent = "0:00";
      el.duration.textContent = "0:00";
      el.prev.disabled = true;
      el.toggle.disabled = true;
      el.next.disabled = true;
      el.toggleGlyph.innerHTML = PLAY_ICON;
      el.toggle.title = say("播放 / 暂停", "Play / pause");
      playing = false;
      optimistic = null;
      return;
    }

    el.source.textContent = sourceLabel(session.source);
    el.track.textContent = session.title || say("未知曲目", "Unknown track");
    el.track.title = session.title || "";
    el.artist.textContent = [session.artist, session.album].filter(Boolean).join(" — ");

    var isPlaying = optimistic === null ? session.status === "playing" : optimistic;
    playing = isPlaying;
    el.toggleGlyph.innerHTML = isPlaying ? PAUSE_ICON : PLAY_ICON;
    el.toggle.title = isPlaying ? say("暂停", "Pause") : say("播放", "Play");

    el.prev.disabled = !session.canPrevious;
    el.next.disabled = !session.canNext;
    // 能暂停 / 继续是"播不播得动"的唯一判据；有些播放器只给状态不给能力位
    el.toggle.disabled = !session.canPlayPause;

    positionMs = session.positionMs || 0;
    positionAt = Date.now();

    var duration = session.durationMs || 0;
    el.duration.textContent = duration > 0 ? clock(duration) : "--:--";
    el.position.textContent = clock(positionMs);
    // 没有时长（直播 / 某些播放器）就不画进度条：一条永远停在 0 的槽看着像坏了
    el.progress.hidden = !showProgress || duration <= 0;
    el.bar.style.width =
      duration > 0 ? Math.max(0, Math.min(100, (positionMs / duration) * 100)) + "%" : "0%";
  }

  /*
   * 进度条自己走。
   *
   * 只在播放中推进，并且到尾巴就停住 —— 让它越过右端再跳回来，比不动更像卡死。
   */
  var durationMs = 0;

  function tickProgress() {
    if (!playing || durationMs <= 0) return;
    var elapsed = Date.now() - positionAt;
    var shown = Math.min(durationMs, positionMs + elapsed);
    el.position.textContent = clock(shown);
    el.bar.style.width = (shown / durationMs) * 100 + "%";
  }

  // ---------- 声音高低 ----------

  /** 缓冲里留多少个点：72 × 80ms ≈ 5.8 秒，正好是"一眼看出刚才那段有没有声" */
  var WAVE_SAMPLES = 72;
  /** 采样间隔。80ms 比平台调度器的下限（250ms）密，所以用自己的定时器 */
  var LEVEL_MS = 80;

  var samples = [];
  var lastSampleAt = 0;
  var waveBox = { w: 0, h: 0 };
  var lastPoints = null;
  var levelTimer = 0;
  var waveRunning = false;
  var levelBlocked = false;

  /**
   * 量一次折线能画多大。
   *
   * `viewBox` 直接设成像素尺寸：这样 1 个用户单位 = 1px，描边粗细、圆点半径
   * 都是所见即所得。用 `preserveAspectRatio="none"` 硬拉的话，横向和纵向
   * 的缩放比不同，描边会一边粗一边细。
   */
  function resizeWave() {
    var box = el.wave.getBoundingClientRect();
    // 折线被藏起来时量出来是 0×0：这时候保持上一次的尺寸，别把 viewBox 缩成 1×1
    if (box.width < 1 || box.height < 1) return;
    var w = Math.round(box.width);
    var h = Math.round(box.height);
    if (w === waveBox.w && h === waveBox.h) return;
    waveBox = { w: w, h: h };
    el.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    el.base.setAttribute("x1", "0");
    el.base.setAttribute("y1", String(h - 2));
    el.base.setAttribute("x2", String(w));
    el.base.setAttribute("y2", String(h - 2));
    // 尺寸变了，上一帧那串点不能复用
    lastPoints = null;
  }

  function drawWave(fraction) {
    if (!waveBox.w) return;
    var points = tracePoints(samples, waveBox.w, waveBox.h, fraction);
    // 一条平线在空转：别每帧都写一遍属性
    if (points === lastPoints) return;
    lastPoints = points;
    el.line.setAttribute("points", points);
  }

  function frame(now) {
    if (!waveRunning) return;
    // 最新那个点从右端往左走：两次采样之间用帧时间插值，12.5Hz 看着也连续
    var fraction = lastSampleAt ? Math.min(1, (now - lastSampleAt) / LEVEL_MS) : 0;
    drawWave(fraction);
    requestAnimationFrame(frame);
  }

  function startWave() {
    if (!showLevel || levelBlocked) return;
    el.wave.hidden = false;
    resizeWave();
    if (!levelTimer) levelTimer = setInterval(sampleLevel, LEVEL_MS);
    if (!waveRunning) {
      waveRunning = true;
      requestAnimationFrame(frame);
    }
  }

  function stopWave() {
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = 0;
    }
    waveRunning = false;
    samples = [];
    lastSampleAt = 0;
    lastPoints = null;
    el.wave.hidden = true;
  }

  function sampleLevel() {
    call("audio.level")
      .then(function (result) {
        var level = result && typeof result.level === "number" ? clamp01(result.level) : 0;
        samples.push(level);
        if (samples.length > WAVE_SAMPLES) samples.shift();
        lastSampleAt = performance.now();
        /*
         * 拿到就画一次（fraction 0），不等下一帧。
         *
         * rAF 在"窗口没人看"时会被浏览器节流甚至完全不发帧 —— 那时候折线不该
         * 停在上一帧的样子。滚动平滑靠 rAF 补，**有数据就有线**靠这一句。
         */
        if (waveRunning) drawWave(0);
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          // 没授权就整条收起来：画一条永远贴底的线，用户会以为声音坏了
          levelBlocked = true;
          stopWave();
          setHint("level");
          return;
        }
        if (error.code === "internal") {
          // 浏览器预览（npm run dev）走这条：WebView2 外面没有 WASAPI
          levelBlocked = true;
          stopWave();
          return;
        }
        /*
         * 其它错误（桥超时 / 设备正在重连）不算致命：下一拍接着问。
         * 设备被别的程序独占时后端会自己重试，这里跟着等就是了。
         */
      });
  }

  // ---------- 轮询媒体会话 ----------

  var subscription = 0;
  var denied = false;
  var failures = 0;
  var showProgress = true;
  var showLevel = true;
  var pollMs = 2000;

  function refresh() {
    return call("media.get")
      .then(function (session) {
        failures = 0;
        if (denied) {
          denied = false;
          setHint("");
        }
        // 轮询回来就是"系统说了算"：撤掉本地那个乐观值
        optimistic = null;
        durationMs = session && session.durationMs ? session.durationMs : 0;
        render(session);
      })
      .catch(function (error) {
        if (error.code === "permission_denied") {
          denied = true;
          render(null);
          setHint("media");
          return;
        }
        /*
         * `internal` = 桥自己抛的"只有桌面应用里能用"。浏览器预览（npm run dev）
         * 走的就是这条：画布能画，但 SMTC 在 WebView2 外面没有对应物。
         */
        if (error.code === "internal") {
          render(null);
          setHint("desktop");
          return;
        }
        failures += 1;
        // 播放器刚启动 / 刚退出时 SMTC 会短暂报错，连续三次才提示
        if (failures >= 3) setHint("unavailable");
      });
  }

  /** 换一个轮询间隔：先退掉旧的，再挂新的 */
  function reschedule(every) {
    var previous = subscription;
    subscription = 0;
    var done = previous
      ? call("schedule.clear", { id: previous }).catch(function () {})
      : Promise.resolve();
    return done
      .then(function () {
        return call("schedule.every", { every: every });
      })
      .then(function (grant) {
        subscription = grant.id;
        return refresh();
      })
      .catch(function () {
        setHint("scheduler");
      });
  }

  function readConfig() {
    return call("config.get").then(function (config) {
      var next = Number(config && config.pollMs);
      pollMs = isFinite(next) ? Math.max(1000, Math.min(10000, next)) : 2000;
      showProgress = !config || config.showProgress !== false;
      showLevel = !config || config.showLevel !== false;
      /*
       * 进度条显不显示是**两个条件**：开关开着，**而且**这一轮真的有总时长。
       *
       * 这里曾经只写 `= !showProgress` —— 于是宿主在启动后补发一次
       * `config-changed`（它会），这一行就把 `render(null)` 刚藏起来的进度条又
       * 翻了出来：卡片上出现一条 0:00 / 0:00 的空槽，看着像"没加载完"。
       * 老版 268×148 排得满满当当，多出来的这一行直接把按钮顶出了卡片。
       */
      el.progress.hidden = !showProgress || durationMs <= 0;
      // 开关关着的那条线一开始就不该露出来：`startWave` 里那道闸门只是不发采样，
      // 藏不藏是另一件事
      el.wave.hidden = !showLevel;
    });
  }

  // ---------- 控制 ----------

  function control(action, local) {
    if (local) local();
    call("media.control", { action: action })
      .then(function (result) {
        // 系统说没做成（比如播放器已经退了）：立刻重读一次，别让界面停在假状态
        if (!result || result.ok !== true) {
          optimistic = null;
          return refresh();
        }
      })
      .catch(function (error) {
        optimistic = null;
        if (error.code === "permission_denied") {
          setHint("media");
        }
        return refresh();
      });
  }

  el.toggle.addEventListener("click", function () {
    var next = !playing;
    control("playPause", function () {
      playing = next;
      optimistic = next;
      el.toggleGlyph.innerHTML = next ? PAUSE_ICON : PLAY_ICON;
      el.toggle.title = next ? say("暂停", "Pause") : say("播放", "Play");
    });
  });

  el.prev.addEventListener("click", function () {
    control("previous");
  });

  el.next.addEventListener("click", function () {
    control("next");
  });

  // ---------- 宿主消息 ----------

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
    if (data.type === "config-changed") {
      var config = data.payload && data.payload.config;
      var previousPoll = pollMs;
      var previousShow = showProgress;
      var previousLevel = showLevel;
      Promise.resolve()
        .then(function () {
          return readConfig();
        })
        .then(function () {
          if (showProgress !== previousShow) render(lastSession);
          if (showLevel !== previousLevel) {
            if (showLevel) startWave();
            else stopWave();
          }
          // 间隔变了才重挂时间轴：每次改配置都重挂会漏掉一拍
          if (pollMs !== previousPoll) return reschedule(pollMs);
        });
      return;
    }
    if (data.type === "tick") {
      if (data.payload && data.payload.id === subscription) refresh();
      // 进度条自己走，不等心跳：心跳是两秒一拍，进度条要看起来是连续的
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

  /*
   * 进度条 250ms 一跳。
   *
   * 这个**不用**平台的调度器：调度器的间隔下限是 1000ms（见 runtime/schedule），
   * 而进度条一秒动一次会明显卡顿。它也不花 IPC —— 纯本地算术，窗口藏起来时
   * 浏览器自己会把定时器降到 1s 一次，代价可以忽略。
   */
  setInterval(tickProgress, 250);

  /*
   * 卡片尺寸变了（用户拖右下角）要重新量折线。
   *
   * `ResizeObserver` 比 `window.onresize` 准：卡片是窗口内容，窗口变了这里
   * 一定跟着变，反过来则不一定。
   */
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () {
      resizeWave();
    }).observe(el.wave);
  }

  paintChrome();

  /*
   * 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
   * 不该拖住配置和第一条轮询。
   */
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  /*
   * 先读配置，再挂时间轴、再开折线。
   *
   * 反过来的话第一次轮询用的是默认的 2 秒，而用户可能设的是 10 秒 ——
   * 启动那一下多问一次无害，但订阅的间隔错了就要等下次改配置才纠正。
   * 折线同理：`showLevel` 关着的时候一个采样都不该发。
   */
  readConfig()
    .catch(function () {})
    .then(function () {
      startWave();
      return reschedule(pollMs);
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
