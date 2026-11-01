/**
 * Todoist 组件（lattice.todoist）—— 远端只读镜像 + 本地草稿本。
 *
 * 四条线，各自独立，谁也别顺手改：
 *
 * 1. **token 走 `secret`，不进 `storage`。** 组件存储是一份明文 JSON（
 *    `widget-data/<id>.json`），token 写进去等于交给任何能读 %APPDATA% 的
 *    进程；`secret.set` 那边是 DPAPI 封的 `secrets.bin`，按组件 id 分前缀。
 *    所以这个文件里**没有一处**把 token 写进 storage 的代码。
 *
 * 2. **出网只有 `network.fetch` 一条路。** 组件文档的 `connect-src` 只有它
 *    自己的协议源，`fetch("https://api.todoist.com/…")` 在浏览器层就抛
 *    `TypeError` —— 那是设计，不是配错。清单里 `network.hosts` 钉死
 *    `api.todoist.com`，白名单在 Rust 侧按实例校验，组件改不了。
 *
 * 3. **对 Todoist 只读。** 这里没有任何写回 Todoist 的代码：没有 POST、
 *    没有 close、没有 move（见 0042 §3）。勾选不了是远端那一档的功能边界。
 *
 * 4. **本地那一档是草稿本，不是第二份待办。** 没有 Todoist 账号的人也得能用
 *    （0043 §3），所以它有 `text` / `done` 两个字段、能加能勾能删；**没有**
 *    档位、优先级、拖拽顺序 —— 那些是 `lattice.todo` 的事。它只在没有 token
 *    时出现，而且**永远不会**往 Todoist 推（那就是双向同步了）。
 *
 * 分工：能算的都在 `todoist-core.js`（纯函数、tests/todoist.html 直接测），
 * 这里只做 DOM、桥和时序。
 */
(function () {
  "use strict";

  var C = window.__latticeTodoistCore;

  var SECRET_NAME = "token";
  var CACHE_KEY = "cache";
  var LOCAL_KEY = "local";
  /** 桥默认 3 秒；出网要按 Rust 那侧的 10 秒接收超时留余量 */
  var NET_TIMEOUT = 15000;
  /** 一次性提示自己消失的时间。它是"说一句"，不是"要求你处理" */
  var NOTE_MS = 12000;
  var TOKEN_PAGE = "https://app.todoist.com/app/settings/integrations/developer";

  // ---------------------------------------------------------------------------
  // 桥
  // ---------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params, timeout) {
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
      }, timeout || 3000);
    });
  }

  function noop() {}

  // ---------------------------------------------------------------------------
  // 主题与语言
  // ---------------------------------------------------------------------------

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

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  /**
   * 一个失败该怎么说。
   *
   * 每一条都指向"下一步做什么"：token 失效 → 换一个；限流 → 等几秒；
   * 不在桌面应用里 → 装到桌面里。合成一句"请求失败"等于让人去查网络。
   */
  function errorText(kind, retryAfter) {
    switch (kind) {
      case "token":
        return say("token 失效了，换一个", "That token is no longer valid");
      case "forbidden":
        return say("这个 token 读不了任务", "This token cannot read tasks");
      case "notfound":
        return say("接口地址变了", "The API endpoint moved");
      case "limit":
        return retryAfter > 0
          ? say("被限流了，" + retryAfter + " 秒后重试", "Rate-limited, retry in " + retryAfter + "s")
          : say("被限流了，过一会儿再试", "Rate-limited, try again later");
      case "server":
        return say("Todoist 那边出错了", "Todoist returned an error");
      case "redirect":
        return say("接口把请求转走了", "The API redirected the request");
      case "truncated":
        return say("返回太大，被截断了", "The response was too large and got truncated");
      case "permission":
        return say("缺联网权限", "Network permission is missing");
      case "nodesktop":
        return say("联网要在桌面应用里", "Networking needs the desktop app");
      case "sealed":
        return say("密钥读不出来，重新填一次", "The saved token cannot be read — paste it again");
      case "bad":
        return say("返回的不是任务列表", "The response was not a task list");
      default:
        return say("连不上 Todoist", "Cannot reach Todoist");
    }
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  /** boot → setup | local | remote | remote-error */
  var view = "boot";
  var token = "";
  var tasks = [];
  var local = [];
  var syncedAt = 0;
  var partial = false;
  var failure = null;
  var busy = false;
  /** 密封库读失败的原因：和"没填过"要分开说 */
  var sealedBroken = "";
  /** 一次性提示的正文（连上那一刻"本地还有几条"），空串就是不显示 */
  var notice = "";
  var noteTimer = 0;
  /** 本地清单在写盘，回声要压住 */
  var writing = 0;
  var pendingReload = false;
  /** 用户已经动过本地清单：磁盘上的旧内容不许盖掉它 */
  var touched = false;

  var rootEl = document.getElementById("root");
  var metaEl = document.getElementById("meta");
  var noteEl = document.getElementById("note");
  var noteTextEl = document.getElementById("noteText");
  var noteCloseEl = document.getElementById("noteClose");
  var setupEl = document.getElementById("setup");
  var setupHintEl = document.getElementById("setupHint");
  var setupErrorEl = document.getElementById("setupError");
  var openSettingsEl = document.getElementById("openSettings");
  var useLocalEl = document.getElementById("useLocal");
  var disconnectEl = document.getElementById("disconnect");
  var cancelEl = document.getElementById("cancel");
  var formEl = document.getElementById("tokenForm");
  var inputEl = document.getElementById("tokenInput");
  var saveEl = document.getElementById("tokenSave");
  var bodyEl = document.getElementById("body");
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var localFormEl = document.getElementById("localForm");
  var localInputEl = document.getElementById("localInput");
  var statusEl = document.getElementById("status");
  var refreshEl = document.getElementById("refresh");
  var connectEl = document.getElementById("connect");
  var settingsEl = document.getElementById("settings");

  // ---------------------------------------------------------------------------
  // 画
  // ---------------------------------------------------------------------------

  function isRemote() {
    return view === "remote" || view === "remote-error";
  }

  function render() {
    rootEl.setAttribute("data-view", view);
    setupEl.hidden = view !== "setup";
    bodyEl.hidden = view === "setup" || view === "boot";
    localFormEl.hidden = view !== "local";
    noteEl.hidden = !notice;
    if (notice) noteTextEl.textContent = notice;

    if (view === "setup") {
      setupHintEl.textContent = say(
        "复制 Todoist「设置 → 集成 → 开发者」里的 API token 粘到下面。它只进本机密封库。",
        "Copy the token from Todoist → Settings → Integrations → Developer and paste it below. It stays in the local sealed store.",
      );
      openSettingsEl.textContent = say("打开 Todoist 设置页", "Open the Todoist settings page");
      inputEl.placeholder = say("粘贴 API token", "Paste the API token");
      saveEl.textContent = say("连接", "Connect");
      useLocalEl.textContent = local.length
        ? say("返回本地清单", "Back to the local list")
        : say("没有 Todoist？先用本地清单", "No Todoist? Use a local list");
      // 没有 token 时这条路必须一直在。从草稿本点底栏那颗云会进 setup，而那里
      // 唯一能回去的就是这一颗 —— 按"本地有条目就不再劝你用草稿本"藏掉它，
      // 卡片就停在 setup 上，那几条再也看不见，只能关掉重开。
      useLocalEl.hidden = Boolean(token);
      disconnectEl.textContent = say("断开 Todoist", "Disconnect Todoist");
      disconnectEl.hidden = !token;
      cancelEl.hidden = !token;
      cancelEl.textContent = say("取消", "Cancel");
    }

    if (isRemote() && (view === "remote" || tasks.length)) {
      metaEl.textContent = partial
        ? say(tasks.length + "+ 项", tasks.length + "+ tasks")
        : say(tasks.length + " 项", tasks.length + (tasks.length === 1 ? " task" : " tasks"));
    } else if (view === "local") {
      metaEl.textContent = say(local.length + " 条", local.length + (local.length === 1 ? " item" : " items"));
    } else if (view === "setup") {
      metaEl.textContent = say("未连接", "Not connected");
    } else if (view === "remote-error") {
      metaEl.textContent = say("连接失败", "Cannot connect");
    } else {
      metaEl.textContent = "";
    }

    if (view !== "setup" && view !== "boot") renderList();

    statusEl.textContent = statusText();
    statusEl.title = failure ? errorText(failure.kind, failure.retryAfter) : "";

    refreshEl.hidden = !isRemote();
    refreshEl.disabled = busy || !token;
    refreshEl.classList.toggle("is-spin", busy);
    refreshEl.setAttribute("aria-label", say("刷新", "Refresh"));

    connectEl.hidden = view !== "local";
    connectEl.setAttribute("aria-label", say("连接 Todoist", "Connect Todoist"));

    settingsEl.hidden = !isRemote();
    settingsEl.disabled = !token;
    settingsEl.setAttribute("aria-label", say("换一个 token", "Use a different token"));

    noteCloseEl.textContent = say("知道了", "Got it");
    localInputEl.placeholder = say("记一条", "Add one");
  }

  function statusText() {
    if (view === "local") return say("本地 · 不会同步", "Local · not synced");
    if (busy) return say("同步中…", "Syncing…");
    var stamp = syncedAt ? C.clockOf(syncedAt) : "";
    if (failure) {
      // 有缓存时把时间也带上：看到"10:42"才知道画的是几点的那份
      return stamp
        ? errorText(failure.kind, failure.retryAfter) + " · " + stamp
        : errorText(failure.kind, failure.retryAfter);
    }
    return stamp ? (lang === "en" ? "synced " + stamp : stamp + " 同步") : "";
  }

  function renderList() {
    listEl.textContent = "";
    if (view === "local") {
      renderLocalList();
      return;
    }
    renderRemoteList();
  }

  function renderRemoteList() {
    var today = C.todayOf(Date.now());
    var rows = tasks.slice(0, C.MAX_ROWS);

    for (var i = 0; i < rows.length; i++) {
      var task = rows[i];
      var row = document.createElement("li");
      row.className = "tz-row";
      row.setAttribute("data-p", task.priority || "none");

      var dot = document.createElement("span");
      dot.className = "tz-dot";
      dot.setAttribute("aria-hidden", "true");

      var text = document.createElement("span");
      text.className = "tz-text";
      // 任务标题是**用户内容**，只能走 textContent。用 innerHTML 的话，
      // 一条叫 `<img onerror=…>` 的任务就能在卡片里跑起来
      text.textContent = task.text;
      text.title = task.text;

      row.appendChild(dot);
      row.appendChild(text);

      if (task.due) {
        var due = document.createElement("span");
        due.className = "tz-due";
        due.textContent = C.dueLabel(task.due, lang);
        if (C.isOverdue(task.due, today)) row.classList.add("is-late");
        row.appendChild(due);
      }

      listEl.appendChild(row);
    }

    emptyEl.hidden = rows.length > 0;
    if (!rows.length) {
      emptyEl.textContent = busy ? say("同步中…", "Syncing…") : say("没有未完成的任务", "No open tasks");
    }
  }

  function renderLocalList() {
    for (var i = 0; i < local.length; i++) {
      var item = local[i];
      var row = document.createElement("li");
      row.className = "tz-row is-local";
      row.setAttribute("data-id", item.id);
      if (item.done) row.classList.add("is-done");

      var check = document.createElement("button");
      check.type = "button";
      check.className = "tz-check";
      check.setAttribute("role", "checkbox");
      check.setAttribute("aria-checked", item.done ? "true" : "false");
      // 标签就是这一条的内容。写"完成"的话，读屏会把整列念成"完成、完成、
      // 完成"—— 一行说的是什么，一个字都不进去（勾没勾由 aria-checked 说）
      check.setAttribute("aria-label", item.text);

      var text = document.createElement("span");
      text.className = "tz-text";
      text.textContent = item.text;
      text.title = item.text;

      var del = document.createElement("button");
      del.type = "button";
      del.className = "tz-del";
      del.textContent = "×";
      del.setAttribute("aria-label", say("删除「" + item.text + "」", "Delete " + item.text));

      row.appendChild(check);
      row.appendChild(text);
      row.appendChild(del);
      listEl.appendChild(row);
    }

    emptyEl.hidden = local.length > 0;
    if (!local.length) emptyEl.textContent = say("记一条试试", "Nothing here yet");
  }

  // ---------------------------------------------------------------------------
  // 远端：取
  // ---------------------------------------------------------------------------

  function verdictError(verdict) {
    var error = new Error("HTTP " + (verdict.status || 0));
    error.kind = verdict.kind;
    error.status = verdict.status || 0;
    error.retryAfter = verdict.retryAfter || 0;
    return error;
  }

  /**
   * 拉一遍，最多跟两跳 cursor。
   *
   * 不在这一层判"成功/失败"以外的事：401、限流、被截断都由 core 的
   * `classify` 定，这里只负责把它们原样往上递 —— 在两层各判一次，
   * 迟早会出现"桥说 ok、界面说错"的对不上。
   */
  function fetchTasks(current) {
    var collected = [];
    var partial = false;

    function step(url, page) {
      return call(
        "network.fetch",
        {
          url: url,
          method: "GET",
          headers: { authorization: "Bearer " + current, accept: "application/json" },
        },
        NET_TIMEOUT,
      ).then(function (response) {
        var verdict = C.classify(response);
        if (verdict.kind !== "ok") throw verdictError(verdict);
        var parsed = C.parsePage(response.body);
        if (parsed.shape === "bad") throw verdictError({ kind: "bad", status: response.status });

        collected = collected.concat(parsed.tasks);
        if (parsed.nextCursor && page + 1 < C.MAX_PAGES && collected.length < C.MAX_CACHE) {
          return step(C.tasksUrl(parsed.nextCursor), page + 1);
        }
        // 还有下一页却没再跟（页数或条数到顶）—— 头部要写 "+"，
        // 把 40 条说成"一共 40 条"是在替服务端撒谎
        partial = Boolean(parsed.nextCursor) || collected.length >= C.MAX_CACHE;
        return { tasks: collected.slice(0, C.MAX_CACHE), partial: partial };
      });
    }

    return step(C.tasksUrl(null), 0).catch(function (error) {
      if (error && error.kind) throw error;
      var verdict = C.classifyError(error);
      var wrapped = new Error(error && error.message ? error.message : "network");
      wrapped.kind = verdict.kind;
      throw wrapped;
    });
  }

  function persistCache() {
    call("storage.set", {
      key: CACHE_KEY,
      value: { v: C.CACHE_VERSION, at: syncedAt, tasks: tasks.slice(0, C.MAX_CACHE) },
    }).catch(noop);
  }

  function refresh() {
    if (!token || busy) return;
    busy = true;
    failure = null;
    render();

    fetchTasks(token)
      .then(function (result) {
        busy = false;
        tasks = result.tasks;
        partial = result.partial;
        syncedAt = Date.now();
        view = "remote";
        failure = null;
        render();
        persistCache();
      })
      .catch(function (error) {
        busy = false;
        failure = { kind: error.kind || "offline", retryAfter: error.retryAfter || 0 };
        view = "remote-error";
        // 缓存留着：失败时把列表清空，等于"连不上"顺手把上次的内容也弄丢了
        render();
      });
  }

  // ---------------------------------------------------------------------------
  // 本地草稿本
  // ---------------------------------------------------------------------------

  function persistLocal() {
    writing += 1;
    call("storage.set", { key: LOCAL_KEY, value: local })
      .catch(noop)
      .then(function () {
        writing -= 1;
        if (writing === 0 && pendingReload) {
          pendingReload = false;
          reloadLocal();
        }
      });
  }

  /** 从磁盘重读。内容没变就不重画，免得自己的回声把列表抖一下 */
  function reloadLocal() {
    if (writing > 0) {
      pendingReload = true;
      return;
    }
    if (touched) return;
    call("storage.get", { key: LOCAL_KEY })
      .then(function (value) {
        var next = C.normalizeLocalItems(value);
        if (JSON.stringify(next) === JSON.stringify(local)) return;
        local = next;
        if (view === "local") render();
      })
      .catch(noop);
  }

  function commitLocal(next) {
    touched = true;
    local = next;
    render();
    persistLocal();
  }

  localFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = localInputEl.value.trim();
    if (!text) return;
    if (local.length >= C.MAX_LOCAL) {
      statusEl.textContent = say("本地清单满了（" + C.MAX_LOCAL + " 条）", "Local list is full (" + C.MAX_LOCAL + ")");
      return;
    }
    localInputEl.value = "";
    commitLocal(C.addLocal(local, { id: newId(), text: text }));
  });

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  listEl.addEventListener("click", function (event) {
    if (view !== "local") return;
    var row = event.target.closest ? event.target.closest(".tz-row.is-local") : null;
    if (!row) return;
    var id = row.getAttribute("data-id");
    if (event.target.closest(".tz-del")) {
      commitLocal(C.removeLocal(local, id));
      return;
    }
    // 整行可点：点哪儿都算勾掉（勾选框只有 13px，不值得要求精确）
    commitLocal(C.toggleLocal(local, id));
  });

  // ---------------------------------------------------------------------------
  // 设置
  // ---------------------------------------------------------------------------

  function showNotice(text) {
    notice = text;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(hideNotice, NOTE_MS);
    render();
  }

  /** 收起那条一次性提示。定时器、那颗「知道了」、断开都要走这里 */
  function hideNotice() {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = 0;
    notice = "";
    render();
  }

  function showSetup(message) {
    view = "setup";
    inputEl.value = "";
    setupErrorEl.hidden = !message;
    setupErrorEl.textContent = message || "";
    render();
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = inputEl.value.trim();
    if (!value) {
      setupErrorEl.hidden = false;
      setupErrorEl.textContent = say("先粘一个 token", "Paste a token first");
      return;
    }
    saveEl.disabled = true;
    call("secret.set", { name: SECRET_NAME, value: value })
      .then(function () {
        saveEl.disabled = false;
        token = value;
        sealedBroken = "";
        setupErrorEl.hidden = true;
        // 连上那一刻说一次"本地还有几条" —— 之后它们就看不见了，
        // 而"没说过就藏起来"和"说过一次"是两件事（0043 §3）
        var kept = local.length;
        view = "remote";
        render();
        refresh();
        if (kept > 0) {
          showNotice(
            say(
              "本地还有 " + kept + " 条，留在本机、不会同步；断开 Todoist 就能看到它们。",
              kept + " local item(s) stay on this machine and are not synced — disconnect Todoist to see them again.",
            ),
          );
        }
      })
      .catch(function (error) {
        saveEl.disabled = false;
        var verdict = C.classifyError(error);
        setupErrorEl.hidden = false;
        setupErrorEl.textContent =
          verdict.kind === "permission"
            ? say("缺密封库权限", "The sealed store permission is missing")
            : errorText(verdict.kind);
      });
  });

  openSettingsEl.addEventListener("click", function () {
    // 打不开就算了：上面那行字已经写清了路径，这条只是少找两步
    call("shell.open", { url: TOKEN_PAGE }).catch(noop);
  });

  useLocalEl.addEventListener("click", function () {
    view = "local";
    setupErrorEl.hidden = true;
    render();
    localInputEl.focus();
  });

  disconnectEl.addEventListener("click", function () {
    call("secret.delete", { name: SECRET_NAME })
      .then(function () {
        token = "";
        failure = null;
        // 那条"本地还有 N 条、断开就能看到"说的是"你现在看不见它们"。
        // 已经看见了还挂着，就是在讲一件发生过的事
        hideNotice();
        // 本地清单还在 → 回到草稿本；空的 → 回到第一次用的界面
        view = local.length ? "local" : "setup";
        render();
      })
      .catch(function (error) {
        var verdict = C.classifyError(error);
        setupErrorEl.hidden = false;
        setupErrorEl.textContent = errorText(verdict.kind);
      });
  });

  cancelEl.addEventListener("click", function () {
    if (!token) return;
    failure = null;
    view = tasks.length ? "remote" : "remote-error";
    render();
  });

  settingsEl.addEventListener("click", function () {
    if (!token) return;
    showSetup("");
  });

  connectEl.addEventListener("click", function () {
    showSetup("");
  });

  refreshEl.addEventListener("click", function () {
    refresh();
  });

  noteCloseEl.addEventListener("click", hideNotice);

  // ---------------------------------------------------------------------------
  // 心跳
  // ---------------------------------------------------------------------------

  /*
   * 用 `schedule.every` 而不是 `setInterval`：组件里自己开定时器等于绕开
   * 平台的"不可见就停摆"（不变量 10）。十秒级的刷新不需要，十分钟级的
   * "别人在手机上加了一条"需要 —— 而不可见时它就该停。
   */
  var tickId = 0;

  function beat() {
    call("schedule.every", { every: C.TTL })
      .then(function (grant) {
        if (grant && grant.id) tickId = grant.id;
      })
      .catch(noop);
  }

  // ---------------------------------------------------------------------------
  // 消息
  // ---------------------------------------------------------------------------

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;

    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    if (data.type === "language") {
      lang = data.payload && data.payload.lang === "en" ? "en" : "zh";
      render();
      return;
    }
    if (data.type === "tick") {
      if (!data.payload || data.payload.id !== tickId) return;
      // 只在真的过期时发请求：十分钟的一拍里，用户可能刚手动刷过
      if (token && !busy && !C.cacheFresh({ at: syncedAt }, Date.now())) refresh();
      return;
    }
    if (data.type === "store-changed") {
      var key = data.payload && data.payload.key;
      if (!key || key === LOCAL_KEY) reloadLocal();
      return;
    }
    if (data.type !== "response") return;

    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) {
      entry.resolve(data.result);
      return;
    }
    var error = new Error(data.error || "Bridge call failed");
    error.code = data.code;
    entry.reject(error);
  });

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  // 先问一次语言（首帧按 HTML 里的中文画）。独立一条链：问不到语言不该拖住读盘
  call("lang.get")
    .then(function (info) {
      if (info && info.lang) {
        lang = info.lang === "en" ? "en" : "zh";
        render();
      }
    })
    .catch(noop);

  var loadCache = call("storage.get", { key: CACHE_KEY })
    .then(function (value) {
      var cache = C.normalizeCache(value);
      if (!cache) return;
      tasks = cache.tasks;
      syncedAt = cache.at;
    })
    .catch(noop);

  var loadLocal = call("storage.get", { key: LOCAL_KEY })
    .then(function (value) {
      if (touched) return;
      local = C.normalizeLocalItems(value);
    })
    .catch(noop);

  var loadToken = call("secret.get", { name: SECRET_NAME })
    .then(function (result) {
      token = result && typeof result.value === "string" ? result.value : "";
    })
    .catch(function (error) {
      // 读不出来不是"没填过"（换 Windows 账户 / secrets.bin 坏了），
      // 但两条路都落在 setup —— 区别只在提示语，所以这里只记原因
      token = "";
      var verdict = C.classifyError(error);
      sealedBroken = verdict.kind === "nodesktop" || verdict.kind === "permission" ? verdict.kind : "sealed";
    });

  Promise.all([loadCache, loadLocal, loadToken]).then(function () {
    if (token) {
      view = "remote";
      render();
      refresh();
      beat();
    } else if (local.length) {
      // 本地清单里有东西 = 这个人选了草稿本。**不另存一个"模式"标记**：
      // 多一个字段就多一处"标记说有、数据却没有"的错法（0043 §3）
      view = "local";
      render();
      beat();
    } else {
      showSetup(sealedBroken ? errorText(sealedBroken) : "");
      beat();
    }
    // 三份状态都落地之后才报 ready —— 早报的话，测试/宿主拿到的是一个
    // 还没决定"显示哪一档"的中间态
    parent.postMessage({ __lattice: 1, type: "ready" }, "*");
  });
})();
