/**
 * 棂 / Lattice —— 组件端 SDK
 *
 * 这个文件**零依赖、不需要构建**：拷进组件目录，用
 * `<script type="module" src="./lattice.js"></script>` 引进来就能用。
 * 之所以坚持不打包，是因为"会写 HTML 就能写组件"是这个平台的门槛承诺 ——
 * 为了用几个 helper 就让作者装一套 node 工具链，等于把门槛还回去了。
 *
 * 用法：
 *
 *   import { createLattice } from "./lattice.js";
 *
 *   const lattice = createLattice();
 *   await lattice.ready;                       // 配置和主题已经就位
 *
 *   const time = document.getElementById("time");
 *   const paint = () => lattice.call("clock.now").then((now) => {
 *     time.textContent = new Date(now.epochMs).toLocaleTimeString();
 *   });
 *
 *   paint();
 *   await lattice.schedule.every(1000, paint);
 *
 * 它做的事就是把 WIDGET_SPEC 里那套 postMessage 协议包一层：请求-响应配对、
 * 超时、主题令牌、配置推送、心跳订阅。**协议本身没变** —— 不用 SDK 的组件
 * 照样能跑，SDK 只是把每个组件都要重写一遍的那 80 行收起来。
 */

export const BRIDGE_TAG = "__lattice";

/** 桥返回的结构化错误。`code` 取值见 WIDGET_SPEC 4.4。 */
export class LatticeError extends Error {
  constructor(code, message, permission) {
    super(message);
    this.name = "LatticeError";
    this.code = code;
    /** 只有 `code === "permission_denied"` 时才有值 */
    this.permission = permission;
  }
}

/** 权限没授予。组件用这个判断要不要显示"去授权"，而不是去猜错误文案。 */
export function isPermissionDenied(error) {
  return Boolean(error) && error.code === "permission_denied";
}

/**
 * 主题令牌 → 短变量名。
 *
 * 长名（`--lattice-text`）是平台的正式契约，短名是给组件用的别名：卡片里写
 * `var(--fg)` 比 `var(--lattice-text-muted)` 好读，也短。两个都设上，作者
 * 挑一个顺手的用。
 */
const THEME_ALIASES = {
  "--lattice-bg": "--bg",
  "--lattice-surface": "--surface",
  "--lattice-text": "--fg",
  "--lattice-text-muted": "--muted",
  "--lattice-border": "--border",
  "--lattice-accent": "--accent",
  "--lattice-radius": "--radius",
  "--lattice-font": "--font",
};

/**
 * 系统语言兜底：不在宿主里（或者 `lang.get` 还没回来）时用浏览器的语言猜一次。
 * 平台那边"跟随系统"走的是同一条判断（中文区 → `zh`，其余 → `en`）。
 */
function systemLanguage() {
  const locale = (typeof navigator !== "undefined" && navigator.language) || "en";
  return { lang: locale.toLowerCase().startsWith("zh") ? "zh" : "en", locale };
}

/** 宿主推来的语言形状不对就留着上一份，别把组件的分支打成 undefined */
function normalizeLanguage(payload, previous) {
  if (!payload || typeof payload !== "object") return previous;
  const lang = payload.lang === "zh" ? "zh" : payload.lang === "en" ? "en" : previous.lang;
  const locale =
    typeof payload.locale === "string" && payload.locale ? payload.locale : previous.locale;
  return { lang, locale };
}

/**
 * 处理器抛出来的东西 → 一句能读的原因。
 *
 * 空字符串不算答案：`WIDGET_SPEC` §3.6 要求 `ok: false` 必须带一句人话（模型会把它
 * 转述给用户，也会据此改参数重来），所以空消息退成"这条工具失败了"。
 */
function readableError(error) {
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message.trim()
      : String(error === undefined ? "" : error).trim();
  return message || "the tool failed";
}

/**
 * 一次 `agent-call` 只该有一条回话。
 *
 * 同一份 SDK 可以在一个文档里建好几个实例（断言页就是这么用的，组件也可能
 * 按区块各建一个），而每个实例都挂着自己的 message 监听器。不在这里串一下的话，
 * 一次调用会回出**两条** `agent-result` —— 一条真的、一条"unknown tool"，
 * 平台先收到哪条就全看监听器注册顺序。
 */
const agentClaims = new Set();

/** 认领一次调用；已经被别人认领过就返回 false */
function claimAgentCall(callId) {
  const key = String(callId == null ? "" : callId);
  if (agentClaims.has(key)) return false;
  agentClaims.add(key);
  // 不让它无限长：一次会话里的调用数是有限的，256 条足够挡住"同一次调用"
  if (agentClaims.size > 256) agentClaims.delete(agentClaims.values().next().value);
  return true;
}

/**
 * 建一个桥客户端。
 *
 * @param {object} [options]
 * @param {number} [options.timeout] 单次调用超时（毫秒），默认 3000
 * @param {number} [options.bootTimeout] 启动时读配置/主题的超时，默认 1200。
 *   比 `timeout` 短：宿主不在的时候（比如直接双击打开 index.html）组件不该
 *   干等三秒才显示第一帧
 * @param {boolean} [options.autoTheme] 收到主题就自动写到 CSS 变量上，默认 true
 * @param {boolean} [options.autoReady] 启动完自动向宿主报 ready，默认 true。
 *   宿主收到 ready 才会推主题和配置 —— 不报的话组件永远拿不到推送
 * @returns {Lattice}
 */
export function createLattice(options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 3000;
  const bootTimeout = Number.isFinite(options.bootTimeout) ? options.bootTimeout : 1200;
  const autoTheme = options.autoTheme !== false;
  const autoReady = options.autoReady !== false;

  /** 桥在宿主页里，不在组件里 —— 顶层窗口说明这个文档不是组件 */
  const hosted = typeof window !== "undefined" && window.parent !== window;

  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  const tickHandlers = new Map();
  /** 清单 `agent.tools` 声明的那几条工具 → 实现（见 `api.agentTools`） */
  const agentHandlers = new Map();

  let config = {};
  let themeTokens = {};
  let language = systemLanguage();

  // -------------------------------------------------------------------------
  // 消息收发
  // -------------------------------------------------------------------------

  function emit(event, payload) {
    const handlers = listeners.get(event);
    if (!handlers) return;
    // 复制一份再遍历：回调里 off() 自己不会把这一轮遍历搞乱
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        // 一个监听器抛错不该拖垮其它监听器，也不该把桥的收包循环打断
        console.error("[lattice] listener for \"" + event + "\" threw", error);
      }
    }
  }

  function on(event, handler) {
    if (typeof handler !== "function") throw new TypeError("lattice.on expects a function");
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    const handlers = listeners.get(event);
    if (handlers) handlers.delete(handler);
  }

  function post(message) {
    parent.postMessage(Object.assign({ [BRIDGE_TAG]: 1 }, message), "*");
  }

  /**
   * 调一个桥方法。失败一律 reject 一个 `LatticeError`，**不抛裸 Error** ——
   * 组件要靠 `code` 决定是降级还是提示授权。
   *
   * `options.timeout` 能盖掉这一条的默认超时：有几条路天生慢得多
   * （`assistant.ask` 是一整轮带工具的对话，平台那边按 180 秒算），
   * 用默认的 3 秒会把它误判成"宿主没响应"。
   */
  function call(method, params, options) {
    if (!hosted) {
      return Promise.reject(
        new LatticeError("internal", "this document is not running inside a Lattice host"),
      );
    }
    const ms = options && Number.isFinite(options.timeout) ? options.timeout : timeout;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new LatticeError("internal", "bridge call timed out: " + method));
      }, ms);

      pending.set(id, { resolve, reject, timer, method });
      post({ type: "request", id, method, params });
    });
  }

  function handleMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object" || data[BRIDGE_TAG] !== 1) return;

    switch (data.type) {
      case "response": {
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        clearTimeout(entry.timer);
        if (data.ok) {
          entry.resolve(data.result);
        } else {
          entry.reject(new LatticeError(data.code || "internal", data.error || "bridge call failed", data.permission));
        }
        return;
      }
      case "theme": {
        themeTokens = data.payload || {};
        if (autoTheme) applyTheme(themeTokens);
        emit("theme", themeTokens);
        return;
      }
      case "language": {
        language = normalizeLanguage(data.payload, language);
        emit("language", language);
        return;
      }
      case "config-changed": {
        config = (data.payload && data.payload.config) || {};
        emit("config", config);
        return;
      }
      case "tick": {
        const id = data.payload && data.payload.id;
        const handler = tickHandlers.get(id);
        if (!handler) return;
        try {
          handler(data.payload);
        } catch (error) {
          console.error("[lattice] tick handler threw", error);
        }
        return;
      }
      case "store-changed": {
        emit("store", data.payload && data.payload.key);
        return;
      }
      /**
       * 模型调了你声明的工具。和桥是**反方向**的同一条通道：一条消息进，
       * 一条 `agent-result` 出，而且**一定要回**（不回的那次，平台等 8 秒
       * 之后告诉模型"它没应"，用户看到的是"这个组件不听话"）。
       *
       * 回话永远带上同一个 `callId`，并且总是回给发消息的那个窗口
       * （`event.source`）—— 父窗口只是最常见的那个，不必假设。
       */
      case "agent-call": {
        const payload = data.payload || {};
        const callId = payload.callId;
        const tool = String(payload.tool || "");
        const source = event.source;
        const answer = (body) => {
          if (!source || typeof source.postMessage !== "function") return;
          source.postMessage(
            Object.assign({ [BRIDGE_TAG]: 1 }, { type: "agent-result", payload: Object.assign({ callId }, body) }),
            "*",
          );
        };

        const handler = agentHandlers.get(tool);
        if (!handler) {
          /*
           * 没挂实现时**先等一下**：同一个文档里可能有另一个实例挂着它
           * （各建一个 client 的组件、以及自己的断言页都是这样）。0ms 之后
           * 还没人认领，才回 `unknown tool` —— 总比让平台干等 8 秒好。
           */
          setTimeout(() => {
            if (claimAgentCall(callId)) answer({ ok: false, error: "unknown tool: " + tool });
          }, 0);
          return;
        }
        if (!claimAgentCall(callId)) return;
        /*
         * 处理器**返回什么就交回什么**，抛错就变成 `ok: false` —— 作者不拼
         * `{ ok, result }` 那层信封，那种信封每个人都写一遍、每个人写错一次。
         * 异步也接：`await` 到它回来再回话（平台那边有 8 秒预算）。
         */
        Promise.resolve()
          .then(() => handler(payload.args || {}, { callId, tool }))
          .then((result) => answer({ ok: true, result: result === undefined ? null : result }))
          .catch((error) => answer({ ok: false, error: readableError(error) }));
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 主题 / 配置
  // -------------------------------------------------------------------------

  function applyTheme(tokens) {
    if (!tokens) return;
    const root = document.documentElement;
    for (const name of Object.keys(tokens)) {
      const value = tokens[name];
      if (!value) continue;
      root.style.setProperty(name, value);
      const alias = THEME_ALIASES[name];
      if (alias) root.style.setProperty(alias, value);
    }
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /**
   * 启动顺序：先把配置、主题、语言**拉**一次，再向宿主报 ready。
   *
   * 为什么要拉：宿主只在收到 `ready` 之后才推主题和配置（它不知道组件什么时候
   * 装好监听器）。所以"等推送"会死等；先拉一次能保证 `await ready` 之后
   * 组件的第一次渲染就是对的颜色和正确的配置。
   *
   * 为什么还要报 ready：宿主收到之后会**再**推一遍。重复应用一次没有副作用，
   * 而这一遍是给"宿主先加载、组件后到"之外的另一种时序兜底的 —— 组件在
   * 拉取之后、报 ready 之前的那一瞬间，配置可能刚好被用户改了。
   */
  function boot() {
    window.addEventListener("message", handleMessage);

    if (!hosted) {
      // 不在宿主里（直接打开文件、或者被别的页面 iframe 嵌了）：
      // 不报错、不卡住，只是所有调用都会立刻失败
      return Promise.resolve(api);
    }

    const settle = (promise) =>
      Promise.race([
        promise.catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), bootTimeout)),
      ]);

    return Promise.all([
      settle(call("config.get")),
      settle(call("theme.get")),
      settle(call("lang.get")),
    ]).then(([values, tokens, spoken]) => {
      if (values && typeof values === "object") config = values;
      if (tokens && typeof tokens === "object") {
        themeTokens = tokens;
        if (autoTheme) applyTheme(themeTokens);
      }
      if (spoken) language = normalizeLanguage(spoken, language);
      if (autoReady) post({ type: "ready" });
      return api;
    });
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  const api = {
    /** 桥客户端是否真的在宿主页里（顶层窗口为 false） */
    hosted,

    /** 启动完成：配置和主题已经应用过一次 */
    ready: null,

    call,
    on,
    off,

    /** 当前主题令牌（长名，`--lattice-*`） */
    get theme() {
      return themeTokens;
    },

    /**
     * 当前界面语言：`{ lang: "zh" | "en", locale: "zh-CN" }`。
     *
     * 作者写的中英文由组件自己挑（平台不认识组件里的句子）。`await ready`
     * 之后这份就是对的；用户中途在设置里换语言会推 `on("language")`。
     */
    get language() {
      return language;
    },

    applyTheme,

    /** 当前配置。宿主推 `config-changed` 时会整个换掉这份对象 */
    get config() {
      return config;
    },

    /** 重新拉一次配置（比如用户点了"恢复默认"之后） */
    async reloadConfig() {
      const values = await call("config.get");
      config = values && typeof values === "object" ? values : {};
      emit("config", config);
      return config;
    },

    storage: {
      /** 读一个键，没有就是 null */
      get: (key) => call("storage.get", { key }),
      /** 写一个键。`value` 传 null 等于删掉它 */
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      /**
       * 存储变了。**同一个组件的其它实例**写盘时也会收到 —— 两个便签摆在一起
       * 是常见用法，靠这个收敛，不要各持一份内存列表。
       */
      onChange: (handler) => on("store", handler),
    },

    schedule: {
      /**
       * 挂一条心跳。返回 `{ id, stop }`。
       *
       * 必须 `await`：订阅号是宿主分配的。心跳挂在平台的时间轴上，窗口不可见
       * 时整条停摆 —— 所以**不要**自己 `setInterval`（那样藏起来也照跑）。
       *
       * @param {number} every 毫秒，最小 250
       * @param {(payload: {id: number, at: number}) => void} handler
       */
      async every(every, handler) {
        if (typeof handler !== "function") throw new TypeError("schedule.every expects a function");
        const grant = await call("schedule.every", { every });
        const id = grant && grant.id;
        if (typeof id !== "number") {
          throw new LatticeError("internal", "the host did not return a timer id");
        }
        tickHandlers.set(id, handler);
        return {
          id,
          stop() {
            tickHandlers.delete(id);
            return call("schedule.clear", { id }).catch(() => undefined);
          },
        };
      },
      clear(id) {
        tickHandlers.delete(id);
        return call("schedule.clear", { id });
      },
    },

    system: {
      /**
       * CPU / 内存 / 磁盘 / 网络。要 `system:monitor`。
       *
       * 速率类字段靠两次采样做差，所以**第一次调用一定是 0**，第二次起才有意义。
       */
      metrics: () => call("system.metrics"),
    },

    media: {
      /**
       * 当前媒体会话，没有播放器时是 `null`。要 `media:control`。
       *
       * 返回 `{ title, artist, album, source, status, canPlayPause, canNext,
       * canPrevious, positionMs, durationMs }`。`status` 是字符串
       * （playing / paused / stopped / changing / opened / closed）。
       */
      get: () => call("media.get"),
      /** 播放 / 暂停合一 —— 组件不知道当前状态时用它最省事 */
      playPause: () => call("media.control", { action: "playPause" }),
      next: () => call("media.control", { action: "next" }),
      previous: () => call("media.control", { action: "previous" }),
      stop: () => call("media.control", { action: "stop" }),
    },

    audio: {
      /**
       * 扬声器现在有多响，`{ level, running }`。要 `audio:level`（**不是**
       * `media:control`：这条线读的是声音本身，不是歌名）。
       *
       * `level` 是 0..1，已经做过分贝映射和释放曲线 —— 直接当高度画就行。
       * 没有设备 / 设备被独占时 `running` 是 false、`level` 是 0，那不是错误。
       *
       * 这是**采样**：80ms 一问，自己攒一串再画折线。问得比这还密没有意义。
       */
      level: () => call("audio.level"),
    },

    network: {
      /**
       * 代发一个 HTTP 请求。要 `network`，而且目标主机必须列在清单的
       * `network.hosts` 里。**重定向不会自动跟随**（3xx 原样返回）。
       *
       * @param {{url: string, method?: string, headers?: Record<string,string>, body?: string}} input
       * @returns {Promise<{status: number, ok: boolean, headers: [string,string][], body: string, truncated: boolean}>}
       */
      fetch: (input) => call("network.fetch", input || {}),
    },

    llm: {
      /**
       * 用**用户自己配的**模型说一句话。要 `llm:chat`。
       *
       * key 不进组件：平台替你把请求发出去，组件全程看不见它，也换不了 baseUrl。
       * 这条路**没有工具** —— 组件只能说话，不能借它改桌面（那是 assistant 面板
       * 和 agent 端点的事）。
       *
       * 失败时的错误码：没授权是 `permission_denied`（`permission` 字段就是
       * `"llm:chat"`），用户还没配模型 / 供应商报错都是 `internal`，`message`
       * 是可以直接给用户看的一句话。
       *
       * @param {Array<{role: "system"|"user"|"assistant", content: string}>} messages
       * @returns {Promise<{text: string}>}
       */
      chat: (messages) => call("llm.chat", { messages }),

      /** 用户到底配没配模型。不需要权限 —— 组件据此决定显示输入框还是提示去设置。 */
      status: () => call("llm.status"),
    },

    assistant: {
      /**
       * 让平台的 assistant **替你动桌面**。要 `desktop:control`。
       *
       * 和 `llm.chat` 的区别是"有没有手"：这条路平台跑完一整轮带工具的对话
       * （系统提示 + 桌面快照 + ≤6 步 + 执行 + 审计），你拿回**一句回话**和
       * **这次真做了什么**的一行行明细。你决定不了执行什么，也拿不到工具调用本身。
       *
       * 三条要知道的：
       * - **没有删除动作**。用户可以自己按 ✕，但"让桌宠替我删组件"不行。
       * - **`system` 位置只当人设**：平台把它塞在规则之后、快照之前，截 1200 字，
       *   覆盖不了平台的任何一条规则。
       * - **很慢**：一轮最多 6 次模型往返，平台按 180 秒超时。别在关键路径上调它，
       *   也别等它回来才画第一帧 —— 发了就显示"我想想……"。
       *
       * 失败：没授权是 `permission_denied`（`permission === "desktop:control"`），
       * 上一轮还没回来 / 用户没配模型 / 供应商报错都是 `internal`，`message`
       * 是可以直接给用户看的一句话。
       *
       * @param {{messages: Array<{role: "system"|"user"|"assistant", content: string}>, persona?: string}} input
       * @returns {Promise<{text: string, actions: Array<{detail: string, ok: boolean, error?: string}>}>}
       */
      ask: (input) => {
        const body = input || {};
        const params = { messages: Array.isArray(body.messages) ? body.messages : [] };
        // 没给人设就**不带这个键**：带一个 undefined 会让宿主收到一个"存在但空"的字段
        if (typeof body.persona === "string") params.persona = body.persona;
        return call(
          "assistant.ask",
          params,
          // 比平台那 180 秒再松 5 秒：先超时的应该是平台，不是这里
          { timeout: 185000 },
        );
      },
    },

    /**
     * 把清单 `agent.tools` 里声明的那几条工具**挂上实现**。要 `agent:tools`。
     *
     * ```js
     * const off = lattice.agentTools({
     *   add: (args) => { items.push(String(args.text)); save(); return { count: items.length }; },
     *   // 异步也接；抛错就是 ok:false，错误信息原样交给模型
     *   list: async () => ({ items: items.slice(0, 20) }),
     * });
     * ```
     *
     * 三条规矩（都在 `WIDGET_SPEC` §3.6 里）：
     * - **返回值就是 `result`**，抛错就是 `error`。不用自己拼 `{ok, result}` 那层信封。
     * - **没注册的工具名不会静默沉掉**：有人调就回一条 `unknown tool: <名字>`。
     * - **别回整份数据**：回话超过 4000 字符是**拒绝**（不是截断），回摘要或者前几条。
     *
     * @param {Record<string, (args: Record<string, unknown>, context: {callId?: string, tool: string}) => unknown | Promise<unknown>>} handlers
     * @returns {() => void} 摘掉这次注册（组件销毁、热重载时用得上）
     */
    agentTools(handlers) {
      if (!handlers || typeof handlers !== "object") {
        throw new TypeError("lattice.agentTools expects an object of functions");
      }
      const added = [];
      for (const [name, handler] of Object.entries(handlers)) {
        if (typeof handler !== "function") {
          throw new TypeError('lattice.agentTools: "' + name + '" is not a function');
        }
        agentHandlers.set(name, handler);
        added.push(name);
      }
      return () => {
        for (const name of added) {
          // 只摘自己挂上去的那一份：后注册的实现不该被前一次的清理函数带走
          if (agentHandlers.get(name) === handlers[name]) agentHandlers.delete(name);
        }
      };
    },

    /** 读系统时间。要 `clock`。 */
    now: () => call("clock.now"),

    /** 写剪贴板。要 `clipboard:write`。 */
    copy: (text) => call("clipboard.write", { text }),

    /**
     * 用系统默认浏览器打开一个链接。要 `shell:open`。
     *
     * 只接受 http / https —— `file:` / `ms-settings:` 这类协议会被平台拒绝
     * （它们能读写本地文件、改系统设置，等于绕开全部出网限制）。少写协议头
     * 没关系（`github.com` 会按 https 补全），但**别把用户的输入原样扔进来**：
     * 先自己看一眼，被拒时给用户一句人话。
     *
     * 浏览器预览里没有系统 shell，这条路会抛 `internal`。
     *
     * @param {string} url
     * @returns {Promise<{ok: true}>}
     */
    open: (url) => call("shell.open", { url }),

    /** 关掉自己这个窗口（桌面窗口）或这张卡片对应的 placement 不会被删 */
    close: () => call("window.close"),
  };

  api.ready = boot();
  return api;
}

export default createLattice;
