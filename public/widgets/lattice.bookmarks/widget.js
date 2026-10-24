/**
 * 网址收藏夹
 *
 * # 一条链接要过几道
 *
 * 用户手打或粘贴进来的东西不是 URL，是"一段文本"：`github.com`、
 * `HTTPS://A.com/x`，或者干脆是 `javascript:alert(1)`。`normalizeUrl` 把它补成
 * 绝对地址（少协议就补 https、空格交给 URL 解析器编码、主机名折平大小写），
 * 只有 http/https 能存进来，存的是 `parsed.href` —— 所以同一条链接的两种写法
 * 在"已收藏"这件事上比得准。
 *
 * **这不是安全边界**。真正的门在 `src-tauri/src/open_policy.rs`：那边不认协议
 * 就等于把 `file:` / `ms-settings:` 交给系统 shell（`ShellExecuteW` 什么都执行）。
 * 这里做的是"让存下来的东西是干净的"，顺便让用户当场看到"这不是个链接"。
 * 两边的规则必须一致，用例表在 `tests/bookmarks.html`（这边）和
 * `open_policy.rs` 的 tests（那边）。
 *
 * # 一个货架，两个视图
 *
 * 存储按 `widgetId`（不是实例）：桌面上放两个收藏夹，它们是同一个货架的两个
 * 视图。每次改动写完盘，平台广播 `store-changed`，另一个视图重读。
 *
 * # 为什么不自动读剪贴板
 *
 * 平台没有"读剪贴板"的权限，这是有意的（剪贴板里可能有刚复制的密码）。所以
 * 流程是用户自己粘贴 —— 别为了"智能"去加一条 `clipboard.read`。
 *
 * # 没有心跳
 *
 * 这个组件不需要定时器：内容只在用户操作或别人写盘时变。别为了"看着在刷新"
 * 挂一条 `schedule.every`，那是白烧电。
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

  // -------------------------------------------------------------------------
  // 数据形状
  // -------------------------------------------------------------------------

  var KEY = "shelf";
  var SCHEMA = 1;
  /** 一屏能扫完的量。超过这个数"收藏夹"就变成了"书签管理器" */
  var MAX_ITEMS = 100;
  var MAX_TITLE = 60;
  var MAX_URL = 2048;

  var items = [];
  var config = null;
  var renaming = null;

  var el = {
    form: document.getElementById("form"),
    url: document.getElementById("url"),
    hint: document.getElementById("hint"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    count: document.getElementById("count"),
  };

  // -------------------------------------------------------------------------
  // URL：归一化与展示
  // -------------------------------------------------------------------------

  var HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
  var IS_HTTP = /^https?:/i;
  /* `example.com:8080/x` 会被当成"协议是 example.com" —— 冒号后面是纯数字端口
     就按浏览器地址栏的规矩当成主机:端口 */
  var LOOKS_LIKE_HOST_PORT = /^[a-z][a-z0-9+.\-]*:\d{1,5}(?:[\/?#]|$)/i;

  function normalizeUrl(raw) {
    var text = typeof raw === "string" ? raw.trim() : "";
    if (!text || text.length > MAX_URL) return null;
    // 裸空格和控制字符会让地址变得不可预测；编码过的东西这里不该出现
    if (/[\u0000-\u0020\u007f]/.test(text)) return null;

    var candidate;
    if (text.slice(0, 2) === "//") candidate = "https:" + text;
    else if (!HAS_SCHEME.test(text)) candidate = "https://" + text;
    else if (!IS_HTTP.test(text) && LOOKS_LIKE_HOST_PORT.test(text)) candidate = "https://" + text;
    else candidate = text;

    var parsed;
    try {
      parsed = new URL(candidate);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (error) {
      return url;
    }
  }

  /** 没给名字时用域名当名字。比"未命名"有用，也比抓网页标题诚实（那要联网） */
  function deriveTitle(url) {
    return hostOf(url).slice(0, MAX_TITLE) || "Link";
  }

  function initialOf(item) {
    var source = hostOf(item.url) || item.title || "";
    var match = source.match(/[\p{L}\p{N}]/u);
    return match ? match[0].toUpperCase() : "•";
  }

  /** 首字母方块的浓度：12–22%，同色系里的一点点区别 */
  function tintOf(host) {
    var hash = 0;
    for (var i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) % 997;
    return 12 + (hash % 11);
  }

  // -------------------------------------------------------------------------
  // 落盘 / 读盘
  // -------------------------------------------------------------------------

  function newId() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /**
   * 读回来的东西一律过一遍这里。
   *
   * 盘上的数据可能是上一版组件写的，也可能被外部改过。返回 null 表示"没有可用的
   * 数据"（没存过 / 版本不认识），和"读失败"是两件事：前者画一个空货架，后者
   * 要提示用户 —— 但都不许种一份默认值写回去。
   */
  function decode(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.v !== SCHEMA) return null;
    if (!Array.isArray(raw.items)) return null;

    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.items.length && out.length < MAX_ITEMS; i++) {
      var entry = raw.items[i];
      if (!entry || typeof entry !== "object") continue;
      var url = normalizeUrl(entry.url);
      if (!url || seen[url]) continue;
      seen[url] = true;
      var title =
        typeof entry.title === "string" ? entry.title.trim().slice(0, MAX_TITLE) : "";
      out.push({
        id: typeof entry.id === "string" && entry.id ? entry.id : newId(),
        url: url,
        title: title || deriveTitle(url),
        addedAt:
          typeof entry.addedAt === "number" && isFinite(entry.addedAt) ? entry.addedAt : 0,
      });
    }
    return out;
  }

  function snapshot() {
    return { v: SCHEMA, items: items };
  }

  function load() {
    return call("storage.get", { key: KEY });
  }

  function persist() {
    return call("storage.set", { key: KEY, value: snapshot() }).catch(function () {
      // 内存里照用，只是写不下去。别把列表清掉 —— 用户的数据不该因为权限没了就消失
      el.count.textContent = "Not saved";
      el.count.classList.add("is-error");
      el.count.title = "Couldn't write the shelf — check the storage permission.";
    });
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function ordered() {
    var list = items.slice();
    var mode = config && config.sort;
    if (mode === "title") {
      list.sort(function (a, b) {
        return (
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
          a.url.localeCompare(b.url)
        );
      });
    } else if (mode === "host") {
      list.sort(function (a, b) {
        return hostOf(a.url).localeCompare(hostOf(b.url)) || a.title.localeCompare(b.title);
      });
    }
    return list;
  }

  var ICON_RENAME =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 3.1l2.3 2.3-6.6 6.6-2.9.6.6-2.9z"/></svg>';
  var ICON_REMOVE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>';

  function actionButton(name, label, icon) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "link-btn";
    button.dataset.action = name;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    return button;
  }

  function rowFor(item) {
    var host = hostOf(item.url);

    var li = document.createElement("li");
    li.className = "link";
    li.tabIndex = 0;
    li.dataset.id = item.id;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", item.title + ", " + host);

    var mark = document.createElement("span");
    mark.className = "link-mark";
    mark.textContent = initialOf(item);
    mark.style.setProperty("--tint", tintOf(host) + "%");
    mark.setAttribute("aria-hidden", "true");

    var body = document.createElement("span");
    body.className = "link-body";

    var name = document.createElement("span");
    name.className = "link-name";
    name.textContent = item.title;
    body.appendChild(name);

    // `showHost` 关掉之后是单行列表：一屏能多放四五行
    if (!config || config.showHost !== false) {
      var hostEl = document.createElement("span");
      hostEl.className = "link-host";
      hostEl.textContent = host;
      body.appendChild(hostEl);
    }

    var actions = document.createElement("span");
    actions.className = "link-actions";
    actions.appendChild(actionButton("rename", "Rename", ICON_RENAME));
    actions.appendChild(actionButton("remove", "Remove", ICON_REMOVE));
    actions.addEventListener("click", function (event) {
      var button = event.target.closest(".link-btn");
      if (!button) return;
      // 按钮在行内，但不该触发"打开"这个动作
      event.stopPropagation();
      if (button.dataset.action === "rename") startRename(item.id);
      else removeItem(item.id);
    });

    li.appendChild(mark);
    li.appendChild(body);
    li.appendChild(actions);

    li.addEventListener("click", function (event) {
      // 有文字被选中（拖选）时不打开 —— 那是"我想复制"，不是"我想跳走"
      var selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (event.target.closest(".link-btn")) return;
      openItem(item.id);
    });
    li.addEventListener("keydown", onRowKeydown);

    return li;
  }

  function render() {
    var list = ordered();
    el.list.textContent = "";
    for (var i = 0; i < list.length; i++) el.list.appendChild(rowFor(list[i]));

    el.empty.hidden = list.length > 0;
    el.count.classList.remove("is-error");
    el.count.removeAttribute("title");
    el.count.textContent = list.length ? String(list.length) : "";
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  function setHint(text, warn) {
    el.hint.textContent = text || "";
    el.hint.classList.toggle("is-warn", !!warn);
  }

  function clearHint() {
    setHint("");
  }

  function itemById(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function add(raw) {
    var url = normalizeUrl(raw);
    if (!url) {
      /*
       * 说清楚"为什么不行"。一句 "Invalid URL" 会让用户反复试 —— 他手里那条
       * 明明能在浏览器里打开（可能是 `file:`，也可能是浏览器自己补了协议）。
       */
      setHint("Only http and https links can be saved here.", true);
      return false;
    }

    for (var i = 0; i < items.length; i++) {
      if (items[i].url === url) {
        setHint("That link is already on the shelf.", true);
        return false;
      }
    }

    if (items.length >= MAX_ITEMS) {
      setHint("The shelf holds " + MAX_ITEMS + " links — remove one first.", true);
      return false;
    }

    items.unshift({ id: newId(), url: url, title: deriveTitle(url), addedAt: Date.now() });
    clearHint();
    render();
    persist();
    return true;
  }

  function removeItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id !== id) continue;
      items.splice(i, 1);
      clearHint();
      render();
      persist();
      // 焦点丢给输入框：桌面窗口靠焦点收键盘，掉到 body 上就什么也打不进去了
      el.url.focus();
      return;
    }
  }

  function openItem(id) {
    var item = itemById(id);
    if (!item) return;
    clearHint();
    call("shell.open", { url: item.url }).catch(function (error) {
      var code = error && error.code;
      if (code === "permission_denied") {
        setHint('Needs the "Open links" permission.', true);
      } else if (code === "internal") {
        setHint("Opening links works in the desktop app.", true);
      } else {
        setHint("Couldn't open that link.", true);
      }
    });
  }

  /*
   * 改名：把名字那个 span 就地换成一个输入框。
   *
   * 用 `blur` 提交而不是只认 Enter —— 用户改完名字最自然的动作是点别处，而那时
   * 输入框会消失；只认 Enter 的话，点击造成的"没保存"会静默丢掉他刚打的字。
   */
  function startRename(id) {
    if (renaming) commitRename();
    var item = itemById(id);
    if (!item) return;
    var row = el.list.querySelector('[data-id="' + id + '"]');
    if (!row) return;
    var nameEl = row.querySelector(".link-name");
    if (!nameEl) return;

    var input = document.createElement("input");
    input.className = "link-rename";
    input.value = item.title;
    input.maxLength = MAX_TITLE;
    input.setAttribute("aria-label", "Name");
    input.addEventListener("keydown", function (event) {
      // 别让 Enter/Delete 冒到行上（那会打开或删掉这一条）
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    });
    input.addEventListener("blur", function () {
      commitRename();
    });

    row.classList.add("is-renaming");
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    renaming = { id: id, input: input };
  }

  function commitRename() {
    if (!renaming) return;
    var session = renaming;
    renaming = null; // 先清：下面的 render 会把输入框整个拆掉，别让 blur 再进来一次
    var item = itemById(session.id);
    if (item) {
      var title = session.input.value.trim().slice(0, MAX_TITLE);
      item.title = title || deriveTitle(item.url);
      persist();
    }
    render();
  }

  function cancelRename() {
    if (!renaming) return;
    renaming = null;
    render();
  }

  function onRowKeydown(event) {
    var id = event.currentTarget.dataset.id;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openItem(id);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeItem(id);
    } else if (event.key === "F2") {
      event.preventDefault();
      startRename(id);
    }
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  el.form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (add(el.url.value)) el.url.value = "";
    el.url.focus();
  });

  el.url.addEventListener("input", clearHint);

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

    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (key && key !== KEY) return;
      // 正在改名时别重读：render 会把输入框拆掉，用户刚打的字就没了
      if (renaming) return;
      load()
        .then(function (raw) {
          var stored = decode(raw);
          if (!stored) return;
          items = stored;
          render();
        })
        .catch(noop);
      return;
    }

    if (data.type === "config-changed") {
      config = data.payload && data.payload.config;
      if (!renaming) render();
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

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /*
   * 先画第一帧（空货架），再等桥 —— 宿主慢一点也不会是一块白卡片。
   * 空货架那句话是诚实的：这时候确实什么都没有。
   */
  render();

  function start(nextConfig) {
    config = nextConfig;
    render();

    return load()
      .then(function (raw) {
        var stored = decode(raw);
        // null 是"没存过"：空货架，不写盘（写了只会给另一个视图发一条无用广播）
        items = stored || [];
        render();
      })
      .catch(function () {
        items = [];
        render();
        setHint("Couldn't read the saved links.", true);
      });
  }

  call("config.get")
    .then(start)
    .catch(function () {
      setHint("This widget could not read its own settings.", true);
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
