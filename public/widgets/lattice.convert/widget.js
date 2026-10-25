/**
 * 单位换算组件
 *
 * 数据是一张表（分类 → 单位 → 换算到基准单位的系数），代码是"读表 + 算"。
 * 之所以不写成 if/else：表能一眼看出缺哪个单位，也方便把整张表挂到
 * `window` 上给自检页对答案（见文件末尾）。
 *
 * # 温度为什么不能只写一个系数
 *
 * 长度换算是 `值 × 系数`，温度是仿射的：0°C 不等于 0°F，也不等于 0K。
 * 所以单位表里允许 `toBase` / `fromBase` 两个函数，没有函数时才用系数。
 * 把它硬塞进系数表会出现"0°C 换出来是 32°F 但 32°F 换回去是 0.0°C 的近似"，
 * 而温度恰恰是这两个值都必须精确的地方。
 *
 * # 两个输入框都活着
 *
 * 上改下算、下改上算。只让一边能输入的写法在"我知道 100 华氏，想换成摄氏"
 * 的时候会逼用户先在心里把方向反过来 —— 那是让用户替程序做判断。
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

  /*
   * 界面语言。
   *
   * 分类名、单位名和几个 aria-label 是这个组件自己的字 —— 平台不知道
   * "Length" 该写成哪句中文。两门都留在这儿，按 `lang.get` 挑一份；用户中途
   * 换语言，平台推一条 `language`，把已经画出去的字原地换掉（两件事都要做：
   * 只读一次 = 换语言卡片不动，只听推送 = 语言停在建文档那一刻）。
   *
   * 首帧不等桥（不变量 18）：HTML 里写死的是中文，英文界面要等 `lang.get`
   * 回来那一趟（几十毫秒）才翻。`lang` 只有 `zh` / `en` 两种。
   */
  var lang = "zh";

  /** 一句话的两种写法，按当前界面语言挑 */
  function say(zh, en) {
    return lang === "en" ? en : zh;
  }

  /** 表里的单位名 / 分类名：要么是字符串（语言无关），要么是两门 */
  function labelText(label) {
    if (typeof label === "string") return label;
    return lang === "en" ? label.en : label.zh;
  }

  function applyLanguage(info) {
    var next = info && info.lang === "en" ? "en" : "zh";
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = say("换算", "Convert");
    // 分类小标签和下拉里的单位名都是画出来的，换语言就得重建一遍
    repaint();
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__lattice !== 1) return;
    if (data.type === "theme") {
      applyTheme(data.payload);
      return;
    }
    // 平台界面换了语言。`lang.get` 是建文档那一刻的答案，这条是后来变了
    if (data.type === "language") {
      applyLanguage(data.payload);
      return;
    }
    if (data.type === "config-changed") {
      applyConfig(data.payload && data.payload.config);
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

  function noop() {}

  // -------------------------------------------------------------------------
  // 单位表
  // -------------------------------------------------------------------------

  /** 普通单位：`factor` = 一个该单位等于多少个基准单位 */
  function unit(id, label, factor) {
    return { id: id, label: label, factor: factor };
  }

  /** 温度：仿射，用两个函数，没有系数 */
  function affine(id, label, toBase, fromBase) {
    return { id: id, label: label, toBase: toBase, fromBase: fromBase };
  }

  var CATEGORIES = [
    {
      id: "length",
      label: { zh: "长度", en: "Length" },
      base: "m",
      units: [
        unit("mm", "mm", 0.001),
        unit("cm", "cm", 0.01),
        unit("m", "m", 1),
        unit("km", "km", 1000),
        unit("in", "in", 0.0254),
        unit("ft", "ft", 0.3048),
        unit("yd", "yd", 0.9144),
        unit("mi", "mi", 1609.344),
      ],
    },
    {
      id: "mass",
      label: { zh: "质量", en: "Mass" },
      base: "kg",
      units: [
        unit("mg", "mg", 1e-6),
        unit("g", "g", 0.001),
        unit("kg", "kg", 1),
        unit("t", "t", 1000),
        unit("oz", "oz", 0.028349523125),
        unit("lb", "lb", 0.45359237),
      ],
    },
    {
      id: "temp",
      label: { zh: "温度", en: "Temp" },
      base: "c",
      units: [
        affine("c", "°C", function (v) { return v; }, function (v) { return v; }),
        affine(
          "f",
          "°F",
          function (v) { return ((v - 32) * 5) / 9; },
          function (v) { return (v * 9) / 5 + 32; },
        ),
        affine("k", "K", function (v) { return v - 273.15; }, function (v) { return v + 273.15; }),
      ],
    },
    {
      id: "data",
      label: { zh: "数据", en: "Data" },
      base: "B",
      units: [
        unit("B", "B", 1),
        unit("KB", "KB", 1024),
        unit("MB", "MB", 1024 * 1024),
        unit("GB", "GB", 1024 * 1024 * 1024),
        unit("TB", "TB", 1024 * 1024 * 1024 * 1024),
      ],
    },
    {
      id: "time",
      label: { zh: "时间", en: "Time" },
      base: "s",
      units: [
        unit("ms", "ms", 0.001),
        unit("s", "s", 1),
        unit("min", "min", 60),
        unit("h", "h", 3600),
        unit("d", { zh: "天", en: "day" }, 86400),
        unit("w", { zh: "周", en: "week" }, 604800),
      ],
    },
    {
      id: "speed",
      label: { zh: "速度", en: "Speed" },
      base: "mps",
      units: [
        unit("mps", "m/s", 1),
        unit("kmh", "km/h", 1 / 3.6),
        unit("mph", "mph", 0.44704),
        unit("knot", "knot", 0.5144444444444445),
      ],
    },
  ];

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      if (CATEGORIES[i].id === id) return CATEGORIES[i];
    }
    return CATEGORIES[0];
  }

  function unitById(category, id) {
    for (var i = 0; i < category.units.length; i += 1) {
      if (category.units[i].id === id) return category.units[i];
    }
    return category.units[0];
  }

  /** 任意单位 → 基准单位 */
  function toBase(unitDef, value) {
    return unitDef.toBase ? unitDef.toBase(value) : value * unitDef.factor;
  }

  /** 基准单位 → 任意单位 */
  function fromBase(unitDef, value) {
    return unitDef.fromBase ? unitDef.fromBase(value) : value / unitDef.factor;
  }

  /**
   * 换算。`categoryId` 换成字符串而不是对象，是为了让自检页能直接喂字面量。
   */
  function convert(value, categoryId, fromId, toId) {
    var category = categoryById(categoryId);
    var from = unitById(category, fromId);
    var to = unitById(category, toId);
    return fromBase(to, toBase(from, value));
  }

  // -------------------------------------------------------------------------
  // 显示
  // -------------------------------------------------------------------------

  var precision = 6;

  /**
   * 按"有效数字"截断，而不是按小数位。
   *
   * 按小数位截的话 `0.001 km → 1000 mm` 和 `1 km → 1000000 mm` 里总有一个
   * 位数不合适；有效数字对两种量级都成立。
   */
  function formatValue(value) {
    if (typeof value !== "number" || !isFinite(value)) return "";
    if (value === 0) return "0";
    var abs = Math.abs(value);
    if (abs >= 1e15 || abs < 1e-9) {
      return value
        .toExponential(Math.max(1, precision - 3))
        .replace(/\.?0+e/, "e")
        .replace("e+", "e");
    }
    var decimals = Math.max(0, precision - 1 - Math.floor(Math.log10(abs)));
    var rounded = Number(value.toFixed(Math.min(12, decimals)));
    return String(rounded);
  }

  /** 读输入框里的数：容忍千位逗号、空格、全角符号，读不出来返回 null */
  function parseValue(text) {
    var cleaned = String(text == null ? "" : text)
      .replace(/[\s,]/g, "")
      .replace(/，/g, "")
      .replace(/[−–—]/g, "-");
    if (!cleaned) return null;
    if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return null;
    var value = Number(cleaned);
    return isFinite(value) ? value : null;
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  var catsEl = document.getElementById("cats");
  var fromValueEl = document.getElementById("from-value");
  var toValueEl = document.getElementById("to-value");
  var fromUnitEl = document.getElementById("from-unit");
  var toUnitEl = document.getElementById("to-unit");
  var swapEl = document.getElementById("swap");

  var state = { category: "length", from: "m", to: "ft" };
  /** 哪一边是"用户刚动过的"：决定重算方向，也决定换分类时谁保留 */
  var active = "from";
  /** 用户动过界面之后，迟到的 storage.get 不许再覆盖他的选择 */
  var touched = false;

  var REMEMBER_KEY = "units";

  function applyConfig(next) {
    if (!next) return;
    var digits = Math.round(Number(next.precision));
    precision = isFinite(digits) ? Math.max(3, Math.min(12, digits)) : 6;
    recompute(active);
  }

  /** 页面上那些写死的字：标题、两个下拉的 aria-label、⇅ 的 title */
  function applyStaticText() {
    fromValueEl.setAttribute("aria-label", say("数值", "Value"));
    toValueEl.setAttribute("aria-label", say("结果", "Result"));
    fromUnitEl.setAttribute("aria-label", say("从哪个单位", "From unit"));
    toUnitEl.setAttribute("aria-label", say("换成哪个单位", "To unit"));
    swapEl.title = say("对调单位", "Swap units");
  }

  /** 换语言之后重画：分类小标签和下拉里的单位名 */
  function repaint() {
    applyStaticText();
    renderCats();
    renderUnits();
  }

  function renderCats() {
    catsEl.innerHTML = "";
    CATEGORIES.forEach(function (category) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "cv-cat" + (category.id === state.category ? " is-active" : "");
      button.textContent = labelText(category.label);
      button.dataset.category = category.id;
      button.addEventListener("click", function () {
        switchCategory(category.id);
      });
      catsEl.appendChild(button);
    });
  }

  function renderUnits() {
    var category = categoryById(state.category);
    fillSelect(fromUnitEl, category, state.from);
    fillSelect(toUnitEl, category, state.to);
  }

  function fillSelect(select, category, selectedId) {
    select.innerHTML = "";
    category.units.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = labelText(item.label);
      option.selected = item.id === selectedId;
      select.appendChild(option);
    });
  }

  function switchCategory(id) {
    if (id === state.category) return;
    touched = true;
    state.category = id;
    var category = categoryById(id);
    /*
     * 换分类时单位要重挑：沿用 `m → ft` 这种选择在"温度"里根本不存在。
     * 规则是"第一个 → 第二个"，比"尽量保留同名字符串"可预测得多。
     */
    state.from = category.units[0].id;
    state.to = category.units[Math.min(1, category.units.length - 1)].id;
    renderCats();
    renderUnits();
    recompute(active);
    remember();
  }

  function recompute(source) {
    var fromValue = parseValue(fromValueEl.value);
    var toValue = parseValue(toValueEl.value);
    if (source === "from") {
      if (fromValue === null) {
        toValueEl.value = "";
        return;
      }
      var converted = convert(fromValue, state.category, state.from, state.to);
      toValueEl.value = formatValue(converted);
      return;
    }
    if (toValue === null) {
      fromValueEl.value = "";
      return;
    }
    // 反向：把"目标单位的值"换算回"来源单位"
    fromValueEl.value = formatValue(convert(toValue, state.category, state.to, state.from));
  }

  function remember() {
    call("storage.set", {
      key: REMEMBER_KEY,
      value: { category: state.category, from: state.from, to: state.to },
    }).catch(noop);
  }

  fromValueEl.addEventListener("input", function () {
    touched = true;
    active = "from";
    recompute("from");
  });

  toValueEl.addEventListener("input", function () {
    touched = true;
    active = "to";
    recompute("to");
  });

  fromUnitEl.addEventListener("change", function () {
    touched = true;
    state.from = fromUnitEl.value;
    active = "from";
    recompute("from");
    remember();
  });

  toUnitEl.addEventListener("change", function () {
    touched = true;
    state.to = toUnitEl.value;
    active = "from";
    recompute("from");
    remember();
  });

  swapEl.addEventListener("click", function () {
    touched = true;
    var from = state.from;
    state.from = state.to;
    state.to = from;
    renderUnits();
    /*
     * 换完之后把结果搬到上面：用户点 ⇅ 的意思是"反过来看这个数"，
     * 不是"把两个空框对调"。
     */
    var previous = toValueEl.value;
    fromValueEl.value = previous;
    active = "from";
    recompute("from");
    remember();
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  /*
   * 先按默认值画一遍（m → ft），再等桥回来落到用户上次的位置。
   *
   * 原来的写法是等 `config.get` → `storage.get` 两个来回都结束才画第一帧：
   * 宿主正常时看不出来，但桥慢一点（或者根本没宿主，比如单独打开组件页）
   * 卡片就是一块空白，要等 3s × 2 才出现内容。而第一帧要画的只是
   * "m → ft"，没有任何东西需要等。
   */
  renderCats();
  renderUnits();
  recompute("from");

  // 先问一次语言（首帧已经按 HTML 里的中文画好了）。独立一条链：问不到语言
  // 不该拖住配置和存档 —— 换算器不该因为问不到语言就不算
  call("lang.get")
    .then(function (info) {
      applyLanguage(info);
    })
    .catch(noop);

  call("config.get")
    .then(function (values) {
      if (values) applyConfig(values);
    })
    .catch(noop)
    .then(function () {
      return call("storage.get", { key: REMEMBER_KEY }).catch(function () {
        return null;
      });
    })
    .then(function (saved) {
      /*
       * `touched` 是这道闸门的意义所在：桥可能几百毫秒才回，用户完全可能
       * 已经点过分类、打过数字了。这时候再把存档盖上去，等于把他刚做的
       * 选择撤销掉 —— 宁可这次不恢复，也不能吃掉用户的操作。
       */
      if (!touched && saved && typeof saved === "object") {
        var category = categoryById(String(saved.category));
        state.category = category.id;
        state.from = unitById(category, String(saved.from)).id;
        state.to = unitById(category, String(saved.to)).id;
        renderCats();
        renderUnits();
        recompute("from");
      }
    })
    .catch(noop)
    .then(function () {
      parent.postMessage({ __lattice: 1, type: "ready" }, "*");
    });

  /* 自检页用：把表和三件纯函数挂出去 */
  window.__latticeConvert = {
    CATEGORIES: CATEGORIES,
    convert: convert,
    formatValue: formatValue,
    parseValue: parseValue,
    /** 自检页用：看得到当前选中的分类与两个单位，不用去猜 DOM */
    snapshot: function () {
      return { category: state.category, from: state.from, to: state.to, active: active };
    },
  };
})();
