# 踩过的坑

> 一行一条：**症状 / 真实原因 / 解法**。这份文件只有一个目的：下次撞到同一个症状时，五秒内能找到它。

> 按**症状出现在哪**分组，不按版本 —— 查坑这件事从来不按版本发生。新坑补进对应的组，别新开一节。

> 怎么用：`Ctrl+F` 搜你看到的**现象**，不要搜原因。这个仓库的坑，症状和原因经常长得完全不像 ——
> 更新器报「检查你的网络」那一条，真正的原因是 release 被勾成了预发布。

现在 **85 条**。每条都是真撞过的；猜出来的坑会把人往错的方向带，所以不写。

---

## 窗口：建、同步、关

这一组全是「一个窗口该有一个」被破坏的时候。建窗口的命令必须是 `async fn`，同一个实例同一时刻只能有一条同步在飞。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 命令里调 `sync_widget_windows` 之后界面直接冻住，日志停在 `sync specs=N`，无报错 | Tauri 2 的**同步命令跑在主线程**，而 `WebviewWindowBuilder::build()` 要把建窗口的活儿投递回主线程再等它完成 —— 命令占着主线程等自己 | 命令改成 `async fn`，落到运行时线程池                                          |
| 同上，但表现为 `WebView2 error HRESULT(0x8007139F)`                | 持有 `Mutex<窗口表>` 去建窗口，新窗口的宿主页立刻回调 `widget_host_config` 抢同一把锁                                | 不维护窗口表，窗口存在性交给 `app.get_webview_window`；宿主页配置在 `build()` **之前**登记 |
| 点「收回」之后窗口要愣几百毫秒才消失                                       | `window.close()` 要等 WebView2 把渲染进程拆完，这段时间窗口还完整地定格在屏幕上                                     | 宿主页先 `hide()` 再走 IPC 关闭，失败则 `show()` 回滚；Rust 侧三处关闭路径同样先 hide 再 close |
| 屏幕上看着只有一个组件，实际上跑着两份 WebView2；「收回」只关得掉一个 | 启动恢复和 120ms 防抖同步**并发**触发，两条 `sync_widget_windows` 都先查到 `get_webview_window(label) == None`，然后各自 `build()` 一次 —— 同一个实例被建出两个窗口，一个归 Tauri 管，另一个成了孤儿 | `desktop.ts` 里把同步串成一条链（`serial()`），同一时刻只允许一条在飞；位置/层级幂等，后一条排队跑即可 |
| 「投放到桌面」按钮点了永久变灰，界面上什么都没发生 | 上一条并发的副作用：同时建窗口把 WebView2 的创建排到几十秒，IPC 的自定义协议先超时（`Failed to fetch`），退到 postMessage 之后长命令的响应再也回不来 —— `desktopBusy` 停在 true | 根因靠串行化解决；同时给 `syncDesktop` / `closeDesktop` 套 `withTimeout`，超时报错并解锁按钮，别让人除了重启没别的办法 |
| 关掉主窗口之后既退不出也回不来 | 没有 `CloseRequested` 处理，也没有托盘：主窗口被销毁，组件窗口还在（进程不退），但没有任何入口能把主窗口要回来，只能去任务管理器 | 桌面上还有组件时 `prevent_close()` + `hide()`；真退出走设置菜单的 `Quit Lattice`（`quit_app`）；再点一次图标由单实例唤回主窗口 |
| assistant 小窗一开，整个应用（连托盘）都僵住，Ctrl+K 也没反应，只能去任务管理器 | 三个 `assistant_window_*` 命令写成了同步 `fn`：同步命令跑在主线程，而建窗口的 `build()` 要把活投递回主线程再等结果 —— 命令占着主线程等自己 | 三个全改成 `pub async fn`，和 `sync_widget_windows` / `widget_close` 同一条规矩（AGENTS §5）。这类死锁 v0.2 就撞过一次，那条记的是"建窗口的命令必须 async"；这次是**新加的命令**又忘了一遍 —— 加任何碰窗口的命令之前，先回去看那三条 |

## 层级、焦点与 z 序

能打字和「待在桌面层」本来是冲突的，守卫就是在解决这个冲突。改这块之前先读 AGENTS §5。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| `layer: desktop` 的组件跑到了最上层                                  | `window.show()` 在 `apply_to` 之后调用，ShowWindow 会把窗口重新提到最前                                    | 先 `show()` 再应用层级                                                  |
| `layer: desktop` 的窗口其实没挂到 WorkerW                       | 部分 Win11 版本 `Progman` 自己承载 `SHELLDLL_DefView`，`0x052C` 之后也不会派生 WorkerW 兄弟窗口，查找返回 None | 已有降级：退成 `HWND_BOTTOM`，仍在所有普通窗口之下；真挂载留给后续版本                  |
| 桌面上的笔记/待办点进去打不了字，连光标都没有                                     | 桌面窗口一律带 `WS_EX_NOACTIVATE`，还被挂进 WorkerW 变成桌面的子窗口 —— 两条都让键盘焦点进不来                               | 清单加 `interactive`（默认 `true`）：不挂 WorkerW、去掉 `NOACTIVATE`、压到 `HWND_BOTTOM` |
| 点一下组件，它窜到所有窗口最前面，切走又掉回桌面 —— 看着就是"闪来闪去"                          | 可激活的窗口被激活时，Windows 会顺手把它提到 z 序最前。能打字和"待在桌面层"本来是冲突的                                        | 子类化拦 `WM_WINDOWPOSCHANGING`：给"往上提"的请求加 `SWP_NOZORDER`，原地不动。激活照给，z 序不动             |
| 守卫明明加了，窗口还是往上窜                                            | `SetWindowSubclass` 跨线程调用不报错，只返回 0 —— 从同步命令的线程装守卫会静默失败                                    | 用 `window.run_on_main_thread(...)` 回到窗口线程再装                                  |
| 切"置顶"没反应，组件还趴在桌面层                                         | 守卫摘得比 `HWND_TOPMOST` 晚：那一下 SetWindowPos 被守卫改写掉了                                                | 守卫状态用窗口属性做开关，`apply_to` 里**先翻开关再落层级**                                  |
| 暂停中的组件窗口恢复之后跑到最前面来了 | `window.show()` 就是 `ShowWindow`，它会把窗口提到最前 —— 而恢复之后层级还停在 `HWND_BOTTOM` / `WorkerW` 的旧印象里 | 恢复时先 `show()` 再重放一次层级（`desktop::apply_to`），顺序反了就等于没压下去 |

## 形状、透明与底板

窗口不透明，一切「看起来透明」的东西都是自己画的。这一组的坑几乎都是「以为系统会替我画」。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 主窗口一片白，`eval` 返回 Ok 但脚本没跑                                   | WebView2 的 GPU 进程起不来（混合显卡 + 虚拟显示适配器）                                                       | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--in-process-gpu`          |
| 加上 `--disable-gpu-compositing` 后透明窗口建不出来                    | 该开关会关掉 DirectComposition，逐像素透明依赖它                                                          | 不要加这个开关                                                           |
| 组件窗口背景永远是白的，`transparent(true)` 无效                          | 逐像素透明要求 WebView2 走合成，软件渲染下拿不到；`DwmEnableBlurBehindWindow` 也压不住                             | 放弃逐像素透明：窗口不透明、宿主页自己画卡片、`SetWindowRgn` 裁圆角                         |
| 组件内容明明写了 `background: transparent`，桌面卡片却是一块白板        | 平台在 `:root` 上设了 `color-scheme: dark`，它会继承进 iframe 元素、变成被嵌入文档的初始 color-scheme；只要不是 `normal`，Chromium 就给 iframe 画布刷一层不透明底色 | `iframe { color-scheme: normal }`（`widgetHost.css` 与 `styles.css` 各一处） |
| 缩放手柄"点不准"，正对着窗口角点按下去会穿到桌面                    | 窗口被 `SetWindowRgn` 裁成圆角后，圆角弧线外侧那几个像素不属于窗口，鼠标事件到不了                            | 四个角的手柄放大到 18px，让弧线以内的部分也落在手柄里；这是圆角窗口的固有代价，Windows 自己的窗口也一样 |
| 磨砂底板上，右上角那排按钮像浮在雾里、颜色跟它压着的那块底板对不上 | 按钮底色是拿"壁纸**平均色**"算的，而它底下压着的是**那一小块**壁纸。绿底板上摆一枚按全局平均色算出来的橄榄色按钮，看着就像没对准 | 窗饰不跟底板算色：`--lattice-chrome` / `--lattice-chrome-fg` 是一对固定中性色（卡片浅就白、深就炭），图标也换成正文色而不是 muted |
| 底板调成浅色之后，组件的状态字（"Saved"、待办计数）淡得看不见 | 强调色写死在主题里：深色主题那支薄荷绿 `#5dcaa5` 压在浅底板上几乎没有对比度 | 合成亮度决定明暗之后，`--lattice-accent` 一起翻（浅用 `#0f6e56`、深用 `#5dcaa5`），组件本来就只读令牌，不用改代码 |
| 底板一改，没改过的组件也"变了一点" | 脚本无条件把 `--lattice-surface` / `--lattice-text` / `--lattice-border` 覆盖成"近似主题"的值，出厂外观下这些近似值跟主题本身有细微差别 | 出厂外观（`auto / 1 / 0`）一个令牌都不覆盖，`isPlainAppearance()` 判断后直接 `removeProperty`，默认样子跟没有这个功能时一模一样 |
| 壁纸层四条边发黑 | 模糊的边缘要往外扩，`filter: blur()` 在 canvas 边界上会把外面的透明像素平均进来 | canvas 比卡片四周各大 `2 × MAX_BLUR`（80px），模糊的尾巴落在卡片外面，被窗口圆角裁掉 |
| 拖窗口时磨砂底"追不上"，停下来还是最初那一张 | 截图是异步的（一张约 24ms + IPC），拖动时每 120ms 就来一次，`wallpaperLoading` 一挡，后面全被丢掉 | 挡的时候记一个 `wallpaperDirty`，`finally` 里发现脏了就补截一张 —— 只补最后一次位置，不排队 |

## 位置与边界

坐标来自三个地方（指针、`screenX`、属性面板），任何一个用了错的坐标系，窗口就跑到屏幕外。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 投放之后组件"消失"，`GetWindowRect` 显示在 -31000 一带                   | 主窗口最小化后 `window.screenX/screenY` 变成 `-32000` 哨兵值，防抖同步拿它重算画布原点，把窗口 `set_position` 到屏幕外      | 缓存上一次可信的原点，遇到哨兵值退回缓存                                             |
| 装完第三个组件"什么都没发生"                                        | `nextFreeSlot` 把换行线写死在 1600px，窄窗口下新组件被摆到可视区右侧，得横向滚才看得见                            | 换行位置按 `.lattice-canvas` 的实际 `clientWidth` 算                                  |
| 组件拖到屏幕边缘外面，之后就再也拖不回来                                 | 拖动完全按指针位移走，没有任何边界约束；唯一能抓的按钮在窗口右上角，跟着窗口一起出界                          | `widgetHost.ts::clampAnchor`：以那颗按钮为锚点，至少留 24px 在某块显示器**工作区**内；按锚点选屏，跨屏拖动才不会被接缝卡住 |
| 组件在桌面上的位置停在任务栏底下，按钮点不到                                | 夹边界用的是 `monitor.size`（含任务栏），不是 `monitor.workArea`                                            | `screenBoxes` 取 `workArea`，取不到才退回 `size`                                  |
| 属性面板改了尺寸，桌面上的组件纹丝不动                                       | `buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement.w/h` 会被它盖掉                      | 提交尺寸时两处一起写；`desktopRects` 有记录才写它                                         |

## 桥、权限与广播

宿主页和主窗口之间所有「我以为只发给了它」的地方。Tauri 的 `emit_to` 会送到每个 `Any` 监听器，载荷里必须自带身份。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 属性面板里撤销了 `storage`，桌面上那个组件照样能读写磁盘 | 权限只在两个地方"记着"：`HostConfig.permissions`（`create()` 时写一次，之后没人更新）和宿主页的 `const granted`（启动时建一次，之后没人动）。`Applied` 那一套 diff 里根本没有权限这一维，所以同步跑了也发现不了变化 | `sync_widget_windows` 每轮比对权限（**排序去重后**比，否则 grants 数组换个顺序会被当成"变了"），变了就 `emit_to` 一条 `lattice:widget-permissions`；宿主页就地清空重填 `granted`（桥每次调用都读它，下一次请求立刻被拒），再 `reloadWidget()` 让组件按新权限重走一遍初始化 |
| 改一个组件的外观 / 权限，桌面上**所有**组件一起变 | `emit_to(label)` 并不"只发给那个窗口"：JS 侧 `listen()` 注册的监听器 target 是 `Any`，而 Tauri 的匹配规则是 `target == Any \|\| filter(target)`（`event/listener.rs::match_any_or_filter`）—— 任何 emit 都会送到每个窗口的 `Any` 监听器上。于是拖 A 的 `Fill` 滑杆，四张卡片的底板一起动；撤 A 的一项权限，四个组件一起重载（未落盘的草稿当场丢） | 载荷里带身份，宿主页自己比对：`lattice:appearance` / `lattice:widget-permissions` 带 `instanceId`，`lattice:window-visible` 带窗口 `label`。真机验过：改 Clock 的权限只有 Clock 的 iframe 带上 `__lattice_reload`，另外三个的 `src` 原样；拖 Clock 的滑杆只有 Clock 的 `--lattice-surface` 变 |
| 在属性面板把权限勾回来，画布卡片上那句 `Needs Widget storage` 还挂着 | `missing` 只在点卡片上那颗 `Grant` 时清（`setMissing([])`），走属性面板这条路没人清 —— 组件其实已经能用了，界面还在喊缺权限 | 授权签名一变就按最新 `grants` 过滤一遍 `missing`（已经有的划掉，仍然缺的留着）。**不要**改成"权限一变就清空"：仍然缺的那几项要等组件下次撞上才重新出现，中间那段时间界面又会骗人 |
| 画布上的卡片自己消失了（组件数据还在），桌面窗口也没了 —— 前后撞到**三次** | `widget_close` → `lattice:widget-close` → 主窗口 `removePlacement`。第三次给 `widget_close` 加了 `reason` 和一行日志，当场抓到：两次都是 `reason: user`，也就是**宿主页那颗 ✕ 的 click 处理真的跑了**。在宿主页里再挂一层鼠标事件探针，抓到的是一条 `isTrusted: true` 的 `mousedown`，落点 `(203, 15)` —— 正是 220×180 窗口右上角那颗 ✕ 的中心（`target` 读出 `null` 是因为点在了按钮里的 `<svg>` 上，`data-act` 在父节点）。所以不是代码替它派发的，是**真鼠标事件**。但也不是必现：干干净净盯 70 秒，一次都没来 | ① 那一下是**真输入**（`isTrusted: true`），但**不是人**：后来有一轮我在只改 Rust 源码、完全没碰鼠标的几分钟里，四个窗口**各发了一条** `reason: user` —— 不是零星的，是成批的。所以"用户手滑"这个解释不成立，`✕` 的 click 仍然有来路不明的派发方，这条坑**没结**。② 架构上的毛病已经修了（见下一行，`reason` 分家 + 每次调用留一行日志 + 关闭可撤销）。③ 下次再撞到，先看 `[lattice] widget_close <label> (reason: user, …)` 那行里的点击特征：`trusted` + 真实坐标 + `detail: 1` 是真鼠标事件（可能是被重放的），`synthetic` 是脚本派的，`detail: 0` 且坐标 `0,0` 是键盘激活。这行在 Rust 侧打，终端里一定看得见。**别再靠"问一句"结案。** ④ 这条日志已经验过：用 CDP 往时钟窗口的 ✕ 上派发一次真点击，打出来是 `trusted detail=1 pointer=mouse at=140,20`（160 宽的窗口，✕ 中心就是 (140,20)）—— 和那几次的 `(203, 15)`（220 宽窗口的 ✕ 中心）**同一副样子**。也就是说那几次确实是"落在 ✕ 上的真实点击"。⑤ 同时验到：窗饰淡着的时候点下去会被手滑保护丢掉（`opacity 0` → 一条日志都没有）。反过来说，那几次**窗饰是可见的**，指针确实停在组件窗口上 —— 所以不是"窗口在鼠标底下刚建出来"那一下，是窗口已经在那儿、指针已经停在上面之后，才来了一次点击。这条线索指向"指针停在组件窗口上时，系统把别处的点击投给了它"，但还没抓到现行 |
| 组件自己调 `window.close()` 之后，用户摆好的布局跟着没了 | 一条命令兼着两种语义："窗口关了"就等于"用户把它删了"。于是任何一次意外调用都变成**静默的数据丢失**，连日志都不留一行 | `reason` 把两件事拆开：只有 `reason == "user"`（宿主页 ✕）才发 `lattice:widget-close` 删 placement；别的来路只关窗口，实例记进 `Runner.suppressed`，本次运行不再重建（否则下一次同步又把它变出来，看着像"关不掉"）。`suppressed` 只在内存里 —— placement 一直躺在 `state.json`，下次启动照样回来。真机验过：`reason: widget` 之后窗口消失、四条 placement 一条不少、等 3 秒也不再冒出来 |
| 组件目录里放个文件，桌面上五个卡片一起重载 | `lattice:widgets-changed` 是广播（`emit` 到所有窗口），载荷如果不带路径，宿主页只能选择"全量重载" | 载荷带**相对路径**（`<id>/<file>`，第一段就是组件 id），宿主页按前缀筛；只有自己那份变了才 `reloadWidget()` |
| 托盘菜单改了"暂停"，设置菜单里的开关还是老样子 | 暂停的真相在 Rust（`Runner.paused`），主窗口的 `paused` 只是镜像。托盘改状态时不发事件，主窗口就永远不知道 | `apply_pause` 里 `emit_to("main", "lattice:paused", ...)`，主窗口收到就落 store；另外主窗口挂载时主动拉一次 `widgets_paused` —— 事件是"变了才发"，页面可能在事件之后才加载 |
| 小窗里问「帮我画个图」，它回「我没有画图的工具」，可那张图就摆在桌面上 | 组件工具清单是在面板里用 `useLattice` 现算的，而**小窗不加载平台外壳**：那份 store 里既没有 placements 也没有 grants，算出来永远是一张空表。答话的 iframe 更只在主窗口的 React 树里 —— 小窗就算把表拼对了也敲不动它。**看着像「这个能力还没做」，实际是算的地方不对** | 清单与执行都收进 `AssistantSurface`：主窗口自己算（`listWidgetTools`），小窗走两条命令问主窗口要（`assistant_widget_tools` / `assistant_widget_call`），判据仍只在 `widgetToolSources` 里过一遍；执行前在主窗口再过一道「这份实例真能调吗」（清单不是授权）。见 [design/0013](./design/0013-widget-tools-across-windows.md) |

## 可见性与调度

`document.visibilityState` 对「窗口最小化」完全无感 —— 这两条是调度器能不能真停下来的全部依据。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 主窗口最小化之后，画布上的组件还在按心跳空转（系统监控那张卡的数字还在变） | `document.visibilityState` 对"窗口最小化"完全无感 —— 实测最小化前后都是 `visible`。WebView2 只在**整个 webview 被藏起来**时才翻这个属性，而最小化只是把窗口收进任务栏，渲染进程照跑。于是调度器那句"不可见就停摆"在桌面端从来没生效过 | `visibility.rs` 盯 `WindowEvent::Resized`（最小化/还原在 Windows 上都是 `WM_SIZE`，最小化那一下尺寸是 0×0），用 `is_minimized()` / `is_visible()` 算出真实可见性，变了才发 `lattice:window-visible`；`hide()` / `show()` 不动尺寸、不触发 Resized，由调用点显式补一次 `sync()`。调度器把这条信号和 `visibilityState` 取"与" |
| 热更新之后画布上的组件又跳起来了，窗口明明还最小化着 | 事件是"**变了才发**"，而页面可能是在窗口已经最小化**之后**才加载的（热更新、权限变更重载、改完 Rust 重启应用）。那一次"变成不可见"早就发生过了，只订事件会永远以为自己是可见的 | 页面第一次建调度器时主动拉一次 `getCurrentWindow().isMinimized()`（`hookWindowVisibility` 里那句动态 import），把初始状态补上。Rust 侧不能靠"重发一次"解决：`LAST` 去重就是为了挡住拖边缩放时几十次重复 emit |

## 数据与落盘

`state.json` 不是状态本身，是主窗口那份 store 的磁盘副本。凡是第二个 webview 想改状态，都先回来看这一组。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 重启之后布局全丢，`localStorage` 里空空如也                        | 这台机器的 WebView2 把 localStorage 全放内存里，`EBWebView/Default/Local Storage` 从没被创建过（优雅退出也一样） | 状态改为显式写文件：`state.json` + `widget-data/<组件>.json`，走原子替换          |
| 加了几条待办，回头只剩一条                                            | 画布上一个实例、桌面窗口一个实例，各持一份内存列表。A 加完 B 还停在旧列表，B 随便动一下就整块写回去                      | Rust 每次落盘后广播 `lattice:widget-store`，两个宿主转成 `store-changed` 推给 iframe；组件收到就重读，自己的写入还在飞时推迟到落地 |
| 两个 Lattice 同时跑，布局互相覆盖 | 没有实例锁。两个进程各建一套组件窗口，还同时往 `state.json` 里写，谁后写谁覆盖 | `instance.rs`：命名互斥体 `Local\Lattice.Instance` 判重 + 命名事件 `Local\Lattice.Wake` 唤回。互斥体句柄**不能**关，关了对象就消失，下一个进程会以为自己是第一个 |
| 组件的便签 / 待办内容被换成了出厂示例（`This is a Note` / `taskA·B·C`） | `widget-data/lattice.note.json` 与 `lattice.todo.json` 在 19:24:14 / 19:24:35 各被重写了一次，写进去的正是组件自带的**种子数据**。最可能的过程：某一次初始化里 `storage.get` 拿到 `null`（读失败、权限还没到位、或文件当时不在），组件走了"没数据就种一份"的分支，然后**把种子存了回去**。那两个时间点正是开发期反复重启 + 热更新 + 跑 headless 测试的时候 | ① 用户内容已尽量捞回：便签全文从 `.scratch/note-preview.html` 里取回，待办从截图里读回 4 条（另外 2 条滚出视野，找不回来）。② **平台侧的兜底已经补上**：`write_atomic` 覆盖前留一代 `.bak`（见 v0.3"组件数据落盘留一代备份"）。③ 组件侧要立规矩：**读失败 ≠ 没有数据**，读失败时绝不许把种子写回去（WIDGET_SPEC 已补） |
| 在小窗里让它"把这个组件挪一下"，挪完主窗口里的布局像退回到启动那一刻（新摆的组件没了、主题也换回去了） | `state.json` 不是状态本身，它只是主窗口那份 store 的**磁盘副本**。小窗是第二个 webview、也是第二个 store：它拿启动时的快照跑执行器、再把整份状态写回磁盘，等于把主窗口这一段时间的所有改动整块盖掉 | 执行器只留在主窗口。`platform/assistant.ts` 抽出 `AssistantSurface`：抽屉 `localSurface(records)` 本地跑，小窗 `remoteSurface()` 把 `assistant_snapshot` / `assistant_act` 交给 `agent.rs`，走 agent 端点**同一条** `call_frontend` 通道，动作照旧先过 `agent_policy` 的白名单。**判据**：凡是"要改桌面"的东西只能在持有 store 的那个窗口里发生，别的窗口最多转发 |

## 组件排版与渲染

一半是「右上角 120×28 那块是窗饰的」，另一半是「数据没来时别画空壳」。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 待办里字打进去了，回车什么都不发生，列表永远是 "Nothing here yet" | iframe 沙箱是 `sandbox="allow-scripts"`，没有 `allow-forms` —— 浏览器会把表单提交整条拦掉，`submit` 事件不触发，也不报错 | 沙箱补上 `allow-forms`（`widgetHost.ts` 与 `WidgetFrame.tsx` 两处）；`tests/todo-add.html` 钉住：同一条提交路径，有这一位就写盘，没有就 0 次写盘 |
| 点待办输入框的右端，组件被钉住 / 直接被关掉 | 桌面窗口的功能图标浮在右上角 `top:6 right:6`、约 120×28，盖在组件内容之上而且**能点**；待办的第一行恰好是通栏输入框 | 组件顶部留一条 22px 标题栏（`padding-right: 120px`）把窗饰让出去，写进 WIDGET_SPEC §5.1 |
| 便签打字时右上角那排按钮一直挡着第一行 | 同一条窗饰，但症状不是"点错"而是"看不见"：正文从 10px 就起排，而窗饰靠 `body:hover` 显示 —— 打字的人手不离键盘、指针一动不动，它也就一动不动地压着正在写的那行 | 便签顶上留 24px 状态条（把底栏的保存状态挪上来，空带会像排版坏了），正文从 40px 起排；`tests/note-layout.html` 7 条断言量死正文起点与安全区宽度 |
| 组件测试页里面板渲染成一堆裸 HTML：按钮是系统默认样式、行挤成一坨 | 面板的样式全在 `src/styles.css`（令牌 + `.lattice-debug-*`），而测试页只 import 了组件，没有 import 平台样式表 | 组件级测试页第一行就 `import "../src/styles.css"`。平台组件不是自带样式的独立件，它们靠全局那一层 |
| 正在播放组件启动后，"来源"那一格永远是空的，别的都正常 | 启动链最后一句 `.then(() => { el.source.textContent = "" })` 是重构时的残留，它跑在**第一次 render 之后**，把刚画上去的播放器名抹掉了 | 渲染函数只有一个入口。启动链里只做"订阅 + 报 ready"，不碰 DOM —— 想清空就清空数据再 render 一次 |
| 没有会话时进度条还在，显示一条空槽加 `--:--` | 那一支写的是 `el.progress.hidden = !showProgress`，把"用户关掉了进度条"当成了唯一的隐藏条件，忘了"没有会话"也该隐藏 | 隐藏条件写全：`!showProgress
| 组件测试里改配置之后，组件读到的还是旧值 | 假宿主里 `setConfig()` 只更新了自己的一个 `pollMs` 变量，而 `config.get` 回的是**启动时捕获的那个对象** —— 两份数据，各改各的 | 假宿主必须让 `config.get` 和 `config-changed` 读同一份对象（`Object.assign(config, next)`）。测试替身自己有两份状态，是最难查的一类"测试通过但功能是坏的" |
| 画布参考线改成"中间实线、两头虚线"之后，端头的虚线几乎看不见（实测只剩 5% 亮度），像"线没画出来" | `mask-image` 遮的是**元素和它的全部子内容**。实线的遮罩（两端透明）写在 `.lattice-guide` 上，同一元素里的 `::after` 虚线被它一起遮掉了 —— 两层变成了两层遮罩的乘积 | 两层都改成伪元素（`::before` 实线 / `::after` 虚线），元素自己不带遮罩；兄弟之间的遮罩互不影响。这条是截屏取像素比出来的（Chrome headless + `System.Drawing` 采样），肉眼只会觉得"线有点淡"。**后来那两层遮罩连同渐隐端头一起删掉了**（线改成局部虚线之后不再需要淡入淡出，一个 `repeating-linear-gradient` 就够），但坑本身留着 —— 往那个元素上加 `mask-image` 或 `filter` 会连它的子内容一起遮/一起模糊 |
| 系统卡片的逐核条偶尔全部归零，或者显示成一排和实际负载对不上的高度，下一拍又自己好了 | 逐核数据是"这一拍每个核的累计计数"，要和**上一拍的数组按索引相减**。休眠唤醒 / CPU 热插拔会让核数变（8 → 16），按索引对上去就是拿 A 核的计数减 B 核的 | `metrics_policy::per_core` 发现长度不一致就返回**空数组**，组件把那一行收起来，下一拍自然恢复。宁可不画，也别画一条看着合理、其实全错的曲线 |
| 提交量显示成"15 MB / 24 MB"，比任务管理器小 4096 倍 | `PERFORMANCE_INFORMATION` 里的 `CommitTotal` / `CommitLimit` / `SystemCache` 单位是**页**，不是字节 | 乘 `PageSize` 再用。同一个结构体里 `ProcessCount` / `ThreadCount` / `HandleCount` 是**计数**、不用乘 —— 一个结构体里混着两种单位，抄字段的时候要一个字段一个字段看 |
| 热力图顶上第一格显示成 `Oct!ov`，两个字叠在一起 | 月份标签是按列硬摆的（`grid-column: index + 1`），一列 11px（格子 9 + 缝 2），而 `Oct` 在 11px 下约 20px 宽。第一列的标签是**开头那个不完整的月份**，11 月 1 日偏偏就落在第 2 列 —— 两个标签只隔 1 列，浏览器照摆，不报错 | 摆之前先做碰撞检查：`usage.ts::heatMonthLabels` 把间距小于 3 列的挤掉，让位的是**开头的残月**（它本来就只盖住一两列），真实月份起点留着。`tests/usage.html` 扫一整年逐周确认最小间距 ≥ 3。凡是"按索引摆文本"的地方都要问一句"最挤的时候多挤" |
| 小窗拉到最小（320×420）时，「Enable Full access」那颗按钮按不到 —— 要按的按钮被顶出了窗框，输入框也一起不见了 | 那道确认（风险段 + 四行硬线 + 勾选框 + 两颗按钮）在英文下有 381px，而面板是个 flex 列：它写着 `flex: none`，于是"不够高"这件事全由下面的对话区和输入框承担，**对话框自己不缩**。实测 320×420 里它底边比面板底边多出 50px，正好是按钮那一行 | 让它能缩、缩不下就自己滚：`flex: 0 1 auto` + `min-height: 0` + `overflow-y: auto`（`styles.css` 的 `.lattice-assistant-mode-confirm`）。判据是"**一屏放不下时，先让内容滚，别把按钮和输入框推出可视区**" —— 凡是往窄面板里塞一段会换行的长文案，都要在最小尺寸下量一遍 `getBoundingClientRect().bottom` |
| 小窗里两行标题、两个 ×：上面那行写 "ASSISTANT"，下面那行写 "Assistant · 模型"，两个关闭隔着 34px 各管一次 | `AssistantPanel` 被**两个宿主复用**（主窗口的抽屉 / 独立小窗），而它自己头上画了一整行（标题 + 齿轮 + ×）。抽屉外面什么都没有，这一行是它唯一的标题和关闭；小窗外面已经有一条 `.lattice-assistant-bar`（标题 + 底板/锁/模式/关闭四个按钮），于是同一件事被画了两遍 | 面板按 `variant` 收：`drawer` 照旧画整行，`window` 在对话态**整行不渲染**、齿轮落进会话条，只有设置态留一行做"返回"。判据是"**宿主已经给的东西，面板里不许再给一遍**" —— 以后往这一行加按钮，先问一句"小窗外面是不是已经有了" |
| 标题栏里那颗锁是**彩色**的，旁边三颗（◐ ▢ ×）是灰的线描，一眼就看出不是一套 | 用的是 emoji `🔒` / `🔓`。emoji 走的是 `Segoe UI Emoji` 那张彩色字体，CSS 的 `color` 管不着它，粗细和基线也跟旁边的字形对不上 | 图标一律用 **SVG + `currentColor`**（`AssistantWindow.tsx::LockIcon`），颜色、粗细、基线就都跟着那一排走。**一排按钮里不许混进 emoji** —— 它在任何主题下都是彩色的，是这一排里唯一"不听话"的那个 |

## 构建、工具链与验证

这台机器上的编译与验证各有各的脾气。**别用 CDP 和合成点击验界面** —— 两样都试过，两样都不行。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| `cargo build` 报 `export ordinal too large: 92606`           | `crate-type` 里有 `cdylib`，windows-gnu 要导出巨大符号表                                              | 只留 `rlib`                                                         |
| `cargo test` 编译通过但一运行就 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` | 这台机器的安全策略不让往 `src-tauri/target/debug/deps/` 写新的 `.exe`（构建输出被拦，二进制是残的），跟代码无关：`cargo build` / 真机运行都正常 | 纯函数逻辑用 `#[path = "..."] mod x;` 写个壳子，`rustc --test 壳子.rs` 单独编一遍 —— 断言还是模块里那一份，不复制；换 msvc 工具链或放开目录权限后 `cargo test` 就能正常跑 |
| 安装包打出来了、release 草稿也建好了，才在 Actions 里看到 `ci` 的 `rust` job 红了一条 —— 而本机跑过的每一项都是绿的 | `cargo test` 在这台机器上跑不了（见上一条），而 `release.yml` **不跑** `cargo test`：只有 `ci.yml` 跑。于是"这一批新写了一条 `#[test]`"在本机从来没被真的执行过，`cargo check --all-targets` 也只证明它**编得过**。`llm.rs` / `hands.rs` / `mcp.rs` 这些带 `tauri` 的模块没有壳子，谁也不替它跑 | 动过 `src-tauri/src` 里没有壳子的 `#[cfg(test)]`：先在 `main` 上推一次，等 `ci` 的 `rust` job 绿了**再**打 tag。`release` 那条只证明"能编能打包"，它替代不了 `ci` —— 反过来也一样，`ci` 里的 shell 单测替代不了真机 |
| `ci` 的 `browser` job 红了一条，`/check-runs/<id>/annotations` 里十几条却全是"全过" | `ci.yml` 只把**日志最后 12 行**写成 annotation（runner 上的完整日志要登录才看得到），而一页有 FAIL 行时它的名字和明细打在列表**中间**，被后面十几页绿页挤出了尾巴。结果就是"看见红色、看不见红在哪一页"，只能整轮重跑；而这轮红本来可能只是 `sdk` 那种 `postMessage` 宏任务的老毛病 | `scripts/test-browser.mjs` 的最后那份小结现在会点名"哪一页红了几条"（`! <页>: N 条断言失败`，和"没跑起来"的页分开排）。改任何 CI 回显时记住这条：**结论必须落在最后几行**，中间的输出等于没输出 |
| `diagnostics.rs` 编译报一堆语法错，位置全在 JS 字符串里 | 上报脚本里有 `split("#")`，而裸字符串写成了 `r#"..."#` —— `"#` 就是结束符，字面量在 `split(` 处被截断 | 用 `r##"..."##`；顺手加一条单测：源码里不许出现 `//`（压成一行时它会把后面全注释掉） |
| 改完 `src-tauri` 里的文件，`tauri dev` 重建出来的进程直接 panic：`HRESULT(0x800700AA) The requested resource is in use` | 文件监听触发重建，但旧的 `lattice.exe` 还活着，两个实例抢同一个 WebView2 用户数据目录 | 改 Rust 之前先停掉 app（或至少确认 `tasklist` 里没有残留进程）；前端改动走 HMR，不用停 |
| 给 WebView2 加上 `--remote-debugging-port` 之后，应用起来了、窗口标题也在，但**一个 `msedgewebview2` 子进程都没有**，端口不监听，窗口里什么都没有 | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 里那条参数让 WebView2 的创建直接失败了（本机环境如此，去掉这个变量立刻正常）。表面症状极像"应用卡住" —— 日志里只有两条 watcher，什么都没有 | 别用 CDP 端口验界面：改成"临时把要验的状态默认成打开 / 关闭，截一张窗口图，然后改回来"。窗口截图用 `GetWindowRect` + `ImageGrab(bbox=..., all_screens=True)`，比 CDP 少一整条依赖 |
| 用 `mouse_event` 合成点击，坐标明明在窗口里（`WindowFromPoint` 也确认了），界面毫无反应 | 注入的输入到不了 WebView2 的渲染进程 —— 而且前台窗口随时会被别的应用（聊天工具）抢走，`SetForegroundWindow` 从后台进程调经常是**静默失败**的 | 别靠合成点击验交互。交互逻辑放进能自动化跑的页面（`tests/debug-panel.html` 直接 `.click()`），真机只看"渲染出来的样子" |
| `tests/sdk.html` 偶尔报"启动时向宿主报了一次 ready"，重跑又好了 | `postMessage` 是**宏任务**，而 `await` 子窗口的 promise 只排**微任务** —— 微任务先跑完。所以"子页面已经发了 ready"不代表"父页面的监听器已经收到" | 跨窗口的断言一律用 `waitFor(条件, 超时)` 轮询，别直接断言。这条是真机上整套测试一起跑、机器忙的时候才暴露的 |
| 刚给这台机器装了真的 gcc（`ring` 要它），Rust 这边反而编不动了 —— 停在 `resource.rc` 上，只有一句 `windres: preprocessing failed.` | 预处理 `.rc` 时 windres 会自己 spawn `gcc -E -xc-header`，而 MSYS2 的 gcc 16.2.0 对**任何** `-x` 都静默退出 1（`gcc -E -x c foo.c` 一样是 1，一个字的诊断都没有）。装真 gcc 之前这里走的是 `gcc-shim`，它不认参数、也就不碰 `-x`，所以同一个故障是"修好一个坏掉另一个" | `.toolchain/windres-shim/x86_64-w64-mingw32-windres.exe`：往参数里塞一句 `--preprocessor <.toolchain>/gcc-shim/gcc.exe` 再转发给真 windres（棂的 `resource.rc` 没有 `#include` / `#ifdef`，"原样复制"就是正确的预处理结果），`-V` / `--version` 的探测请求原样转发（`embed-resource` 靠它认编译器种类）；`scripts/tauri.mjs` 发现这个目录就把它排到 PATH 最前。**两个 shim 各管一件事**：`windres-shim` 管"谁来预处理"，`gcc-shim` 管"预处理怎么做" —— `ring` 的 `.c` 仍然必须走真 gcc |
| 改完 CSS 打开页面，**一点样式都没有**：按钮是系统默认样子、元素挤成一坨，可 `styles.css` 明明有 12 万字节 | vite 的 CSS transform 缓存被写坏了 —— 多个进程同时改同一个 `.css`（这个仓库常态：几个 agent 并行）时，watcher 和 transform 抢同一份缓存，产物是**空串**：`curl /src/styles.css` 回来的 JS 里 `__vite__css = ""`。症状看着像"我的 CSS 语法错了"，其实内容完全正常 | 先别动 CSS：`curl -s http://127.0.0.1:1420/src/styles.css \| grep '__vite__css = ""'`，命中就 `touch src/styles.css`（只改 mtime，不动内容），一秒恢复。判据是"**文件有内容、页面没样式**" —— 那就不是 CSS 的问题 |
| 想拍一张窄窗口（320 宽）的布局图，`--window-size=320,420` 拍出来却是 500 宽，`@media (max-width: 380px)` 死活不生效 | Chrome 的窗口有最小尺寸（这台机器上 500），`--window-size` 给再小也会被抬上去；`--headless=old` 一样。于是"窄窗口"根本没被造出来，媒体查询当然不匹配 —— 而这个失败**长得像"媒体查询写错了"** | 窄视口只能靠 iframe 造：外层页面里放一个 `width="320"` 的 iframe，iframe 的 viewport 就是它的框，媒体查询在里面判的正是这个宽度。顺带把 `innerWidth` 写进 `data-*` 用 `--dump-dom` 读出来核对，别靠截图反推 |
| 断言页跑出 **0 条断言**，而这一页明明写着几十条 | 脚本字符串里直接写了 `</script>`（比如断言「原始 HTML 被转义」那一句）—— HTML 解析器不认 JavaScript，看到闭合标签就把这一页的 `<script>` 就地结束，后面的断言全变成页面上的文字。**「0 条」和「这一页没写断言」是同一个症状**，所以第一反应永远是回去数断言 | 写成 `<\/script>`（`\/` 在 JS 字符串里就是 `/`，但 HTML 解析器不认这一对）；`tests/markdown.html` 那行注释钉着原因 |

## 目录、签名与网络

分发这条路上，两边各写一半的约定最容易出事：`publisher` 放在根还是条目、`dwHeadersLength` 是字符还是字节。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 用户组件"装了但打不开"，卡片写着"待接入"                                 | 用户组件的文件在 `%APPDATA%` 里，前端资源里没有，`/widgets/<id>/...` 这条路径够不到它                          | 注册 `lattice-widget` 协议，把 iframe 的 src 指向 `http://lattice-widget.localhost/<id>/<相对路径>`（`protocol.rs`） |
| 自定义协议的地址在 Windows 上一直 404                                  | Windows / Android 把自定义 scheme 挂在 `http://<scheme>.localhost/`，其它平台才是 `<scheme>://localhost/` —— 写成后者在 Windows 上连请求都发不出去 | `registry.ts::widgetSchemeBase()` 按 UA 分流；协议处理器只看 `uri.path()`，不关心 host |
| 组件里 `fetch("data.json")` 被 CORS 拦掉                            | iframe 是 `sandbox="allow-scripts allow-forms"`，文档源是 opaque 的，取自己的文件在浏览器看来也算跨域                       | 协议响应统一带 `Access-Control-Allow-Origin: *`
| 卸载组件后顶栏计数比看得见的多一个                                     | 只删了 `installedIds`，没删 `placements`：留下一个指向不存在组件的幽灵，画不出来也点不到                            | `uninstall` 里先按 `widgetId` 清掉所有实例，再取消安装                                |
| 网络代理里**带自定义头的请求全部失败**，`GetLastError()` 只给 `ERROR_INVALID_PARAMETER (87)`；不带头的请求好好的 | `WinHttpSendRequest` 的 `dwHeadersLength` 是**字符数**，不是字节数。我按 UTF-16 的字节数传了 2 倍 —— 同一份代码里注册表那几个 API（`RegSetValueExW` 的 `cbData`）收的**是**字节数，凭手感写就错了 | 传 `header_wide.len() - 1`（字符数）。这条只有真机联调能发现：单元测试碰不到 WinHTTP，而"组件联网时灵时不灵"会让人往白名单、权限、DNS 方向查很久 |
| 目录里六个组件全都报 "has no publisher key"，可 `registry.json` 里明明写着 `publisher` | 写目录的脚本把 `publisher` 放在**根**上（一处写、六个条目共用），而解析只认**条目级**的。两层结构里"字段放哪一层"是两个人的约定，脚本和解析各写一半就是这种结果 | 条目级优先、没有就继承根级（`rootPublisher`）。这类"一个字段两个层级"的格式，两边必须同一份样本验过 —— 单测里补了 3 条断言，但真机探针是唯一能抓到它的地方 |
| 验签单测"全绿"，可签名其实是错的 | 测试向量是**凭印象写**的（`e556…` 开头那一串），断言和假数据一起错，红不了 | 向量必须是**生成**的：用 Node 的 `crypto.sign` 真签一次，把 `sha256 / signature / publicKey` 原样贴进 Rust 单测。跨语言验签的测试数据没有"大概对"，只有"从对面拿过来的" |
| `.scratch` 里的验签壳子编不过：`unresolved import ed25519_dalek` / `crate::protocol` 找不到 | `rustc --test 壳子.rs` 只编这一个文件，不会替你解析 `Cargo.toml` 里的依赖，也没有 `crate::` 下的兄弟模块 | 加 `-L src-tauri/target/debug/deps --extern ed25519_dalek=<rlib> --extern sha2=<rlib>`；`csp.rs` 只用到 `protocol::SCHEME`，桩一个常量即可。桩的值要抄对 —— 抄成 `lattice`（真值是 `lattice-widget`）时单测会红，这次正好被它抓了一下 |
| 下载 16MB 的组件包，sha256 永远对不上，报"下载损坏" | 中间那一层顺手 `String::from_utf8_lossy` 转了一道字符串：非 UTF-8 的字节全变成 U+FFFD，二进制当场报废。上传下载这类管道里，**任何一次"顺手转成字符串"都是不可逆的** | `network::send` 改成返回 `Vec<u8>`，上限由调用方给（目录 2MB / 包 16MB）；`network_fetch` 只在最后一步转字符串。同一个函数服务两种用途时，最底层那个类型要选得够宽 |
| 更新器弹"检查你的网络"，可网络完全正常；release 页面能打开、产物也都在 | 发布时勾了 **"Set as a pre-release"**：`/releases/latest` 跳过的不只是草稿，还有预发布。`releases/download/v0.x.0/latest.json` 照样 200，**唯独更新器会去敲的那个地址**（`releases/latest/download/latest.json`）是 404 —— 而插件对任何非 2xx 都只记日志、最后统一抛 `ReleaseNotFound`，和真断网是同一句话 | 在 release 页面取消那个勾（或者下个版本别勾）。代码侧没有更稳的办法，`latest` 这个别名就是这么定义的。前端 `describeUpdateError` 先认这一条再认网络（`tests/updater.html` 14 条钉着，含"别把 `TargetNotFound` 也归进来"） |

## 错误上报与崩溃守卫

报错这件事本身也会坏，而且坏得比不报错更难查。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 组件明明在第 15 行抛错，错误卡写着 `index.html:67:25` | 往组件文档里注入的上报脚本占了几十行，而 `event.lineno` 数的是**文档里的行** —— 所有内联脚本的行号被整体推后 | 注入时把脚本压成一行（`diagnostics.rs::snippet`），文档总行数不变；外部脚本报自己的文件名行号，本来不受影响。单测直接断言"注入前后行数相等、`boom();` 还在第 8 行" |
| 组件抛了 `undefinedThing is not defined`，卡片却显示 `Failed to load img` | 错误按到达顺序覆盖：脚本先抛，紧接着 `<img>` 加载失败，后到的那条把根因盖掉了 | 按严重程度挑主错误（脚本/未决 3 > 资源 1），同级先到者胜；其余收进 `+N`，悬停能看全。`pickPrimary` 有 6 条断言 |
| 崩溃守卫上线后，两个组件窗口在几十秒里各重载了一千多次，日志刷到 1.5MB，界面一直在闪 | 第一版把**认不出来**的 `ProcessFailed` kind 也当成"挂了"去重载。`--in-process-gpu` 下每次导航都会看到辅助进程退出（实测 kind 4 = `UTILITY_PROCESS_EXITED`），重载又触发下一次事件 | 只有明确知道"重载能修好"的 kind 才重载（渲染进程 / GPU），其余记一行就够。拿不准时重载的代价是"把一个偶发事件变成死循环" |

## 常驻：自启

注册表里那条命令不会自己跟着 exe 走。

| 症状 | 真实原因 | 解法 |
| --- | --- | --- |
| 开机自启开关打开、重启却没起来；或者起来的还是旧的开发版 | 注册表里那条命令指向的是上一次的 exe（换过安装位置、升级过、或者开发时写进去的 `target\debug\lattice.exe`）。注册表不会自己跟着走 | 启动时对账：`autostart::reconcile()` 发现注册的那条不是当前 exe 就改写（只改已存在的，不会顺手打开）。debug 构建跳过 —— 否则 `tauri dev` 一次就把用户的自启劫持到开发产物上 |

---

每个版本做了什么、哪些决定被推翻过，在 [ROADMAP.md](./ROADMAP.md)。构建与发版的手册在 [reference/build.md](./reference/build.md)。
