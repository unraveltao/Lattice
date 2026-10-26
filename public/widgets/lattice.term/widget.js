/**
 * 终端组件（`lattice.term`）
 *
 * 它不是终端模拟器，是**一条常驻 PowerShell 的皮肤**：命令发出去，输出以事件
 * 一段段回来，卡片只负责画。状态（`cd` 到了哪、变量还在不在）全在 shell 里。
 *
 * 三条和别的组件不一样的地方：
 *
 * 1. **输出走事件，不走桥的返回值**。`term.write` 只回一个编号，正文从
 *    `{ type: "term" }` 推送进来。桥是一问一答的，`ping -n 10` 那十行塞不进
 *    一个 Promise —— 塞进去就变成"等十秒一次性出现"。
 * 2. **哨兵归 Rust 切**（`term_policy.rs`）。卡片这边只做防御：万一有半截标记
 *    漏进正文，别让用户看见 `\x1eLATTICE:c3:0:C:\…`。
 * 3. **一条命令在飞的时候不再发第二条**。可以接着敲，敲完的那条排在队里，
 *    上一条的 `done` 到了才发 —— 这样"方块"（停）永远停的是**当前**这条。
 *
 * 纯逻辑挂在 `window.__latticeTerm` 上，`tests/term.html` 直接拿它断言，
 * 不复制一份去测（和 battery / habit 同一个路子）。
 */
(function () {
  "use strict";

  // ---------- 极简桥客户端 ----------
  var seq = 0;
  var pending = new Map();

  function call(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject, at: Date.now() });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
      setTimeout(
        function () {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("Bridge call timed out: " + method));
        },
        // 起一条 shell 要几百毫秒（实测 ~500ms），3 秒默认值对 term.write 太紧
        timeoutMs || 3000,
      );
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

  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 纯逻辑 ----------

  /** 卡片上最多画多少行。再早的已经不在内存里（设计 §5「输出刷屏」） */
  var MAX_LINES = 2000;

  /** 命令历史的上限。落盘走组件自己的 storage，不进平台的 state.json */
  var HISTORY_MAX = 200;

  var RS = "\u001e";

  /**
   * 把漏进来的哨兵标记切掉。
   *
   * 正常路径上它到不了这里（Rust 在切帧时就吃掉了）。留着是因为"标记进了正文"
   * 这种故障在界面上极其显眼、又极难一眼看出是谁的错 —— 而卡片能做的只有
   * "别画它"。只认我们自己的形状，别的 RS 字符照原样显示。
   */
  function stripMarker(text) {
    var out = String(text == null ? "" : text);
    // 换行归一：Rust 那边已经做了（`term_policy::normalize_lines`），这里再防一层 ——
    // 进度条那种"回到行首重画"的 `\r` 按换行处理，否则整段会挤成一行
    out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var at = out.indexOf(RS + "LATTICE:");
    while (at >= 0) {
      var end = out.indexOf("\n", at);
      out = out.slice(0, at) + (end < 0 ? "" : out.slice(end + 1));
      at = out.indexOf(RS + "LATTICE:", at);
    }
    return out;
  }

  /**
   * 把一段输出接到行数组上。
   *
   * `atLineStart` 是关键：一段 chunk 可能在半个行中间结束（`ping` 一次读一行），
   * 下一段要接在同一行上，而不是另起一行。少了它，中文和带 `\r` 的进度输出
   * 会变成"一个字一行"。
   */
  function appendLines(state, text, stream) {
    var parts = stripMarker(text).split("\n");
    var lines = state.lines.slice();
    var atStart = state.atLineStart === true;
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) atStart = true;
      var piece = parts[i];
      if (atStart) {
        // 末尾那个换行只是"下一段另起一行"，不是一条空行
        if (piece === "" && i === parts.length - 1) break;
        lines.push({ text: piece, stream: stream });
        atStart = false;
      } else if (lines.length === 0) {
        lines.push({ text: piece, stream: stream });
      } else {
        var tail = lines[lines.length - 1];
        lines[lines.length - 1] = { text: tail.text + piece, stream: tail.stream };
      }
    }
    var dropped = Math.max(0, lines.length - MAX_LINES);
    if (dropped > 0) lines = lines.slice(dropped);
    return { lines: lines, atLineStart: atStart, dropped: dropped };
  }

  /** 一条事件喂进状态。**纯函数**：断言页拿它一遍遍试，不碰 DOM */
  function feed(state, event) {
    if (!event || typeof event !== "object") return state;
    var next = Object.assign({}, state);
    if (typeof event.seq === "number" && event.seq > next.seq) next.seq = event.seq;

    if (event.kind === "chunk") {
      var appended = appendLines(next, event.text || "", event.stream === "stderr" ? "stderr" : "stdout");
      next.lines = appended.lines;
      next.atLineStart = appended.atLineStart;
      next.dropped = (next.dropped || 0) + appended.dropped;
      if (event.id && !next.active) next.active = event.id;
      return next;
    }

    if (event.kind === "done") {
      // 不是正在等的那一条（重发的旧事件）：别把这一条的状态弄乱
      if (next.active && event.id && next.active !== event.id) return next;
      next.active = null;
      next.lastCode = typeof event.code === "number" ? event.code : null;
      next.truncated = Boolean(event.truncated);
      next.status = "idle";
      return next;
    }

    if (event.kind === "lost") {
      next.active = null;
      next.status = "lost";
      return next;
    }
    return next;
  }

  /** 空白状态。第一帧、浏览器预览（没有 shell）、权限被拒都用它 */
  function blankState() {
    return {
      status: "idle",
      cwd: "",
      shell: "powershell",
      seq: 0,
      lines: [],
      atLineStart: true,
      dropped: 0,
      active: null,
      lastCode: null,
      truncated: false,
      history: [],
      denied: false,
    };
  }

  /**
   * 历史：去重 + 上限 200。
   *
   * "连敲两次同一条"不该占两格（上下箭头翻起来最烦的正是这个）；
   * 从更早翻出来再敲一次的，要挪到末尾 —— 它刚刚又用过一次。
   */
  function historyPush(history, command) {
    var text = String(command == null ? "" : command).trim();
    if (!text) return history.slice();
    var next = history.filter(function (item) {
      return item !== text;
    });
    next.push(text);
    if (next.length > HISTORY_MAX) next = next.slice(next.length - HISTORY_MAX);
    return next;
  }

  /** 提示符：`PS C:\Users\me>`。目录拿不到时只留 `PS>` */
  function promptText(state) {
    var label = state.shell === "cmd" ? "" : "PS";
    var cwd = state.cwd || "";
    if (!cwd) return label ? label + ">" : ">";
    return (label ? label + " " : "") + cwd + ">";
  }

  /**
   * 卡片窄的时候把目录剪短：从左边砍，保住最后两段（那才是"我在哪"）。
   * `columns` 由 `columnsFor` 算出来 —— 字号锁死、列数跟着宽度走。
   */
  function fitPrompt(cwd, columns) {
    var text = String(cwd == null ? "" : cwd);
    var room = Math.max(8, Math.round(columns || 0) - 3);
    if (text.length + 1 <= room) return text + ">";
    var parts = text.split("\\");
    var tail = parts[parts.length - 1] || "";
    var prev = parts.length > 1 ? parts[parts.length - 2] : "";
    var candidate = "…\\" + (prev ? prev + "\\" : "") + tail + ">";
    if (candidate.length <= room + 1) return candidate;
    var clipped = tail;
    while (clipped.length > 1 && ("…\\" + clipped + ">").length > room + 1) {
      clipped = clipped.slice(1);
    }
    return "…\\" + clipped + ">";
  }

  /** 这一宽的卡片能放多少列。字号锁 12px，列数由宽度算（设计 §6 验收第 5 条） */
  function columnsFor(width, charWidth) {
    if (!(width > 0) || !(charWidth > 0)) return 0;
    return Math.max(1, Math.floor(width / charWidth));
  }

  window.__latticeTerm = {
    feed: feed,
    appendLines: appendLines,
    stripMarker: stripMarker,
    historyPush: historyPush,
    promptText: promptText,
    fitPrompt: fitPrompt,
    columnsFor: columnsFor,
    blankState: blankState,
    MAX_LINES: MAX_LINES,
    HISTORY_MAX: HISTORY_MAX,
  };

  // ---------- 界面 ----------

  var cardEl = document.getElementById("card");
  var dotEl = document.getElementById("dot");
  var titleEl = document.getElementById("title");
  var cwdEl = document.getElementById("cwd");
  var outEl = document.getElementById("out");
  var formEl = document.getElementById("form");
  var promptEl = document.getElementById("prompt");
  var inputEl = document.getElementById("input");
  var stopEl = document.getElementById("stop");

  var state = blankState();
  /** 排队等着发的那一条（上一条还没 done 时敲的） */
  var queued = null;
  /** 这一次 `lost` 是我们自己按了方块，不是 shell 自己退了 */
  var stopping = false;
  /** 字符宽度，量一次就够：字号是锁死的 */
  var charWidth = 7.2;

  function measureCharWidth() {
    var probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;font-family:var(--mono);font-size:12px;white-space:pre";
    probe.textContent = "0000000000";
    document.body.appendChild(probe);
    var width = probe.getBoundingClientRect().width / 10;
    probe.remove();
    if (width > 0) charWidth = width;
  }

  function columns() {
    return columnsFor(outEl.clientWidth, charWidth);
  }

  function scrollToBottom() {
    outEl.scrollTop = outEl.scrollHeight;
  }

  /**
   * 把行数组同步到 DOM：DOM 里恒有 `lines.length` 个节点，一行一个。
   * 只改变了的那个节点 —— 一段 chunk 落在半行中间时，改的是最后一行的文字。
   */
  function paint() {
    var out = outEl;
    while (out.childNodes.length > state.lines.length) out.removeChild(out.firstChild);
    for (var i = 0; i < state.lines.length; i++) {
      var line = state.lines[i];
      var node = out.childNodes[i];
      if (!node) {
        node = document.createElement("span");
        node.className = "term-line";
        out.appendChild(node);
      }
      if (node.textContent !== line.text) node.textContent = line.text;
      var cls =
        "term-line" +
        (line.stream === "stderr"
          ? " is-err"
          : line.stream === "note"
            ? " is-note"
            : line.stream === "echo"
              ? " is-echo"
              : "");
      if (node.className !== cls) node.className = cls;
    }
  }

  function pushLine(text, stream) {
    var appended = appendLines(state, text + "\n", stream);
    state.lines = appended.lines;
    state.atLineStart = true;
    state.dropped += appended.dropped;
  }

  function render() {
    dotEl.setAttribute("data-state", state.denied ? "denied" : state.status);
    titleEl.textContent = say("终端", "Terminal");
    cwdEl.textContent = state.cwd || say("PowerShell", "PowerShell");
    // 提示符 = `PS ` + 缩写过的目录。列数先扣掉 `PS ` 那三个字符，
    // 否则目录刚好占满时整行会被挤出输入框
    var label = state.shell === "cmd" ? "" : "PS ";
    promptEl.textContent = label + fitPrompt(state.cwd, Math.max(8, columns() - label.length));
    stopEl.hidden = !state.active;
    stopEl.disabled = !state.active;
    cardEl.classList.toggle("is-denied", Boolean(state.denied));
    document.title = say("终端", "Terminal");
  }

  function paintAndRender() {
    var stick = outEl.scrollTop + outEl.clientHeight >= outEl.scrollHeight - 12;
    paint();
    if (stick) scrollToBottom();
    render();
  }

  function note(zh, en) {
    pushLine(say(zh, en), "note");
  }

  function deniedNote() {
    note("需要「在终端里跑命令」权限 —— 去属性面板里勾上", "Needs the Run commands permission — grant it in the inspector");
  }

  /** 问一次平台的状态。`since` 把藏起来那段时间漏掉的事件补回来 */
  function refreshState() {
    return call("term.state", { since: state.seq }, 5000)
      .then(function (info) {
        if (!info || typeof info !== "object") return;
        state.running = Boolean(info.running);
        state.cwd = typeof info.cwd === "string" ? info.cwd : "";
        state.shell = typeof info.shell === "string" ? info.shell : "powershell";
        if (typeof info.seq === "number" && info.seq > state.seq) state.seq = info.seq;
        if (state.denied) {
          state.denied = false;
          pushLine(say("权限有了，可以跑了", "Permission granted — ready"), "note");
        }
        paintAndRender();
      })
      .catch(function (error) {
        if (error && error.code === "permission_denied") {
          state.denied = true;
          deniedNote();
          paintAndRender();
        }
      });
  }

  function send(command) {
    var text = String(command == null ? "" : command).trim();
    if (!text) return;
    if (state.active) {
      // 上一条还在跑：排着，等 done 再发（方块永远停的是当前这条）
      queued = text;
      return;
    }
    pushLine(promptText(state) + " " + text, "echo");
    state.history = historyPush(state.history, text);
    call("storage.set", { key: "history", value: state.history }).catch(function () {});
    paintAndRender();

    call("term.write", { command: text }, 15000)
      .then(function (reply) {
        if (reply && typeof reply.id === "string" && !state.active) state.active = reply.id;
        state.status = "running";
        state.denied = false;
        paintAndRender();
      })
      .catch(function (error) {
        if (error && error.code === "permission_denied") {
          state.denied = true;
          deniedNote();
        } else {
          note(
            "这条命令没能发出去：" + (error && error.message ? error.message : "未知原因"),
            "The command could not be sent: " + (error && error.message ? error.message : "unknown reason"),
          );
        }
        state.status = "idle";
        state.active = null;
        paintAndRender();
      });
  }

  function applyEvent(event) {
    var before = state;
    state = feed(state, event);
    if (state === before) return;

    if (event.kind === "done") {
      if (state.truncated) note("（输出已截断，超过 64KB 的部分没显示）", "(output truncated — more than 64KB was dropped)");
      if (typeof state.lastCode === "number" && state.lastCode !== 0) {
        note("（退出码 " + state.lastCode + "）", "(exit code " + state.lastCode + ")");
      }
      paintAndRender();
      refreshState();
      if (queued) {
        var next = queued;
        queued = null;
        send(next);
      }
      return;
    }

    if (event.kind === "lost") {
      if (stopping) {
        note("已停掉这条 shell —— 下一条命令会起一条新的", "Shell stopped — the next command starts a new one");
      } else {
        note("shell 退出了 —— 敲一条命令就会起一条新的", "The shell exited — type a command to start a new one");
      }
      stopping = false;
    }

    paintAndRender();
    // `lost` 之后平台那边已经把这条 shell 忘了，问一次把 cwd / seq 对齐
    if (event.kind === "lost") refreshState();
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var command = inputEl.value;
    inputEl.value = "";
    send(command);
  });

  stopEl.addEventListener("click", function () {
    stopping = true;
    call("term.stop", {}, 5000).catch(function () {});
    queued = null;
    state.active = null;
    state.status = "idle";
    paintAndRender();
  });

  /*
   * 上下箭头翻历史。光标在行尾之外时先还给输入框自己（左右移动），
   * 这里只管"整条换掉"这一种。
   */
  var cursor = -1;
  inputEl.addEventListener("keydown", function (event) {
    if (event.key === "ArrowUp") {
      if (!state.history.length) return;
      event.preventDefault();
      cursor = cursor < 0 ? state.history.length - 1 : Math.max(0, cursor - 1);
      inputEl.value = state.history[cursor] || "";
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      return;
    }
    if (event.key === "ArrowDown") {
      if (!state.history.length) return;
      event.preventDefault();
      cursor = cursor < 0 ? -1 : Math.min(state.history.length - 1, cursor + 1);
      inputEl.value = cursor < 0 ? "" : state.history[cursor] || "";
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    }
  });

  cardEl.addEventListener("pointerdown", function (event) {
    // 窗饰上的按钮不抢焦点；卡片其它地方点一下就回输入框
    if (event.target === stopEl || stopEl.contains(event.target)) return;
    inputEl.focus();
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type === "term") {
      applyEvent(data.payload);
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

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    render();
  }

  /*
   * 藏起来再回来：中间那段事件可能被 WebView 节流掉，`since` 让平台重发一遍。
   * 这条和"事件还在、只是没画"是两回事 —— 两条路都留着，谁也替不了谁。
   */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refreshState();
  });

  // ---------- 启动 ----------
  // 首帧先按"没有 shell"画（不变量 18），等桥回来再换
  measureCharWidth();
  paintAndRender();
  inputEl.focus();

  call("lang.get")
    .then(function (info) {
      if (info) applyLanguage(info);
    })
    .catch(function () {});

  call("storage.get", { key: "history" })
    .then(function (value) {
      if (Array.isArray(value)) {
        state.history = value.filter(function (item) {
          return typeof item === "string" && item.trim() !== "";
        }).slice(-HISTORY_MAX);
      }
    })
    .catch(function () {});

  refreshState().then(function () {
    parent.postMessage({ __lattice: 1, type: "ready" }, "*");
  });
})();
