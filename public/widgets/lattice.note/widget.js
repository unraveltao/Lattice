/**
 * 便签组件
 *
 * 这个组件存在的意义不是"便签"这个功能，而是验证平台的一个硬问题：
 * 组件里能不能正常输入。桌面端窗口是 WS_EX_NOACTIVATE（永不激活）的，
 * 输入框要打字就必须有焦点 —— 这两件事在 Win32 层是打架的。
 * 在浏览器预览里它只是普通 textarea，到了独立窗口才见真章。
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
   * 界面语言。
   *
   * 便签上的字（状态行、字数、占位符）都是这个组件自己的，平台不知道中文
   * 怎么写。所以两件事都要做：启动时问一次 `lang.get`，用户中途换语言再收
   * `language` 推送，把已经画出去的字原地换掉。
   *
   * 首帧按 HTML 里写死的中文画（不变量 18）；英文界面等桥回来那一趟再翻，
   * 不为这几十毫秒画"加载中"。
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
    document.title = say("便签", "Note");
    textEl.placeholder = say("写点什么…", "Write something…");
    updateCount();
    // 状态行的文字由状态机给，重画当前那一条，别把"保存中…"写成别的
    setStatus(statusKey, statusKind);
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
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === "text") reloadText();
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

  // ---------- 业务 ----------
  var textEl = document.getElementById("text");
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");

  var timer = null;

  /*
   * 保存状态机
   *
   * 两个数字就够：
   *   revision  每次输入 +1，代表"用户想存的那一版内容"
   *   saved     已经确认落盘的版本
   *
   * 不这么写会出三种错，全都表现为"优先级搞反了"：
   *   1. 保存在飞的时候用户又敲了字，回调却把状态写成"已保存" —— 界面撒谎；
   *   2. 两次保存并发，旧的那次后完成，把新内容盖掉 —— 旧值赢了新值；
   *   3. 载入是异步的，用户先开始打字，磁盘上的旧内容回来把输入冲掉 ——
   *      磁盘赢了用户。
   */
  var revision = 0;
  var saved = 0;
  var saving = false;

  /*
   * 状态行按"键"存，不存已经翻好的字：换语言时要能重画当前那一条。
   * kind 只管颜色（saved / error / 空）。
   */
  var statusKey = "loading";
  var statusKind = "";

  var STATUS_TEXT = {
    loading: function () {
      return say("正在载入…", "Loading…");
    },
    saving: function () {
      return say("保存中…", "Saving…");
    },
    saved: function () {
      return say("已保存", "Saved");
    },
    unsaved: function () {
      return say("未保存", "Unsaved");
    },
    noPermission: function () {
      return say("没有存储权限", "No storage permission");
    },
    saveFailed: function () {
      return say("保存失败", "Could not save");
    },
    loadFailed: function () {
      return say("读不到内容", "Could not load");
    },
  };

  function setStatus(key, kind) {
    statusKey = key;
    statusKind = kind || "";
    var text = STATUS_TEXT[key]();
    statusEl.textContent = text;
    statusEl.className = statusKind ? "is-" + statusKind : "";
    // 状态条只有 140px 宽（右边 120px 留给窗饰），长文案会被省略号截掉；
    // 截掉了才挂 title，没截就别挂 —— 不然"Saved"上也会凭空弹出个提示
    if (statusEl.scrollWidth > statusEl.clientWidth) statusEl.title = text;
    else statusEl.removeAttribute("title");
  }

  function updateCount() {
    countEl.textContent = say(
      Array.from(textEl.value).length + " 字",
      Array.from(textEl.value).length + " chars",
    );
  }

  function save() {
    // 上一次还没回来就什么都不做：它回来时会发现 revision 更大，自己再存一次
    if (saving || saved >= revision) return;
    saving = true;
    var target = revision;
    setStatus("saving", "");
    call("storage.set", { key: "text", value: textEl.value })
      .then(function () {
        saved = target;
        saving = false;
        if (revision > saved) {
          save();
          return;
        }
        setStatus("saved", "saved");
      })
      .catch(function (error) {
        saving = false;
        setStatus(error.code === "permission_denied" ? "noPermission" : "saveFailed", "error");
      });
  }

  textEl.addEventListener("input", function () {
    revision += 1;
    updateCount();
    // 正在保存时别把"保存中…"改回"未保存"，那会让人以为存完了又退回
    if (!saving) setStatus("unsaved", "");
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });

  // 失焦立刻落盘，避免用户切走时最后 400ms 的输入丢掉
  textEl.addEventListener("blur", function () {
    clearTimeout(timer);
    save();
  });

  /**
   * 别的实例改了这份便签，重读一次。
   *
   * 什么时候不重读（本地优先，和保存状态机是同一套优先级）：
   *   - 还有没落盘的输入（revision > saved）：用户正在写，磁盘上的不能盖过来
   *   - 光标就在输入框里：同上，哪怕刚好存完了也别在人家打字时换内容
   */
  function reloadText() {
    if (revision > saved) return;
    if (document.activeElement === textEl) return;
    call("storage.get", { key: "text" })
      .then(function (value) {
        if (revision > saved) return;
        if (typeof value !== "string") return;
        if (value === textEl.value) return;
        textEl.value = value;
        updateCount();
        setStatus("saved", "saved");
      })
      .catch(function () {});
  }

  // 窗口被收走 / 页面隐藏时补一次。postMessage 是异步的，不保证一定送达，
  // 但比干等那 400ms 定时器强
  function flush() {
    if (revision <= saved) return;
    clearTimeout(timer);
    save();
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住读盘和首屏
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(function () {
      /* 拿不到就按中文画 */
    });

  call("storage.get", { key: "text" })
    .then(function (value) {
      if (revision > 0) {
        // 用户在这几十毫秒里已经开始打字了：磁盘上的旧内容优先级最低
        updateCount();
        setStatus("unsaved", "");
        return;
      }
      if (typeof value === "string") textEl.value = value;
      updateCount();
      setStatus("saved", "saved");
    })
    .catch(function (error) {
      if (revision > 0) return;
      updateCount();
      setStatus(error.code === "permission_denied" ? "noPermission" : "loadFailed", "error");
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
