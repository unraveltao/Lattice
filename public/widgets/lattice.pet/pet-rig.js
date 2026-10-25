/**
 * 大肥鱼的 rig：网格变形 + 弹簧 + 一张会变的脸。
 *
 * 几何和贴图来自 Coopanion（Pal-AI-Lab）的鲸鱼 figure —— `whale/model.json` 里是
 * 25 个部件的 `box` + `grid`、枢轴、脸部矩形和三套服装；`whale/tex`、`whale/feat`、
 * `whale/outfits/*` 是拆好的图。**顶点数据不在文件里**：网格是 `box` 上的均匀栅格，
 * 现算，所以 21 KB 就能描述一整套 rig。
 *
 * 这里做三件事：
 *   1. 把每个部件按"枢轴旋转 + 矩形位移场"的变形器链，用 Canvas2D 的
 *      `clip + setTransform + drawImage` 画出来（一个三角形一次）；
 *   2. 用几个标量弹簧给头发 / 裙摆 / 尾巴 / 鳍 / 呆毛做次级动态 —— 它们是
 *      "滞后"，不是物理绳，视觉上的"一串珠子"来自网格细分 + 按 v 加权；
 *   3. 把表情画进一张 390×252 的离屏画布：眼白 / 虹膜 / 睫毛三件套 + 眼睑裁切，
 *      所以"半闭眼、眯眼、爱心眼"都不用贴图。
 *
 * 两件不能做的事（沙箱 iframe 是不透明源）：
 *   - **不能读像素**：`getImageData` 会抛，所以窗口轮廓只能在构建期算好
 *     （`art/build-masks.py` → `art/rig-data.js`）。
 *   - **不能 fetch 自己的 JSON**：数据也是用 classic script 带进来的。
 */
(function (global) {
  "use strict";

  /* ---------- 单位换算 ---------- */

  // rig 空间：x=128 在身体下方、脚底 y=256（和上游 figure.js 同一套坐标）
  var S = 0.19;
  var X0 = 650;
  var FEET = 1363;
  // 脸那张离屏画布覆盖原画的这一块（master 像素），一个 texel 一个 master 像素
  var FACE = { x: 520, y: 578, w: 390, h: 252 };
  // 头部四层做视差的范围（rig 单位）
  var HEAD = [30, 12, 215, 168];

  /** master 像素 → rig 单位（和上游 figure.js 的 U/V 同一个式子） */
  var U = function (x) {
    return 128 + (x - X0) * S;
  };
  var V = function (y) {
    return 256 - (FEET - y) * S;
  };

  var clamp = function (v, a, b) {
    return Math.max(a, Math.min(b, v));
  };
  var ease = function (rate, dt) {
    return 1 - Math.exp(-rate * dt);
  };

  function numbers(value) {
    if (typeof value === "string") return value.trim().split(/[\s,]+/).map(Number);
    if (Array.isArray(value)) return value.map(Number);
    return value;
  }

  /* ---------- 弹簧 ---------- */

  /**
   * 一个标量弹簧。`lim` 限幅：扔得狠的时候头发会过冲，但不能折回自己身上
   * （超过就夹住、并把速度清零，否则它会贴着限位来回弹）。
   */
  function Spring(k, c, lim) {
    this.x = 0;
    this.v = 0;
    this.k = k;
    this.c = c;
    this.lim = lim || Infinity;
  }

  Spring.prototype.step = function (target, dt) {
    this.v += ((target - this.x) * this.k - this.v * this.c) * dt;
    this.x += this.v * dt;
    if (this.x > this.lim) {
      this.x = this.lim;
      this.v = 0;
    } else if (this.x < -this.lim) {
      this.x = -this.lim;
      this.v = 0;
    }
    return this.x;
  };

  /* ---------- 变形器树 ---------- */

  /**
   * 部件挂在哪条链上，由**我们自己**按 model.json 的 pivots 和部件 box 拼出来：
   * 上游把这个表写在 figure.js 里，我们只借用它的几何数据，不搬它的代码。
   */
  function buildDeformers(model, outfitId) {
    var pivots = {};
    var key;
    for (key in model.pivots) pivots[key] = numbers(model.pivots[key]);
    var outfit = null;
    var i;
    for (i = 0; i < (model.outfits || []).length; i++) {
      if (model.outfits[i].id === outfitId) outfit = model.outfits[i];
    }
    if (outfit && outfit.pivots) {
      for (key in outfit.pivots) pivots[key] = numbers(outfit.pivots[key]);
    }

    var defs = {};
    var rot = function (id, pivot, parent) {
      defs[id] = { kind: "rot", pivot: pivot || [128, 256], parent: parent || "" };
    };
    var warp = function (id, rect, parent) {
      defs[id] = { kind: "warp", rect: rect, parent: parent || "" };
    };

    rot("body", pivots.body);
    rot("waist", pivots.waist, "body");
    rot("neck", pivots.neck, "body");
    // 头部四层共用一个矩形，位移量按层递减，看起来就有"前后"了
    warp("headBack", HEAD, "neck");
    warp("headMid", HEAD, "neck");
    warp("headFeat", HEAD, "neck");
    warp("headFront", HEAD, "neck");
    // 后发跟着头走，但只跟一半 —— 下半截应该留在背上
    warp("hairSway", [39.46, 48.33, 144.21, 173.66], "headBack");
    warp("bangsSway", [80.69, 51.75, 112.29, 99.75], "headFront");
    rot("tail", pivots.tail, "body");
    warp("tailBend", [24.26, 172.21, 83.03, 40.47], "tail");
    rot("armNear", pivots.armNear, "body");
    rot("armFar", pivots.armFar, "body");
    rot("legBack", pivots.legBack, "body");
    rot("legFront", pivots.legFront, "body");
    rot("finFar", pivots.finFar, "headBack");
    rot("finNear", pivots.finNear, "headMid");
    rot("ahoge", pivots.ahoge, "headFront");
    warp("skirt", [79.55, 168.41, 98.04, 61.18], "body");
    warp("skirtSit", [47.44, 168.98, 151.81, 68.97], "body");
    warp("brows", [117.74, 97.35, 58.33, 9.12], "headFeat");
    warp("creases", [126.29, 108.94, 44.46, 9.88], "headFeat");

    // 服装自己带的枢轴 / 变形器（斗篷的围巾、店员装的马尾）
    if (outfit && outfit.deformers) {
      for (key in outfit.deformers) {
        var spec = outfit.deformers[key];
        rot(key, numbers(spec.pivot), spec.parent);
      }
    }
    return defs;
  }

  function chainOf(defs, id) {
    var chain = [];
    for (var d = id; d && defs[d]; d = defs[d].parent) chain.push(d);
    return chain;
  }

  /** 把一个静止点按链算到本帧位置（链是内→外，所以正序走） */
  function applyChain(defs, chain, st, x, y) {
    for (var i = 0; i < chain.length; i++) {
      var def = defs[chain[i]];
      var state = st[chain[i]];
      if (!def || !state) continue;
      if (def.kind === "rot") {
        var pivot = def.pivot;
        var angle = (state.a || 0) * Math.PI / 180;
        var cos = Math.cos(angle);
        var sin = Math.sin(angle);
        var scaleX = state.sx === undefined ? 1 : state.sx;
        var scaleY = state.sy === undefined ? state.sx === undefined ? 1 : state.sx : state.sy;
        var lx = (x - pivot[0]) * scaleX;
        var ly = (y - pivot[1]) * scaleY;
        x = pivot[0] + (state.tx || 0) + lx * cos - ly * sin;
        y = pivot[1] + (state.ty || 0) + lx * sin + ly * cos;
      } else if (def.kind === "warp" && state.fn) {
        var rect = def.rect;
        var u = clamp((x - rect[0]) / rect[2], 0, 1);
        var v = clamp((y - rect[1]) / rect[3], 0, 1);
        var shift = state.fn(u, v, x, y);
        x += shift[0];
        y += shift[1];
      }
    }
    return [x, y];
  }

  /* ---------- 网格 ---------- */

  /**
   * Canvas2D 的网格封顶 6×8：再多就是在给自己找卡（每多一格多两个三角形，
   * 每个三角形都是一次 clip + drawImage）。最细的部件在后发（8×12），压到 6×8
   * 之后弯曲会略硬一点 —— 这是这条路的固定代价，WebGL2 才吃得下更细的网格。
   */
  function buildMesh(part, defs) {
    var grid = numbers(part.grid) || [6, 6];
    var nx = Math.max(1, Math.min(6, Math.round(grid[0])));
    var ny = Math.max(1, Math.min(8, Math.round(grid[1])));
    var box = numbers(part.box);
    var x = box[0];
    var y = box[1];
    var w = box[2];
    var h = box[3];
    var vertices = [];
    var i;
    var j;
    for (j = 0; j <= ny; j++) {
      for (i = 0; i <= nx; i++) {
        vertices.push([x + (w * i) / nx, y + (h * j) / ny, i / nx, j / ny]);
      }
    }
    var triangles = [];
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var a = j * (nx + 1) + i;
        var b = a + 1;
        var c = a + nx + 1;
        var d = c + 1;
        triangles.push([a, b, c], [b, d, c]);
      }
    }
    return {
      id: part.id,
      tex: part.tex,
      z: Number(part.z) || 0,
      alpha: part.alpha === undefined ? 1 : Number(part.alpha),
      vertices: vertices,
      triangles: triangles,
      chain: chainOf(defs, part.parent),
      warped: vertices.map(function (v) {
        return [v[0], v[1]];
      }),
    };
  }

  /* ---------- 主体 ---------- */

  function create(canvas, data) {
    var model = data.model;
    var masks = data.masks;
    var ctx = canvas.getContext("2d", { alpha: true });

    var images = {};      // tex id → Image / canvas
    var outfit = "maid";
    var parts = [];       // 当前服装，已按 z 排好
    var defs = {};
    var st = {};
    var loaded = {};      // 已发起的贴图加载

    // 布局：rig 单位 → 窗口 CSS 像素
    var view = { k: 1.5, ox: 0, oy: 0, w: 420, h: 340, dpr: 1 };
    /** 配置里的「大小」：1 = 铺满窗口，0.55 = 出厂那只小的（见 `layout` 的注释） */
    var sizeScale = 1;

    // 动态
    var spring = {
      hair: new Spring(55, 7, 1.8),
      hairY: new Spring(50, 8, 1.2),
      bangs: new Spring(110, 10, 1.6),
      skirt: new Spring(100, 9, 1.6),
      skirtY: new Spring(90, 10, 1.1),
      tail: new Spring(40, 5, 32),
      fins: new Spring(90, 9, 30),
      ahoge: new Spring(140, 6, 38),
      head: new Spring(70, 10, 16),
      armN: new Spring(60, 9, 95),
    };
    var motion = { walking: false, speed: 0, phase: 0, dragging: false, lift: 0 };
    var expr = "neutral";
    var blink = 0;        // 0 睁开 → 1 闭眼
    var blinkNext = 2.4;
    var blinkAge = 0;
    var clock = 0;
    var faceDirty = true;
    var stats = { frames: 0, parts: 0, missing: [], images: 0 };

    /* ---------- 贴图 ---------- */

    function base(src) {
      return "whale/" + src;
    }

    function want(key, src, done) {
      if (images[key]) {
        if (done) done(images[key]);
        return;
      }
      if (loaded[key]) return;
      loaded[key] = true;
      var image = new Image();
      image.onload = function () {
        images[key] = image;
        stats.images++;
        // 脸上的部件（眼白 / 嘴）到齐之前那张画布是空的，到了要重画一遍
        if (key === "faceFx" || key.indexOf("feat:") === 0) faceDirty = true;
        if (done) done(image);
      };
      image.onerror = function () {
        stats.missing.push(src);
        delete loaded[key];
      };
      image.src = base(src);
    }

    /* ---------- 脸 ---------- */

    var faceCv = document.createElement("canvas");
    faceCv.width = FACE.w;
    faceCv.height = FACE.h;
    var fx = faceCv.getContext("2d");
    images.faceFx = faceCv;

    /*
     * 眼睛单独画在一张小画布上，再整张盖到脸上。
     *
     * 为什么不直接画在脸上：眼睑是一条二次曲线，闭眼时要把它以上**整片**擦掉。
     * 直接擦脸会把腮红、嘴、甚至上一帧的眼睛一起擦出洞来（而且 `destination-out`
     * 擦不出"半透明眼皮"）。分两层之后，擦的范围就只在这只眼睛里。
     */
    var eyeCv = document.createElement("canvas");
    var ex = eyeCv.getContext("2d");

    var poly2 = function (c, x) {
      return c[0] * x * x + c[1] * x + c[2];
    };

    /*
     * 每只眼的几何 + "闭眼行程"。
     *
     * `ball` / `iris` / `lash` 都是 master 像素的 **[x0, y0, x1, y1]**，不是宽高 ——
     * 上游的 model.json 一直用这个口径（嘴是 [758,764,773,775]，15×11）。
     * 行程 = 眼睑线到眼球下缘的最大间距，闭眼就是把眼睑推这么远。
     */
    var EYE = {};
    (function () {
      var sides = ["eyeL", "eyeR"];
      for (var i = 0; i < sides.length; i++) {
        var key = sides[i];
        var spec = model.feat.eyes[key];
        var ball = numbers(spec.ball);
        var lidFit = numbers(spec.lidFit);
        var rimFit = numbers(spec.rimFit);
        var travel = 0;
        for (var x = ball[0] + 4; x < ball[2] - 4; x += 2) {
          travel = Math.max(travel, poly2(rimFit, x) - poly2(lidFit, x));
        }
        var cx = (numbers(spec.iris)[0] + numbers(spec.iris)[2]) / 2;
        EYE[key] = {
          ball: ball,
          iris: numbers(spec.iris),
          lash: numbers(spec.lash),
          lidFit: lidFit,
          travel: travel + 2,
          cx: cx,
          cy: poly2(lidFit, cx),
        };
      }
    })();

    function spriteRect(name) {
      var rect = model.feat.sprites[name];
      return rect ? numbers(rect) : null;
    }

    /*
     * 三张嘴比原画里的位置高一点（happy 高 9、drag 高 16、sleep 高 4 master 像素），
     * 这里补回中间线上 —— 否则换表情时嘴会跳。
     */
    var MOUTH_DY = { happy_mouth: 9, drag_mouth: 16, sleep_mouth: 4 };

    /** 一张整图表情（一双眼或一张嘴）：按它自己的矩形放，可绕中心缩放 */
    function drawSprite(name, scale) {
      var rect = spriteRect(name);
      if (!rect) return;
      var image = images["feat:" + name];
      if (!image) return;
      var cx = (rect[0] + rect[2]) / 2;
      var cy = (rect[1] + rect[3]) / 2;
      var sx = scale ? scale[0] : 1;
      var sy = scale ? scale[1] : 1;
      fx.save();
      fx.translate(cx - FACE.x, cy + (MOUTH_DY[name] || 0) - FACE.y);
      fx.scale(sx, sy);
      fx.drawImage(image, rect[0] - cx, rect[1] - cy);
      fx.restore();
    }

    /**
     * 一只睁着的眼。`open` 0 = 全闭、1 = 全睁。
     *
     * 眼球 + 虹膜在 `eyeCv` 里合成（虹膜用 `source-atop`，不会越出眼框），
     * 再用 `destination-out` 把眼睑以上擦掉，最后整张盖到脸上；
     * 睫毛单独画、跟着眼睑往下走，闭眼时压扁。
     */
    function openEye(key, open) {
      var eye = EYE[key];
      var bx0 = eye.ball[0];
      var by0 = eye.ball[1];
      var w = eye.ball[2] - bx0;
      var h = eye.ball[3] - by0;
      // 上下各留 20 px：睫毛和眼睑曲线都要一点余量，不然会被画布边切掉
      if (eyeCv.width !== w + 40 || eyeCv.height !== h + 40) {
        eyeCv.width = w + 40;
        eyeCv.height = h + 40;
      }
      var g = ex;
      g.setTransform(1, 0, 0, 1, 20 - bx0, 20 - by0);
      g.clearRect(bx0 - 20, by0 - 20, w + 40, h + 40);
      g.globalCompositeOperation = "source-over";
      var ball = images["feat:" + key + "_ball"];
      if (ball) g.drawImage(ball, bx0, by0);
      g.globalCompositeOperation = "source-atop";
      var iris = images["feat:" + key + "_iris"];
      if (iris) g.drawImage(iris, eye.iris[0], eye.iris[1]);

      // 眼睑：推 `travel * (1 - open)` 那么远，然后把曲线以上整片擦掉
      var drop = (1 - clamp(open, 0, 1)) * eye.travel;
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.moveTo(bx0 - 20, by0 - 20);
      for (var x = bx0 - 20; x <= eye.ball[2] + 20; x += 3) {
        g.lineTo(x, poly2(eye.lidFit, clamp(x, bx0, eye.ball[2])) + drop - 1);
      }
      g.lineTo(eye.ball[2] + 20, by0 - 20);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = "source-over";
      g.setTransform(1, 0, 0, 1, 0, 0);

      fx.drawImage(eyeCv, bx0 - 20 - FACE.x, by0 - 20 - FACE.y);

      var lash = images["feat:" + key + "_lash"];
      if (!lash) return;
      fx.save();
      fx.translate(eye.cx - FACE.x, eye.cy + drop - FACE.y);
      fx.scale(1, 0.55 + 0.45 * clamp(open, 0, 1));
      fx.drawImage(lash, eye.lash[0] - eye.cx, eye.lash[1] - eye.cy);
      fx.restore();
    }

    /*
     * 腮红一共两团，位置是原画上的 [x, y, 半径x, 半径y]（master 像素）。
     * 用椭圆径向渐变而不是正圆：她的脸是压扁的，正圆会看起来像贴了两块圆片。
     */
    var CHEEKS = [
      [618, 770, 40, 20],
      [852, 762, 22, 15],
    ];

    function blush(amount) {
      if (amount < 0.02) return;
      for (var i = 0; i < CHEEKS.length; i++) {
        var x = CHEEKS[i][0];
        var y = CHEEKS[i][1];
        var rx = CHEEKS[i][2];
        var ry = CHEEKS[i][3];
        fx.save();
        fx.translate(x - FACE.x, y - FACE.y);
        fx.scale(1, ry / rx);
        var gradient = fx.createRadialGradient(0, 0, 0, 0, 0, rx);
        gradient.addColorStop(0, "rgba(255,120,140," + 0.55 * amount + ")");
        gradient.addColorStop(1, "rgba(255,120,140,0)");
        fx.fillStyle = gradient;
        fx.beginPath();
        fx.arc(0, 0, rx, 0, Math.PI * 2);
        fx.fill();
        fx.restore();
      }
    }

    /*
     * 每个表情用哪套眼睛 / 嘴。
     *
     * `eyes: "open"` 走"眼球 + 虹膜 + 眼睑"那条路（能眨眼、能半闭），
     * 其余值是整眼贴图（happy / sleep / drag / love / dizzy / surprised）。
     * `open` 是静止时眼睑的位置：1 全睁，0.35 就是"快睡着了"。
     */
    var FACES = {
      neutral: { eyes: "open", open: 1, mouth: "neutral_mouth" },
      happy: { eyes: "open", open: 0.72, mouth: "happy_mouth", blush: 0.6 },
      shy: { eyes: "open", open: 0.8, mouth: "drag_mouth", blush: 1 },
      angry: { eyes: "open", open: 0.55, mouth: "drag_mouth" },
      unhappy: { eyes: "open", open: 0.62, mouth: "neutral_mouth" },
      slack: { eyes: "open", open: 0.3, mouth: "sleep_mouth" },
      sleep: { eyes: "sleep", mouth: "sleep_mouth" },
      love: { eyes: "love", mouth: "love_mouth", blush: 1 },
      surprised: { eyes: "surprised", mouth: "surprised_mouth" },
      dragged: { eyes: "drag", mouth: "drag_mouth" },
      dizzy: { eyes: "dizzy", mouth: "dizzy_mouth" },
    };

    function paintFace() {
      faceDirty = false;
      fx.setTransform(1, 0, 0, 1, 0, 0);
      fx.globalCompositeOperation = "source-over";
      fx.clearRect(0, 0, FACE.w, FACE.h);
      var face = FACES[expr] || FACES.neutral;

      if (face.eyes === "open") {
        /*
         * 眨眼是在"表情自带的静止位置"上再压一层 —— 直接乘 `blink` 是不对的：
         * slack 那档本来就半闭，眨眼要能从半闭压到全闭，而不是从 0.3 压到 0。
         */
        var rest = face.open === undefined ? 1 : face.open;
        var open = clamp(rest - blink * rest, 0, 1);
        openEye("eyeL", open);
        openEye("eyeR", open);
      } else {
        drawSprite(face.eyes + "_eyeL");
        drawSprite(face.eyes + "_eyeR");
      }
      blush(face.blush || 0);
      drawSprite(face.mouth);
      faceDirty = false;
    }

    /* ---------- 服装 ---------- */

    function partsFor(id) {
      if (id === "maid") return model.parts;
      for (var i = 0; i < (model.outfits || []).length; i++) {
        if (model.outfits[i].id === id) return model.outfits[i].parts || model.parts;
      }
      return model.parts;
    }

    /*
     * 表情那一层。
     *
     * `face` 贴图是皮肤 + 眼窝，眼睛 / 嘴 / 腮红画在 `faceCv` 上，必须**单独一层**
     * 盖在它上面 —— 少了这一层，她就只有一张没有眼睛的脸（上游 figure.js 也是
     * 在部件表里 push 同样一条）。z 取 9：要压过 `eye_creases`（8.5）和
     * `brows`（8.6），又不能盖到刘海（13）。
     */
    var FACE_PART = {
      id: "faceFx",
      tex: "faceFx",
      z: 9,
      parent: "headFeat",
      grid: [4, 4],
      box: [U(FACE.x), V(FACE.y), FACE.w * S, FACE.h * S],
    };

    function useOutfit(id) {
      outfit = masks[id] ? id : "maid";
      defs = buildDeformers(model, outfit);
      var list = partsFor(outfit).concat([FACE_PART]);
      parts = list
        .map(function (part) {
          return buildMesh(part, defs);
        })
        .sort(function (a, b) {
          return a.z - b.z;
        });
      // 装纹理：部件表里有 `src` 的（服装）按它的路径，其余按 tex id
      list.forEach(function (part) {
        // `faceFx` 是那张画布，不加载文件（`want` 见到已有的会直接返回）
        if (part.tex !== "faceFx") want(part.tex, part.src || "tex/" + part.tex + ".png");
      });
      for (var name in model.feat.sprites) want("feat:" + name, "feat/" + name + ".png");
      want("feat:eyeL_ball", "feat/eyeL_ball.png");
      want("feat:eyeL_iris", "feat/eyeL_iris.png");
      want("feat:eyeL_lash", "feat/eyeL_lash.png");
      want("feat:eyeR_ball", "feat/eyeR_ball.png");
      want("feat:eyeR_iris", "feat/eyeR_iris.png");
      want("feat:eyeR_lash", "feat/eyeR_lash.png");
      stats.parts = parts.length;
      faceDirty = true;
      layout();
    }

    /* ---------- 布局 / 区域 ---------- */

    function maskOf() {
      return masks[outfit] || masks.maid;
    }

    /**
     * 把 rig 放大到窗口里：底部居中，脚底留 18 px 给"站在桌面上"的感觉。
     * 上限 1.55 是手感值 —— 再大她的头就会顶到气泡。
     *
     * `sizeScale` 是配置里的「大小」：窗口尺寸是平台定的（出厂 420×340），而一只
     * 占满整扇窗口的宠物在桌面上太大了，所以再乘一个用户可调的系数。整个
     * 缩放链路只有 `view.k` 这一个数：轮廓（`region`）、气泡位置（`artBox`）
     * 都从它算出来，改它一个就全都跟着走。
     */
    function layout(w, h, dpr) {
      if (w) view.w = w;
      if (h) view.h = h;
      if (dpr) view.dpr = dpr;
      var box = maskOf().box;
      var fit = clamp(
        Math.min(1.55, (view.h - 96) / box[3], (view.w - 40) / box[2]),
        0.5,
        1.8,
      );
      view.k = clamp(fit * sizeScale, 0.25, 2);
      /*
       * 再夹一次：`sizeScale` 大于 1 时上面那个 1.55 / 减 96 的余量就不作数了，
       * 她的头顶会跑出画布上边界（画不出来、也不在区域里，看着"断头"）。
       * 这一道按"整只装得下"算，和用户怎么拧无关。
       */
      view.k = Math.min(view.k, (view.h - 18) / box[3], view.w / box[2]);
      view.ox = view.w / 2 - (box[0] + box[2] / 2) * view.k;
      view.oy = view.h - 18 - (box[1] + box[3]) * view.k;
    }

    /** 窗口区域：静止轮廓 × 当前布局。坐标是窗口 CSS 像素 */
    function region() {
      var k = view.k;
      var runs = maskOf().runs.map(function (run) {
        return {
          kind: "rect",
          x: Math.round(view.ox + run[0] * k),
          y: Math.round(view.oy + run[1] * k),
          w: Math.max(1, Math.round(run[2] * k)),
          h: Math.max(1, Math.round(run[3] * k)),
        };
      });
      // 影子伸到脚的两侧去了，轮廓那几块盖不住它，单独补一块
      var s = shadowBox();
      var pad = 4;
      runs.push({
        kind: "rect",
        x: Math.round(s.cx - s.rx - pad),
        y: Math.round(s.cy - s.ry - pad),
        w: Math.max(1, Math.round(s.rx * 2 + pad * 2)),
        h: Math.max(1, Math.round(s.ry * 2 + pad * 2)),
      });
      return runs;
    }

    /** 她实际占的那块（不含区域余量），CSS 像素：气泡要贴在它上面 */
    function artBox() {
      var box = maskOf().box;
      return {
        x: view.ox + box[0] * view.k,
        y: view.oy + box[1] * view.k,
        w: box[2] * view.k,
        h: box[3] * view.k,
      };
    }

    /* ---------- 每帧 ---------- */

    /**
     * 脚底那圈影子。
     *
     * 她是从壁纸上"裁"出来的一只：身体本身不能有投影（区域之外不存在），于是
     * 她就真的像一张贴纸贴在那儿。上游的 Coo 也是这么解决的 —— `body.js` 在
     * 她脚下画一个压扁的椭圆（`shadowEl`），人眼一看到这块接触面，就认"她站在
     * 桌面上"，而不是"她浮在壁纸前面"。
     *
     * 颜色只有黑 + 透明度（径向渐变），所以深浅两种壁纸都成立，不用跟着主题变。
     * 位置跟着 `view.k` 走：她调大调小、换窗口尺寸，影子一起变。
     */
    function shadowBox() {
      var k = view.k;
      var box = maskOf().box;
      var w = box[2] * k;
      return {
        cx: view.ox + (box[0] + box[2] / 2) * k,
        // 她的脚底在 `view.h - 18`：影子压在脚线上下各几像素，才像"踩在地上"
        cy: view.h - 20,
        rx: w * 0.34,
        ry: Math.min(9, Math.max(3.5, w * 0.045)),
      };
    }

    function drawShadow() {
      var s = shadowBox();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.scale(1, s.ry / s.rx);
      var grad = ctx.createRadialGradient(0, 0, s.rx * 0.12, 0, 0, s.rx);
      grad.addColorStop(0, "rgba(0, 0, 0, 0.30)");
      grad.addColorStop(0.55, "rgba(0, 0, 0, 0.15)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, s.rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function buildState(dt) {
      var t = clock;
      var brisk = clamp(motion.speed / 60, 0, 1);
      var swing = clamp(-motion.speed * 0.03 - motion.lift * 0.02, -1.6, 1.6);

      var hair = spring.hair.step(swing * 1.1 + (motion.walking ? -0.25 : 0), dt);
      var hairY = spring.hairY.step(swing * 0.5, dt);
      var bangs = spring.bangs.step(swing * 0.8, dt);
      var skirt = spring.skirt.step(swing * 0.8 + (motion.walking ? -0.2 : 0), dt);
      var skirtY = spring.skirtY.step(motion.dragging ? 0.8 : 0, dt);
      var tailAngle = spring.tail.step(
        swing * 12 + 6 * Math.sin(t * (1.1 + 1.8 * brisk)) + 2 * Math.sin(t * 0.7),
        dt,
      );
      var fins = spring.fins.step(3 * Math.sin(t * 1.6) + 4 * skirt, dt);
      var ahoge = spring.ahoge.step(6 * Math.sin(t * 1.9) + 8 * skirt, dt);
      var headTilt = spring.head.step(clamp(swing * 6, -16, 16), dt);

      // 呼吸：上下 1%，横向反着来，看起来才是"有体积"
      var breath = Math.sin(t * 1.9) * 0.01;
      st.body = { a: 0, sx: 1 - breath, sy: 1 + breath };
      st.waist = { a: 0 };
      st.neck = { a: headTilt * 0.5 };
      st.legFront = { a: motion.walking ? Math.sin(motion.phase) * 13 : 0 };
      st.legBack = { a: motion.walking ? -Math.sin(motion.phase) * 11 : 0 };
      st.armNear = { a: motion.walking ? Math.sin(motion.phase) * 8 : 0 };
      st.armFar = { a: motion.walking ? -Math.sin(motion.phase) * 8 : 0 };
      st.tail = { a: tailAngle };
      st.tailBend = { fn: warpField(tailAngle * 0.3, 0) };
      st.finNear = { a: -fins * 0.4 };
      st.finFar = { a: fins * 0.3 };
      st.ahoge = { a: ahoge * 0.6 };
      st.bangsSway = { fn: warpField(bangs * 2.4, 0, 1) };
      st.hairSway = { fn: warpField(hair * 5, hairY * 6, 0.6) };
      st.skirt = { fn: warpField(skirt * 3.2, skirtY * 2.4, 0.4) };
      st.skirtSit = { fn: warpField(skirt * 2.2, skirtY * 1.6, 0.4) };
      // 头部四层视差：越靠前的动得越多
      st.headBack = { fn: warpField(-headTilt * 0.18, 0) };
      st.headMid = { fn: warpField(headTilt * 0.22, 0) };
      st.headFeat = { fn: warpField(headTilt * 0.26, 0) };
      st.headFront = { fn: warpField(headTilt * 0.34, 0) };
      st.brows = { fn: warpField(0, 0) };
      st.creases = { fn: warpField(0, 0) };
      // 服装自带的变形器直接跟着身体走
      for (var key in defs) {
        if (st[key]) continue;
        if (defs[key].kind === "rot") st[key] = { a: headTilt * 0.2 };
        else if (defs[key].kind === "warp") st[key] = { fn: warpField(0, 0) };
      }

      /*
       * 各部件的不透明度。
       *
       * 部件表里同时有"站着"和"坐着"两套裙子 / 腰带 —— 它们不是两个版本的备份，
       * 而是要按姿势择一显示的两层。不写这份表，两层都按 1 画：站着的时候
       * 坐着的那条裙子叠在站着的裙子上，看起来像穿了两条裙子。
       *
       * 眼睑褶皱（`eye_creases`）同理：它的透明度本该跟着睁眼程度走，我们不画
       * 那条线，就整层关掉，否则脸上会平白多一道。
       */
      st.alpha = {
        skirt_sit: 0,
        waist_bow_sit_front: 0,
        eye_creases: 0,
      };

      // 眨眼：20% 概率短眨（接上一拍），否则 2.2–5.2 秒一次
      blinkAge += dt;
      if (blinkAge >= blinkNext) {
        blinkAge = 0;
        blinkNext = Math.random() < 0.2 ? 0.28 : 2.2 + Math.random() * 3;
      }
      var wasClosed = blink > 0.02;
      blink = blinkAge < 0.16 ? Math.sin((Math.PI * blinkAge) / 0.16) : 0;
      /*
       * 眨眼的中间帧也要重画。只在这一下结尾标脏的话，画布会停在"眼睛睁着"的
       * 那一帧上 —— 看起来就是"眨眼没反应"。一次眨眼不到 0.16 秒，重画十来张
       * 390×252 的画布，代价可以忽略。
       */
      if (blink > 0 || wasClosed) faceDirty = true;
    }

    /** 位移场：横向按 v 加权（下半截留在原地），纵向按 v² 收尾 */
    function warpField(dx, dy, curve) {
      var weight = curve === undefined ? 0.6 : curve;
      return function (u, v) {
        var k = weight + (1 - weight) * v;
        return [dx * k, dy * v * v + dy * 0.15 * v];
      };
    }

    function triangle(image, dest, uv, imgW, imgH) {
      var u0 = uv[0];
      var u1 = uv[1];
      var u2 = uv[2];
      var sx1 = u1[0] - u0[0];
      var sy1 = u1[1] - u0[1];
      var sx2 = u2[0] - u0[0];
      var sy2 = u2[1] - u0[1];
      var det = sx1 * sy2 - sx2 * sy1;
      if (Math.abs(det) < 1e-8) return;
      var dx1 = dest[1][0] - dest[0][0];
      var dy1 = dest[1][1] - dest[0][1];
      var dx2 = dest[2][0] - dest[0][0];
      var dy2 = dest[2][1] - dest[0][1];
      var a = (dx1 * sy2 - dx2 * sy1) / det;
      var b = (dy1 * sy2 - dy2 * sy1) / det;
      var c = (sx1 * dx2 - sx2 * dx1) / det;
      var d = (sx1 * dy2 - sx2 * dy1) / det;
      var e = dest[0][0] - a * u0[0] - c * u0[1];
      var f = dest[0][1] - b * u0[0] - d * u0[1];

      ctx.save();
      ctx.beginPath();
      // 顶点往外扩 0.35 像素：不扩的话三角形之间会有发丝一样的缝
      var cx = (dest[0][0] + dest[1][0] + dest[2][0]) / 3;
      var cy = (dest[0][1] + dest[1][1] + dest[2][1]) / 3;
      for (var i = 0; i < 3; i++) {
        var px = dest[i][0];
        var py = dest[i][1];
        var distance = Math.hypot(px - cx, py - cy) || 1;
        var grow = 0.35 / distance;
        var nx = px + (px - cx) * grow;
        var ny = py + (py - cy) * grow;
        if (i === 0) ctx.moveTo(nx, ny);
        else ctx.lineTo(nx, ny);
      }
      ctx.closePath();
      ctx.clip();
      ctx.transform(a, b, c, d, e, f);
      ctx.drawImage(image, 0, 0, imgW, imgH);
      ctx.restore();
    }

    function draw(dt) {
      stats.frames++;
      var k = view.k;
      var dpr = view.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // 影子先落，她再站上去（同一帧里影子永远在最底下）
      drawShadow();
      // rig 单位直接当 CSS 像素用，再乘 dpr 落到设备像素
      ctx.setTransform(k * dpr, 0, 0, k * dpr, view.ox * dpr, view.oy * dpr);
      /*
       * `high` 不是细节，是"别糊"：canvas 默认的 `low` 在缩小时只做双线性，
       * 头发、睫毛这种细线会丢掉半条。她又被缩到 0.85–1.3 之间，正好落在
       * 最吃这个设置的那一段。
       */
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      for (var i = 0; i < parts.length; i++) {
        var mesh = parts[i];
        var image = images[mesh.tex];
        if (!image) continue;
        /*
         * 透明度：`st.alpha` 是这一帧说了算的（姿势决定哪一层在），没有就退回
         * 部件自带的 `alpha`。0 的层直接跳过 —— 画一遍再乘 0 等于白花一次
         * 网格计算，26 个部件里有两个是恒 0 的。
         */
        var alpha = st.alpha && st.alpha[mesh.id];
        if (alpha === undefined) alpha = mesh.alpha;
        if (!(alpha > 0.002)) continue;
        ctx.globalAlpha = alpha > 1 ? 1 : alpha;
        var warped = mesh.warped;
        for (var v = 0; v < mesh.vertices.length; v++) {
          var point = applyChain(defs, mesh.chain, st, mesh.vertices[v][0], mesh.vertices[v][1]);
          warped[v][0] = point[0];
          warped[v][1] = point[1];
        }
        var imgW = image.naturalWidth || image.width;
        var imgH = image.naturalHeight || image.height;
        for (var t = 0; t < mesh.triangles.length; t++) {
          var tri = mesh.triangles[t];
          triangle(
            image,
            [warped[tri[0]], warped[tri[1]], warped[tri[2]]],
            [
              [mesh.vertices[tri[0]][2] * imgW, mesh.vertices[tri[0]][3] * imgH],
              [mesh.vertices[tri[1]][2] * imgW, mesh.vertices[tri[1]][3] * imgH],
              [mesh.vertices[tri[2]][2] * imgW, mesh.vertices[tri[2]][3] * imgH],
            ],
            imgW,
            imgH,
          );
        }
      }
      ctx.globalAlpha = 1;
    }

    /* ---------- 对外 ---------- */

    useOutfit("maid");

    return {
      stats: stats,
      layout: layout,
      region: region,
      artBox: artBox,
      outfit: function () {
        return outfit;
      },
      setOutfit: function (id) {
        useOutfit(id);
      },
      /** 配置里的「大小」。真的变了才返回 true（外面据此重算轮廓 / 气泡位置） */
      setScale: function (value) {
        var next = clamp(Number(value) || 1, 0.4, 1.6);
        if (Math.abs(next - sizeScale) < 0.001) return false;
        sizeScale = next;
        layout();
        return true;
      },
      scale: function () {
        return sizeScale;
      },
      setExpression: function (name) {
        if (!FACES[name] || name === expr) return;
        expr = name;
        faceDirty = true;
      },
      expression: function () {
        return expr;
      },
      setMotion: function (next) {
        if (next.walking !== undefined) motion.walking = !!next.walking;
        if (next.speed !== undefined) motion.speed = Number(next.speed) || 0;
        if (next.phase !== undefined) motion.phase = Number(next.phase) || 0;
        if (next.dragging !== undefined) motion.dragging = !!next.dragging;
        if (next.lift !== undefined) motion.lift = Number(next.lift) || 0;
      },
      tick: function (dt) {
        clock += dt;
        buildState(dt);
        if (faceDirty) paintFace();
        draw(dt);
        return stats;
      },
      /** 贴图齐了没有（第一帧之后才算齐，缺的会进 stats.missing） */
      ready: function () {
        var total = 0;
        var have = 0;
        for (var i = 0; i < parts.length; i++) {
          total++;
          if (images[parts[i].tex]) have++;
        }
        return total > 0 && have === total;
      },
    };
  }

  global.__PetFigure = { create: create };
})(window);
