/**
 * 环境音引擎：四种背景声全部由 Web Audio 现场合成，包里没有一个音频文件。
 *
 * # 为什么不带 mp3
 *
 * 组件是纯静态目录，放一个 3 MB 的雨声就要跟着包走、跟着签名、还要想缓存；
 * 而"雨"和"火"的辨识度几乎全在噪声的频谱和包络上 —— 白噪过一道 1.2 kHz
 * 低通就是雨，棕噪加随机爆裂脉冲就是火。合成出来的东西零素材、秒开、
 * 也不用为它申请任何权限（没有 network，也没有 audio 读取）。
 *
 * # 参数从哪来
 *
 * 合成参数取自 vela-cleanroom 的 `src/lib/ambience.ts`（MIT）。那边的一整套
 * localStorage、Tauri 事件和"媒体在播时让位"都属于它自己的宿主，搬过来只留
 * 合成这一半：组件版的偏好走组件存储，播放状态不落盘（见 manifest 的 help）。
 *
 * # 为什么不留定时器
 *
 * 雨和咖啡厅的"呼吸感"用 LFO（低频振荡器）做，不靠 setInterval 改增益；
 * 只有篝火的爆裂需要离散脉冲，那个由宿主页的 250ms 心跳喂进来（`tick()`），
 * 窗口藏起来时心跳停摆，雨声继续、火声变闷 —— 这是有意的取舍：让组件在
 * 不可见时安静下来，比让它在后台抢 CPU 重要。
 *
 * 这个文件是纯逻辑：不碰 DOM，也不问宿主。播放器的 AudioContext 在第一次
 * `play()` 时才创建 —— 页面加载就建一个 ctx 会被自动播放策略按在
 * `suspended`，界面上就会出现"显示在播放、其实没声"的谎。
 */
(function () {
  "use strict";

  var DEFAULT_VOLUME = 0.4;

  /**
   * 四个场景。`crackle` 是每个心跳（250ms）放一次爆裂的概率，
   * `swell` / `drift` 是低频振荡器（hz 与深度），都不是定时器。
   */
  var SCENES = [
    {
      id: "rain",
      zh: "雨",
      en: "Rain",
      noise: "white",
      filter: { type: "lowpass", frequency: 1200, q: 0.7 },
      swell: { hz: 0.09, depth: 0.12 },
      crackle: 0,
    },
    {
      id: "cafe",
      zh: "咖啡厅",
      en: "Café",
      noise: "brown",
      filter: { type: "bandpass", frequency: 520, q: 0.6 },
      swell: { hz: 0.05, depth: 0.1 },
      // 中心频率缓慢漂移，免得听出"一个固定的嗡"
      drift: { hz: 0.037, depth: 130 },
      crackle: 0,
    },
    {
      id: "fire",
      zh: "篝火",
      en: "Fire",
      noise: "brown",
      filter: { type: "lowpass", frequency: 700, q: 0.9 },
      swell: { hz: 0.07, depth: 0.1 },
      crackle: 0.42,
    },
    {
      id: "white",
      zh: "白噪",
      en: "White",
      noise: "white",
      filter: null,
      swell: { hz: 0.02, depth: 0.04 },
      crackle: 0,
    },
  ];

  function sceneById(id) {
    for (var i = 0; i < SCENES.length; i += 1) {
      if (SCENES[i].id === id) return SCENES[i];
    }
    return null;
  }

  function clamp01(value) {
    var number = typeof value === "number" && isFinite(value) ? value : 0;
    return Math.min(1, Math.max(0, number));
  }

  /**
   * 存档/参数里读到什么算什么。坏值逐项退回出厂：不认识的场景落回雨，
   * 音量夹到 0..1 —— 存进去的东西可能来自上一个版本，也可能被手改过。
   */
  function normalizePrefs(raw) {
    var source = raw && typeof raw === "object" ? raw : {};
    var kind = sceneById(source.kind) ? source.kind : SCENES[0].id;
    var volume =
      typeof source.volume === "number" && isFinite(source.volume)
        ? clamp01(source.volume)
        : DEFAULT_VOLUME;
    return { kind: kind, volume: volume };
  }

  /**
   * 滑杆值 → 主增益。
   *
   * 不是线性的：人对响度的感觉接近幂函数，线性滑杆的"中间"听起来已经有
   * 八成响；再乘 0.85 是因为满音量的白噪会盖过人声。听感上 50% 大约相当于
   * 线性的 33%。
   */
  function amplitude(volume) {
    return 0.85 * Math.pow(clamp01(volume), 1.6);
  }

  /** 2 秒噪声底，循环播放。棕噪是对白噪做一次积分（能量压向低频）。 */
  function noiseBuffer(ctx, brown) {
    if (!ctx.__latticeNoise) ctx.__latticeNoise = {};
    var cache = ctx.__latticeNoise;
    var key = brown ? "brown" : "white";
    if (cache[key]) return cache[key];

    var rate = ctx.sampleRate || 44100;
    var length = Math.floor(rate * 2);
    var buffer = ctx.createBuffer(1, length, rate);
    var data = buffer.getChannelData(0);
    var last = 0;
    for (var i = 0; i < length; i += 1) {
      var white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        data[i] = white;
      }
    }
    cache[key] = buffer;
    return buffer;
  }

  /** 一次篝火爆裂：三角波 + 极短的指数包络，像木柴"啪"的一下。 */
  function pulse(graph) {
    var ctx = graph.context;
    var now = ctx.currentTime || 0;
    try {
      var osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 90 + graph.random() * 160;
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25 + graph.random() * 0.2, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06 + graph.random() * 0.08);
      osc.connect(gain).connect(graph.master);
      osc.start(now);
      osc.stop(now + 0.25);
      return true;
    } catch (error) {
      // ctx 已经关了（窗口正在销毁）：丢掉这一次脉冲，不抛
      return false;
    }
  }

  /**
   * 搭一整张节点图：噪声源 →（滤波）→ 包络 → 主增益 → 输出。
   *
   * 单独导出是为了让断言页能拿一个真 AudioContext 搭图、直接读节点属性
   * （滤波类型/频率/Q、主增益的调度值），不用听声音也能验参数。
   */
  function buildGraph(ctx, kind, volume, random) {
    var scene = sceneById(kind) || SCENES[0];
    var now = ctx.currentTime || 0;
    var roll = typeof random === "function" ? random : Math.random;

    var master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    var filter = null;
    if (scene.filter) {
      filter = ctx.createBiquadFilter();
      filter.type = scene.filter.type;
      filter.frequency.value = scene.filter.frequency;
      if (filter.Q) filter.Q.value = scene.filter.q;
      filter.connect(master);
    }

    var source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx, scene.noise === "brown");
    source.loop = true;
    var amp = ctx.createGain();
    amp.gain.value = 0.85;
    source.connect(amp).connect(filter || master);

    // "呼吸"：低频振荡器直接叠在包络增益上，不写一行定时器
    var lfo = null;
    if (scene.swell) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = scene.swell.hz;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = scene.swell.depth;
      lfo.connect(lfoGain);
      lfoGain.connect(amp.gain);
      lfo.start(now);
    }

    // 咖啡厅：第二个更慢的 LFO 推着带通中心频率走
    var drift = null;
    if (scene.drift && filter) {
      drift = ctx.createOscillator();
      drift.frequency.value = scene.drift.hz;
      var driftGain = ctx.createGain();
      driftGain.gain.value = scene.drift.depth;
      drift.connect(driftGain);
      driftGain.connect(filter.frequency);
      drift.start(now);
    }

    source.start(now);
    // 淡入：直接赋值会"啪"一声，setTargetAtTime 是听不出来的那种渐入
    master.gain.setTargetAtTime(amplitude(volume), now, 0.25);

    return {
      kind: scene.id,
      scene: scene,
      context: ctx,
      random: roll,
      master: master,
      filter: filter,
      amp: amp,
      source: source,
      lfo: lfo,
      drift: drift,
    };
  }

  /**
   * 拆图：先把主增益推到 0（80ms 的释放），再把源停掉。
   *
   * 停源要留 600ms —— 增益还在滑，马上停会听到"咔"。master 最后断开，
   * 免得每暂停一次就在 destination 上挂一个静音的节点。
   */
  function stopGraph(graph) {
    if (!graph) return;
    var ctx = graph.context;
    var now = ctx.currentTime || 0;
    try {
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setTargetAtTime(0, now, 0.08);
    } catch (error) {
      /* ctx 已经关了 */
    }
    var at = now + 0.6;
    [graph.source, graph.lfo, graph.drift].forEach(function (node) {
      if (!node) return;
      try {
        node.stop(at);
      } catch (error) {
        /* 已经停过了 */
      }
    });
    setTimeout(function () {
      try {
        graph.master.disconnect();
      } catch (error) {
        /* 已经断了 */
      }
    }, 700);
  }

  /**
   * 一个页面一台播放器（卡片里就是单例）。`options` 只为断言页存在：
   * 换掉 AudioContext 的构造和随机源，合成过程就完全确定。
   */
  function createEngine(options) {
    var opts = options || {};
    var random = typeof opts.random === "function" ? opts.random : Math.random;
    var makeContext =
      opts.createContext ||
      function () {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        return Ctor ? new Ctor() : null;
      };

    var ctx = null;
    var graph = null;
    var kind = SCENES[0].id;
    var volume = DEFAULT_VOLUME;

    function ensureContext() {
      if (ctx) return ctx;
      try {
        ctx = makeContext();
      } catch (error) {
        ctx = null;
      }
      return ctx;
    }

    /* 自动播放策略：resume 可能被拒。拒了不报错、不改状态 ——
     * 下一次点击会再试一次（`play()` 也会），界面按"图在"画播放态。 */
    function resume() {
      if (!ctx || typeof ctx.resume !== "function") return;
      try {
        var promise = ctx.resume();
        if (promise && typeof promise.catch === "function") promise.catch(function () {});
      } catch (error) {
        /* 有的实现直接抛 */
      }
    }

    return {
      state: function () {
        return {
          playing: !!graph,
          kind: kind,
          volume: volume,
          context: ctx ? String(ctx.state || "unknown") : "none",
        };
      },
      graph: function () {
        return graph;
      },
      context: function () {
        return ctx;
      },

      /** 开始 / 换场景。返回 false 表示这个环境根本建不出 AudioContext。 */
      play: function (nextKind, nextVolume) {
        var target = sceneById(nextKind) ? nextKind : kind;
        if (typeof nextVolume === "number" && isFinite(nextVolume)) {
          volume = clamp01(nextVolume);
        }
        var context = ensureContext();
        if (!context) return false;

        if (graph && target !== graph.kind) {
          stopGraph(graph);
          graph = null;
        }
        kind = target;
        if (graph) {
          try {
            graph.master.gain.setTargetAtTime(amplitude(volume), context.currentTime, 0.1);
          } catch (error) {
            /* ctx 已经关了 */
          }
        } else {
          graph = buildGraph(context, kind, volume, random);
        }
        resume();
        return true;
      },

      pause: function () {
        if (!graph) return false;
        stopGraph(graph);
        graph = null;
        return true;
      },

      setVolume: function (next) {
        volume = clamp01(next);
        if (!graph || !ctx) return;
        try {
          graph.master.gain.setTargetAtTime(amplitude(volume), ctx.currentTime, 0.1);
        } catch (error) {
          /* ctx 已经关了 */
        }
      },

      /** 心跳一拍：只有篝火会在这里掉出一次爆裂。返回这一拍有没有响。 */
      tick: function () {
        if (!graph) return false;
        if (!graph.scene.crackle) return false;
        if (graph.random() > graph.scene.crackle) return false;
        return pulse(graph);
      },

      close: function () {
        if (graph) stopGraph(graph);
        graph = null;
        if (ctx) {
          try {
            var promise = ctx.close();
            if (promise && typeof promise.catch === "function") promise.catch(function () {});
          } catch (error) {
            /* 已经关了 */
          }
        }
        ctx = null;
      },
    };
  }

  var api = {
    SCENES: SCENES,
    DEFAULT_VOLUME: DEFAULT_VOLUME,
    sceneById: sceneById,
    normalizePrefs: normalizePrefs,
    amplitude: amplitude,
    buildGraph: buildGraph,
    createEngine: createEngine,
    player: createEngine(),
  };

  window.__latticeAmbienceCore = api;
})();
