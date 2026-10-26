---
status: done
date: 2026-10-26
supersedes:
code: src/runtime/schedule.ts, src/widgetHost.ts, src/platform/WidgetFrame.tsx, src/platform/Canvas.tsx, src/platform/store.ts, src/App.tsx, src/runtime/widget-tools.ts, src/styles.css, src-tauri/src/runner.rs, packages/sdk/lattice.js, public/widgets/lattice.pet/pet.js
---

# 0017 —— 组件自己的帧循环要有停的条件

## 1. 问题

桌面上摆两只桌宠，任务管理器里 `msedgewebview2` 有一个进程**长期满载一个核**；
应用整体空闲时（主窗口最小化、桌宠在呼吸）实测 **7.5% of machine ≈ 1.2 核**。
这台机器只剩 0.9 GB 可用内存，任何一点空转都直接变成风扇和卡顿。

拆开看，一个核里几乎没有"算"的成分：

- `pet.js` 的 `frame()` **无条件** `requestAnimationFrame(frame)`，每帧都 `figure.tick(dt)`；
- `pet-rig.js` 的 `draw()` 每帧 `clearRect` 整屏再重画 25 个部件（每个部件是若干次
  `clip + drawImage`）；
- 平台的 `schedule` 只管挂在时间轴上的定时器，`rAF` 不归它管（不变量 10 明说了
  "它画的是这一帧的读数"），所以"看不见就别跑"对帧循环**完全没生效**；
- 同一份组件还被画了两遍：桌面窗口一份、主窗口画布一份（`Canvas.tsx` 不按 layer 过滤）。

## 2. 候选

| | A：只降帧（闲着 20fps） | B：只做可见性停役 | C：两条都做（选中） |
| --- | --- | --- | --- |
| 做法 | `frame()` 里按 `IDLE_FRAME_MS` 跳过帧 | 宿主把可见性推给组件，`setVisible(false)` 取消 rAF | A + B |
| 换掉什么 | 60fps 的整屏重绘 | 被藏起来的窗口照样在画 | — |
| 新增什么 | 一个常量 + 一个 `wantsFullRate()` | 一条推送 `{ type: "visible" }` + SDK 的 `on("visible")` | 两样都加 |
| 代价 | 闲着时动画只有 20fps（呼吸看不出，眨眼略硬） | 桥协议多一条推送；两个宿主都要接 | 同左 |

## 3. 决定

**决定**：两条都做，且**闲着用 20fps 而不是"降到 10fps 或停帧"**。

理由：`draw()` 的时间轴用 `dt`，而 `dt` 早就被夹在 `0.05`。**50ms 恰好等于 0.05**，
所以 20fps 的步长和 60fps 的步长在动画时间上是同一个值 —— 呼吸、发丝弹簧、眨眼
的时间轴**一点都不变慢**，只是采样变稀。再往下（10fps）就得改成两段 0.05 子步，
不然动画会变慢，而收益只是再省一半。

**代价**：眨眼那 160ms 在 20fps 下只有 3 帧采样，看起来比原来硬一点；走起来 / 被
拖着 / 气泡开着的时候仍然是 60fps（`wantsFullRate()`），所以"她动起来"的观感不变。

**什么时候该推翻它**：如果将来把绘制从"整屏重绘"改成"脏矩形"，单帧成本会掉一个
数量级，那时 60fps 空闲也不贵，这条降帧就可以去掉（判据是同一个采样脚本量出来
<5% 单核）。

## 4. 接口与数据

**推送（宿主 → 组件）**

```
{ __lattice: 1, type: "visible", payload: { visible: boolean } }
```

时机：窗口被最小化 / 收起 / 整个盖住、再露出来，以及 iframe 加载完成 / 报 `ready`。
载荷不带 `instanceId`：这条说的是"这个窗口"，而一个宿主页只有一个组件实例。

**宿主侧**：`runtime/schedule.ts` 新增 `windowVisibleNow()` 与 `subscribeWindowVisible(handler)`
（订阅时**立刻回调一次当前值** —— 页面可能是在窗口已经不可见之后才加载的）；
`widgetHost.ts` 与 `WidgetFrame.tsx` 各订阅一次并 `post` 出去，iframe 的 `ready` /
`load` 再补推一次当前值。

**SDK**：`case "visible"` → `emit("visible", bool)`，`lattice.d.ts` 补一条重载。

**落盘格式与迁移**：无。

**要改的文件**：上面 `code:` 那五个 + `tests/schedule.html`（5 条断言）+ 文档
（PITFALLS / WIDGET_SPEC §4.4 / AGENTS 不变量 10）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 组件在不可见窗口里加载，之后一直以为自己在屏幕上 | 只订事件，而"变成不可见"发生在订阅之前 | `subscribeWindowVisible` 订阅时立刻回调一次当前值 |
| 桌宠回来之后弹簧猛地跳一下 | 停摆期间攒下的 `dt` 被一次性用掉 | 续跑前把 `lastFrame` 清零，回来补一帧 |
| 被盖住 / 收起时还在烧 CPU | 只做了降帧、没做停役；或宿主没把 `visible` 转进去 | 两个宿主都要接；`setVisible(false)` 直接 `cancelAnimationFrame` |
| 停役之后再也没动 | 唤醒路径漏了一条（走动 / 拖拽 / 气泡） | 唤醒只有 `setVisible(true)` 一个入口，它统一重新 `requestAnimationFrame` |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/schedule.html` | 25（+5） | 订阅立刻回调当前值；窗口收起 / 文档隐藏都推 `false`；退订之后不再推 |

**手工验一次**（2026-10-26，真机，16 核 / 15.8 GB，两只桌宠）：

| 状态 | 修之前 | 修之后 |
| --- | --- | --- |
| 桌宠在桌面上呼吸（主窗最小化） | 7.5% of machine ≈ **1.2 核** | 2.4% ≈ **0.6 核**（20fps） |
| 桌宠被窗口整个盖住 | 照跑，同上 | **0.01% ≈ 0.16% 单核**（一帧都不画） |
| 桌宠页面每秒重绘 | 60 次（`clearRect` 计数） | 25 次（闲着）/ 60 次（走动、气泡开着） |

量法：进程级用 `Get-Process` 的 `TotalProcessorTime` 差分（20 秒，按核数折算）；
页面级用 WebView2 的远程调试端口（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）
取每个 target 的 `Performance.getMetrics`，再在页面里包一层 `clearRect` 数重绘次数。
**注意**：本机 WebView2 走的是软件光栅（`--in-process-gpu` 兜底，见 `lib.rs`），
所以"一帧多少钱"这个数在其他机器上会更低 —— 结论（该停、该降）不受影响。

## 7. 同一个摆放的第二份：画布不再挂活副本（2026-10-26，同一轮）

修完"停的条件"之后，剩下的大头不是帧率而是**份数**：本机摆着两只桌宠，
任务管理器里却有四个 `lattice.pet` 在跑 —— 桌面窗口各一份，主窗口画布上再各一份
（`Canvas.tsx` 对每个 placement 无条件挂 iframe）。同一个组件跑两遍，
两份各自 `clearRect`、各自吃一份光栅。

**决定**：桌面模式下画布只画**静态卡**（`.lattice-poster`：图标 + 一句话），不挂
iframe。判据收在一个纯函数里 —— `runtime/widget-tools.ts::canvasNeedsLiveFrame`，
三个例外各有各的理由：

| 例外 | 为什么必须活着 |
| --- | --- |
| 没进桌面模式（`desktopMode === false`） | 那时没有窗口，画布就是它唯一的家，设计态还得能调它 |
| 声明了 `agent.tools` **且**授了 `agent:tools` | 画布这一份是数据平面唯一的答话人，撤了模型调它只会得到 `not-running`（WIDGET_SPEC §3.6） |
| 这一份的窗口已被组件自己关掉（`suppressed`） | 静态卡的意思是"它在自己那个窗口里跑"，窗口不在还画静态卡，这个组件在屏幕上就**一个像素都没有了** —— 而卡片还在说它在桌面上 |

第三条是实测撞出来的：`lattice.pet` 右键会 `window.close()`（组件自己关窗，
placement 留着，见不变量 11 与 `runner.rs::widget_close`），那一刻窗口没了。
所以 `widget_close` 在 `suppressed` 分支上多广播一条 `lattice:widget-suppressed`
（**和删摆放的那条 `lattice:widget-close` 分开**，合成一条就是当初静默删用户数据的老路），
主窗口把它记进 store 的同名镜像（不落盘），画布据此退回活的那一份。

**实测（真机，16 核 / 15.8 GB，两只桌宠都在桌面上）**：

| 状态 | 改之前 | 改之后 |
| --- | --- | --- |
| 主窗口画布上活的 iframe | 2 | **0**（两张静态卡） |
| 同一个组件的活副本总数 | 4（2 窗口 + 2 卡） | **2**（只有那两扇窗口） |
| 每份活副本的空转成本 | 约 0.3 核 / 份（同一状态下逐 renderer 差分） | 画布这一份的 0.3 核 × 2 不再存在 |

量法：`--remote-debugging-port=9222` 之后在主窗口页面里数
`document.querySelectorAll("iframe")` 与 `.lattice-poster`（改之前/之后各一次），
成本用进程树 `TotalProcessorTime` 差分。

**什么时候该推翻它**：等桌面窗口自己能应数据平面（AGENTS §8 的「不唤醒窗口」那条），
第二条例外就能去掉，判据可以收成"`desktopMode` 之外一律静态卡"。
在那之前**别在别处再写一份"要不要挂活副本"的判断** —— 画布、工具登记、钱包页面
的"是不是在跑"都该问同一个函数。
