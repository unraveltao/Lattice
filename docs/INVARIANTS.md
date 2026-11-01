# 二十四条不变量

> 这是 [`AGENTS.md`](../AGENTS.md) 第 4 节的正文。**根文件里一行一条（带 `INV-n` 编号），这里是被压掉的边界、例外和"破了会怎样"。**
>
> 什么时候读：根文件那一行不足以判断该不该这么改的时候。编号是**稳定 ID** —— 引用不变量请写 `INV-8`，不要写"第 8 条"（顺序会变，编号不会）。
>
> 三条判据帮你决定要不要读全文：这条的**例外**你这次会不会碰到、有没有**两处判据**要同时改、破了之后是**报错**还是**静默**。

## INV-1 零内置

平台本身不含任何组件。随应用分发的包（`bundled`）必须显式"安装"（记进 `installedIds`）才可用；用户目录里的包（`user`）在磁盘上即已装。不要为了"体验好一点"让 bundled 自动可用，那会把扩展平台退化成桌面工具。

## INV-2 两个宿主，一套桥

画布里的 `WidgetFrame.tsx` 和桌面上的 `widgetHost.ts` 都必须走 `runtime/bridge.ts` 的同一张方法表。**任何"只在预览能用"或"只在桌面能用"的分叉都是 bug**，不是特性。画布在桌面模式下退成静态卡（`poster`）不算分叉：那一份根本没在跑，跑的是真窗口那一份，两条路仍是同一张方法表 —— 谁要"修"它，先看 `runtime/widget-tools.ts::canvasNeedsLiveFrame` 和 PITFALLS「可见性与调度」最后一条。

## INV-3 鉴权靠窗口引用，不靠 origin

沙箱 iframe 的 origin 是字符串 `"null"`，所有组件一样，`event.origin` 分不出实例。必须 `event.source === iframe.contentWindow`。

## INV-4 权限按 `widgetId` 授予，不按实例

语义是"你信不信任这段代码"，跟桌面上摆了几份无关。

## INV-5 落盘不用 localStorage

这台机器上 WebView2 把 localStorage 放内存里，进程一退就没了。所有持久化都走文件（`state.json` / `widget-data/*.json`），写入用"临时文件 + 原子替换"。

## INV-6 底板是平台的，组件只读令牌

颜色 / 浓度 / 磨砂由宿主页画（`wallpaper.rs` 截壁纸 + `widgetHost.ts` 三层叠），组件一行代码都不参与。所以：`html, body` 必须保持透明；组件里**不许写死颜色**，字色、强调色、描边全部取 `--lattice-text` / `--lattice-accent` / `--lattice-border` —— 底板一变浅，平台会把它们整体翻一遍，写死的值不会跟着翻。出厂外观（`auto / 1 / 0`）下平台**不覆盖任何令牌**，默认样子必须跟没有这个功能时一像素不差。

## INV-7 错误通道不是桥

`__lattice_diag`（组件报错）和 `__lattice`（桥请求/响应）是两条独立的消息，两个宿主都必须**先认错误、再认桥**，而且 `isWidgetErrorReport` 只认结构不认来源 —— 来源校验（`event.source === iframe.contentWindow`）在它之前做。混在一起的后果不是崩溃，是**组件能靠伪造一条"错误"骗到宿主的一次回话**，或者反过来每次加载都弹一张错误卡。改 `runtime/widget-reporter.js` 里的 `tag` 就要同步改 `runtime/diagnostics.ts` 的 `REPORT_TAG`，`tests/diagnostics.html` 钉住了这个字面量。

## INV-8 权限是活的，不是启动快照

用户在属性面板撤掉一项，**已经开着的窗口必须当场失去它**。两个宿主各存一份 `granted`（`widgetHost.ts` 的 `Set`、`WidgetFrame.tsx` 的 `grantedRef`），桥每次调用都读它；Rust 侧 `HostConfig.permissions` 由 `sync_widget_windows` 每轮比对，变了就 `emit_to("lattice:widget-permissions")`。四条约束：比对必须**先排序去重**（grants 数组换个顺序不等于权限变了，否则点一下开关就重载一次组件）；载荷必须带 `instanceId`（`emit_to` 是广播，见第 9 条）；宿主收到后既要换集合**也要** `reloadWidget()`（只换集合的话，组件在授权前写进界面的"权限被拒"不会自己回头）；`create()` 里登记 `HostConfig` 时也要用排好序的那份，否则新窗口第一轮同步就会误判成"变了"；画布卡片上那句 `Needs …`（`WidgetFrame` 的 `missing`）要按最新 `grants` 过滤，只在点 `Grant` 时清的话，用户改从属性面板勾回来就会一直挂着。

## INV-9 `emit_to` 是广播，收件人自己认领

`emit_to(label)` 听着像"只发给那个窗口"，其实不是：JS 侧 `listen()` 注册的监听器 target 是 `Any`，而 Tauri 的匹配规则是 `target == Any || filter(target)`（`event/listener.rs::match_any_or_filter`）—— **任何** emit 都会送到**每个**窗口的 `Any` 监听器上。所以凡是"发给某个窗口"的事件，载荷里都要带身份（`instanceId` 或窗口 `label`），由宿主页比一次再处理。不带的后果不是报错，是**串味**：拖 A 的底板滑杆四张卡片一起变色，撤 A 的一项权限四个组件一起重载、未落盘的草稿当场丢。`lattice:theme` 是唯一**故意**全局的（平台切明暗，所有窗口都该跟着换）。

## INV-10 看不见就别跑

组件的心跳一律挂在 `runtime/schedule.ts` 的时间轴上，不自己 `setInterval`。窗口不可见时整条时间轴停摆，回来只补一拍。**"不可见"有两个来源**：`document.visibilityState` 和 Rust 发来的 `lattice:window-visible` —— 前者对"窗口最小化"完全无感（实测最小化前后都是 `visible`），只盯它等于没停。加了新的"窗口状态"判断，先想清楚该不该停摆，别在组件里各写一套。
- **`requestAnimationFrame` 不是例外，是另一件事**：它画的是"这一帧的读数"，正确性不依赖它跑多少拍 —— 秒表存的是按下去的那一刻，卡片藏起来时 rAF 自然停，回来按时间戳重算一次就是对的。需要**平台在不可见时也保持节奏**、或者要**多组件对齐同一拍**的，才必须走时间轴。另外时间轴的最小间隔是 250ms（`MIN_INTERVAL`），拿它刷百分秒会每帧跳 25 个数，看着像卡了而不是在计时。
- **但它照样要有停的条件**："卡片藏起来时 rAF 自然停"只在**整个 webview 被藏起来**时成立，窗口被收起 / 最小化 / 盖住时它照跑。所以宿主把可见性当推送下发（`{ type: "visible" }`，`schedule.ts` 的 `subscribeWindowVisible` → 两个宿主 → SDK 的 `on("visible")`），自己开帧循环的组件**必须接**。还闲着的时候要降帧：桌宠每帧整屏重绘 25 个部件，60fps 空转实测 1 核，20fps 呼吸看不出区别（`dt` 夹在 0.05 正好对上 20fps 的步长，动画速度不变）。见 PITFALLS「可见性与调度」。

## INV-11 关窗口 ≠ 删用户数据

`widget_close` 收一个 `reason`，**只有 `reason == "user"`（宿主页 ✕ 按钮）才发 `lattice:widget-close` 让主窗口删 placement**；别的来路（组件自己调桥的 `window.close`、或将来任何新入口）只关窗口，实例记进 `Runner.suppressed`，本次运行不再重建。placement 是用户摆好的布局，属于用户数据；窗口只是它的一个渲染。一条命令兼两种语义的代价，是任何一次意外调用都会静默删掉用户的东西 —— 这条坑真实发生过三次。加新的"关闭"入口时，`reason` 必须显式传，不许省；`widget_close` 里那行 `eprintln!` 也不许删，它记录的正是"谁关的"。（`reason: user` 这一路仍然会真的删 —— 手滑的兜底不在这里，在 UI 侧：`removePlacement` 会把快照留在 `lastClosed` 里、主窗口底部弹 8 秒 `Undo`，**同时**塞进落盘的 `trash`（组件库底部的"最近删除"，留 20 条 / 7 天，判据在 `runtime/trash.ts`）。两条兜底答的是两个问题：撤销条救"手滑当场"，回收站救"当时没看着屏幕"。所以**别在 `removePlacement` 之外的地方直接 `filter` 掉 placement**，那等于两条兜底一起绕开；也别只塞其中一处 —— 只进 `lastClosed` 的话，8 秒之后那件东西再也没有去处。）

## INV-12 组件的 CSP 只在 `csp.rs` 里改

组件是不可信代码，沙箱挡"碰宿主"，CSP 挡"往外发"。四条必须记住的：
- **`'self'` 在这里是废的**。组件跑在 `sandbox="allow-scripts"` 的 iframe 里，文档源是 opaque，`'self'` 匹配不到任何东西 —— 写上等于把组件自己的 `widget.js` 也拦了，组件白屏。协议源必须显式写出来。
- **协议源跟平台走**：Windows 是 `http://lattice-widget.localhost`，别处是 `lattice-widget://localhost`，必须和 `runtime/registry.ts::widgetSchemeBase` 一字不差。两处对不上，症状是"组件坏了"，最难查。
- **`connect-src` 收在组件自己的 origin 上，不是 `'none'`**。组件 `fetch("./data.json")` 是正当用法；而放行自己的 origin 不构成出网通道 —— `lattice-widget://` 是只读文件服务，GET 只回这个组件自己的文件。
- **CSP 不等于堵死**。`location.href = "https://…/?d="` 这种自我导航它管不了（没有 `navigate-to` 指令）。这道缝由 `egress.rs` 补：每个组件窗口建完立刻挂 `FrameNavigationStarting`，在导航发生前取消。**别把这条当成"以后再说的加固"** —— 它和 CSP 是一套的两半，只有 CSP 的话，组件照样能把数据拼进 URL 送出去。

## INV-13 配置按实例，权限按组件

`grants` 的键是 `widgetId`（问的是"你信不信任这段代码"），`configs` 的键是 `instanceId`（问的是"这一份要怎么显示"）。两者别互相借：配置挪到 `widgetId`，两个时钟就共享 12/24 小时制；权限挪到 `instanceId`，用户要为同一个组件授权两遍。**值只在 `runtime/config.ts::resolveConfig` 里合并**（缺的键补出厂值、非法值退回出厂值），Rust 只透传 —— 规则散到两边，画布和桌面就会显示得不一样。配置变化**不重载**组件（推 `config-changed`），只有权限变化才重载。

## INV-14 联网是"按组件的白名单"，不是"有权限就能连"

`network.fetch` 过三道闸，顺序不能换：`permissions` 里有 `network` → 目标主机在 `manifest.network.hosts` 里 → 请求形状合法（方法 / 头数 / 体积）。四条别踩回去的：
- **没有通配符，这是故意的**。`*.example.com` 写起来方便，但它把"我允许这一个接口"变成"我允许整个域"，而这个平台的权限面板只显示一行名字 —— 用户没法审阅到底放行了什么。要多个主机就列多个。
- **端口算身份的一部分**。`127.0.0.1:8787` 不等于 `127.0.0.1`；不写端口就是默认的 80 / 443。少了这条，"允许本机调试端口"等于"允许本机全部端口"。
- **重定向必须关掉**（`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`）。跟随 302 等于白名单失效：放行 `a.com`，`a.com` 把组件 302 到 `evil.com`，数据就出去了。现在的行为是把 302 原样当响应交回组件，由组件自己决定要不要再发一次（那时又要过一遍白名单）。
- **走 IPC，不搭本地 HTTP 代理**。开一个 `127.0.0.1:xxxx` 的代理端口就等于给组件留了一条绕过桥的路（它 `fetch` 那个端口没人拦），而 IPC 通道只有宿主页能说话。
- **画布上的实例也要能出网**（`network_policy::egress_for`）。白名单在桌面窗口那条路上存在 Rust 的注册表里（建窗口时写进去的），而画布上的实例**不是窗口** —— 它跑在主窗口的 iframe 里，注册表里没有条目。第一版没做这条兜底，结果是同一个组件"桌面上能联网、设计器里不能"，而设计器恰好是用户第一次配置它的地方，症状是刚加进来就报"连不上服务"。现在未注册的窗口退回宿主页随请求带来的 `network.hosts`（`bridge.ts` 的 `egress`）。**在册的窗口一律用自己那份**：窗口已经注册了还去信请求里那份，等于让一个前端 bug 悄悄扩大出网范围。

这条是**加了一扇门，不是拆了别的门**：CSP（INV-12）和 `egress.rs` 的导航拦截照旧生效，组件仍然不能自我导航把数据拼进 URL 送走。
**`shell.open` 是另一扇门，也只开一条缝。** 组件要把链接交给系统浏览器，只能走 `bridge.ts` 的 `shell.open`（权限 `shell:open`）→ `open.rs`。三条别踩回去：
- **协议白名单只有 http/https，写在 `open_policy.rs` 里。** `tauri-plugin-opener` 把字符串原样丢给 `ShellExecuteW`，而它**不认协议** —— `file:` 会把本地文件交给默认程序打开，`ms-settings:` 能直接翻到系统隐私页，`search-ms:` / 任何注册过的自定义协议一样照办。少这一道，`file:///C:/…` 比联网彻底得多。
- **别在组件里另写一套放行规则。** 组件侧只做"让存下来的东西是干净的"（`github.com` → `https://github.com/`、`example.com:8080/x` 认成主机加端口），边界上 `open_policy::normalize` 再判一次；两边的用例表在 `tests/bookmarks.html` 和 `open_policy.rs` 的 tests 里各钉一份。
- **它不削弱 `egress.rs`。** 那条拦的是"组件自己的 frame 导航走"，这条是"把地址交给浏览器"，组件的文档仍然钉在自己的 origin 上。

## INV-15 分发的信任锚点是包，不是目录

装一个包要过三道，顺序不能换：`sha256(字节)` 等于目录里写的 → ed25519 签名能被 `publisher.key` 验过 → 这把钥匙等于**这个组件第一次安装时钉在本地的那把**（`store.trustedKeys`）。前两道挡传输损坏和伪造，第三道才挡得住"另起一把钥匙、连目录一起换掉"。五条别踩回去：
- **目录本身不签名**，它只是索引。所以"目录能改"这件事必须由上面三道兜住 —— 谁想给目录加个新字段去驱动行为（自动安装、自动更新、静默授权），先想清楚这个字段被改坏之后会怎样。
- **先验签名再看版本**。反过来的话，换了钥匙的包会被当成"一次普通更新"直接装进去，用户连提示都看不到（`planInstall` 里那两行的顺序就是这么定的）。
- **换钥匙必须由用户点头**。`planInstall` 返回 `untrusted` 时界面要同时印出**两把**指纹，点一次确认才继续；不要"检测到新钥匙就自动信任"。
- **覆盖安装之前必须备份，回滚是交换不是复制**。`backup.rs` 只留一代；用复制实现回滚的话，连点两次会回到同一个旧版本，用户会以为按钮坏了。三条安装路径（目录安装 / 拖文件夹 / `.lattice`）走同一条备份规则，否则"拖文件夹"会成为唯一一种没法回滚的安装方式。
- **新版本多要的权限不自动授予，但也不禁用组件**。自动授予 = 把"更新"变成一次静默提权；禁用组件 = "更新完就不能用了"。正确形状是"照旧能用 + 一条不会自己消失的横幅，直到用户处理"。`flagPermissionReview` / `resolvePermissionReview` 是唯一入口，别在别处直接改 `grants`。

## INV-16 平台更新和组件更新是两套东西，别混

组件走目录 JSON + `.lattice` 包 + ed25519；平台走 `latest.json` + NSIS 安装包 + minisign。两条路径不共用代码，只共用"静态文件 + 签名 + 没有服务端"这个思路。四条别踩回去：
- **两把钥匙，两个私钥位置**。组件发布者的 `scripts/dev-publisher.key` 是**故意公开**的（演示目录用）；平台更新的 `.keys/updater.key` 必须保密 —— 它泄露等于任何人都能给你所有用户推假更新。`.keys/` 在 `.gitignore` 里，公钥在 `tauri.conf.json` 的 `plugins.updater.pubkey`。
- **只在用户点击时检查，没有后台轮询**。加了轮询就要回答"多久一次、失败重试几次、用户关了怎么办"，而收益只是"早几天知道"。
- **装完 `restart()`，不是 `exit()`**。新二进制只有新进程才会跑；更新完应用自己消失，用户会当成更新失败。走自定义命令 `restart_app`，不引 `plugin-process`。
- **release 先出草稿**。`/releases/latest` 只认已发布的 release，草稿期间更新器查不到东西（等于没发）。先发再验 = 拿全体用户当灰度。
- **发布时别勾 "Set as a pre-release"**。`/releases/latest` 跳过的不只是草稿，还有**预发布**：勾上之后 release 页面正常、产物都在、`releases/download/v0.1.0/latest.json` 也 200，唯独 `releases/latest/download/latest.json` 是 404 —— 也就是更新器会去敲的那个地址。v0.1.0 就这么挂了一版。症状更坑：插件对**任何非 2xx** 都只记日志，最后统一抛 `Error::ReleaseNotFound`，跟真断网**是同一句话**，界面上于是显示"检查你的网络"。`describeUpdateError` 现在先认这一条再认网络（`tests/updater.html` 14 条断言钉着），但根治还是别勾那个框。

## INV-17 说明写在清单里，改了行为就补一条 changelog

组件的"怎么用"是 `manifest.json` 的 `help`，不是包里的 README —— 组件是纯静态目录，平台没有 Markdown 渲染器，写进清单才能跟着包走（同目录、同提交、同签名）、离线能看、第三方能用，还能被 `tests/help.html` 真的读出来对账。四条别踩回去：
- **坏条目逐条丢**，和 `config` / `icon` 同一条规矩。一节没标题、一条是空串、版本号不合法 —— 丢那一条，包照常加载。说明是锦上添花，不该有"让组件打不开"的权力。
- **上限不是建议**。6 节 × 6 条 × 160 字、变更 12 条 × 8 项，`runtime/help.ts` 里是真截断。放宽它之前先想清楚 320px 面板放不放得下。
- **改了组件行为，同一次提交里把当前版本那一条 changelog 补上**。`tests/help.html` 会红：写了说明的组件，changelog 里必须有 `version === manifest.version` 的那一条。写用户能看懂的话（"拖动排序"），不写内部重构。
- **每个 `config` 字段都得有交代**：要么字段自带 `help`，要么在说明正文里被提到。用户看见一个开关却不知道它干什么，等于没做这个开关。这条也是 `tests/help.html` 钉着的。

## INV-18 先画第一帧，再等桥

组件的 `config.get` / `storage.get` 都是往返，宿主慢一点（或者根本没宿主）就是几秒钟的空白卡片 —— 而第一帧要画的通常只是默认值（`00:00.00`、`m → ft`）。正确顺序是：同步按默认值渲染 → 发请求 → 回来再改。三条别踩回去：
- **存档迟到时用 `touched` 闸门挡住**。桥回来之前用户完全可能已经点过分类、打过数字，这时候再把存档盖上去，等于把他刚做的选择撤销掉。宁可这次不恢复，也不能吃掉用户的操作。
- **别把"等桥"写进首屏路径**，也别用"加载中"占位 —— 空白卡片和骨架屏只是把同一个等待画得更久。
- 自检页顺带受益：DOM 同步就有了，`tests/convert.html` / `tests/stopwatch.html` 可以直接操作组件自己的按钮，不用先等桥超时（`config.get` + `storage.get` 各 3 秒，最坏 6 秒）。

## INV-19 先定名，再写代码

仓库里已经有名字的东西就用那个名字，没有就当场定一个写进 [`GLOSSARY.md`](../GLOSSARY.md) —— 别在代码、文档、对话里各叫一个。四条：
- **撞名先裁再写**。一个词指两件事的时候（`目录` 曾同时指商店的清单和文件系统的文件夹；`store` 曾同时指 Zustand 容器、磁盘存储和商店），先定一个、把另一个改掉，再动手。留着"靠上下文能分清"的代价是：读的人（和模型）每次都要猜一次，而**猜错不会报错**——它会一路写下去，最后你在一个数据丢失的 bug 里才发现两边说的不是一个东西。
- **术语表只收跨块共用的词**。边界是"组件作者能看见，且前端 / Rust / SDK 都会用到"。某个 slice 的内部字段、某条 Rust 命令名不进表——代码本身就是它的家。
- **术语表定"是什么"，规范定"必须怎样"**。同一个词在 `WIDGET_SPEC` 里有行为约束时，`GLOSSARY` 只写一句话定义加一条指向，别把契约抄第二遍（`docs/README.md` 第四节）。
- **改术语表用精确替换，不许整份重写**。它和第 12 节第 7 条那几个文件一样是冲突高发区：改完立刻 `git add GLOSSARY.md && git commit`。术语表被写歪不会报错，只会让后面每一份文档都跟着歪，所以**新增或改动条目后看一眼 `git diff`**，纯措辞微调可以跳过。

## INV-20 流式的东西走事件，不走桥的返回值；活的东西要有两条收尸路

终端组件（`lattice.term`）是第一个"一条命令的输出比一次调用活得久"的能力，四条别踩回去：
- **桥是一问一答的，流只能走事件**。`term.write` 只回编号，正文从 `lattice:term` 一条条来（Rust `emit` → 宿主页按 `instanceId` 转发 → iframe）。把 `ping -n 10` 塞进一个 Promise 的后果不是"慢一点"，是"等十秒一次性出现"——而那正好是终端最不能忍的。任何新能力只要"边跑边有话说"，都按这个形状来（`llm_chat_stream` 同一条）。
- **输出要留补发缓冲**。窗口藏起来回来、权限变更重载 iframe，中间那段事件会缺；`term.state { since }` 让平台把 `seq` 之后的缓冲重发一遍（环形缓冲，`term_policy::RING_EVENTS` / `RING_BYTES`）。只有 `seq` 没有正文的"对账"是假的 —— 组件缺的是那几行字。
- **常驻进程要有两条收尸路，少一条就漏**。一条是实例销毁（画布：宿主页卸载时 `term_dispose`；桌面：`runner.rs` 的 `WindowEvent::Destroyed` → `term::kill_instance`），另一条是应用退出（`RunEvent::Exit` → `term::kill_all`）。只挂第一条，"组件早删了、进程还在"会一直留到重启；只挂第二条，用户关一张卡片就多一个 `powershell.exe`，而任务管理器里没人知道它是谁的。
- **每个实例一条进程，别按命令起进程**。实测每条命令 480ms 起步（常驻之后约 40ms），而"每条命令起一个"还会顺手丢掉 `cd` 和变量 —— 于是"终端"就变成了"命令输入框"。代价要写在组件说明里：跑不了 `vim` / `ssh`，没有 `Ctrl+C`（停 = 杀 shell），没有 ANSI 颜色。

## INV-21 密钥只进密封库，明文只当迁移兜底

模型 key 和组件要用的 token 都存在 `secrets.bin`（`CryptProtectData` 封的一个文件，见 `secrets.rs` / 设计 0026），`assistant.json` 里的 `apiKey` 只在"密封写不进去"时留作兜底。四条别改回去：
- **组件碰不到 `llm.*`**。键名一律由平台拼（`widget.<组件 id>.<name>`），组件只递名字片段。`widget_id` 确实来自宿主上下文（组件递不上来），但它最终来自**磁盘上的清单**，所以 `secrets_policy::widget_id_ok` 要按 `manifest.ts` 的 `ID_RE` 再判一次 —— 这是命名空间隔离唯一的那道墙。
- **删除是明确动作，不是猜出来的**。`write_config` 只"有值就封"，**从不删**；删只有两条路：`llm_set_key("")` 和 `llm_profile_remove`。反过来写（空 key 就删密封那一条）会在"换 Windows 账户、解不开"的那一次把密文抹掉 —— 而换回原账户本来还能用。
- **解不开 ≠ 没有**。`secrets.bin` 读不出来时 `load_checked` 直接 `Err` 并**拒绝任何写入**；`secret.get` 回错误而不是 `{value: null}`，界面说的是"读不出来，请重新填一次"。文件本身永远不删。
- **DPAPI 不是密码学保险箱**。它绑当前 Windows 账户：挡得住别的用户和拷走的文件，**挡不住以这个账户跑的任何程序**。权限文案和组件 `help` 里必须写明，别让用户以为"加密了所以安全"。

## INV-22 组件的保存只能递给平台一个名字，落点在系统对话框里，不在组件的参数里

`file.save`（权限 `file:save`，`bridge.ts` → `export.rs`）是组件唯一一条"往盘上写"的路，四条别改成别的形状：
- **参数里没有路径，只有文件名**。`name` 带 `\ / : * ? " < > |`、带 `..`、超过 120 个字符一律 `bad_params`（`save-file.ts::cleanSaveName` 与 `export_policy::clean_name` 各判一遍 —— 一层挡"组件写错了"，一层挡"有人绕过了第一层"）。别把它换成 `fs_policy::normalize_path`：那个函数是给**用户指的路径**用的，它允许目录，组件拿到目录就意味着"写到哪儿由它说了算"。每次调用都弹保存对话框，位置由用户选。
- **它是 `file.write` 的另一件事，名字不许共用**。`file.write` 是 assistant 的手：带审批、能覆盖任意路径；`file.save` 是"用户当场挑一个地方存出去"。一个词两个意思，后面所有人都会搞混。
- **写一个文件还是打一个 zip 由内容决定**。一个文件、给的是 `text` → 写那个文件；多于一个文件、或任意一条给了 `base64` → 打成一个 zip（`files[].name` 是 zip 内的相对路径）。**先全部解码、全部合格再写包** —— 任何一条坏就整趟失败，不许留半个 zip、也不许悄悄丢掉坏的那张图。
- **取消不是错误**。回 `{ ok: false, cancelled: true }`，没有 `code`、没有 `message`，组件界面上一个字都不说。把它当 `internal` 弹红字，就是"点了取消却像出错了"——这个仓库为这句话踩过不止一次。

## INV-23 灰掉的东西必须说得出为什么

`capability_policy.rs` 的 `Verdict` **没有 `available` 字段**：它由 `reason` 算（`reason.is_none()`），所以"不可用且没有原因"在类型层面就写不出来。加一条能力 = 六处一起动，少一处的症状都是**静默**的：
- **`CAPABILITIES` 里挑一个 `Need`**。用枚举而不是在 `judge` 里 match 字符串 id —— 后者漏一行会落到 `_ => ok`，于是新能力永远显示"能用"。加了 `Need` 的变体，编译器会逼你写判据。
- **探针里填事实**。`capability_probe::facts` 那个数组字面量是**故意不写成循环**的：漏一项编译就红，循环漏一项是静默的 `false`（= "关着"）。
- **前端 `LABELS` 加一行**（`runtime/capabilities.ts`）。漏了不会崩，界面上显示的是内部 id（`hands.shell`），而没人会报这个 bug。
- **`i18n/settings.ts` 加一句中文**。漏了不会崩，只是那一行永远说英文 —— 和 `t()` 的兜底一样，是最难被发现的那一类漏。
- **原因码是封闭集合**（`REASONS`）。新增一个码要同时改 `capabilityReasonText` 的 switch 和 `tests/capabilities.html` 里那张表；两边各一条断言钉着"每个码都不是靠兜底那句混过去的"。
- **探针只报它真能看见的事**。键鼠那组永远是绿的：`SendInput` 没有"能不能用"这个问题，唯一会失败的是 UIPI，那件事只有目标窗口知道。看不见就不假装看得见 —— 体检结果是一份**判断**，不是一条**流水**，所以也**不许**挂定时器：用户锁一下屏，"屏幕"那行就会红，而那条红字说的不是"你不能用"，是"我刚才看了一眼，那一瞬间不行"。

## INV-24 平台页面和组件文档是两份 CSP，别混成一个

组件那份在 `csp.rs`（不可信代码，`default-src 'none'`）；平台这份在 `tauri.conf.json` 的 `app.security.csp`（我们自己的代码，但一个依赖渲染了没转义的 HTML 就有注入）。四条：
- **平台这份不许有 `'unsafe-inline'` / `'unsafe-eval'` / 外部源**。内联 `<style>` 由 Tauri 发 nonce（`html2::inject_nonce_token`）、内联 `<script>` 按哈希加，所以不需要放开；真需要内联样式就改成类名（`runtime/markdown.ts` 的表格对齐就是这么改的）。
- **`frame-src` 不能是 `'none'`**：主窗口的画布和 widget-host 都**要**嵌组件文档的 iframe。那是唯一一处"看起来该关、其实必须开"的指令，理由写在 `scripts/guards/csp.mjs` 里。
- **`img-src` 有一个 `https:`**：商店图标来自用户可配的目录源，主机不可枚举。这是整份策略唯一的让步，`connect-src` 一个外部地址都没开 —— 所以"直接把数据发出去"那条路仍然是关的。
- **改策略先跑 `npm run check:csp`，别靠"打开看看"**。它盯着不许出现的东西、入口 HTML 里的内联脚本与 style 属性、平台代码有没有直连外网，还会对账 `tests/csp.html` 里那份"证明不会白屏"的策略。白屏的第一反应是放开，而放开之后没人收回来 —— 这条命令就是那道刹车。

