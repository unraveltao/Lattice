/**
 * 天气组件 —— 平台里第一个真的联网的组件。
 *
 * 数据来自 Open-Meteo：不要 key、没有注册、返回纯 JSON。选它不是为了省事，
 * 而是因为"要 key 的天气服务"必须把 key 塞进组件包里，而组件包是公开的、
 * 会被签名后放进目录 —— 那等于把 key 发给所有人。
 *
 * # 组件不直连
 *
 * 这份文档的 CSP 里 connect-src 只有自己的协议源，`fetch("https://…")` 在
 * 浏览器层面就抛 TypeError。出网只有一条路：桥上的 `network.fetch`，由 Rust
 * 侧按清单里的 `network.hosts` 代发。所以下面每一处网络调用都必须处理三种
 * 失败：权限没给、主机没列、请求本身失败 —— 它们长得像，处置完全不同。
 *
 * # 存储为什么按"城市 + 单位"分键
 *
 * 组件的存储是按 widgetId 的，同一个组件的两个实例共用一份。桌面上摆一个
 * 上海、一个东京，如果只存一个 `reading` 键，后写的那份会把对方的读数盖掉，
 * 于是"东京那张卡片显示的是上海的温度"。所以键里带上城市和单位，两个实例
 * 各写各的，互不相干。这一点和待办不同（待办本来就该共享一份清单）。
 *
 * # 刷新交给调度器
 *
 * 组件自己不碰 setInterval。两条心跳都挂在平台那条时间轴上：一条拉数据
 * （按配置，默认 30 分钟），一条只用来刷新"多久之前"那行字（60 秒）。
 * 窗口藏起来 / 主窗口最小化时整条时间轴停摆，回来只补一拍。
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // 桥
  // -------------------------------------------------------------------------

  var seq = 0;
  var pending = new Map();

  function call(method, params, timeoutMs) {
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
      }, timeoutMs || 3000);
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
   * 天气状况、体感 / 风速这些标签、地名的拼接、日期和错误话都是这个组件自己的
   * 字 —— 平台不知道「雷阵雨」对应哪句英文。所以两门都留在这儿，按 `lang.get`
   * 挑一份；用户中途换语言，平台推一条 `language`，把已经画出去的字原地换掉
   * （两件事都要做：只读一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
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
    document.title = say("天气", "Weather");
    // 天气状况、标签、多久之前、错误话全在 render 里，重画一次比逐个替换稳 ——
    // 而且不能等下一拍心跳，那一拍在 30 分钟后
    paintLabels();
    render();
  }

  // -------------------------------------------------------------------------
  // 天气码
  // -------------------------------------------------------------------------

  /*
   * WMO 4677 的天气码。Open-Meteo 直接给这个码，不给文案 —— 翻译是组件的事。
   *
   * 归到七个图形里，而不是一码一图：卡片上那个图标只有 40px，二十八种图形
   * 画出来互相分不清，用户能分辨的是"晴 / 云 / 雨 / 雪 / 雾 / 雷"这六类。
   * 文案仍然逐码给准 —— 那是文字，不占地方。
   *
   * 中文挑的是预报里的自然说法（晴 / 阴 / 小雨 / 雷阵雨），不是逐词直译；
   * 英文原句一个字都没动。返回 `{ glyph, zh, en }`，由 `render` 按语言挑。
   */
  function condition(code, isDay) {
    var night = isDay === 0;
    var sun = night ? "moon" : "sun";

    if (code === 0) return { glyph: sun, zh: "晴", en: "Clear" };
    if (code === 1) return { glyph: sun, zh: "少云", en: "Mainly clear" };
    if (code === 2)
      return { glyph: night ? "moon-cloud" : "partly", zh: "多云", en: "Partly cloudy" };
    if (code === 3) return { glyph: "cloud", zh: "阴", en: "Overcast" };
    if (code === 45) return { glyph: "fog", zh: "雾", en: "Fog" };
    if (code === 48) return { glyph: "fog", zh: "冻雾", en: "Freezing fog" };

    if (code >= 51 && code <= 57) {
      return {
        glyph: "drizzle",
        zh:
          code === 51
            ? "小毛毛雨"
            : code === 53
              ? "毛毛雨"
              : code === 55
                ? "大毛毛雨"
                : "冻毛毛雨",
        en:
          code === 51
            ? "Light drizzle"
            : code === 53
              ? "Drizzle"
              : code === 55
                ? "Dense drizzle"
                : "Freezing drizzle",
      };
    }
    if (code >= 61 && code <= 67) {
      return {
        glyph: "rain",
        zh: code === 61 ? "小雨" : code === 63 ? "中雨" : code === 65 ? "大雨" : "冻雨",
        en:
          code === 61
            ? "Light rain"
            : code === 63
              ? "Rain"
              : code === 65
                ? "Heavy rain"
                : "Freezing rain",
      };
    }
    if (code >= 71 && code <= 77) {
      return {
        glyph: "snow",
        zh: code === 71 ? "小雪" : code === 73 ? "中雪" : code === 75 ? "大雪" : "米雪",
        en:
          code === 71
            ? "Light snow"
            : code === 73
              ? "Snow"
              : code === 75
                ? "Heavy snow"
                : "Snow grains",
      };
    }
    if (code >= 80 && code <= 82) {
      return {
        glyph: "rain",
        zh: code === 80 ? "小阵雨" : code === 81 ? "阵雨" : "强阵雨",
        en: code === 80 ? "Light showers" : code === 81 ? "Showers" : "Violent showers",
      };
    }
    if (code >= 85 && code <= 86) {
      return {
        glyph: "snow",
        zh: code === 85 ? "阵雪" : "强阵雪",
        en: code === 85 ? "Snow showers" : "Heavy snow showers",
      };
    }
    /*
     * 95–99 才是雷暴（99 带冰雹）。这里**必须写死上界**：
     * `code >= 95` 会把 123 这种不存在的码也吃进来，于是"没见过的码"
     * 永远走不到下面那条兜底 —— 结果是把一个未知码报成"雷暴带冰雹"，
     * 比报"—"糟得多。
     */
    if (code >= 95 && code <= 99) {
      return {
        glyph: "storm",
        zh: code >= 96 ? "雷阵雨伴冰雹" : "雷阵雨",
        en: code >= 96 ? "Thunderstorm with hail" : "Thunderstorm",
      };
    }

    // 没见过的码：别编一个说法，也别画成晴天
    return { glyph: "cloud", zh: "—", en: "—" };
  }

  // -------------------------------------------------------------------------
  // 人话
  // -------------------------------------------------------------------------

  /*
   * "多久之前"。三档就够 —— "42 分钟" 和 "42 分钟 12 秒" 对判断数据新不新鲜
   * 没有区别，而卡片只有那么宽。
   */
  function describeAge(ms) {
    if (!isFinite(ms) || ms < 0) return "";
    var seconds = Math.round(ms / 1000);
    if (seconds < 90) return say("刚刚", "just now");
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + say("分钟", " min");
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + say("小时", " h");
    return Math.round(hours / 24) + say("天", " d");
  }

  function fail(code, zh, en) {
    var error = new Error(en || zh);
    error.code = code;
    // 这句话要显示在卡片上，所以两门都带着 —— 换语言时不用回头猜它原来是哪门
    error.text = [zh, en || zh];
    return error;
  }

  function rounded(value, unit) {
    if (typeof value !== "number" || !isFinite(value)) return "—";
    return Math.round(value) + unit;
  }

  // -------------------------------------------------------------------------
  // URL
  // -------------------------------------------------------------------------

  function geocodeUrl(query) {
    return (
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(query) +
      "&count=1&language=en&format=json"
    );
  }

  /*
   * 单位不在前端换算，直接让接口按单位返回。
   *
   * 自己换算是"少一次参数、多一处可能算错"：摄氏转华氏、km/h 转 mph 各一个
   * 公式，而接口本来就有这两个开关。少写一行代码，也少一个和官方数字对不上
   * 的机会。
   */
  function forecastUrl(place, units) {
    var params = [
      "latitude=" + Number(place.latitude).toFixed(4),
      "longitude=" + Number(place.longitude).toFixed(4),
      "current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
      "daily=temperature_2m_max,temperature_2m_min",
      "timezone=auto",
      "forecast_days=1",
    ];
    if (units === "imperial") {
      params.push("temperature_unit=fahrenheit");
      params.push("wind_speed_unit=mph");
    }
    return "https://api.open-meteo.com/v1/forecast?" + params.join("&");
  }

  // -------------------------------------------------------------------------
  // 网络
  // -------------------------------------------------------------------------

  /*
   * 一次 GET，只认 2xx 的 JSON。
   *
   * 三种"看起来成功了其实没有"的情况都在这里挡掉，否则它们会变成更难懂的
   * 症状：3xx（桥不跟随重定向，会原样回来）、被截断的响应（1MB 上限，
   * 切一半的 JSON 解析出来的错误信息毫无意义）、非 JSON 的正文（公司网络
   * 的登录页就是这么回来的）。
   */
  function fetchJson(url) {
    /*
     * 25 秒，比 Rust 侧那 20 秒总超时**长**。
     *
     * 反过来（组件先放弃）会出现最难受的一种状态：界面已经报了超时，宿主那边
     * 的请求还活着，晚一点回来了也没人接。让底层先失败，组件只负责翻译。
     */
    return call("network.fetch", { url: url, headers: { accept: "application/json" } }, 25000).then(
      function (response) {
        if (!response || typeof response.status !== "number") {
          throw fail("empty", "请求回来是空的", "the request came back empty");
        }
        if (response.status >= 300 && response.status < 400) {
          var target = response.headers.location || "elsewhere";
          throw fail(
            "redirect",
            "服务器重定向到 " + target,
            "the server redirected to " + target,
          );
        }
        if (!response.ok) {
          throw fail("http", "服务回了 " + response.status, "the service answered " + response.status);
        }
        if (response.truncated) {
          throw fail("truncated", "响应被截断了", "the response was cut short");
        }
        try {
          return JSON.parse(response.body);
        } catch (error) {
          throw fail("json", "回来的不是 JSON", "the response was not JSON");
        }
      },
    );
  }

  /*
   * 把桥给的错误归成四类。
   *
   * `internal` 是 Rust 侧 `Err(String)` 的落点，里面混着好几种完全不同的
   * 情况，只能看文案。其中"主机没列进清单"是**作者的错误**（写漏了
   * network.hosts），不是运行时的偶发故障 —— 它永远好不了，所以必须说清楚，
   * 不能跟"网络抖了一下"混在一起报。
   */
  function classify(error) {
    var code = error && error.code;
    var message = (error && error.message) || String(error);
    // 卡片上那句话两门都带着（`fail` 挂上来的）；桥自己抛的错只有英文那一句，
    // 那就两门都用它 —— 平台的后端文案不该由组件瞎猜一遍
    var pair = error && error.text ? error.text : [message, message];
    if (code === "permission_denied") return { kind: "denied", detail: pair };
    if (code === "noplace") return { kind: "noplace", detail: message };
    if (code === "internal" && /network\.hosts/.test(message)) {
      var host = /host "([^"]+)"/.exec(message);
      return { kind: "blocked", detail: host ? host[1] : message };
    }
    return { kind: "failed", detail: pair };
  }

  // -------------------------------------------------------------------------
  // 存储
  // -------------------------------------------------------------------------

  function placeKey(query) {
    // 大小写和多余空格不该产生两份缓存（"Shanghai" 和 "shanghai " 是同一个地方）
    return String(query).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function readingKey(query, units) {
    return "reading:" + placeKey(query) + ":" + units;
  }

  function load(key) {
    return call("storage.get", { key: key });
  }

  /*
   * 写缓存失败不该影响界面 —— 读不到缓存顶多是下次多一次请求，
   * 而把它抛出去会让"数据已经拿到、界面却不显示"。
   */
  function save(key, value) {
    return call("storage.set", { key: key, value: value }).catch(noop);
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  var state = {
    /* idle | unconfigured | loading | ready | stale | denied | blocked | noplace | failed */
    phase: "idle",
    config: null,
    place: null,
    reading: null,
    /** 解释那一行：两门都存着（`[zh, en]`），换语言时重挑一次就行 */
    detail: null,
  };

  /*
   * 每次 start 换一个号。异步回调回来时对一下号，不是最新那次就整个作废。
   *
   * 没有这个的话：用户在属性面板里把上海改成东京，上海那次请求晚回来一步，
   * 就把东京覆盖掉了 —— 而且地图上显示的是"东京"，数字是上海的。
   */
  var run = 0;

  var tickId = 0; // 刷新"多久之前"
  var netId = 0; // 拉数据
  var netEvery = 0;

  var el = {
    root: document.getElementById("root"),
    place: document.getElementById("place"),
    age: document.getElementById("age"),
    temp: document.getElementById("temp"),
    cond: document.getElementById("cond"),
    high: document.getElementById("high"),
    low: document.getElementById("low"),
    feels: document.getElementById("feels"),
    wind: document.getElementById("wind"),
    glyphUse: document.getElementById("glyph-use"),
    hint: document.getElementById("hint"),
    dtHigh: document.getElementById("dt-high"),
    dtLow: document.getElementById("dt-low"),
    dtFeels: document.getElementById("dt-feels"),
    dtWind: document.getElementById("dt-wind"),
  };

  /** 底行那四个小标签：跟语言走，跟数据无关，换语言时单独重画一次 */
  function paintLabels() {
    el.dtHigh.textContent = say("高", "H");
    el.dtLow.textContent = say("低", "L");
    el.dtFeels.textContent = say("体感", "Feels");
    el.dtWind.textContent = say("风速", "Wind");
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /*
   * 没有数据时，大字号那个位置放一句短标题，条件行放解释。
   *
   * 不用一排破折号：占位符看起来像"正在加载"，而这几种状态里有几种是
   * 永远好不了的（清单里没列主机），需要用户或作者动手。
   *
   * 两门都留在这儿（`[zh, en]`），由 `render` 现挑 —— 换语言时不用等下一次刷新。
   */
  var HEADLINES = {
    unconfigured: ["还没设城市", "Set a city"],
    loading: ["—", "—"],
    denied: ["没有联网权限", "No network access"],
    blocked: ["主机不在名单里", "Host not allowed"],
    noplace: ["查不到这个城市", "Unknown place"],
    failed: ["连不上天气服务", "Can't reach the service"],
  };

  /** 提示行留的是原因，不是那句已经翻好的话：换语言时重挑一次 */
  function paintHint() {
    var text =
      state.phase === "stale" && state.reading
        ? say("离线，下一拍再试", "Offline — will retry on the next tick")
        : "";
    el.hint.textContent = text;
    el.hint.classList.toggle("is-visible", !!text);
  }

  function unitsOf(config) {
    return config && config.units === "imperial" ? "imperial" : "metric";
  }

  /*
   * 顶行那个地名。
   *
   * 地理编码还没回来（或者根本没回来）时用用户填的那个词顶上 —— 否则重载
   * 组件的一瞬间标题是空的，卡片看着像没加载完。`state.place` 里的
   * name 是接口规范化过的（"shanghai" → "Shanghai"），回来后替换。
   */
  function placeLabel() {
    if (state.place && state.place.name) return state.place.name;
    return String((state.config && state.config.place) || "").trim();
  }

  function render() {
    var reading = state.reading;
    var phase = state.phase;

    el.root.dataset.state = phase;
    el.place.textContent = placeLabel();
    paintLabels();

    if (!reading) {
      el.age.textContent = "";
      var headline = HEADLINES[phase];
      el.temp.textContent = headline ? say(headline[0], headline[1]) : "—";
      el.cond.textContent = state.detail ? say(state.detail[0], state.detail[1]) : "";
      el.high.textContent = "—";
      el.low.textContent = "—";
      el.feels.textContent = "—";
      el.wind.textContent = "—";
      el.glyphUse.setAttribute("href", "#g-cloud");
      paintHint();
      return;
    }

    var units = unitsOf(state.config);
    var windUnit = units === "imperial" ? " mph" : " km/h";
    var shape = condition(reading.code, reading.isDay);

    el.place.textContent = placeLabel();
    el.place.title =
      state.place && state.place.region
        ? state.place.name + say("，", ", ") + state.place.region
        : "";

    el.temp.textContent = rounded(reading.temp, "°");
    el.temp.title =
      (typeof reading.temp === "number" ? reading.temp.toFixed(1) : "?") +
      (units === "imperial" ? " °F" : " °C") +
      (typeof reading.humidity === "number"
        ? say(" · 湿度 " + Math.round(reading.humidity) + "%", " · " + Math.round(reading.humidity) + "% humidity")
        : "");

    el.cond.textContent = say(shape.zh, shape.en);
    el.glyphUse.setAttribute("href", "#g-" + shape.glyph);

    el.high.textContent = rounded(reading.high, "°");
    el.low.textContent = rounded(reading.low, "°");
    el.feels.textContent = rounded(reading.feels, "°");
    el.wind.textContent = rounded(reading.wind, windUnit);

    renderAge();
  }

  /*
   * 只动"多久之前"那一行和离线提示。
   *
   * 单独一个函数是因为它每分钟跑一次，而整张卡片只在拿到新数据时才重画 ——
   * 每分钟把温度重新写一遍，等于每分钟制造一次布局，纯属浪费。
   */
  function renderAge() {
    if (!state.reading) {
      el.age.textContent = "";
      paintHint();
      return;
    }
    el.age.textContent = describeAge(Date.now() - state.reading.at);
    paintHint();
  }

  // -------------------------------------------------------------------------
  // 心跳
  // -------------------------------------------------------------------------

  function clampMinutes(value) {
    var minutes = Number(value);
    if (!isFinite(minutes)) return 30;
    return Math.max(15, Math.min(180, minutes));
  }

  function ensureClock() {
    if (tickId) return;
    call("schedule.every", { every: 60000 })
      .then(function (grant) {
        tickId = grant.id;
      })
      .catch(noop);
  }

  /*
   * 拉数据那一拍。间隔变了必须**先清再挂**：`schedule.every` 没有"改间隔"，
   * 再挂一次就是第二条订阅，改五次配置就用满八条上限，第六次开始静默失败。
   */
  function ensureRefresh() {
    var want = clampMinutes(state.config && state.config.refreshMinutes) * 60000;
    if (netId && netEvery === want) return;

    var old = netId;
    netId = 0;
    netEvery = 0;
    (old ? call("schedule.clear", { id: old }).catch(noop) : Promise.resolve())
      .then(function () {
        return call("schedule.every", { every: want });
      })
      .then(function (grant) {
        netId = grant.id;
        // 用返回的 every（已夹紧）校准，别用自己算的那个数
        netEvery = grant.every;
      })
      .catch(noop);
  }

  function clearTimers() {
    [tickId, netId].forEach(function (id) {
      if (id) call("schedule.clear", { id: id }).catch(noop);
    });
    tickId = 0;
    netId = 0;
    netEvery = 0;
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------

  function start(config) {
    var token = ++run;
    state.config = config;

    /*
     * 先把上一次的痕迹全清掉，再重新读缓存。
     *
     * 不清的话，"从上海改成东京、而东京没有缓存"这一路会把上海的读数和上海的
     * 地名留在屏幕上，配着新配置 —— 用户看到的是东京的标题配上海的温度。
     * 配置变了就当一切重来，只有缓存能重新填回来。
     */
    state.place = null;
    state.reading = null;
    state.detail = null;

    var query = String((config && config.place) || "").trim();
    if (!query) {
      state.phase = "unconfigured";
      state.detail = ["在属性面板里选一个城市。", "Pick one in the inspector."];
      render();
      clearTimers();
      return;
    }

    var units = unitsOf(config);

    /*
     * 先把上次读数摆上去，再走网络。
     *
     * 重载组件（改权限、切主题、重启）不该让卡片空一下 —— 而"空一下"在
     * 断网时会变成一直空着。旧数据配一行"离线"比空白诚实得多。
     */
    load(readingKey(query, units))
      .then(function (cached) {
        if (token !== run) return;
        if (cached && typeof cached.at === "number" && typeof cached.temp === "number") {
          state.reading = cached;
          state.phase = "stale";
          render();
        }
        if (!state.reading) {
          state.phase = "loading";
          render();
        }
        return refresh(token);
      })
      .catch(function (error) {
        if (token !== run) return;
        // 读缓存失败 ≠ 没有缓存。绝不能在这里把默认值写回去（那是数据丢失的经典路径）
        state.phase = "loading";
        render();
        return refresh(token);
      })
      .then(function () {
        if (token !== run) return;
        /*
         * 只有"还会自己好起来"的状态才挂心跳。
         *
         * 权限没给、主机没列、城市查不到 —— 这三种靠定时器永远好不了，
         * 挂上就是每 30 分钟白敲一次门（主机没列那种还会每半小时往 stderr
         * 打一条 blocked 日志）。它们要的是人去改配置，而改配置会重新走
         * start()，那时再挂。
         */
        if (state.phase === "denied" || state.phase === "blocked" || state.phase === "noplace") {
          return;
        }
        ensureClock();
        ensureRefresh();
      });
  }

  function resolvePlace(query, token) {
    var key = "place:" + placeKey(query);

    return load(key).then(function (cached) {
      if (token !== run) return null;
      if (
        cached &&
        cached.query === query &&
        isFinite(cached.latitude) &&
        isFinite(cached.longitude)
      ) {
        return cached;
      }

      return fetchJson(geocodeUrl(query)).then(function (payload) {
        /*
         * 查不到的时候 Open-Meteo **不给 results 这个键**，不是给一个空数组。
         * 当成 `[]` 处理的话，用户看到的是"服务连不上"，而其实是"没有这个城市"。
         */
        var hit = payload && payload.results && payload.results[0];
        if (!hit) throw fail("noplace", query, query);

        var place = {
          query: query,
          name: hit.name,
          region: hit.admin1 || "",
          country: hit.country || "",
          latitude: hit.latitude,
          longitude: hit.longitude,
        };
        save(key, place);
        return place;
      });
    });
  }

  function fetchForecast(place, units) {
    return fetchJson(forecastUrl(place, units)).then(function (payload) {
      var current = payload && payload.current;
      if (!current || typeof current.temperature_2m !== "number") {
        throw fail("shape", "预报里没有当前温度", "the forecast had no current temperature");
      }
      var daily = payload.daily || {};
      return {
        at: Date.now(),
        units: units,
        temp: current.temperature_2m,
        feels: numberOr(current.apparent_temperature),
        humidity: numberOr(current.relative_humidity_2m),
        wind: numberOr(current.wind_speed_10m),
        code: numberOr(current.weather_code),
        isDay: current.is_day === 0 ? 0 : 1,
        high: daily.temperature_2m_max ? numberOr(daily.temperature_2m_max[0]) : null,
        low: daily.temperature_2m_min ? numberOr(daily.temperature_2m_min[0]) : null,
      };
    });
  }

  function numberOr(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  function refresh(token) {
    var query = String((state.config && state.config.place) || "").trim();
    if (!query) return Promise.resolve();
    var units = unitsOf(state.config);

    return resolvePlace(query, token)
      .then(function (place) {
        if (token !== run || !place) return null;
        state.place = place;
        return fetchForecast(place, units);
      })
      .then(function (reading) {
        if (token !== run || !reading) return;
        state.reading = reading;
        state.phase = "ready";
        state.detail = null;
        render();
        save(readingKey(query, units), reading);
      })
      .catch(function (error) {
        if (token !== run) return;
        handleFailure(error);
      });
  }

  function handleFailure(error) {
    var problem = classify(error);

    if (problem.kind === "denied") {
      /*
       * 撤销授权会让宿主重载组件，所以这里不自己重试 —— 重试只会一串
       * 立刻失败的调用。把话说明白，等重载。
       */
      state.phase = "denied";
      state.detail = ["在属性面板里允许联网。", "Allow network access in the inspector."];
      render();
      clearTimers();
      return;
    }

    if (problem.kind === "blocked") {
      // 作者写漏了 network.hosts，重试一万次也一样
      state.phase = "blocked";
      state.detail = [
        problem.detail + " 没写进清单。",
        problem.detail + " is not in the manifest.",
      ];
      render();
      clearTimers();
      return;
    }

    if (problem.kind === "noplace") {
      state.phase = "noplace";
      state.detail = [
        "查不到「" + problem.detail + "」。",
        "No match for “" + problem.detail + "”.",
      ];
      render();
      return;
    }

    // 其余的都能自己好：有旧读数就继续显示旧读数，没有就把原因说出来
    if (state.reading) {
      state.phase = "stale";
      render();
      return;
    }
    state.phase = "failed";
    state.detail = problem.detail;
    render();
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
      var id = data.payload && data.payload.id;
      if (id === tickId) {
        renderAge();
        return;
      }
      if (id === netId) refresh(run);
      return;
    }

    if (data.type === "config-changed") {
      start(data.payload && data.payload.config);
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
   * 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
   * 不该拖住配置和刷新，卡片也不该停在两种文字的混合状态。
   */
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(noop);

  call("config.get")
    .then(function (config) {
      start(config);
    })
    .catch(function () {
      state.phase = "failed";
      state.detail = ["这个组件读不到自己的设置。", "This widget could not read its own settings."];
      render();
    })
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });
})();
