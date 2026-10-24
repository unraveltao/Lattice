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

  let config = {};
  let themeTokens = {};

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
   */
  function call(method, params) {
    if (!hosted) {
      return Promise.reject(
        new LatticeError("internal", "this document is not running inside a Lattice host"),
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new LatticeError("internal", "bridge call timed out: " + method));
      }, timeout);

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
   * 启动顺序：先把配置和主题**拉**一次，再向宿主报 ready。
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

    return Promise.all([settle(call("config.get")), settle(call("theme.get"))]).then(([values, tokens]) => {
      if (values && typeof values === "object") config = values;
      if (tokens && typeof tokens === "object") {
        themeTokens = tokens;
        if (autoTheme) applyTheme(themeTokens);
      }
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
