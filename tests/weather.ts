/**
 * 天气组件 —— 平台里第一个联网组件，所以这一页盯的全是"网不对的时候"。
 *
 * 这里不联网。测试自己扮宿主：回答 `config.get` / `storage.*` / `schedule.*`，
 * 并按 URL 编造 `network.fetch` 的响应。理由是那几条边界（查不到城市、主机
 * 没列进清单、权限被拒、3xx、截断、断网）**没法靠真接口复现** —— 而它们恰好
 * 是用户最可能撞上的。
 *
 * 钉住的四件事：
 *
 *   1. **没配城市就一个请求都不发。** 新装的机器上，组件默认没有城市；这时
 *      去敲接口等于拿一个空查询去问"这是哪儿"。
 *   2. **状态要分开。** 没授权 / 主机没列 / 城市查不到 / 连不上，四种都得有
 *      自己的说法，而且后三种不该继续挂心跳（它们靠定时器永远好不了）。
 *   3. **旧数据不许被抹掉。** 断网时继续显示上次的读数并标明"离线"；
 *      从上海切到东京、而东京没有缓存时，上海的读数必须消失（否则标题是
 *      东京、数字是上海）。
 *   4. **缓存按城市 + 单位分键。** 存储是 per-widgetId 的，两个实例共用一份，
 *      只存一个 reading 键就会互相覆盖。
 */

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NetReply =
  | { kind: "response"; status?: number; ok?: boolean; body?: string; truncated?: boolean; headers?: Record<string, string> }
  | { kind: "denied" }
  | { kind: "internal"; error: string };

type Host = {
  frame: HTMLIFrameElement;
  doc: Document;
  store: Record<string, unknown>;
  setCalls: number;
  netCalls: string[];
  timers: Map<number, number>;
  cleared: number[];
  config: Record<string, unknown>;
  setNet: (next: (url: string) => NetReply) => void;
  pushConfig: (next: Record<string, unknown>) => void;
  fireTick: (id: number) => void;
  ready: Promise<void>;
};

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const API = "https://api.open-meteo.com/v1/forecast";

function json(value: unknown, status = 200): NetReply {
  return { kind: "response", status, ok: status >= 200 && status < 300, body: JSON.stringify(value) };
}

function geocodeHit(name: string, latitude: number, longitude: number, region = "") {
  return json({
    results: [{ id: 1, name, latitude, longitude, country: "China", admin1: region }],
  });
}

function forecast(patch: Record<string, unknown> = {}) {
  return {
    latitude: 31.177504,
    longitude: 121.46255,
    current: {
      time: "2026-10-24T15:15",
      interval: 900,
      temperature_2m: 20.7,
      relative_humidity_2m: 87,
      apparent_temperature: 21.6,
      is_day: 1,
      weather_code: 51,
      wind_speed_10m: 15.2,
    },
    daily: { time: ["2026-10-24"], temperature_2m_max: [20.9], temperature_2m_min: [18.1] },
    ...patch,
  };
}

/** 按 URL 编一份"正常"的网络：上海 → 21 度小雨 */
const happyNet = (url: string): NetReply => {
  if (url.startsWith(GEO)) {
    return url.includes("name=Tokyo")
      ? geocodeHit("Tokyo", 35.6895, 139.6917, "Tokyo")
      : geocodeHit("Shanghai", 31.22222, 121.45806, "Shanghai Municipality");
  }
  if (url.startsWith(API)) return json(forecast());
  return { kind: "internal", error: "unexpected url " + url };
};

function mount(options: {
  config?: Record<string, unknown>;
  store?: Record<string, unknown>;
  net?: (url: string) => NetReply;
}): Host {
  const frame = document.createElement("iframe");
  let net = options.net ?? happyNet;
  let nextTimerId = 1;

  const state: Host = {
    frame,
    /*
     * 必须是 getter：`contentDocument` 在 appendChild 那一刻指向的是
     * about:blank，导航到组件页面之后换成了另一个 Document。早先存一份引用，
     * 后面所有断言都在读那张空白页，症状是"每个 getElementById 都返回 null"。
     */
    get doc() {
      return frame.contentDocument as Document;
    },
    store: { ...(options.store ?? {}) },
    setCalls: 0,
    netCalls: [],
    timers: new Map(),
    cleared: [],
    config: { place: "Shanghai", units: "metric", refreshMinutes: 30, ...(options.config ?? {}) },
    setNet: (next) => {
      net = next;
    },
    pushConfig: (next) => {
      state.config = next;
      frame.contentWindow?.postMessage(
        { __lattice: 1, type: "config-changed", payload: { config: next } },
        "*",
      );
    },
    fireTick: (id) => {
      frame.contentWindow?.postMessage(
        { __lattice: 1, type: "tick", payload: { id, at: Date.now() } },
        "*",
      );
    },
    ready: Promise.resolve(),
  };

  // allow-same-origin 只是让测试能读 iframe 里的 DOM；被测组件本身不需要它
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = "/widgets/lattice.weather/index.html";

  state.ready = new Promise<void>((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__lattice !== 1) return;

      if (data.type === "ready") {
        resolve();
        return;
      }
      if (data.type !== "request") return;

      const id = data.id as number;
      const reply = (payload: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ __lattice: 1, type: "response", id, ...payload }, "*");

      const params = (data.params ?? {}) as Record<string, unknown>;

      if (data.method === "config.get") {
        reply({ ok: true, result: state.config });
        return;
      }
      if (data.method === "storage.get") {
        const key = String(params.key);
        reply({ ok: true, result: key in state.store ? state.store[key] : null });
        return;
      }
      if (data.method === "storage.set") {
        state.setCalls += 1;
        state.store[String(params.key)] = params.value;
        reply({ ok: true, result: { ok: true } });
        return;
      }
      if (data.method === "schedule.every") {
        const timerId = nextTimerId++;
        state.timers.set(timerId, Number(params.every));
        reply({ ok: true, result: { id: timerId, every: params.every } });
        return;
      }
      if (data.method === "schedule.clear") {
        const timerId = Number(params.id);
        state.cleared.push(timerId);
        state.timers.delete(timerId);
        reply({ ok: true, result: { ok: true } });
        return;
      }
      if (data.method === "network.fetch") {
        const url = String(params.url);
        state.netCalls.push(url);
        const answer = net(url);
        if (answer.kind === "denied") {
          reply({
            ok: false,
            code: "permission_denied",
            error: "permission not granted: network",
            permission: "network",
          });
          return;
        }
        if (answer.kind === "internal") {
          reply({ ok: false, code: "internal", error: answer.error });
          return;
        }
        reply({
          ok: true,
          result: {
            status: answer.status ?? 200,
            ok: answer.ok ?? (answer.status ?? 200) < 300,
            headers: answer.headers ?? { "content-type": "application/json" },
            body: answer.body ?? "",
            truncated: answer.truncated ?? false,
          },
        });
        return;
      }

      reply({ ok: false, code: "unknown_method", error: "unknown method " + String(data.method) });
    });
  });

  document.body.appendChild(frame);
  return state;
}

/** 让组件跑完那一串桥调用（每次都是一轮消息往返） */
const settle = () => sleep(260);

const text = (host: Host, id: string) => host.doc.getElementById(id)?.textContent ?? "";
const attr = (host: Host, id: string, name: string) =>
  host.doc.getElementById(id)?.getAttribute(name) ?? "";
const phase = (host: Host) => host.doc.getElementById("root")?.getAttribute("data-state") ?? "";

/**
 * 组件默认按中文画（测试页没有宿主，问不到 `lang.get`）；这里推一条
 * `language` 让它切到英文 —— 顺便验了平台那条推送真的被接住。
 */
const setLang = async (host: Host, next: "zh" | "en") => {
  host.frame.contentWindow?.postMessage(
    { __lattice: 1, type: "language", payload: { lang: next } },
    "*",
  );
  await sleep(30);
};

// ---------------------------------------------------------------------------

// ---- 场景 1：没配城市 ----
{
  const host = mount({ config: { place: "" } });
  await host.ready;
  await settle();

  eq(phase(host), "unconfigured", "没配城市时状态是 unconfigured");
  eq(text(host, "temp"), "还没设城市", "默认那门是中文：大字号位置是一句中文引导语");
  log(
    text(host, "cond").includes("属性面板"),
    `中文解释指向属性面板：「${text(host, "cond")}」`,
  );
  await setLang(host, "en");
  eq(text(host, "temp"), "Set a city", "大字号位置是一句引导语，不是破折号");
  log(/inspector/i.test(text(host, "cond")), `解释指向属性面板：「${text(host, "cond")}」`);
  eq(host.netCalls.length, 0, "一个请求都没发");
  eq(host.timers.size, 0, "也没挂心跳");

  host.frame.remove();
}

// ---- 场景 2：首次加载（先地理编码，再取天气）----
{
  const host = mount({});
  await host.ready;
  await settle();

  eq(host.netCalls.length, 2, "两次请求：先查城市，再取天气");
  log(host.netCalls[0]?.startsWith(GEO) ?? false, "第一次是地理编码");
  log(/name=Shanghai/.test(host.netCalls[0] ?? ""), "地理编码带上了城市名");
  log(host.netCalls[1]?.startsWith(API) ?? false, "第二次是预报接口");
  log(
    /latitude=31\.2222/.test(host.netCalls[1] ?? "") && /longitude=121\.4581/.test(host.netCalls[1] ?? ""),
    "预报用的是地理编码回来的坐标，不是用户填的那个词",
  );
  log(/current=temperature_2m/.test(host.netCalls[1] ?? ""), "预报请求里点名要了当前温度");
  log(!/temperature_unit/.test(host.netCalls[1] ?? ""), "公制时不传单位参数（接口默认就是摄氏）");

  eq(phase(host), "ready", "拿到数据后状态是 ready");
  eq(text(host, "place"), "Shanghai", "标题用地名，不是用户填的词");
  eq(text(host, "temp"), "21°", "20.7 度显示成 21°");
  eq(text(host, "cond"), "小毛毛雨", "中文里挑自然说法，不逐词直译");
  eq(text(host, "age"), "刚刚", "中文说「刚刚」");
  eq(
    host.doc.getElementById("dt-feels")?.textContent,
    "体感",
    "底行标签是中文（数字和 ° 不翻）",
  );

  await setLang(host, "en");

  eq(text(host, "cond"), "Light drizzle", "天气码 51 翻成 Light drizzle");
  eq(attr(host, "glyph-use", "href"), "#g-drizzle", "图形换成毛毛雨");
  eq(text(host, "high"), "21°", "今日高温");
  eq(text(host, "low"), "18°", "今日低温");
  eq(text(host, "feels"), "22°", "体感");
  eq(text(host, "wind"), "15 km/h", "风速带单位");

  log("place:shanghai" in host.store, "城市被缓存下来了（下次不用再查）");
  log("reading:shanghai:metric" in host.store, "读数按「城市 + 单位」分键存");

  const intervals = [...host.timers.values()].sort((a, b) => a - b);
  eq(intervals, [60000, 1800000], "两条心跳：一分钟（刷新多久之前）和半小时（拉数据）");
  eq(text(host, "age"), "just now", "刚拿到时说 just now");

  host.frame.remove();
}

// ---- 场景 3：有城市缓存时不再地理编码 ----
{
  const host = mount({
    store: {
      "place:shanghai": {
        query: "Shanghai",
        name: "Shanghai",
        region: "Shanghai Municipality",
        country: "China",
        latitude: 31.22222,
        longitude: 121.45806,
      },
    },
  });
  await host.ready;
  await settle();

  eq(host.netCalls.length, 1, "只有一次请求");
  log(host.netCalls[0]?.startsWith(API) ?? false, "直接取天气，没有再查一遍城市");
  eq(phase(host), "ready", "照常渲染");

  host.frame.remove();
}

// ---- 场景 4：断网但有旧读数 ----
{
  const at = Date.now() - 42 * 60000;
  const host = mount({
    store: {
      "place:shanghai": {
        query: "Shanghai",
        name: "Shanghai",
        region: "",
        country: "China",
        latitude: 31.22222,
        longitude: 121.45806,
      },
      "reading:shanghai:metric": {
        at,
        units: "metric",
        temp: 18.4,
        feels: 17,
        humidity: 70,
        wind: 9,
        code: 3,
        isDay: 1,
        high: 19,
        low: 12,
      },
    },
    net: () => ({ kind: "internal", error: "network is unreachable" }),
  });
  await host.ready;
  await settle();

  eq(phase(host), "stale", "连不上时退回 stale，不是空白也不是报错块");
  eq(text(host, "temp"), "18°", "旧读数照常显示");
  eq(text(host, "cond"), "阴", "旧读数里的天气码也翻成中文");
  eq(text(host, "age"), "42分钟", `中文标明多久之前：「${text(host, "age")}」`);
  log(/离线/.test(text(host, "hint")), `中文底部说明是离线的：「${text(host, "hint")}」`);

  await setLang(host, "en");

  eq(text(host, "cond"), "Overcast", "旧读数里的天气码也照常翻译");
  eq(text(host, "age"), "42 min", "顶行标明这份数据是 42 分钟前的");
  log(/offline/i.test(text(host, "hint")), `底部说明是离线的：「${text(host, "hint")}」`);
  log(
    host.doc.getElementById("hint")?.classList.contains("is-visible") ?? false,
    "提示行真的显示出来了（不是只写了文本）",
  );
  eq(
    (host.store["reading:shanghai:metric"] as { temp: number }).temp,
    18.4,
    "失败时绝不写回存储（读失败 ≠ 没有数据）",
  );

  // 一分钟那一拍只该刷新"多久之前"，不该顺手再拉一次数据
  const clockId = [...host.timers.entries()].find(([, every]) => every === 60000)?.[0];
  const before = host.netCalls.length;
  if (clockId) host.fireTick(clockId);
  await sleep(120);
  eq(host.netCalls.length, before, "时钟那一拍不联网");
  eq(text(host, "temp"), "18°", "时钟那一拍不重画温度");

  host.frame.remove();
}

// ---- 场景 5：权限被拒 ----
{
  const host = mount({ net: () => ({ kind: "denied" }) });
  await host.ready;
  await settle();

  eq(phase(host), "denied", "没授权时状态是 denied");
  eq(text(host, "temp"), "没有联网权限", "中文说的是没授权，不是网络坏了");
  await setLang(host, "en");
  eq(text(host, "temp"), "No network access", "说的是没授权，不是网络坏了");
  log(/allow/i.test(text(host, "cond")), `指向授权：「${text(host, "cond")}」`);
  eq(host.timers.size, 0, "不挂心跳 —— 没权限时重试一万次也一样");
  eq(host.setCalls, 0, "也没往存储里写任何东西");

  host.frame.remove();
}

// ---- 场景 6：主机没列进清单（作者写漏了）----
{
  const host = mount({
    net: () => ({
      kind: "internal",
      error: 'host "api.open-meteo.com" is not listed in this widget\'s network.hosts',
    }),
  });
  await host.ready;
  await settle();

  eq(phase(host), "blocked", "状态是 blocked，不是普通失败");
  eq(text(host, "temp"), "主机不在名单里", "中文标题说清是主机的问题");
  await setLang(host, "en");
  eq(text(host, "temp"), "Host not allowed", "标题说清是主机的问题");
  log(text(host, "cond").includes("api.open-meteo.com"), `把主机名念出来：「${text(host, "cond")}」`);
  eq(host.timers.size, 0, "不挂心跳 —— 清单写错了靠定时器好不了");

  host.frame.remove();
}

// ---- 场景 7：城市查不到 ----
{
  const host = mount({
    config: { place: "Atlantis" },
    net: (url) => (url.startsWith(GEO) ? json({ generationtime_ms: 0.08 }) : json(forecast())),
  });
  await host.ready;
  await settle();

  eq(phase(host), "noplace", "查不到城市时状态是 noplace");
  eq(text(host, "temp"), "查不到这个城市", "中文标题说查不到");
  await setLang(host, "en");
  eq(text(host, "temp"), "Unknown place", "标题说查不到");
  log(text(host, "cond").includes("Atlantis"), `把用户填的词念回去：「${text(host, "cond")}」`);
  eq(text(host, "place"), "Atlantis", "标题仍然显示用户填的词，不清空");
  eq(host.netCalls.length, 1, "只查了城市，没有拿空坐标去问天气");
  eq(host.timers.size, 0, "不挂心跳");

  host.frame.remove();
}

// ---- 场景 8：非 2xx ----
{
  const host = mount({
    net: (url) =>
      url.startsWith(GEO)
        ? geocodeHit("Shanghai", 31.22222, 121.45806)
        : { kind: "response", status: 503, ok: false, body: "upstream is down" },
  });
  await host.ready;
  await settle();

  eq(phase(host), "failed", "服务端 503 时状态是 failed");
  log(text(host, "cond").includes("503"), `把状态码说出来：「${text(host, "cond")}」`);

  host.frame.remove();
}

// ---- 场景 9：3xx 不自动跟随 ----
{
  const host = mount({
    net: (url) =>
      url.startsWith(GEO)
        ? geocodeHit("Shanghai", 31.22222, 121.45806)
        : {
            kind: "response",
            status: 302,
            ok: false,
            headers: { location: "https://elsewhere.example/" },
            body: "",
          },
  });
  await host.ready;
  await settle();

  eq(phase(host), "failed", "重定向当成失败，不当成成功");
  log(
    text(host, "cond").includes("elsewhere.example"),
    `说出被重定向到哪儿：「${text(host, "cond")}」`,
  );

  host.frame.remove();
}

// ---- 场景 10：英制 ----
{
  const host = mount({ config: { units: "imperial" } });
  await host.ready;
  await settle();

  const url = host.netCalls[1] ?? "";
  log(/temperature_unit=fahrenheit/.test(url), "英制时让接口直接给华氏");
  log(/wind_speed_unit=mph/.test(url), "风速也要英里");
  eq(text(host, "wind"), "15 mph", "风速后缀跟着单位走");
  log("reading:shanghai:imperial" in host.store, "缓存键带上单位，不会和公制那份打架");

  host.frame.remove();
}

// ---- 场景 11：天气码翻译 ----
{
  const host = mount({});
  await host.ready;
  await settle();

  let canned = forecast();
  host.setNet((url) =>
    url.startsWith(GEO) ? geocodeHit("Shanghai", 31.22222, 121.45806) : json(canned),
  );

  await setLang(host, "en");

  const cases: [number, number, string, string][] = [
    // [码, is_day, 期望文案, 期望图形]
    [0, 0, "Clear", "#g-moon"],
    [0, 1, "Clear", "#g-sun"],
    [1, 1, "Mainly clear", "#g-sun"],
    [2, 1, "Partly cloudy", "#g-partly"],
    [3, 1, "Overcast", "#g-cloud"],
    [45, 1, "Fog", "#g-fog"],
    [61, 1, "Light rain", "#g-rain"],
    [65, 1, "Heavy rain", "#g-rain"],
    [75, 1, "Heavy snow", "#g-snow"],
    [82, 1, "Violent showers", "#g-rain"],
    [95, 1, "Thunderstorm", "#g-storm"],
    [99, 1, "Thunderstorm with hail", "#g-storm"],
    [123, 1, "—", "#g-cloud"],
  ];

  for (const [code, isDay, label, glyph] of cases) {
    canned = forecast({
      current: {
        temperature_2m: 5,
        relative_humidity_2m: 50,
        apparent_temperature: 4,
        is_day: isDay,
        weather_code: code,
        wind_speed_10m: 3,
      },
    });
    host.pushConfig({ place: "Shanghai", units: "metric", refreshMinutes: 30 });
    await sleep(120);
    eq(text(host, "cond"), label, `天气码 ${code} → ${label}`);
    eq(attr(host, "glyph-use", "href"), glyph, `天气码 ${code} 用 ${glyph}`);
  }

  host.frame.remove();
}

// ---- 场景 12：改配置换城市 ----
{
  const host = mount({});
  await host.ready;
  await settle();

  eq(text(host, "place"), "Shanghai", "先是上海");

  host.pushConfig({ place: "Tokyo", units: "metric", refreshMinutes: 15 });
  await settle();

  log(
    host.netCalls.some((url) => url.startsWith(GEO) && url.includes("name=Tokyo")),
    "换了城市要重新地理编码",
  );
  eq(text(host, "place"), "Tokyo", "标题跟着换");
  /*
   * 间隔从 30 分钟改成 15 分钟：`schedule.every` 没有"改间隔"，只能清掉旧的
   * 再挂一条。不清就是第二条订阅 —— 改五次配置用满八条上限，第六次开始
   * 静默失败，而界面上什么都不会变。
   */
  log(host.cleared.length > 0, "旧的刷新订阅被 clear 掉了");
  eq(host.timers.size, 2, "清完重新挂了两条，不是四条");
  log(
    [...host.timers.values()].includes(15 * 60000),
    `新的间隔是 15 分钟（现有 ${JSON.stringify([...host.timers.values()])}）`,
  );

  host.frame.remove();
}

// ---- 场景 13：换城市但新城市没有缓存 ----
{
  const host = mount({
    store: {
      "place:shanghai": {
        query: "Shanghai",
        name: "Shanghai",
        region: "",
        country: "China",
        latitude: 31.22222,
        longitude: 121.45806,
      },
      "reading:shanghai:metric": {
        at: Date.now() - 60000,
        units: "metric",
        temp: 30,
        feels: 30,
        humidity: 50,
        wind: 5,
        code: 0,
        isDay: 1,
        high: 31,
        low: 20,
      },
    },
  });
  await host.ready;
  await settle();
  eq(text(host, "place"), "Shanghai", "先按上海的缓存把卡片画出来");
  eq(text(host, "temp"), "21°", "接口回来后以接口为准（缓存那份是 30 度）");

  // 东京这条网络走不通
  host.setNet((url) => {
    if (url.startsWith(GEO) && url.includes("name=Tokyo")) return geocodeHit("Tokyo", 35.6895, 139.6917);
    return { kind: "internal", error: "network is unreachable" };
  });
  host.pushConfig({ place: "Tokyo", units: "metric", refreshMinutes: 30 });
  await settle();

  eq(text(host, "place"), "Tokyo", "标题是东京");
  eq(
    text(host, "temp"),
    "连不上天气服务",
    "默认中文也说得出「连不上」，而不是一直停在加载",
  );
  await setLang(host, "en");
  eq(
    text(host, "temp"),
    "Can't reach the service",
    "东京没有缓存、又连不上时，绝不能让上海的温度留在屏幕上",
  );

  host.frame.remove();
}

document.getElementById("out")!.innerHTML = lines
  .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
  .join("\n");
(window as unknown as { __done: boolean }).__done = true;
