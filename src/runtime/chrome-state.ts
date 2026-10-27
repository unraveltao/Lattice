/**
 * 窗饰上那两颗"位置"按钮：现在是什么、点下去变成什么
 *
 * # 为什么要把这件事抽出来
 *
 * 层级（置顶 / 贴桌面）有**两个持有者**：平台的 store（`placement.layer`，
 * 落在 `state.json` 里）和宿主页（窗饰那颗箭头按钮要画图标）。宿主页只在
 * 建窗口时从 `HostConfig` 取一次初值，之后平台改了层级，它那份副本不会自己
 * 变 —— 于是按钮画着旧图标，而点下去又是**从旧副本算新副本**，送回去的值
 * 等于没变。用户看到的是"置顶那颗按钮是死的"。
 *
 * 修法有两半：平台改层级时推一条 `lattice:widget-layer` 给宿主页
 * （`runner.rs::sync_widget_windows`），宿主页收到就认下来重画。这半边
 * 要有人判断"这条消息是不是我这一份的"——`emit_to(label)` 并不只发给那个
 * 窗口（JS 侧 `listen()` 的 target 是 `Any`，见 `runner.rs` 里
 * `AppearanceMessage` 的注释），不认的话改 A 的层级会让桌面上所有组件的
 * 窗饰一起重画。
 *
 * 抽成纯函数是为了这两件事能被钉住：**图标和提示语必须出自同一个值**
 * （拆开写就会出现"箭头说在置顶层、提示语说点一下会置顶"），以及
 * **不是我的消息一律不认**。
 *
 * # 一条不成文的约定，这里写明
 *
 * 图标说**现在在哪**（向上 = 置顶层），提示语说**点一下会去哪儿**
 * （"置顶中 —— 点击贴到桌面"）。两者方向相反是对的，别"顺手统一"。
 */

/** 窗口层级。和 `src-tauri/src/desktop.rs::WindowLayer` 一一对应 */
export type WindowLayer = "desktop" | "top";

/** 窗饰按钮长什么样：图标、是否点亮、两条可读文案（都是 i18n 的 key） */
export interface ChromeLook {
  icon: "layer-top" | "layer-desktop" | "pin" | "pinned";
  on: boolean;
  /** 悬停提示：说"点一下会怎样" */
  title: string;
  /** 无障碍名字：说"现在是什么" */
  aria: string;
}

/**
 * 层级按钮。
 *
 * `on` 和 `icon` 一起动：点亮的那颗必须正好是"我现在就在这一层"，
 * 不然用户要靠读提示语才知道自己在哪儿。
 */
export function layerLook(layer: WindowLayer): ChromeLook {
  if (layer === "top") {
    return {
      icon: "layer-top",
      on: true,
      title: "On top — click to pin to desktop",
      aria: "Send to desktop layer",
    };
  }
  return {
    icon: "layer-desktop",
    on: false,
    title: "On desktop — click to keep on top",
    aria: "Keep on top",
  };
}

/** 别针：锁住位置与大小。它和层级是两件事 —— 别针不改变窗口在谁上面 */
export function pinLook(pinned: boolean): ChromeLook {
  if (pinned) {
    return {
      icon: "pinned",
      on: true,
      title: "Position locked — click to unlock",
      aria: "Unlock position",
    };
  }
  return {
    icon: "pin",
    on: false,
    title: "Lock position and size",
    aria: "Lock position",
  };
}

/** 点一下层级按钮之后应该是什么 */
export function nextLayer(layer: WindowLayer): WindowLayer {
  return layer === "top" ? "desktop" : "top";
}

/** 点一下别针之后应该是什么 */
export function nextPinned(pinned: boolean): boolean {
  return !pinned;
}

/**
 * 平台推来的层级，认不认？
 *
 * 返回 `null` = 不是我这个实例的，别动。这条不能省：`emit_to(label)` 会送到
 * 每个窗口的 `Any` 监听器上，不比对的话，改一个组件的层级，桌面上其余组件的
 * 窗饰会跟着重画（现象是"点了一下，所有卡片闪一下"）。
 */
export function adoptLayer(
  mine: string,
  payload: { instanceId: string; layer: WindowLayer },
): WindowLayer | null {
  if (!payload || payload.instanceId !== mine) return null;
  return payload.layer === "top" ? "top" : "desktop";
}

/** 平台推来的别针，认不认？理由同上 */
export function adoptPinned(
  mine: string,
  payload: { instanceId: string; pinned: boolean },
): boolean | null {
  if (!payload || payload.instanceId !== mine) return null;
  return payload.pinned === true;
}
