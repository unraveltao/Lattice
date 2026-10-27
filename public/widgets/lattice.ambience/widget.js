/**
 * 环境音组件
 *
 * 第三方视角：不 import 平台任何东西，只通过 postMessage 跟宿主说话。
 * 合成全部在 `ambience-core.js` 里（纯逻辑、可断言），这里只管三件事：
 * 把卡片画出来、把用户的选择喂给播放器、把偏好写进组件存储。
 *
 * 两条不能省的行为：
 *  1. **出声必须从点击开始。** 浏览器的自动播放策略、以及桌面端"窗口从不
 *     抢焦点"这两件事叠在一起，页面加载就建 AudioContext 会被按在
 *     `suspended` —— 界面写着"播放中"、耳朵里没有声音，那比不做更糟。
 *     所以 `play()` 只在按钮的点击处理里调用。
 *  2. **播放态不落盘。** 记住的是"选了什么、多大声"，不是"刚才在放"。
 *     下次打开这张卡片仍然是暂停：一个会自己出声的组件，用户在会议室里
 *     打开它是要骂人的。
 *
 * 心跳只服务篝火的爆裂，且只在播放时挂（250ms）。窗口藏起来时平台把
 * 心跳停掉，雨声继续、火声变闷 —— 这比在后台每 250ms 醒一次强。
 */
(function () {
  "use strict";

  // ---------- 极简桥客户端 ----------
  var seq = 0;
  var pending = new Map();

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lattice: 1, type: "request", id: id, method: method, params: params }, "*");
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
   * 界面语言：场景名、状态行、滑杆的无障碍标签都是这个组件自己的字。
   * 两件事都要做 —— 启动时 `lang.get` 一次，用户中途换语言再收 `language`
   * 推送；只做前一半，换语言卡片不动。
   */
  var lang = "zh";

  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  // ---------- 业务 ----------
  var core = window.__latticeAmbienceCore;
  var player = core.player;

  var stateEl = document.getElementById("state");
  var playEl = document.getElementById("play");
  var volEl = document.getElementById("vol");
  var fillEl = document.getElementById("volFill");
  var thumbEl = document.getElementById("volThumb");
  var pctEl = document.getElementById("pct");
  var chips = Array.prototype.slice.call(document.querySelectorAll(".ab-chip"));

  var prefs = core.normalizePrefs(null);
  var playing = false;
  /** 存档回来之前用户已经点过了：这时磁盘上的旧值优先级最低 */
  var touched = false;
  var tickId = 0;
  var tickWanted = false;
  /** 正在飞的写入条数（用来认出"store-changed 是自己刚写的那条"） */
  var writing = 0;
  var lastWriteAt = 0;
  var noAudio = false;
  var noStore = false;

  function sceneLabel() {
    var scene = core.sceneById(prefs.kind) || core.SCENES[0];
    return lang === "en" ? scene.en : scene.zh;
  }

  function percent() {
    return Math.round(prefs.volume * 100);
  }

  function render() {
    chips.forEach(function (chip) {
      var active = chip.getAttribute("data-scene") === prefs.kind;
      chip.setAttribute("aria-pressed", active ? "true" : "false");
      chip.classList.toggle("is-on", active);
    });

    playEl.setAttribute("data-playing", playing ? "true" : "false");
    playEl.setAttribute("aria-label", playing ? say("暂停", "Pause") : say("播放", "Play"));

    var pct = percent();
    volEl.setAttribute("aria-valuenow", String(pct));
    volEl.setAttribute("aria-valuetext", pct + "%");
    volEl.setAttribute("aria-label", say("音量", "Volume"));
    fillEl.style.width = pct + "%";
    thumbEl.style.left = pct + "%";
    pctEl.textContent = pct + "%";

    if (noAudio) {
      stateEl.textContent = say("此环境没有音频输出", "No audio output here");
    } else if (playing) {
      stateEl.textContent = sceneLabel() + " · " + pct + "%";
    } else if (noStore) {
      stateEl.textContent = say("已暂停 · 不记住设置", "Paused · not remembered");
    } else {
      stateEl.textContent = say("已暂停", "Paused");
    }
    // CSS 只认这一个开关（按钮图标、呼吸光都挂在它上面）
    document.body.setAttribute("data-playing", playing ? "true" : "false");
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("环境音", "Ambience");
    chips.forEach(function (chip) {
      var scene = core.sceneById(chip.getAttribute("data-scene"));
      if (scene) chip.textContent = lang === "en" ? scene.en : scene.zh;
    });
    render();
  }

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

    // 另一个实例（或者平台的清空操作）改了同一份偏好
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === "ambience") reloadPrefs();
      return;
    }

    if (data.type === "tick") {
      if (playing && tickId && data.payload && data.payload.id === tickId) player.tick();
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

  // ---------- 偏好 → 播放器 ----------

  function persist() {
    writing += 1;
    call("storage.set", { key: "ambience", value: { kind: prefs.kind, volume: prefs.volume } })
      .catch(function (error) {
        if (error && error.code === "permission_denied") {
          noStore = true;
          render();
        }
        /* 别的原因存不上：这次会话里照样记得，只是下次打开是出厂值 */
      })
      .then(function () {
        writing -= 1;
        lastWriteAt = Date.now();
      });
  }

  /**
   * 别人的写入要不要跟随。三道闸：
   *  - 用户在这张卡片上动过（`touched`）：本地优先，别把人家刚点的盖掉
   *  - 自己有写入在飞：那多半就是自己这条广播
   *  - 刚写完 1.2 秒内：同上，广播没有回执，只能按时间猜
   */
  function reloadPrefs() {
    if (touched || writing > 0) return;
    if (Date.now() - lastWriteAt < 1200) return;
    call("storage.get", { key: "ambience" })
      .then(function (value) {
        if (touched || writing > 0) return;
        var next = core.normalizePrefs(value);
        if (next.kind === prefs.kind && next.volume === prefs.volume) return;
        prefs = next;
        if (playing) {
          if (!player.play(prefs.kind, prefs.volume)) stopQuietly();
        }
        render();
      })
      .catch(function () {});
  }

  /* 播放器建不出图（没有音频设备 / 被策略彻底挡住）：
   * 回到暂停，并在状态行说清楚，不留一个"播放中"的假象 */
  function stopQuietly() {
    playing = false;
    noAudio = true;
    wantTick(false);
    render();
  }

  function start() {
    if (noAudio) return;
    if (!player.play(prefs.kind, prefs.volume)) {
      stopQuietly();
      return;
    }
    playing = true;
    wantTick(true);
    render();
  }

  function stop() {
    player.pause();
    playing = false;
    wantTick(false);
    render();
  }

  /**
   * 心跳的挂与摘。注册是往返，用户可能在上一条还没回来时又按了一次暂停，
   * 所以 `.then` 里要按最新的 `tickWanted` 再判一次 —— 否则会出现
   * "已经暂停了、但心跳还挂着"的孤儿订阅。
   */
  function wantTick(on) {
    tickWanted = on;
    if (on && !tickId) {
      call("schedule.every", { every: 250 })
        .then(function (grant) {
          var id = grant && typeof grant.id === "number" ? grant.id : 0;
          if (!id) return;
          if (!tickWanted) {
            call("schedule.clear", { id: id }).catch(function () {});
            return;
          }
          tickId = id;
        })
        .catch(function () {
          /* 心跳没挂上：雨声照常，篝火少了爆裂 */
        });
      return;
    }
    if (!on && tickId) {
      var stale = tickId;
      tickId = 0;
      call("schedule.clear", { id: stale }).catch(function () {});
    }
  }

  function selectScene(id) {
    if (!core.sceneById(id) || id === prefs.kind) return;
    touched = true;
    prefs.kind = id;
    if (playing && !player.play(prefs.kind, prefs.volume)) stopQuietly();
    render();
    persist();
  }

  function setVolume(next, options) {
    prefs.volume = core.normalizePrefs({ kind: prefs.kind, volume: next }).volume;
    player.setVolume(prefs.volume);
    render();
    if (!options || !options.silent) persist();
  }

  // ---------- 交互 ----------

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      selectScene(chip.getAttribute("data-scene"));
    });
  });

  playEl.addEventListener("click", function () {
    touched = true;
    if (playing) stop();
    else start();
  });

  /*
   * 音量滑杆：自绘，不用原生 input[type=range]（沙箱里 color-scheme 被钉成
   * normal，原生控件会按浅色画）。拖动过程中只改播放器、不落盘，抬手才写一次。
   */
  var dragging = false;

  function volumeAt(clientX) {
    var rect = volEl.getBoundingClientRect();
    if (!rect.width) return prefs.volume;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  volEl.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    touched = true;
    dragging = true;
    try {
      volEl.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 老实现没有捕获，drag 靠 pointermove 照样能用 */
    }
    setVolume(volumeAt(event.clientX), { silent: true });
    event.preventDefault();
  });

  volEl.addEventListener("pointermove", function (event) {
    if (!dragging) return;
    setVolume(volumeAt(event.clientX), { silent: true });
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    try {
      volEl.releasePointerCapture(event.pointerId);
    } catch (error) {
      /* 没捕获过 */
    }
    persist();
  }

  volEl.addEventListener("pointerup", endDrag);
  volEl.addEventListener("pointercancel", endDrag);

  volEl.addEventListener("keydown", function (event) {
    var step = event.shiftKey ? 0.01 : 0.05;
    var next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = prefs.volume + step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = prefs.volume - step;
    else if (event.key === "PageUp") next = prefs.volume + 0.1;
    else if (event.key === "PageDown") next = prefs.volume - 0.1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    if (next === null) return;
    event.preventDefault();
    touched = true;
    setVolume(next);
  });

  /*
   * 自动播放策略的兜底：万一第一次点击没把 ctx 叫醒（个别 WebView 把
   * 合成的手势判定得很严），下一次任意点击补一次 resume。只补一次意思 ——
   * 不轮询、不重试队列。
   */
  document.addEventListener(
    "pointerdown",
    function () {
      if (!playing) return;
      var ctx = player.context();
      if (!ctx || ctx.state !== "suspended") return;
      try {
        var promise = ctx.resume();
        if (promise && typeof promise.catch === "function") promise.catch(function () {});
      } catch (error) {
        /* 叫不醒就算了，卡片上仍然是播放态 */
      }
    },
    true,
  );

  // 窗口被收走时不需要做什么：扬声器里的声音不该跟着卡片一起断。真停是
  // 卡片被移除（iframe 销毁，AudioContext 自然释放）。

  // ---------- 首帧与桥 ----------
  render();

  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到语言就按 HTML 里的中文画 */
    });

  call("storage.get", { key: "ambience" })
    .then(function (value) {
      if (touched) return;
      prefs = core.normalizePrefs(value);
      render();
    })
    .catch(function (error) {
      if (error && error.code === "permission_denied") {
        noStore = true;
        render();
      }
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
