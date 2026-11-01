/**
 * 桌宠窗口的入口（LAT-0041）。
 *
 * 和 `main.tsx` / `assistantMain.tsx` 一样是**独立入口**：主入口会拉起整个平台外壳
 * （画布、面板、桌面同步、agent 桥）。这一扇窗只要一块画布 —— 装不下的东西越多，
 * "谁在改状态"的边界就越容易糊掉。
 *
 * # 它不是组件
 *
 * 这里没有 `bridge.ts`、没有权限、没有 manifest、没有沙箱 iframe。这个窗口是
 * **平台自己的一扇窗**，和 assistant 小窗、听写浮钮、对齐参考线同一类东西。
 * 皮肤是数据（`pets/<id>/pet.json`），不跑代码 —— 所以这里也不需要"组件那套"。
 *
 * # 这一版做到哪
 *
 * 读皮肤 → 画一帧静止姿态（含五官）→ 算轮廓报给平台（点得透、点得到）→
 * 跟着姿态换脸 → 点她做皮肤声明的那个动作。
 * **动画（弹簧、变形器、走路、眨眼）是下一片**；这一片先把
 * "平台功能真的在桌面上站起来了"这件事做实。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  DEFAULT_SCALE,
  expressionFor,
  fit,
  partsFor,
  unionBox,
  type PetModel,
  type PetRegionPart,
} from "./runtime/pet/model";
import { paintFace } from "./runtime/pet/face";
import { drawPose, loadTextures, measureRegion } from "./runtime/pet/rig";

/** `pet_boot` 的返回。和 Rust 那边的 `PetBoot` 一一对应。 */
interface PetBoot {
  state: { rect: { w: number; h: number }; scale: number };
  skin: {
    id: string;
    render: string;
    data: string;
    w: number;
    h: number;
    portrait: string | null;
    postures: Array<string | null>;
    actions: Array<{ gesture: string; action: string }>;
    ignored: string[];
  };
}

/**
 * 皮肤资源的基地址。
 *
 * Windows / Android 上 Tauri 把自定义 scheme 挂在 `http://<scheme>.localhost/`，
 * 其它平台才是 `<scheme>://localhost/`。写错了的症状不是报错，是画布一片空白
 * （贴图全部 `onerror`），所以和 `registry.ts::widgetSchemeBase` 用同一套判断。
 */
function skinBase(): string {
  const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return windows ? "http://lattice-pet.localhost/" : "lattice-pet://localhost/";
}

function canvasOf(): HTMLCanvasElement {
  const canvas = document.getElementById("pet");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("missing #pet");
  return canvas;
}

/**
 * 把算好的轮廓报给平台。
 *
 * **坐标是物理像素**（`desktop::RegionPart` 那个口径），所以要乘 DPI ——
 * 报逻辑像素的症状是高 DPI 屏上只有左上角那一小块能点。
 */
async function pushRegion(parts: PetRegionPart[], dpr: number): Promise<void> {
  const physical = parts.map((part) => ({
    kind: "rect" as const,
    x: Math.round(part.x * dpr),
    y: Math.round(part.y * dpr),
    w: Math.max(1, Math.round(part.w * dpr)),
    h: Math.max(1, Math.round(part.h * dpr)),
  }));
  await invoke("pet_set_region", { parts: physical });
}

async function main(): Promise<void> {
  const boot = await invoke<PetBoot | null>("pet_boot");
  // 没有可用皮肤：平台那边也不会建窗，走到这儿只可能是皮肤在启动后被删了。
  // 报一个空轮廓 —— 一块透明的、点得透的区域，比一块吃点击的空白好。
  if (!boot) {
    await invoke("pet_set_region", { parts: [] });
    return;
  }

  const base = `${skinBase()}${boot.skin.id}/`;
  const response = await fetch(`${base}${boot.skin.data}`);
  if (!response.ok) {
    console.error(`[pet] could not load ${boot.skin.data}: ${response.status}`);
    return;
  }
  const model = (await response.json()) as PetModel;
  const parts = partsFor(model);
  const { textures, missing } = await loadTextures(base, parts, model.feat);
  if (missing.length > 0) {
    // 少一张不致命，但一定要留痕：症状是"她少了半边"，而那种问题没人报得清。
    console.warn(`[pet] ${missing.length} texture(s) missing:`, missing);
  }

  const canvas = canvasOf();
  const scale = Number.isFinite(boot.state.scale) ? boot.state.scale : DEFAULT_SCALE;

  // 当前那张脸。`null` = 这份皮肤没有表情层，那就只画部件。
  let face = paintFace(model, textures, expressionFor(boot.skin.postures, "idle") ?? "neutral");

  const render = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 之后所有绘制都在 CSS 像素里，不用到处乘 dpr
    ctx.scale(dpr, dpr);

    drawPose(ctx, parts, textures, fit(unionBox(parts), width, height, scale), face);

    void pushRegion(measureRegion(parts, textures, width, height, { scale, face }), dpr);
  };

  render();

  // 窗口尺寸变了（换皮肤、换 DPI）就整条重来一遍 —— 轮廓和拟合都跟着窗口走
  window.addEventListener("resize", render);

  /**
   * 姿态换了就换脸。
   *
   * **换脸必须重画整帧**：表情层是 z=9 的一个部件，它变了但别的没变 ——
   * 只重画表情会留下上一张脸的残影（画布是 clearRect 之后再画的）。
   *
   * 轮廓也顺带重算：`surprised` 的眼睛比 `neutral` 大一圈，理论上会顶出边界。
   * 实测顶不出去，但"理论上"这三个字不该出现在点击区域的判据里。
   */
  const applyPosture = (posture: string): void => {
    document.documentElement.dataset.posture = posture;
    const next = expressionFor(boot.skin.postures, posture);
    if (!next) return;
    const painted = paintFace(model, textures, next);
    if (!painted) return;
    face = painted;
    render();
  };

  await listen<{ posture: string }>("lattice:presence", (event) => {
    applyPosture(event.payload.posture);
  });

  const now = await invoke<{ posture: string }>("presence_get").catch(() => null);
  if (now) applyPosture(now.posture);

  /*
   * 点她 = 做皮肤为 `click` 声明的那个动作。
   *
   * **动作名来自皮肤数据**，所以这里只负责查表转发；白名单在 Rust 那边
   * （`pet::pet_act`）—— 皮肤能表达的是"我想让她被点时干什么"，不是"我能调
   * 平台的哪个能力"。
   *
   * 只认 `click`，不认 `doubleClick`：一次双击会先触发两次 click，两套手势
   * 同时声明就会两个动作都跑。等动画那一层有了拖拽，再一起处理手势的互斥。
   */
  window.addEventListener("click", () => {
    const action = boot.skin.actions.find((entry) => entry.gesture === "click")?.action;
    if (!action || action === "none") return;
    void invoke("pet_act", { action }).catch((error: unknown) => {
      console.error(`[pet] action "${action}" failed:`, error);
    });
  });
}

void main().catch((error: unknown) => {
  console.error("[pet] boot failed:", error);
  // 启动失败也要把轮廓清空：一块透明的空窗比一块吃点击的空白好
  void invoke("pet_set_region", { parts: [] }).catch(() => {});
});
