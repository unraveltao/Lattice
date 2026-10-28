---
status: accepted
date: 2026-10-28
supersedes: 0035（"灰边只剩 DWM 那一层"那一条：只做 DWM 是关不掉的，见 §5）
code: src-tauri/src/assistant_window.rs, src-tauri/src/assistant_window_policy.rs, src-tauri/src/desktop.rs, src-tauri/src/lib.rs, src/runtime/assistant-window.ts, src/platform/AssistantPanel.tsx, src/styles.css, src/runtime/i18n/assistant.ts
---

# LAT-0036 —— 小窗那圈灰边真的关掉、`Ctrl+滚轮` 缩放整块面板

## 1. 问题

两件，都出在 0035 落地之后：

1. **灰边还在。** 用户原话："为什么这个窗口做出来会有一个灰色的边框，能不能去掉，就让它跟对话框一样纯色就行。" 0035 只关了 CSS 那条 `inset 0 0 0 1px` 加 DWM 那条 `DWMWA_BORDER_COLOR`，用户看到的是"改过了，边还在"。这不是没做，是**只做了几层里的一层**。落地过程中数清楚是**三层**：DWM 画的 1px、`WS_THICKFRAME` 的非客户区、以及 `SetWindowRgn` 裁圆角那一圈（第三层是验的时候才发现的，见 §3 末）。
2. **面板不能放大。** 用户原话："我需要 Ctrl 加滚轮可以实现字体放大和字体的缩小功能。" 800×600 的窗在 4K 屏上、或者离得远的时候，12px 的字读不动。而 WebView2 自带的 Ctrl+滚轮 缩放**不能直接用**：抽屉和画布是同一个 webview，`setZoom` 会把画布一起放大。

## 2. 候选

### 灰边

| | A：只补 DWM 那一层 | B：`WM_NCCALCSIZE` 归零 | C：关掉 `resizable` |
| --- | --- | --- | --- |
| 做法 | `DwmSetWindowAttribute(DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE)`（0035 已经这么做了） | 子类化窗口，`WM_NCCALCSIZE` 且 `wParam == TRUE` 时返回 0 —— 非客户区算成零，系统没有地方画那圈边 | `resizable(false)`，窗口不再有 `WS_THICKFRAME` |
| 换掉什么 | 什么都不换 | 非客户区（连带系统那条边缘拖动） | 三个自绘手柄 + `startResizeDragging` |
| 新增什么 | 无 | 一个子类过程（常驻） | 无 |
| 代价 | **Win10 上这个属性根本不存在**（`E_INVALIDARG`），且它是"画上去的颜色"，系统重排帧时会被重刷 —— 0035 只在 `create` 里调过一次，切模式就回来了 | 边缘拖动没了（客户区铺满整个窗口，`WM_NCHITTEST` 一律 `HTCLIENT`），只剩页面里三个手柄 | 窗口不可缩放 —— 把要的东西一起关掉了 |

### 缩放

| | A：`webview.setZoom()` | B：面板根上一条 CSS `zoom` | C：字号令牌（`--lattice-font-scale` + 196 处 `calc()`） |
| --- | --- | --- | --- |
| 做法 | 让 WebView2 缩整个 webview | `.lattice-assistant { zoom: var(--lattice-zoom, 1) }` | 把 assistant 那段每条 `font-size` 改成 `calc(... * var(--scale))` |
| 换掉什么 | 无 | 无 | 196 处 `font-size` |
| 新增什么 | 一条 IPC | 一条自定义属性 + 五档表 | 一条自定义属性 |
| 代价 | **抽屉和画布同一个 webview** —— 画布会跟着放大；两个容器行为不一致 | 缩放手柄 / 标题栏不跟着放大（它们在面板外面，属于窗口 chrome） | 只放大字，边距和图标不动，固定高度（标题栏 34px）会夹字；196 处改错一处不会报错 |

## 3. 决定

**灰边走 B，并保留 A。** 两层是两件不同的事：`WM_NCCALCSIZE` 决定"非客户区有多大"（Win10 / Win11 都认这条系统消息），`DWMWA_BORDER_COLOR` 决定"DWM 画不画那 1px"（只有 Win11 22000+ 有）。0035 只做了后者，所以在 Win10 上等于什么都没做；在 Win11 上也会被 `apply_mode` 的 `SetWindowPos(SWP_FRAMECHANGED)` 重刷回来。

代价写具体：**系统那条边缘拖动没了**。用户拖窗口只能靠页面里右 / 下 / 右下三个自绘手柄（它们走 `startResizeDragging`，发的是合成消息，不受 `WM_NCHITTEST` 影响）。没有补 `WM_NCHITTEST` 是因为窗口被 `SetWindowRgn` 裁了 12px 圆角，外圈 6px 的热区落在可见区域内，做太宽会吃掉标题栏的拖动热区 —— 三个手柄够用就先不加，加了反而多一个"拖到边上和拖标题栏打架"的失败面。

**第三层是验的时候才冒出来的**，记在这里因为它是同一条症状的另一半。前两层都关掉之后，真机截图里四边**还剩 1px**：像素采样显示面板内部是 `#262a32`（自己的深色底板），而最外一圈是 `#fbfaf8 / #e8e6e0`（后面的浅色文档）—— 也就是那一圈**根本不属于窗口**。三步排掉法：

1. 无头 Chrome 渲染 `assistant.html`（没有窗口、没有 DWM）→ 四边都是 `#17171d`，页面本身是铺满的 → 不是 CSS。
2. 枚举子窗口 → `WRY_WEBVIEW` / `Chrome_WidgetWin_1` / `RenderWidgetHost` 全是 `800×600` 且和窗口同原点 → 不是 WebView2 被摆歪。
3. 运行时 `SetWindowRgn(hwnd, NULL)` 清掉区域再截一次 → **内容铺到最外一像素，环没了**；再套回 `(0, 0, w+1, h+1)` → 环回来。

所以第三层是**区域边界压在窗口最外一像素上**：不透明的窗口看不出来（自己的底色盖住了），`transparent(true)` 的窗口就露馅。改法是把区域各边往外放 1px（`desktop::clip_rounded` 的 `(-1, -1, w + 2, h + 2)`）—— 多给的部分被窗口自身裁掉，不会画到别处。**这条改动是共用的**：桌面上的组件卡片走同一个 `clip_rounded`，它们也是透明窗口，同样少这一像素。

**缩放走 B。** `zoom` 在 Chromium 里的语义正好是"浏览器 Ctrl+加号"：**面板占的屏幕面积不变，内容按倍率放大，布局空间按比例缩小**。所以 1.5 倍时不会把输入卡挤出窗口 —— 这一条是量出来的，不是猜的（`.scratch/zoom-probe.html`：`flex: 1` 的子项 `clientHeight` 从 186 变 124 = 186 / 1.5，内容 `scrollHeight` 不超，红块渲染宽 100 → 150）。

**什么时候该推翻它**：

- 灰边：如果哪天 Windows 让 `DWMWA_BORDER_COLOR` 在 Win10 上也生效，`frame_proc` 就可以删了 —— 但它现在不生效，删了边会回来。
- 缩放：如果用户抱怨"放大之后缩放手柄没跟着变大"（手柄是窗口 chrome，本来就不该放大），或者要 2 倍 —— 1.5 是"800 宽里会话栏 208 占 312、对话剩 488"的实测上限，再大一档一行字断成两截，那就得先改窗口尺寸策略。

## 4. 接口与数据

**Tauri 命令**

```
方法名：assistant_window_font_scale
参数：scale: f64（归一化在 Rust 做，前端只递"下一档"）
返回：落盘之后的整份 WindowState（v4）
错误：无（写盘失败时返回内存那份）
```

**落盘格式与迁移**

`assistant-window.json` v3 → v4，只多一个字段：

```jsonc
{ "version": 4, "mode": "floating", "rect": {...}, "appearance": {...},
  "locked": false, "sidebar": true,
  "fontScale": 1.0 }        // 新增；缺字段 = 1（v3 及以前没有缩放这回事）
```

`#[serde(default = "one")]` 管 Rust 那半，`normalizeZoom(input.fontScale)` 管 TS 那半。**v1 / v2 的迁移分支一个都没动**，只在末尾多归一化一个字段。

**要改的文件**

- `assistant_window.rs`：`frame_proc` / `install_frame_proc`（子类，必须在窗口线程上装）、`hide_system_border` 记 `hr`、`apply_mode` 末尾重关一次、`WindowState` 加 `font_scale`、`normalize_state` 加一道尺寸上限、新命令。
- `assistant_window_policy.rs`：`ZOOM_STEPS` / `normalize_zoom` / `step_zoom` / `clamp_size` + 6 条测试。
- `desktop.rs`：`clip_rounded` 的区域各边放大 1px（第三层，共用给所有圆角窗口）。
- `lib.rs`：注册命令。
- `assistant-window.ts`：`ZOOM_STEPS` 镜像 / `normalizeZoom` / `stepZoom` / v4 类型与迁移。
- `AssistantPanel.tsx`：`zoom` 状态、滚轮与键盘监听、`elementFromPoint` 判落点、缩放读数。
- `styles.css`：`zoom` 一条 + 读数按钮。
- `i18n/assistant.ts`：`Zoom` / `Reset zoom`。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 灰边还在（Win11） | 只调了 `DWMWA_BORDER_COLOR`，而 `apply_mode` 的 `SetWindowPos(SWP_FRAMECHANGED)` 让 DWM 按新帧重画了一遍；`create` 里那一次早就不算了 | 子类常驻（`WM_NCCALCSIZE` 每次都会问它）+ `apply_mode` 末尾补关一次 DWM。**两半都要做** |
| 灰边还在（Win10） | `DWMWA_BORDER_COLOR` 是 Win11 22000 才有的属性，Win10 上 `DwmSetWindowAttribute` 回 `E_INVALIDARG`（`0x80070057`），静默失败 | 靠 `WM_NCCALCSIZE` 归零，那是系统消息，两代都认。`hide_system_border` 把 `hr` 打进日志 —— **静默失败是这条坑的主因** |
| 窗口里一个字都不显示 / 客户区 0×0 | 把 `WM_NCCALCSIZE` 的 `wParam == FALSE` 那一趟也返回了 0 | 只拦 `wParam == TRUE`（"算非客户区"那趟）。`FALSE` 那趟问的是"客户区现在多大"，必须交给系统 |
| 子类装上了但没生效 | `SetWindowSubclass` 跨线程调**不报错**，只返回 0（`desktop.rs` 那条坑同源） | 用 `run_on_main_thread` 投递，返回 0 时 `eprintln` 出来 |
| 窗口边缘拖不动了 | `WM_NCCALCSIZE` 归零之后客户区铺满整个窗口，`WM_NCHITTEST` 一律 `HTCLIENT` | 这是**取舍**：三个自绘手柄仍然能用。别为了它把 `resizable(false)` 写死 |
| `Ctrl+滚轮` 滚一格跳两档 | WebView2 自带的 Ctrl+滚轮 缩放没被吃掉（`AreBrowserAcceleratorKeysEnabled` 默认开），两套叠在一起 | `wheel` 监听必须 `{ passive: false }` 且 `preventDefault()`；打开面板时再 `setZoom(1)` 清一次历史值 |
| 放大到 1.5 之后输入卡被挤出窗口 / 右边一条缝 | `zoom` 挂在了 `position: fixed` 的容器上，或者挂在 `flex: 1` 的子项上而实现把尺寸乘了两遍 | 挂在 `.lattice-assistant` 根上一条（抽屉的 `fixed` 与小窗的 `flex: 1` 都量过：布局空间按 1/倍率缩小，不溢出） |
| 往抽屉上拖文件，`@path` 加不进去 / 加错地方 | 用 `getBoundingClientRect()` 比落点，`zoom ≠ 1` 时它和事件坐标不在同一个空间 | 改成 `document.elementFromPoint(x, y)` + `panelRef.contains(hit)` —— 命中测试和画面永远是同一块 |
| 重启之后缩放回到 1 | 只改了前端状态、没落盘；或者落盘写在 `assistant.json` 而不是 `assistant-window.json` | 窗口自己的外观只有一个家（`assistant-window.json` v4）。前端先本地走一档再 invoke，落盘失败只影响"下次打开" |
| 窗口一次比一次大 / 下次启动整块跑到屏幕外 | `SetWindowPos(SWP_FRAMECHANGED)` 之后系统补发的那条 `Resized` 里 `inner_size()` 可能是 0，换算成 `u32` 落盘就成了 `800 × 65535`；`migrate_size` 只管下限，`clamp_position` 只会挪位置 | ①重算帧那次 `SetWindowPos` **把 `cx/cy` 一起钉住**（不钉，系统按"保住客户区"往外长一个边框厚度，实测 800×600 → 816×609）②落盘前过一遍 `clamp_size`，上限是工作区 |
| 前两层都关了，四边**还剩** 1px 浅色线（深色面板外面浮一条桌面） | 第三层：`SetWindowRgn` 的区域边界正好压在窗口最外一像素上。不透明窗口看不出来，`transparent(true)` 的窗口那一像素不属于可见内容 | 区域各边放大 1px（`clip_rounded` 写 `(-1, -1, w + 2, h + 2)`）。**先按"清掉区域再截一次"定位**，别去翻 CSS —— 无头 Chrome 里页面本来就是铺满的 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/assistant-window.html` | 39 → 48 | 五档表一字不差、1.4 归到 1.3、到顶到底不动、坏值回 1、v3 文件读出 `fontScale === 1`、滚一格只走一档 |
| `src-tauri/src/assistant_window_policy.rs` | 10 → 16 | 同上（Rust 那份），`rustc --test` 单跑；外加 `clamp_size` 的两条（65535 被夹回工作区、工作区比下限还小时不夹出负区间） |

**手工验一次**：

1. `Ctrl+K` 开小窗 → **外面没有灰边**，四边连 1px 的浅色线都没有（面板直接贴边），四角仍然是圆的。
2. 底板面板切到桌面模式再切回浮窗 → 边**不能回来**。
3. 拖右下角手柄 → 能缩能放，缩到 560×420 停住。
4. `Ctrl+滚轮` 上下各滚几格 → 面板整体变大变小，**滚一格只走一档**。
5. 到 1.5 再往上滚 → 停住；`Ctrl+0` → 回 1；读数按钮点一下也回 1。
6. 退出重进 → 还是上次那个档位。
7. 1.5 倍下：输入卡还在窗口里、没有横向滚动条、抽屉右边缘没有缝。
8. 退出重进两三次 → 尺寸**一格都不长**（重算帧那次如果没钉 `cx/cy`，每次会多 16px）。
