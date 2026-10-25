---
status: draft
date: 2026-10-25
code: src-tauri/src/assistant_window.rs, src-tauri/src/desktop.rs, src/platform/AssistantWindow.tsx, src/runtime/assistant-window.ts, src/assistantMain.tsx, src/assistant-window.css
---

# 0007 —— assistant 上桌面：位置、底板、锁与缩放

> 用户的诉求原文：**"这个 agent 的面板要支持放在桌面，背景还跟其他组件一样可以调节，还可以固定放大缩小之类的"**。
> 三件事：① 它能待在**桌面那一层**（跟着壁纸、被应用窗口盖住），而不是只能浮在上面；
> ② 底板**跟组件同一套 appearance**（tint / alpha / blur）；③ 能**锁住、能拖边放大缩小**。
> 这三件事都不碰组件协议，但都碰窗口行为与一份落盘文件，所以先写这一份。

## 1. 问题

今天 `assistant_window.rs` 把窗口钉死在一种形态：`resizable(false)`、`decorations(false)`、
`always_on_top(false)`、固定 `400 × 580`、只能拖标题栏。它是一块**浮窗** ——

- **它不在桌面那一层**。Win+D / 点任务栏右下角之后，桌面上的卡片都还在，它跟着缩下去；
  而用户把它当"桌面的一部分"用（一边看它一边动壁纸上的组件）。
- **底板是死的不透明面板**，而组件有 appearance（`runtime/appearance.ts`：tint / alpha / blur，
  三层是 canvas 壁纸 + veil + 内容）。用户要的是"跟组件一样能调"—— 同一套控件、同一套语义，
  包括"出厂外观下不覆盖任何令牌"（不变量 6）。
- **不能缩放**。`400×580` 是为"六七轮对话 + 输入框"排的，但有人在桌面上想把它拉成一条窄边，
  也有人想拉到 900 宽看代码块。自绘 resize 这套交互组件那边已经有了（`widgetHost.ts`）。
- **没有锁**。放在桌面上之后，拖它/拖边很容易失手；主窗口的卡片有锁（`locked`），它没有。

## 2. 候选

| | A：做成 placement（进 store 的布局） | B：窗口自己有两种模式（浮窗 / 桌面）+ 自带 appearance | C：只加"置顶 + 可缩放" |
| --- | --- | --- | --- |
| 做法 | `kind: "assistant"` 的 placement，画布上能摆、属性面板能调、`runner` 负责建窗口 | 一颗模式按钮；桌面模式走 `desktop::apply_to(Desktop, interactive)`，外观/尺寸/锁存在 `assistant-window.json` v2 | 保持浮窗，只加 `resizable` 与 `always_on_top` |
| 复用 | 投放、锁定、外观控件、缩放手柄全都现成 | 复用手柄交互、appearance 模块与 `widget_wallpaper`，状态独立 | 几乎没有复用 |
| 代价 | placement 的每个消费者都假设 `widgetId` → 清单/授权/`configs`/`grants`；assistant 没有包、没有清单，也不该有组件权限。`buildSpecs` / `runner` / `Canvas` / `Inspector` / `partialize` 至少五处要开分支，且"能装能卸"的语义对它不成立（卸掉 assistant？） | 一份新状态文件 + 两条命令 + 自绘手柄；窗口行为要自己维护 | 没解决用户说的"放在桌面" |
| 结论 | 否 | **选它** | 否 |

A 否得再补一句：`runner` 的窗口表是按 placement 生成的，assistant 的对话在**它自己窗口的内存里**。
把它的生死交给布局数据，等于把"聊到一半"挂在一次布局同步上。

## 3. 决定

**两种模式，同一个窗口，不重建。**

> **2026-10-25 补：标题栏那颗切换按钮删了。** 用户原话："那个放大窗口是没用的，可以删除了"
> —— 它长在最大化该在的位置（`▢`，`×` 左边），也长得像最大化，按下去却是把窗口换一层。
> 一个按钮最糟的错就是"看着像另一件事"。`mode` 仍然照 `assistant-window.json` 读、仍然
> 决定窗口层级（标题栏那颗药丸写着当前是哪一档），**只是界面上不再有入口**。
> 要加回来就换个样子：底板面板里一行开关就够，别放回标题栏。

| | 浮窗（默认，现状） | 桌面 |
| --- | --- | --- |
| 层级 | 普通窗口（不置顶） | `desktop::apply_to(Desktop, click_through: false, interactive: true, Rect)` |
| 焦点 | 能打字 | **也能打字** |
| 面板 | 现状 | 同左 |
| `Ctrl+K` | 开关它 | 开关它（模式不变） |

**桌面模式必须走 `interactive: true` 那条路，不能挂 WorkerW。** `desktop.rs` 开头就写着：
`SetParent` 到 WorkerW 之后窗口"连激活的资格都没有"，WebView2 拿不到键盘焦点 ——
对一个**聊天框**来说那是致命的（光标会闪，敲的字全进了后面的窗口）。
`interactive: true` 的做法是"`HWND_BOTTOM` 的普通窗口 + 底层守卫"：能被点、能打字，
失焦之后被守卫压回最底层，视觉上就是贴在桌面上。这是这个功能最重要的一条技术判断。

**切换模式不需要重建窗口**，因为这两条都是**事后可改**的窗口属性：

```
桌面：  desktop::install_guard(hwnd)（一次） → apply_to(Desktop, false, true, Rect)
浮窗：  desktop::set_sink(hwnd, false) → show + set_focus（之后再点它会正常升到前面）
```

`always_on_top` 必须在建窗口时定（那条坑写在 `runner::create` 里），所以**浮窗模式不置顶** ——
`Ctrl+K` 已经会 `set_focus()`。不重建的第二个好处：**对话一行都不丢**。

**底板（appearance）**：`{tint, alpha, blur}`，语义与组件完全一致（`runtime/appearance.ts`
的 `normalizeAppearance` / `isPlainAppearance` / `luminance`，上限 `MAX_BLUR = 40`）。
出厂值 `auto / 1 / 0` = 不覆盖任何令牌、不截图、和今天的窗口一像素不差（不变量 6）。
三层和 `widgetHost.ts` 同一秩序：`canvas`（`widget_wallpaper`，`pad = MAX_BLUR × 2`）→ `veil`
（`rgba(tint, alpha)`）→ 内容。控件放在标题栏那颗"底板"按钮里（浮窗与桌面都有）：
**一个明暗开关**（`runtime/appearance.ts::isDarkTint`）+ 浓度 + 模糊，和属性面板的语义一一对应。
开关只表达方向（亮着 = 深色底），**不去动它就是跟随主题** —— 出厂值本来就是 `auto`，
第三档不必再摆一颗药丸；原来那三颗（auto / dark / light）在 224px 的板子里挤成了
"Dar k" / "Ligh t" 两行。

**锁与缩放**：

- `locked`：拖标题栏与拖边都失效（光标也不该变成可拖）。锁的是**位置与尺寸**，不锁内容。
  和组件的 `locked` 同一句话。
- 缩放：8 个方向里先做**右 / 下 / 右下**三个手柄，按下去调系统的
  `startResizeDragging('East' | 'South' | 'SouthEast')`。
  最小 `320 × 420`（再小输入框放不下），上限不设、但**每次应用都夹进当前屏工作区**。
  尺寸的权威在 Rust（`Resized` → `schedule_save` 合并 400ms 写盘）；页面只在 `resize`
  停 200ms 后补截一张壁纸（canvas 铺的是 `innerWidth + pad × 2`）。

  这一条在真机上**改了三轮**，三个坑各自独立，读的人别只记住最后一个：

  1. **页面自己逐帧 `setSize` 不行**。手柄贴在右 / 下边缘，光标往想要的方向挪 1px 就已经在
     客户区之外，而 `pointermove` 只在客户区内派发 —— 第一帧还没到，缩放就断了。
  2. **窗口必须 `resizable(true)`**。Windows 上不可调整的窗口没有 `WS_THICKFRAME`，
     `startResizeDragging`（`WM_NCLBUTTONDOWN` + `HTBOTTOMRIGHT`）什么都不做，按下去等于
     按在一块石头上。原来写 `false` 是怕系统边框和自绘手柄打架 —— 实测不打架：
     `decorations(false)` 之下没有可见边框，两个入口都落到同一条 `Resized` 上。
     顺手 `.min_inner_size(320, 420)`：拖边那条路根本不过页面，下限得让系统也认一遍。
  3. **圆角区域必须按外框裁**（`clip_rounded_current`）。`SetWindowRgn` 用的是窗口坐标，
     拿客户区尺寸当宽度就会把右边 16px、下面 9px 裁到区域之外 —— 那块正好压在页面的
     手柄上，**症状不是报错，是按下去掉到下面的窗口里**（`WindowFromPoint` 会指到主窗口）。

  手柄留 `12px` 宽不是随手定的：外圈那 4px（`SM_CXFRAME`）被 `tauri-runtime-wry` 的
  `TAURI_DRAG_RESIZE_BORDERS` 覆盖层吃掉（它专门给无边框窗口做系统拖边），里侧必须还有
  一截能收到 `pointerdown` —— 6px 的手柄在那条带上等于没有。
- 尺寸与位置一起存在 `assistant-window.json` v2，拖动/缩放**松手时存一次**（不是每一帧写盘）。

**拖标题栏走原生拖动区，不走 JS。** 标题栏带 `data-tauri-drag-region`（锁上时**不渲染**这个属性），
由 Tauri 自己在 `mousedown` 上起拖；位置也不再由页面在松手时补一次 IPC —— Rust 监听 `Moved` / `Resized`，
400ms 内没有新事件才写盘（`schedule_save`）。三条理由：

1. 拖动是"按下就跟着走"的手感，走 JS 要先进一次 IPC（`startDragging`），任何一次往返抖动都会被用户当成"拖不动"；
2. "按住拖、拖完立刻退出"这种序列，在页面里存就有一拍存不上；窗口自己监听坐标变化则一定落在最后一拍；
3. 锁只有一个判据：属性渲不渲染。页面里不写 `if (locked) return` —— 两处判据迟早有一处漏。

两个容易踩的细节：`data-tauri-drag-region` 只认**事件目标那一层**有没有这个属性，所以标题栏里的字必须
`pointer-events: none`（否则按在标题上就拖不动，而标题恰好是标题栏面积最大的一块）；锁上时手柄与拖动区
一起消失，光标也不该变成可拖。

**落盘（v2）**

```json
{
  "version": 2,
  "mode": "floating",                        // floating | desktop
  "rect": { "x": 1200, "y": 700, "width": 400, "height": 580 },   // 逻辑像素
  "appearance": { "tint": "auto", "alpha": 1, "blur": 0 },
  "locked": false
}
```

v1 的 `{x, y}` 就地升级：`mode: floating`、尺寸取默认、外观出厂、`locked: false`，位置照用。
坏文件当"没有记录"（落右下角），不让它拦住窗口。

## 4. 接口与数据

```
assistant_window_state()                  → AssistantWindowState（v2 全量，面板开局读一次）
assistant_window_mode(mode)               → AssistantWindowState（切换 + 应用层级 + 存盘）
assistant_window_appearance(appearance)   → AssistantWindowState（归一化后存盘，非法值退回出厂）
assistant_window_locked(locked)           → AssistantWindowState
assistant_window_save_rect(rect)          → AssistantWindowState（`{x, y, width, height}`，松手时存；夹紧在 Rust 侧再判一次）
```

`assistant_window_save_pos` 保留原名，但**页面已经不调它了**：拖动与缩放由窗口自己监听 `Moved` / `Resized` 记（见上），它只留作"显式保存一次"的逃生门，存的也是**位置与尺寸**。`assistant_window_toggle` / `_hide` 保持原样。**Rust 是唯一真源**：前端每次改完都拿返回值覆盖本地状态，
不在两处各攒一份（和 `assistant_hands*` 同一条）。前端纯逻辑放 `runtime/assistant-window.ts`：
`DEFAULT_ASSISTANT_WINDOW`、`MIN_W` / `MIN_H`、`clampRect(rect, work)`、`migrateAssistantWindow(raw)`
（v1 → v2、坏值逐项退回）—— 纯函数，`tests/assistant-window.html` 钉着。

**不动的东西**：`state.json`（它归布局）、组件桥、`placement`、`runner`、`configs`/`grants`。
assistant 仍然是"平台的一部分，不是组件"（`assistant_window.rs` 开头那条）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 桌面模式下点了它却打不了字 | 走了挂 WorkerW 那条路（本设计的头号已知坑） | 只用 `interactive: true`；真机上第一件事就是点输入框敲两个字 |
| 桌面模式下它跑到别的应用上面去了 | 底层守卫没装上 / 装在了错的线程 | `install_guard` 只能在窗口自己的线程上调；切模式时先装守卫再落层级（顺序见 `apply_to` 注释） |
| 切到浮窗之后它还沉在底下 | 只翻了守卫开关，没让它升上来 | 切回浮窗：`set_sink(false)` + `show` + `set_focus`，用户下一次点击就正常 |
| 拖手柄完全没反应（尺寸不变） | 页面自己逐帧 `setSize`，而 `pointermove` 在客户区外就没了 —— 第一帧就没到 | 交给系统：`startResizeDragging(direction)` + 权限 `core:window:allow-start-resize-dragging` |
| 手柄画着、按下去窗口**完全不动**，鼠标像点在下面的窗口上 | 圆角区域用了客户区尺寸（`SetWindowRgn` 要的是外框），右边 16px / 下面 9px 被裁到区域外，那块在系统看来「没有窗口」 | `clip_rounded_current(hwnd, radius)` 现量 `GetWindowRect` 再裁；`Resized` 之后也要重裁一次 |
| 缩放正常，但右下角的圆角不见了 | 区域记的是建窗口时那个尺寸 | `Resized` 里 `reclip()`（区域是快照，不是跟随） |
| 缩放之后输入框被挤没 / 溢出 | 内容没有最小高度，或者窗口尺寸没夹紧 | 面板是 flex 列，输入框 `min-height`；`clampRect` 在前后端各判一次 |
| 锁上了还能拖 | 只拦了标题栏，没拦手柄 | 锁是**一处判据**：`locked` 为真时 `startDragging` 与手柄都不挂处理器 |
| 多屏 / 换 DPI 之后窗口飞到屏幕外 | 存的是逻辑像素，换屏后工作区变了 | 每次应用前 `clampRect(工作区)`；读不到屏幕就退回默认角落 |
| 底板开到最大模糊，边缘露一圈没糊到的 | 截图 pad 不够 | `pad = MAX_BLUR × 2`（和宿主页同一个值，别各写一个） |
| 按在标题上拖不动（按在字上没反应） | `data-tauri-drag-region` 只认事件目标那一层，字把事件接走了 | 标题栏里的 `span` 一律 `pointer-events: none`（`assistant-window.css`） |
| 拖完重启，位置还是旧的 | 只在松手时存一次，而那一刻可能还没落盘 | 由 Rust 监听 `Moved` / `Resized` 合并 400ms 后写盘，页面不参与 |
| `assistant-window.json` 坏了 | 断电 / 手改 | 当"没有记录"：落右下角、默认尺寸、出厂外观；**绝不拦住窗口** |
| 切模式把对话弄丢 | 有人顺手改成"重建窗口" | 本设计不重建；真要重建时必须先落会话（`assistant_session_save`）再建 —— 写在这儿，防止以后"优化"掉 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant-window.html` | ~16 | v1→v2 迁移、坏值逐项退回、`clampRect` 夹进工作区与最小尺寸、`normalizeAppearance` 的出厂值不动令牌 |
| `src-tauri/src/assistant_window_policy.rs` | ~10 | `rustc --test`：模式字面量只有两个、rect 夹紧、v1 迁移、尺寸上下限 |
| 手工 | — | **拖动已验证**：真机上连拖四次，位移与光标一一对应（100×60 × 4），落盘的 rect 跟着变；v1 的 `{x, y}` 真文件也升成了 v2。仍待验（要等命令接线）：桌面模式下 Win+D / 被应用盖住之后还在、点它敲字能进输入框、锁上拖不动、拉右下角到 900×700 松手重启还是这个尺寸、切回浮窗对话一行没少 |

**不做的**：9 个方向的缩放手柄只做三个；不提供"反向缩放"（画面缩放）—— 那会让字体一起变大，
和"把面板拉宽"是两件不同的事，混在一起用户分不清。这两条写在这里，不是"以后再随便加"。
