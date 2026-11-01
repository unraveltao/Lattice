# 已知缺口

> 这是 [`AGENTS.md`](../../AGENTS.md) 第 8 节的正文。**改之前先看这里** —— 它回答"这件事现在做到哪一步"，避免把"待验"当 bug 修、把"有意取舍"当缺陷补。
>
> 分类判据：**这一行三个月后能不能变成"已修"**。能 → 待验 / 卡在外部；不能 → 有意取舍。改掉一条就删一条，别留着当"历史"。


这张表以前混着三种东西，读的人分不清"我现在能做"和"我做了也没用"。现在按**这一行三个月后能不能变成"已修"**分三类：

| 类 | 判据 | 态度 |
| --- | --- | --- |
| **8.1 待验** | 代码已经在了、断言也绿，缺的只是一次真机 / 另一台机器 / 真硬件 | **是待办，不是 bug。** 别为了让断言变绿去改行为 |
| **8.2 卡在外部** | 要别人点头 | 写在这里是为了不再重复研究 —— 想"要不要买证书 / 再提一次 PR"之前先读它 |
| **8.3 有意的取舍** | 永远不该变成"已修" | **看到别修。** 每条都试过，代价写在 ROADMAP 的"被推翻的十个决定"或 design 里 |

三类之外还有 **8.4** 那批"已修（别再改回去）"：那是教训，不是缺口 —— 读它们的目的和读上面三类正好相反。

## 8.1 待验（缺的只是一次真机或另一台机器）

> 验完不要只把行标成"已验"：按 [`verify.md`](./verify.md) 最后那几条留三样东西（能重跑的探针 / 那一次的实际输出 / 划掉这一行），再删。

| 缺口 | 差的是什么 | 怎么算完 |
| --- | --- | --- |
| **密封密钥只验了"失败"那一半**（v0.13，见 [0026](../design/LAT-0026-sealed-secrets.md)） | `secrets_policy.rs` 16 条 + `tests/secret.html` 17 条全过，`cargo check` 干净，**迁移与"失败保留明文"这条真的跑到了**（这台机器的 agent 进程树里 `LoadLibraryW("dpapi.dll")` 回 NULL，`CryptProtectData` 一律 127，于是设置页那行按设计亮了出来）。**没验的是成功那半**：DPAPI 封出来的字节、`secrets.bin` 真的能读回、换账户真的解不开 | 正常用户会话里：填一个模型 key → 关掉设置 → `assistant.json` 的 `apiKey` 是空的、`secrets.bin` 在 → 重启后模型仍可用 → 把 `secrets.bin` 拷到另一个 Windows 账户下，确认读不出来**且文件还在** → 用一块临时组件试 `secret.get`，确认它读不到 `llm.*`。**别为了"验通"把 DPAPI 换掉** —— 那是密码学，不是布局 |
| **电池读数只在断言里验过**（0.3.0 起是系统卡上的一行，组件已下架） | `tests/sysmon.html` 里电池那一段 + `power_policy.rs` 6 条全过，`cargo check --all-targets` 干净 —— 但全是"哨兵值认不认 / 百分比夹没夹"和"拿假读数画得对不对"。**真硬件一次没插拔过**：插电、拔电、低电量、省电模式，以及台式机（没有电池）上那一行是**整个不出现**而不是 0% | 摆一张 System：插电看得到在充电与百分比 → 拔掉电源，几十秒内剩余时间出来、交流那行消失 → 台式机上确认那一行根本没画 → 撤掉 `system:monitor` 再点，卡片该说它缺这一项 → 属性面板关掉「电池」，那一行消失而**卡片尺寸不动**。**别在平台侧加缓存或后台线程来"验"它** —— 那是把节流从组件的 `schedule.every` 挪走 |
| **GPU 数字一次没在跑起来的应用里看过**（0.3.0，见 [0030](../design/LAT-0030-merged-system-widget.md)） | `gpu_policy.rs` 9 条 `rustc --test` 全过，PDH 探针在这台机器上读到两块适配器（`Get-Counter`），但 `gpu.rs` 自己那条查询**没在 app 里跑过一次** —— 单测盖的是"解析与分组"，不是"计数器加不加得上"。没验的还有：`PdhAddEnglishCounterW` 在中文系统上真的换成本地名、两块适配器挑的是正在忙的那块、显存总量与任务管理器对得上 | 开一个吃显卡的程序（游戏，或 `dxdiag` 的 3D 测试）→ 系统卡 GPU 那行跟着上去、显存「已用 / 总量」与任务管理器「性能 → GPU」同一个数 → 关掉程序回到个位数 → 无独显的机器上整行不出现，**不是 0%**。数字对不上先怀疑"挑错了适配器"（`gpu_policy::pick`），不是"计数器读错了" |
| **`STATE_VERSION` 3 迁移只在浏览器里验过**（0.3.0） | `tests/catalogue-cache.html` 17 条钉住了改写 / 配置 / 两份尺寸 / 回收站 / 已装列表，但那是拿一份手写的 v2 对象调函数。**真 `state.json` 没迁过**，尤其 `desktopRects` 里那份尺寸 —— 它只在真机开窗时才被读到（`buildSpecs` 里 `placed.h` 优先于 `placement.h`） | 退出应用（`Get-Process lattice` 要空，孤儿进程会用内存里的旧状态盖回文件）→ 换回一份 0.2 的 `state.json` → 启动：电量卡**在原位置**变成"只剩电池那一行"（240×176，不是消失）、系统卡底栏完整（桌面上 328，不是 240）、回收站里没有恢复不出来的电池条目 → 再重启一次，确认迁移只跑一次 |
| **小窗那圈边还有第三层没在真机上看见过**（0036，见 [0036](../design/LAT-0036-assistant-window-frame-and-zoom.md)） | 那圈边其实是**三层**：DWM 画的 1px、`WS_THICKFRAME` 的非客户区、以及 `SetWindowRgn` 裁圆角那一圈。前两层这一版都关了（`frame_proc` 子类 + `hide_system_border`，运行日志里 `DWMWA_BORDER_COLOR -> hr=0x00000000`，说明 DWM 这半确实生效）；第三层是**清掉区域再截一次**证出来的 —— 区域一清，内容就铺到窗口最外一像素；区域一套，四边各露 1px 桌面。改法是把区域各边放大 1px（`desktop::clip_rounded`），**这条只有人眼能确认** | `Ctrl+K` 开小窗 → 四边**不该**再有那条 1px 的浅色线（深色面板直接贴边，和对话框一样纯色）→ 底板面板切「桌面」再切回「浮窗」，边不能回来（这是上一版失败的现场：`apply_mode` 会重算帧）→ 退出重进两三次，尺寸不长（800×600，重算帧那次没钉 `cx/cy` 时每次多 16px）→ 顺手看一眼桌面上的组件卡片，它们走同一个 `clip_rounded`。**别为了"看起来没边"把圆角去掉**：圆角和边是两件事，圆角是裁出来的 |
| **`Ctrl+滚轮` 缩放只验到"能变"**（0036） | 真机上两次实测：滚到 85% 与 115%，`assistant-window.json` 里 `fontScale` 跟着落盘（v4）。**没验的三件**：一格是不是只走一档（WebView2 自带的 Ctrl+滚轮 缩放会和我们的处理器抢，两边都生效就是"滚一格跳两档"）、`Ctrl+0` 与读数按钮能不能回到 100%、1.5 倍下输入卡有没有被挤出窗口 | 面板上 `Ctrl+滚轮` 往上滚**一格** → 读数从 100% 变 115%（不是 130%）→ 再滚一格 130% → 滚到 150% 再往上，停住 → `Ctrl+0` 回 100%、读数按钮点一下也回 100% → 放大到 150% 看三件事：输入卡还在窗口里、没有横向滚动条、抽屉右边缘没有缝 → 退出重进还是上次那一档。**"滚一格跳两档"先怀疑 `wheel` 监听没写 `{ passive: false }`**，不是 `stepZoom` 算错 |
| **输入卡只在无头 Chrome 里看过**（0035） | 加号菜单的 Esc / 点外面、拖放、`textarea` 到六行停住、空输入时发送钮是灰的 —— 这四条都要真的动鼠标键盘。无头截图只能证明"摆在那儿是那个样子" | ① 空输入：发送钮灰 → 打一个字变亮 → 发出去变方块（Stop）→ ② 连打七行：到 108px 停住，框内滚，对话区高度不变 → ③ `＋` 菜单：Esc 关、点外面关、贴一个路径回车后草稿多一行 `@路径` 且焦点回输入框 → ④ 菜单里点「技能 →」应落到设置的技能那一格，不是设置的首页 |
| **终端还有四处没在真机上走过**（v0.13 的 `lattice.term`，见 [0018](../design/LAT-0018-terminal-widget.md)） | **整条链路验通了**（2026-10-26，桌面窗口 + 探针组件）：中文不乱码；`Start-Sleep 350ms` 的四次到齐在 322 / 696 / 1053 / 1416 / 1775ms（一条条到，不是最后一起到）；stderr 三段 + `done code=1`；`cd` 保留；哨兵一个字没漏进正文；`term.state { since }` 重放；`term.stop` 之后 id 从 `c1` 重新数；退出应用那只 `powershell.exe` 跟着没了。**没走的四处**：① 卡片上的 **Stop 按钮**本身 ② **删掉卡片**那条收尸路（`term_dispose` / `WindowEvent::Destroyed`）③ `dir` 那种上百行长输出、240px 窄卡上**长行折不折** ④ `ping -n 10` 的真实节奏（这次用 `Start-Sleep` 循环代替） | `cd C:\Windows` 再 `dir`（列出来的必须是 `C:\Windows` 的东西）→ `ping -n 10 127.0.0.1` 一行一行出 → 点 Stop，任务管理器里那只 `powershell.exe` 真没了 → 删卡、退出，`Get-Process powershell` 干净。**别用"输出出现了"当通过**：这条能力要验的是顺序与收尸 |
| **组件工具只剩「不唤醒窗口」**（v0.11 数据平面） | 声明、执行、SDK 那一侧（[0012](../design/LAT-0012-sdk-agent-tools.md)）、小窗那一轮（[0013](../design/LAT-0013-widget-tools-across-windows.md)）都收口了，`tests/widget-tools.html` 55 + `tests/agent.html` 70 钉着。只剩一处：画布那张是破卡或组件没装时，调用直接回 `not-running` | 真机走一遍小窗那条 IPC（装 `lattice.diagram` + 授 `agent:tools` + 摆一张 → `Ctrl+K` 问"帮我画个流程图" → 该画出来；撤掉授权再问 → 该说没有这个工具）。「唤醒」要么接受现状，要么做成**一次显式请求**而不是默认路径 —— "建窗口 → 等宿主页 boot → 再投递"是一串会输的竞态 |
| **`shell.open` 只过了单测** | `open_policy.rs` 5 条 `rustc --test` + `tests/bookmarks.html` 48 条全过 —— 但那全是"规则对不对"和"组件答得对不对"。**没验的是最后一步**：`ShellExecuteW` 到底有没有把浏览器叫起来，以及撤掉 `shell:open` 之后点一行是不是只出提示 | 装 Bookmarks（属性面板里勾上 Open links）→ 点一行看默认浏览器是否起来（`shell.open` 成功只代表"交给系统了"）→ 撤掉 Open links 再点，卡片应显示 "It needs the Open links permission"。**跑之前先确认没有残留的 `lattice.exe`**，孤儿进程会用内存里那份盖掉 `state.json` |
| **手在真机上还有三处没走过**（其余 2026-10-25 已验，见 [AGENT_ACCESS §4.9](../AGENT_ACCESS.md)） | 六组开关、审批、六种手都跑通了。**还没走的**：`hands.rs` 那 7 条与 `mcp.rs` 那 8 条 `cargo test` 本机跑不了（写不了 `target/debug/deps`）；截图内容只有人眼能看（模型 `vision: false`）；`input.key` 只验了 `Enter`，`Ctrl+S` 这类组合键没在前台窗口里试；撤掉某组开关之后模型再调它（`disabled`）只在单测里验过 | 换一台能跑 `cargo test` 的机器补那 15 条；再起一次真机，把「撤掉 Files 之后让它读」和「Ctrl+S 进前台窗口」各试一次 |
| **技能包与免问区只在断言里验过** | `tests/skills.html` 55 条、`skills_policy.rs` 19 条全过，`cargo check` 干净 —— 但那全是"解析对不对 / 算得对不对 / 判得对不对"。**整条真机链路没走** | 导入一个真的技能目录（里面有 `SKILL.md`）→ 面板上出现名字与描述 → 打开它问"按那个流程做" → 写 `workspace` 内的那份不该弹确认条，写 `D:\GitDev\lattice` 里的该弹 → 关掉开关再问一次，它回到默认做法 |
| **「跟随系统」只在一台英文系统上验过** | 这台机器的 WebView2 报 `en-US`，所以三档里"跟随系统"落回英文是对的；"系统是中文时点跟随系统"和"应用开着的时候改系统语言"只走了代码（`watchSystemLanguage`） | 换一台中文 Windows（或临时改显示语言）看两件事：新装第一次启动应该是中文；应用开着时切系统语言，界面应当当场跟着换。`resolveLang` 的纯逻辑已被 `tests/i18n.html` 钉住，要补的是真机那一段 |
| **混合 DPI 只验了一半** | 夹紧链路已改成全程物理像素，但**这台机器两块屏都是 96 DPI**（1728×1080 ×2），"跨到不同缩放的屏"这条路径只走了代码、没走过真机 | 找一台接 4K 屏（150% 或 175%）的机器，把组件拖过去再拖回来，看锚点是不是还跟着指针；`screen-fit.ts` 的纯几何已被 `tests/screen-fit.html` 钉住，要补的是 `widgetHost.ts` 里那几处 `scaleFactor()` 重取 |
| **完全访问接管组件工具只在断言里验过**（0037，见 [0037](../design/LAT-0037-agent-omnipotence.md)） | `assumeGranted` 与 `config.set` 都收了口（`tests/widget-tools.html` 66 / `tests/assistant.html` 209 / `tests/agent.html` 81，`agent_policy.rs` 28 条 `rustc --test`）。**没验的是模式真的从 Rust 走到了两个宿主**：主窗与小窗拿到的组件工具表是不是同一份，以及"退出完全访问后盘上的授权没被改写" | 装两个组件（一个授 `agent:tools`、一个不授）→ 内部模式问"列出两个组件各自的数据"，没授权那个答不出来 → 切完全访问（勾风险）→ 同一个问题两份都答得出来 → 退出完全访问再问一次，没授权那个又答不出来，且 `state.json` 的 `grants` 一个字节没变 → 让它"把便签字号调到 20"：确认条要弹（**`auto` 档也弹**）→ 允许后卡片字号真的变了 → 审计里那行记了键名不记值。**别用"它说改了"当通过** —— 这条要验的是"表真的变宽了、盘真的没变" |
| **更新没在真机上"升上来"过一次**（v0.7） | 发布那条链的四步走完了（打 tag → Actions 出草稿 → 发布 → 线上端点核过 `latest.json` 的版本、签名长度与直链），安装包与 `.sig` 都是 Actions 出的。**没走的只有最后一句**：一台装着旧版本的机器点 Check for updates → 下载 → 装完自己重启 | 一台装着旧版本的机器：设置 → Check for updates → 看到新版本号 → 点更新 → 下载走完 → 应用自己重启 → 版本号变了、布局和组件都还在。**别用"端点返回 200"当通过**：这条要验的是"装完真的起来了"，而重启走的是自定义命令 `restart_app`，不是插件 |

## 8.2 卡在外部（我们这边推不动）

| 缺口 | 卡在哪 | 剩下能做的 |
| --- | --- | --- |
| **安装包没有代码签名** | 第一次运行被 SmartScreen 拦成"未知发布者"，用户流失基本都发生在这一步。**2026 年重新算过账：不买证书**（完整论证在 [CODE_SIGNING.md](../CODE_SIGNING.md)）—— EV 从 2024 起不再跳过 SmartScreen、Azure Artifact Signing 的个人开发者只限美/加、OV 一年一续且私钥必须进硬件。免费那条是 SignPath Foundation，申请在走 | 等 SignPath 通过，把 release 里那条**已经写好、休眠着**的签名步骤打开（没配就照常发未签名的包）。**别去买 OV/EV**：付费唯一买到的是"发布者名字从'未知'变成你的" |
| **winget 清单卡在 CLA** | `microsoft/winget-pkgs#461881`（`unraveltao.Lattice` 0.1.1）已经开了，`winget validate` 在 1.29.380 上过了（顺手揪出 locale 那份 `ManifestType` 写成 `singleton`，见 PITFALLS 第 87 条）。**卡在 Microsoft 的 CLA**，那一步只能作者本人做 | 在那个 PR 里回一句 `@microsoft-github-policy-service agree`，等合并。合并之后这一条才算完；生成器与三份 YAML 的形状已经验过（`npm run test:winget` 11 条，见 [reference/build.md §五](./build.md)） |

## 8.3 有意的取舍（看到别修）

| 取舍 | 为什么是这样 | 真要改的话 |
| --- | --- | --- |
| **底板透不出后面的窗口** | 磨砂层是"壁纸"，不是"压在组件后面的浏览器窗口"—— 系统的模糊半径写死，做不成滑杆，二者只能选一个 | 要么接受，要么换 `SetWindowCompositionAttribute` 并放弃连续滑杆（ROADMAP 被推翻的决定 7） |
| **动态壁纸会滞后** | 截图有 2s 缓存，壁纸幻灯片 / Wallpaper Engine 最多晚 2 秒 | 换成壁纸变更通知（`SystemEvents`）后主动失效缓存 —— 做得成，但现在不值得 |
| **画布预览只是近似** | 画布没有壁纸可采样，只用 `color-mix` 算"底色盖在主题底色上"的合成色，模糊完全看不出来 | 要看得准只能投放出去；**别试图在画布里模拟模糊** |
| **CSP 只盖用户组件** | 内置组件走前端资源管线、拿不到 CSP 头（它们随二进制分发，信任级别和平台本体一样）。同一份代码装成内置和装进用户目录，**联网**行为不一样（错误上报不在此列，那条两条路都注入了） | 要么让内置组件也走 `lattice-widget://`，要么接受这个不对称 —— 已经在 [`WIDGET_SPEC.md`](../WIDGET_SPEC.md) 5.2 里对组件作者写清楚了。**别在宿主页想办法补**，头只能在发文档的那一端加 |
| **样式守门人不扫组件目录** | `check-tokens.mjs` 只读 `src/**/*.css`。`public/widgets/*/style.css`（当时 21 个官方包）在闸门外，**这是有意的**：组件目录是作者的创作空间，官方包要和第三方走同一套约束 | 想收"官方包也守三张表"就**另加一条只扫 `public/widgets/` 的检查**（先跑一遍看既有违规有多少），别把组件目录塞进现有那条 —— 那会让第三方作者 clone 下来先撞一堵墙 |
| **商店没有服务端** | 目录得手工重发（`npm run store:index` 再上传）；评分只是本地字段，不汇总；举报写成一个文件，**不会自动送到作者手上**，得用户自己发出去 | 这是有意的（见INV-15 与 ROADMAP 的四个取舍）。真接后端时替换的是"目录从哪儿取"和"举报写到哪儿"，`parseCatalogue` / `planInstall` / 验签那一层一行都不用动 |
| **吊销只有本地那一半** | `state.json` 的 `blockedKeys` 是按钥匙的黑名单，排在 `planInstall` **第一道闸**（顺序见 `runtime/catalogue.ts` 的注释：排到"换人了"后面，换一把新钥匙就能绕过拉黑的意图），界面上能加能删。缺的三件：① 要求用户**先知道**钥匙泄露了；② **只挡安装** —— 已装的组件照跑，界面上没有任何提示；③ 没有时效，两年前的包今天照样验得过 | 推理在 [design/0021](../design/LAT-0021-revocation.md)：建议每个源附一份**自己签名**的 `revoked.json`（单调 `version`、离线用最后一份、不自动卸载只挂横幅）。代价是"谁来签"变成"源运营者签自己那一份"，**挡不住源运营者作恶** —— 这一点必须写在界面上，不能只写在文档里。**别做成静默信任**：那等于把第三道校验删了 |
| **签名没有时效** | 包没有有效期、没有时间戳，一个两年前的包今天照样验得过；"回滚到旧版本"在密码学层看不出来 | 目录里加 `publishedAt` 只是索引层字段（可改）。真要防降级得靠版本单调 —— 现在靠的是"只往更高的版本装"，但用户可以手动装旧包 |
| **回滚只有一代** | 连着更新两次之后回不到第一版 | 用户真正需要的是"回到刚才那个"，多代备份是个没有正确答案的配置项。真要加，先把 `widget-backups/<id>` 变成 `<id>/<version>`，再把"交换"改成"指针移动" |
| **权限复核只在主窗口** | 那条横幅挂在主窗口底部；用户一直不开主窗口，就一直看不到。已经有的兜底是卡片上的 `Review` 标记（`LibraryPanel`），但同样要打开主窗口才看得见 | 可以考虑让托盘图标带状态 |
| **浏览器预览那条通道是 `assistant.json` 的第二份真源**（2026-10-26 收窄，见 [0015](../design/LAT-0015-preview-config-mirror.md)） | 它追到了 v4，而且**不再靠白名单保命**：`parseConfig` 搬完认得的字段之后把文件里不认识的顶层键原样带回去（`skills` 丢过一版，丢的就是"搬运名单里没有"）；失败那几句也说同一种抬头（[0014](../design/LAT-0014-llm-failure-codes.md)）。**仍然要人跟**：认得的字段语义变了、`HANDS_KEYS` 那六组开关本身（第七组手要在两处加） | 加字段时照旧看一眼 `emptyConfig()` / `version`（形状没变就不用改），语义变化必须两边一起改并在 `npm run test:llm-proxy` 里补一条往返；**别把"不认识的照抄"改回逐字段白名单** —— 那等于把静默数据丢失一起改回来 |
| **Rust 直接生成的那几句还是英文**（2026-10-26 收口，见 [0014](../design/LAT-0014-llm-failure-codes.md)） | 供应商与网络那两类**已经双语**：Rust 只回"哪一种失败 + 状态码 + 供应商原话"（抬头 `@@llm:{...}` 一行），句子由 [`runtime/llm-errors.ts`](../../src/runtime/llm-errors.ts) 按界面语言拼。**仍然有意留英文的**：`llm.rs` 自己那几条 IO / 配置读写错误（"文件坏了"是事实，不是文案） | 加新的失败码三处一起改：`llm_policy.rs::status_code` / `runtime/llm-errors.ts` 的 `SENTENCES` / `i18n/assistant.ts`；`tests/llm-models.html` 与 `llm_policy.rs` 各钉一份。**别再往 Rust 里塞中文句子** —— 那等于第二份 i18n 表 |

## 8.4 已修（别再改回去）

已修（别再改回去）：**被别的窗口整个盖住也算看不见**。可见性以前只认"最小化 / 收起"，浏览器一最大化，桌面上每张卡的心跳照跑 —— 系统监控每秒采一次 CPU，就这么一直采着。现在 `occlusion.rs` 每 1.5 秒在窗口里取九个点问 `WindowFromPoint`，九个点全落在别人的窗口上才判"挡住"，然后走同一条 `lattice:window-visible` 链路。五条别踩回去：
- **点透窗口（`WS_EX_TRANSPARENT`）要跳过这一套**。`WindowFromPoint` 本来就跳过点透窗口，拿它判永远是"被挡住"，那个组件会被永久停摆 —— 误判成"不刷新"是看得见的坏，比少省的那点电严重。
- **比对用 `IsChild`，不要比 `GetAncestor(GA_ROOT)`**。桌面层组件被 `SetParent` 挂到了 WorkerW 下面，那时它的 root 是 WorkerW 不是自己，比 root 会把这一整类窗口判成挡住。
- **`DWMWA_CLOAKED` 也算挡住**。虚拟桌面里那一半、被挂起的 UWP，`IsWindowVisible` 仍然是 true，屏幕上却没有。
- **任何一次查询失败都当"看得见"**（和 `visibility.rs` 同一条规矩）。
- **九个点全没命中才算挡住**。露出一角就停，卡片会看着像冻住；这个误判比多耗几度电明显得多。
纯逻辑（采样点怎么取、几个没命中算挡住）在 `occlusion_policy.rs`，8 条断言用 `rustc --test` 壳子跑得动；Win32 那半只能真机验。

已修（别再改回去）：**✕ 要"按下和松开都落在按钮上"才认**。那条"组件自己从画布上消失"的幽灵点击至今没查到派发方 —— 日志里是 `isTrusted: true`、`detail: 1`、`pointer: mouse`，落点正好是 ✕ 中心，和真点击一模一样。查不出派发方就只能把门收窄：`runtime/close-guard.ts` 逐条判"窗饰淡够了吗 / 有 pointerdown 吗 / 松手还在按钮上吗 / 命中测试还是按钮吗 / 同一根指针吗 / 位移超了吗"，`tests/close-guard.html` 22 条钉着。三条别踩回去：
- **没有 pointerdown 的 click 一律不认**（`detail === 0` 的键盘激活例外，否则把键盘用户挡在门外）。
- **`elementFromPoint` 那条不能省**。它专门抓"点击发生之后窗口挪了位置、现在才被处理"的迟到输入 —— 那组坐标已经不在按钮上了。
- **`why` 必须跟着 IPC 走**（`CloseOrigin::describe` 会打到 `widget_close` 那行日志里）。下次复现时 `ok` 说明那真是一段完整的按下 + 松开，`keyboard` 说明是键盘激活，两者指向完全不同的方向。
注意它**没有解决根因**：如果幽灵点击本身就是一段完整的按下 / 松开，这套判断照样放行。它做的是堵死"没有按下就关窗"，并给下一次复现留下判据。

已修（别再改回去）：**覆盖安装之前先备份，回滚是交换**。`package::extract` 与 `widgets::install_widget` 都调 `backup::save_existing`，旧目录整份复制到 `widget-backups/<id>`，只留一代；`widget_rollback` 走 `backup::swap`（两个方向各改一次名），不是复制回来。四条：**三条安装路径都要备份**（目录安装 / 拖文件夹 / `.lattice`），少一条就有一种装法回不去；**卸载连备份一起删**（`uninstall_widget`）—— 那是用户明确说的"不要了"；**没有备份时回滚必须明确报错**（`there is no previous version to roll back to`），不要静默成功，真机探针专门验了这一条；**备份失败只记日志、不阻断安装**（备份是保险，不是前提）。

已修（别再改回去）：**目录的 `publisher` 可以写在根上**。`store-index.mjs` 一处写、六个条目共用，`parseCatalogue` 是"条目级优先、没有就继承根级"。第一版只认条目级，真机跑出来的结果是"六个组件全都没有 publisher key" —— 单测里没有这个样本，只有真机才看得见。改目录格式时两边一起改。

已修（别再改回去）：**下载包这条路上不许出现字符串**。`network::send` 返回 `Vec<u8>` + 调用方给上限，`network_fetch` 只在最后一步 `String::from_utf8_lossy`。中间任何一次"顺手转成 String"，非 UTF-8 字节就变成 U+FFFD，sha256 必然对不上 —— 症状是"每个包都下载损坏"，而你会去查网络、查缓存、查目录，就是不查那一行转换。

已修（别再改回去）：**换钥匙必须让用户看见两把指纹**。`planInstall` 先验签名再看版本（反过来的话，换了钥匙的包会被当成一次普通更新装进去），返回 `untrusted` 时 `CatalogueSection` 印出本地钥匙和新钥匙的指纹，点确认才走 `trustKey` + 安装。别加"检测到新钥匙就自动信任"的分支 —— 那等于把第三道校验删了。

已修（别再改回去）：**改组件文件不用再手动重载**。`watch.rs` 用 `ReadDirectoryChangesW` 盯两个根（用户组件目录 + `public/widgets`），递归，合并成一条 `lattice:widgets-changed` 发给主窗口；`widgetHost.ts` 按 `${config.widgetId}/` 前缀过滤后自己 `reloadWidget()`，画布上的 `WidgetFrame` 听同一个事件、做同一件事（按前缀筛 + 给 `src` 加时间戳重挂 iframe）。五条别踩回去：**去抖按"静默 300ms"算、不是固定 300ms**（存一次盘会连出三四个事件，固定窗口会把一次保存切成两次重载，组件闪两下）；**必须有 `MAX_HOLD` 上限（2000ms）**——一直存盘的话"静默"永远等不到，没有上限就永不触发；**安装/卸载期间要抑制**（`SUPPRESS` 那个 `AtomicBool` + `Suppress` RAII），装一个组件是几十个文件的批量拷贝，不抑制就是十几次重载；**只重载受影响的组件**，别的组件跟着刷新等于把用户正在打的字清掉；**两条宿主都要接**——画布那条以前漏了，症状是"改一行 CSS，桌面上的卡片自己变了、画布上那张一动不动"，而画布恰好是先把样子调好再投到桌面的地方，于是每改一次都要删掉重拖。

已修（别再改回去）：**有托盘了**。`tray.rs` 三项：打开主窗口 / 暂停全部组件 / 退出，左键单击直接唤回主窗口（`show_menu_on_left_click(false)`）。两条：**托盘菜单和设置菜单必须走同一组命令**（`toggle_paused` / `instance::show_main` / `app.exit`），各写一套的话两边状态会飘——托盘说"Resume"、设置菜单里那个勾却是空的；**暂停项的文案要跟着 `widgets_paused` 走**，每次点击后重新 `set_text`，别只在建菜单时写一次。

已修（别再改回去）：**开机自启**。`autostart.rs` 读写 HKCU 的 `Run` 值 `Lattice`，写入时命令带引号（`"<exe>"`），卸载由 `installer-hooks.nsh` 的 `NSIS_HOOK_PREUNINSTALL` 删掉。三条：**只修不建**——`reconcile()` 只在"用户已经开过"且路径漂移时改写，别让它顺手把没开的项打开；**只在 release 构建里修**，dev 的 exe 路径每次编译都变，改了就变成"开机启动一个已经不存在的调试版"；**设置菜单要显示"路径已失效"**（`isStaleTarget()`），否则用户看到勾是亮的、开机却没反应，只能自己去翻注册表。

已修（别再改回去）：**暂停 = 把窗口藏起来**，不是停掉调度器。`Runner.paused` 是 `AtomicBool`，`apply_pause` 遍历所有 `widget-` 窗口 `hide()` / `show()`，新建窗口时如果处于暂停态就直接建成隐藏的。之所以不"只停调度器"：组件仍然在画、仍然在跑自己的 `requestAnimationFrame`，用户看不到却在烧 CPU；而 `hide()` 顺带把 `document.visibilityState` 翻成 `hidden`，调度器那条链路（INV-10）自动跟着停，不用再写一套。**`show()` 会把窗口提到最前**，恢复之后要补一次 `apply_to()` 把层级落回去，否则置底的组件会跳到所有窗口前面。

已修（别再改回去）：**渲染进程崩了能自己回来**。`crash.rs` 挂 `add_ProcessFailed`，`crash_policy.rs` 决定"重载还是放弃"：只有 `render` / `gpu` 两种类型重载，`browser` 直接放弃（那是整个 WebView2 进程，重载只会原地再崩），其余类型只上报一次。三条：**重载要在另一个线程上、延 120ms**——在崩溃回调里同步重建窗口会把 WebView2 卡死；**必须记账限流**（60 秒窗口内最多 3 次），否则一个必崩的组件会变成每秒一次的重载风暴，CPU 打满、日志刷屏；**放弃时要让用户能手动重试**（`lattice:widget-crashed` → 主窗口底部那张 `.lattice-crash` 条 → `widget_reload`），只在日志里放弃等于组件静默消失。注意这条**只管渲染进程整体挂掉**，组件里 `throw` 一个异常不走这条路（那是错误通道的事，见INV-7）。

已修（别再改回去）：**组件可以联网了，按白名单**。`network.rs` 是 WinHTTP 出网代理，`bridge.ts` 的 `network.fetch` 进它，三道闸见INV-14。验的时候注意 **`WinHttpSendRequest` 的 `dwHeadersLength` 收的是字符数**（注册表那几个 API 收字节数，两个不一样），传错的表现是"每个带自定义头的请求都失败、`GetLastError()` 只给 `ERROR_INVALID_PARAMETER (87)`、不带头的请求却正常"—— 这条坑让人往白名单方向查了很久。

已修（别再改回去）：**多显示器夹紧改成全程物理像素**。`screen-fit.ts` 只算几何，`widgetHost.ts` 负责取数：`availableMonitors()` 的 `position` / `size` 和 `outerPosition()` / `innerSize()` 都是物理像素，**只有指针位移是 CSS 像素**，所以拖拽时要乘当前那块屏的 `scaleFactor`，而且**跨屏那一刻要重新取**（`scaleFactor()` 变了就把基准重设一次，否则跨到 150% 的屏上指针和窗口会以 1.5 倍速分家）。真机验过：把时钟窗口推到物理 `x=-5000`，重载宿主页后落在 `x=-1834`，即第二块屏左沿 `-1728` 加 24px 边距。

已修（别再改回去）：撤销授权必须当场生效。`HostConfig.permissions` 以前只在 `create()` 写一次，宿主页的 `granted` 也是启动时建一次 —— 撤掉 `storage` 之后桌面上那个组件照样能写盘。现在 `sync_widget_windows` 每轮比对权限（**先排序去重**，否则 grants 数组换个顺序就重载一次组件），变了 `emit_to("lattice:widget-permissions")`；宿主页清空重填集合并 `reloadWidget()`。只换集合不重载是不够的：组件在授权前写进界面的"权限被拒"不会自己回头。

已修（别再改回去）：没有桥方法的权限不许出现在可勾选列表里。`PERMISSION_READY`（`runtime/manifest.ts`）是**唯一**判据 —— `normalizePermissions` 也读它（以前那里另抄了一份同样的七项名单，漏抄一处的表现是"清单里写了、界面上没有"，不报错），`InspectorPanel` 据此禁用开关并打 `soon`，`LibraryPanel` 据此画灰色虚线标签。加一项权限要**五处一起改**：`Permission` 联合类型、`PERMISSION_READY`、`PERMISSION_LABELS` 文案、`bridge.ts` 的 `defineMethod`、`catalogue.ts` 的 `KNOWN_PERMISSIONS`（最后这处漏了只是商店卡片少一行权限）。`soon` 那套现在不会触发（集合和联合类型一样长），留着是给"先声明、后实现"占位 —— 真要那么干得先让归一化放行集合外的名字。

已修（别再改回去）：重启会把组件放回桌面。`desktopMode` 与 `restoreOnLaunch` 都落盘，`App.tsx` 在**水合完成 + 清单读到**之后才恢复（少一个条件就会拿空列表同步一次，把窗口全关掉）。恢复时**不要**顺手最小化主窗口 —— 开机就把窗口藏起来，用户会以为应用没打开。

已修（别再改回去）：同步必须串行。见 §7 那条。并发两条 `sync_widget_windows` 会建出重复窗口（其中一个是孤儿，屏幕上看不出来），还会把 IPC 拖到超时、让按钮永久变灰。`serial()` 就在 `desktop.ts` 里，别绕过它直接 `invoke`。

已修（别再改回去）：用户组件能加载了。`protocol.rs` 提供 `lattice-widget://`，`registry.ts` 按来源分流入口地址，`buildSpecs` 传绝对地址。**不要再让宿主页自己拼前缀**，也不要给协议放宽路径校验。

已修（别再改回去）：组件加载失败不再是白屏。协议层失败时按请求类型分流 —— **文档导航**（`Sec-Fetch-Dest: document` / `iframe`）拿一页可读 HTML（`diagnostics.rs`），**子资源请求**拿空 body。这条分流不能省：组件 `fetch("x.json")` 拿到 HTML 会抛一个和真实原因无关的解析错误，比空 body 更难查。`wants_document()` 里那两个 `Sec-Fetch-*` 值是浏览器生成的，组件伪造不了。

已修（别再改回去）：内置组件也上报错误。以前注入只发生在 `protocol.rs`（`lattice-widget://`），而内置组件的文件走应用自己的源，协议层碰不到 —— 官方组件抛错既不弹卡也不出兜底页。现在**上报脚本只有一份**（`src/runtime/widget-reporter.js`），两条发文档的路各自读它：Rust 侧 `diagnostics.rs` 用 `include_str!` 编进二进制，前端侧 `scripts/widget-diagnostics-plugin.mjs` 在 dev 中间件和 `build` 收尾（`closeBundle`，必须排在 public 目录拷贝之后）各注一次。三处别踩回去：**改上报逻辑只改那个 .js**，两边各写一份必然漂；**两条路压行方式必须一致**（按行 trim 再用空格连成一行，末尾也 trim，否则字节不同、行号偏移对不上）；**`.html` 的守卫不能放宽**，`manifest.json` 被注一段脚本就整包废了。`npm run test:injection` 用和 Rust 单测同一批 fixture 钉住插入点。

已修（别再改回去）：注入的上报脚本必须**压成一行**。`event.lineno` 数的是文档里的行，注入多占一行，组件里所有内联脚本的行号就整体错位（真撞到过：第 15 行抛的错报成 `index.html:67:25`）。`snippet()` 负责压行，`reporter_source_has_no_line_comments` 这条单测保证源码里没有 `//`（压成一行时它会把后面全注释掉）。

已修（别再改回去）：组件不能把自己导航出去。`egress.rs` 在每个组件窗口建完后挂 `FrameNavigationStarting` + `NavigationStarting`，导航发生前取消。三条别踩回去：**宿主源从配置算、不要从 `window.url()` 取**（`build()` 返回时窗口还是 `about:blank`，第一版就是这么静默失效的）；**`webview2-com` 的版本必须和 tauri/wry 一致**（差一个次版本就是两个不兼容的 crate）；**前缀比较要防 `localhost:1420.evil.com`**。拦下来必须留一行 `egress blocked` —— 不然"组件突然不联网了"没法查。

已修（别再改回去）：组件不能往任意地址发数据了。`csp.rs` 一处生成策略，`protocol.rs` **只在 HTML 文档上挂头**（子资源响应上的 CSP 浏览器一律忽略，发给 `.js`/`.css` 只是白占字节）。三个坑都写在 `csp.rs` 的模块注释里，改之前先读：`'self'` 对 opaque origin 无效；协议源必须和 `widgetSchemeBase` 一致；`connect-src` 要放行组件自己的 origin 而不是 `'none'`。**别把策略散到调用点去拼字符串** —— 一份策略一处生成，才可能被单测钉住。

已修（别再改回去）：卸载组件要连 `placements` 一起清。只删 `installedIds` 会留下一个指向不存在组件的幽灵实例 —— 计数多一个，画不出来也点不到，只能手改 `state.json` 才能收拾。

已修（别再改回去）：拖动/缩放都要过 `clampAnchor`。不夹的话组件能被拖到屏幕外，右上角那颗按钮跟着出界，用户再也没有着力点把它拉回来。**不要改成"限制整个窗口在屏幕内"**：半截悬在边上是很正常的用法，只保证锚点抓得住就够了。

已修（别再改回去）：窗口最小化之后组件的心跳必须停。`document.visibilityState` 对最小化无感（实测最小化前后都是 `visible`），所以 `visibility.rs` 从 `WindowEvent::Resized` 推真实可见性、发 `lattice:window-visible`，调度器把它和 `visibilityState` 取"与"。**两个触发点缺一不可**：`hide()` / `show()` 不改尺寸、不触发 Resized，得在 `guard_main_close` 和 `instance::show_main` 里显式 `sync()`。真机验过：主窗口最小化 3.2 秒，画布那份 sysmon 0 拍、桌面那份 3 拍（说明只停了该停的那个）；还原后 1.2 秒 2 拍（补一拍 + 正常一拍）。

已修（别再改回去）：按窗口发的事件，载荷里必须带身份。`emit_to(label)` 实际是广播（INV-9），所以 `lattice:appearance` / `lattice:widget-permissions` 带 `instanceId`、`lattice:window-visible` 带窗口 `label`，宿主页比对后才处理。加新事件时照这个来 —— 不带身份的后果是"改一个、变一片"，而且不会报错。

已修（别再改回去）：同一组件的多个实例靠 `store-changed` 收敛，不要退回成"每个实例自己缓存一份列表"。那正是"待办只剩一条"的成因。

已修（别再改回去）：组件存储改成**键级原子写 + 读不缓存**。`bridge.ts` 不再持有 `storeCache`，`storage.set` 走 Rust 的 `widget_store_update`（进程内加锁读-改-写）。任何"为了省 IPC 加回一层缓存"的改动，都会重新引入"桌面写的内容被主窗口的旧 map 覆盖"。

已修（别再改回去）：桌面组件能打字了。以前所有桌面窗口都是 `WS_EX_NOACTIVATE` + WorkerW 子窗口，键盘事件进不来。现在按 `manifest.interactive` 分流（见 §7），可输入的窗口压在最底层并挂上底层守卫 —— 点它不会窜到别的窗口前面，也不会在失焦时掉回去，所以不闪。**不要再加"失焦回沉"那套逻辑**：守卫已经保证它一直在最底层，回沉只会多一次 `SetWindowPos`，白白让 z 序抖一下。

已修（别再改回去）：**层级和别针是"活的事实"，不是建窗口那一刻的快照**。属性面板 / 卡片右键菜单 / agent 改 `placement.layer` 之后，`sync_widget_windows` 只把新层级写进 Win32 —— 宿主页窗饰那颗箭头按钮手里的 `HostConfig.layer` 副本没人更新，于是按钮画着旧状态；更糟的是点下去它是**从旧副本算新副本**，送回去的值等于没变，那颗按钮看起来就是死的（用户报的原话："置顶是有问题的"）。现在 `Runner::set_layer` / `set_pinned` 返回"真的变了没有"，变了就 `emit_to(label, "lattice:widget-layer" / "lattice:widget-pinned")`，宿主页用 `runtime/chrome-state.ts` 的 `adoptLayer` / `adoptPinned` 认下再重画（载荷带 `instanceId`，INV-9）。**图标和提示语的对应关系也搬进了那个模块** —— 拆开写就会长出"箭头说在置顶层、提示语说点一下会置顶"这种自相矛盾的按钮，`tests/chrome-state.html` 34 条钉着。加任何"平台也会改"的窗口属性时先问一句：宿主页手里那份副本谁来更新？

已修（别再改回去）：**窗饰那颗层级按钮只发意图，不在命令里就地应用**。`widget_set_layer` 以前是「`apply_to` + `patch_layer`」一起干，而 `patch_layer` 把 `Applied.layer` 写成新值等于告诉后面的同步"这一位已经落过了"—— 只要就地那一次没真的落到窗口上（窗口还挂在 WorkerW 下、守卫没摘、tao 的样式重排把顶层位抹回去），**同步就再也不会重试**，界面全说置顶、窗口趴在桌面层。用户的原话是"这里点了没效果，我在面板里调节 layer 才有用"。现在这条命令只 `emit_to("main")`，由主窗口 `updatePlacement` → 120ms 同步 → `diff` → `apply_to`，**就是面板里那条路**；`patch_layer` 整个删掉，`Applied` 只由 `diff` 和 `widget_report_rect` 写。同理 `widget_set_pinned` 也不再自己写 `HostConfig`。多 120ms 换"界面说的和窗口做的一定是同一件事"，值得。

已修（别再改回去）：**拖动要按下去就动，不能等 IPC**。`track()`（指针捕获 + move 监听）以前挂在五六个 `await` 之后 —— 那段空窗期里的移动没人接，按一下就松手的快速拖动整趟丢掉，机器越忙空窗越长，用户只会说"拖不动"。现在 `track()` 同步挂上、IPC 读数在后台跑，回来补一次最新位移。同时 `pointerdown` 挂到**整颗胶囊**（120×28）而不是那颗 22×22 的点阵：先发现一个隐藏按钮、再瞄准 22px，本身就是"不好拖"的一部分。另外四颗按钮照旧放行。改这块之前先读 `widgetHost.ts` 里那段注释，别把 `track` 挪回 `await` 后面。

已修（别再改回去）：属性面板改尺寸要**同时写 `placement` 和 `desktopRects`**。`buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement` 的话，已经投放到桌面的组件不会变。

已修（别再改回去）：**层级是三档，不是"置顶开关"**。原来只有 `desktop` / `top`，日常最想要的那一档（普通窗口 —— 浮在资源管理器上面、但不压全屏视频）**根本选不出来**，于是用户把层级调来调去都觉得"没变化"，连报两轮"置顶没用"。现在 `WindowLayer` 是 `desktop` / `normal` / `top`，顺序就是 z 序从下到上，宿主页那颗箭头和检查器那排分段按钮都按 `runtime/layer.ts` 的 `WINDOW_LAYERS` 循环（**别在别处另写一份数组**，加档时漏一处不报错，只会把新值悄悄当默认值）。六条别踩回去：
- **`desktop` 这个名字对可输入的组件是近似的**：它只能退成 `HWND_BOTTOM`（压在所有普通窗口下面），不可能真的挂进 WorkerW —— 挂进去就拿不到键盘焦点。所以检查器那句说明按 `interactive` 分两套写，`layerHintKey()` 是唯一判据。
- **`normal` 要同时摘两样**：从 WorkerW 里 `reparent(null)` 出来，再 `SetWindowPos(HWND_NOTOPMOST)`；收尾那句 `set_always_on_top(layer == Top)` 必须还在（tao 自己记着 topmost 那一位，只改 Win32 会被它下一次重排按回去）。
- **底层守卫只给 `desktop + interactive`**（`guard` 那个布尔），`normal` / `top` 一律 `set_sink(false)` —— 守卫还活着的时候 `HWND_NOTOPMOST` 会被改写成 `HWND_BOTTOM`。
- **`adoptLayer` 遇到不认识的值返回 `null`，不降级**：老版本宿主页收到 `"normal"` 应该保持原样，把它当 `"desktop"` 等于静默改用户的选择。
- **`widget_layer_probe` 由主窗口调、带 `instanceId`**：主窗口手里只有 store 主键，而探针必须问**组件那个窗口**（问主窗口自己只会得到主窗口的层级），所以先 `Runner::label_of` 反查 label。它只读、幂等，别在里面顺手 `apply_to`。
- **检查器那行读数是等宽小字、不是提示**：它存在的唯一理由是让"我点了没效果"从四次猜测变成一个事实。要的和实际的对不上必须红字写出来（`probeLabelKey` + `expectedProbe`），五句话五种状态（`workerw` / `bottom` / `normal` / `topmost` / `unknown`）—— 降级和成功长得一样的话，这行等于没写。

已修（别再改回去）：iframe 的沙箱必须带 `allow-forms`。少了这一位，浏览器会把表单提交整条拦掉 —— `submit` 事件不触发、控制台不报错，组件里"输入框 + 回车"这种最普通的写法静默失效（待办清单就这么空转了一整版：字打得进去，回车没反应，列表永远是"Nothing here yet"）。`tests/todo-add.html` 钉住了这件事：同一条提交路径，有 `allow-forms` 就写盘，没有就 0 次写盘。改沙箱属性时两处一起改：`src/widgetHost.ts`（桌面窗口）和 `src/platform/WidgetFrame.tsx`（画布）。

已修（别再改回去）：右上角那块地方要让给窗饰。桌面窗口的功能图标浮在 `top: 6px; right: 6px`，大约 120×28（五颗按钮），鼠标一进卡片就淡入，而且**真的能点**。组件把输入框、按钮、可点列表项摆在那儿，用户点下去点到的是"收回"。待办清单的解法是顶部先放一条 22px 标题栏（`padding-right: 120px`），窗饰正好落在标题栏右端。新组件照抄这条，或者整块内容避开右上角。**给窗饰加按钮时，两个组件的 `padding-right` 和 `tests/note-layout.html` 的 `PILL_WIDTH` 要一起加**，否则正文又被压住。

补一次（2026-10-24）：**这条以前只是"新组件照抄"，没人回头量过老组件**。写了个一次性探针 `.scratch/chrome-fit.html`，把 14 个包按各自清单里的尺寸放进 iframe，量出所有落在右上角那块 120×28 里的元素（带内容的、可点的才算），结果三条中枪：
- **`lattice.calculator`** —— 页签从 8px 就开始排，最右边那颗 `Hash` 整颗在按钮底下（`x 198–290, y 10–31`）。加了一条 22px 标题栏。
- **`lattice.calendar`** —— 月份栏铺满整张卡片，`›`（下个月）在 `x 270–292`，标题右半截也在底下。给 `.cal-head` 加 `padding-right: 120px`，标题允许省略号截断。
- **`lattice.stopwatch`** —— 34px 的读数从 8px 起排，右上角那截数字被压住。同样加了 22px 标题栏。

三个都升到 0.1.1 并补了 changelog。改完再跑一遍探针：`affected=0`。**新组件一律先跑这个探针再交付** —— 它量的是真布局，不是"看起来没问题"。用法：`npm run dev` 起着，然后
```bash
chrome --headless=new --window-size=1560,1500 --virtual-time-budget=25000 \
  --dump-dom http://localhost:1420/.scratch/chrome-fit.html
```
预算要给到 25 秒（14 个 iframe 依次加载，9 秒截到的是半截）。探针只打印不断言，别塞进 `npm run test:browser`：那里每个页面只有 9 秒。

同一条规矩还有个"看不见"的版本：**正文从顶上就开始排的组件**（便签）不会"点错"，而是正在写的那一行被压住 —— 打字的人手不离键盘、指针一动不动，窗饰也就不动。所以那 24px 里别留空带，放一条真信息（便签放的是保存状态）。判据是正文起点 `y ≥ 34`（窗饰下沿），`tests/note-layout.html` 直接量这个数。


已修（别再改回去）：**组件能读也能控制系统媒体会话**。`media.rs` 走 WinRT 的 SMTC，桥上是 `media.get` / `media.control`，共用 `media:control` 一项权限。四条别踩回去：**每次调用自己 `CoInitializeEx(COINIT_MULTITHREADED)`，返回值故意不看**（已经初始化过会返回 `RPC_E_CHANGED_MODE`，那不是失败；不初始化直接调才是 `RPC_E_NOT_INITIALIZED`）；**没有会话时返回 `null` 而不是错误**（桌面上没开播放器是常态，组件该显示"没在放"）；**`TimeSpan` 是 100ns 单位，除 10000 才是毫秒**；**`IAsyncOperation::join()` 阻塞等、不加超时**（组件侧桥调用本来就有 3 秒超时，再套一层只是多一条失败路径）。唯一用户是 `public/widgets/lattice.music`（v0.9 从 `lattice.media` 改名而来），`tests/music.html` 71 条断言钉着它的渲染与控制。（`agent:activity` 那项权限的内置用户——v0.8 的 `lattice.agent` 看板——在 v0.10 连包删了，桥和权限留着给第三方。）

已修（别再改回去）：**声音高低是"回环采集"，不是问 SMTC**。`audio.rs` 在默认输出设备上开一路 `AUDCLNT_STREAMFLAGS_LOOPBACK`，每块算一个 RMS 就把采样丢掉，桥上是 `audio.level`（权限 `audio:level`，**单独一项、没并进 `media:control`**：读会话拿的是歌名歌手，这条线拿的是正在播出来的声音本身，并在一起等于"我要控制播放"顺带拿到了"听你电脑在放什么"）。六条别踩回去：**采集线程只有一个、常驻**（一次 `Initialize` 十几毫秒，按调用现开现关会让线一顿一顿；命令只锁一个 f32 读一下，所以它是同步命令，不是 `async`）；**`GetMixFormat` 的内存是系统分配的，`wBitsPerSample` / `nChannels` 必须在 `CoTaskMemFree` 之前抄下来**（free 之后再解引用是 use-after-free，编译器不拦）；**`frames` 是帧数不是采样数，要乘声道数**（少乘只是漏读右声道，多乘就越界读）；**静音块看 `AUDCLNT_BUFFERFLAGS_SILENT`，别解引用那个指针**（系统说这段是空的，内存可能根本没写过）；**没有设备 / 被独占时 `running: false` + `level: 0` 不是错误**（两秒后自己重连，组件画平线）；**组件 80ms 一问就够**（后端 40ms 更新一次，问得更密不会更新得更快，只会把桥压满 —— 它比调度器 250ms 的下限密，所以组件用自己的 `setInterval`，不是 `schedule.every`）。纯逻辑在 `audio_policy.rs`（6 条 `rustc --test`），WASAPI 那半边只有真机能验：`audio_policy.rs` 测不到指针，`audio.rs` 编不进壳子。

已修（别再改回去）：**`.lattice` 包能装也能打**。打包在 `scripts/pack-widget.mjs`（手写 ZIP），装在 `package.rs` + `package_policy.rs`。四条别踩回去：**打包必须确定性**（条目排序、DOS 时间戳固定 1980-01-01、UTF-8 名），否则"这个包是不是我发的那个"永远无法回答，以后也没法签名；**zip-slip 要防两道**（`safe_relative_path` 拒 `..`/绝对路径/盘符，`join_inside` 在真正写盘那处再验一次）；**安装要原子**（先解到 `<id>.incoming`，成功了才删旧的、改名），解到一半失败不能留下半个组件；**任何一条不过就整包拒绝**，不做"部分安装"。`install_widget` 的入参是 `source`（目录或 `.lattice` 文件），改名时记得同步 `App.tsx`。

已修（别再改回去）：**调试面板**（`Ctrl+Shift+D`）。桥调用和组件 console 汇到 `runtime/debug.ts` 的环形缓冲，面板只负责画。四条别踩回去：**tracer 挂在 `BridgeContext` 里，不是模块级全局钩子** —— 画布上同时挂好几个实例，全局钩子只会剩下最后一个，别的实例的调用全记到它头上；**桌面窗口的记录靠 `emit("lattice:debug")` 攒批过来**（400ms 或 50 条一次），主窗口在启动时就订阅，面板关着也在收；**组件的 console 由 `widget-reporter.js` 转发**（`__lattice` + `type: "log"`，限速 40 条/秒），这条通道以前不存在，vite dev 不转发组件窗口的 console；**过滤和统计是纯函数**（`filterRecords` / `summarize`），别把逻辑写回组件里 —— `tests/debug.html` 靠它们做断言。

已修（别再改回去）：**SDK 是"随包分发的普通文件"，不是 npm 依赖**。`packages/sdk/lattice.js` 是唯一真源，每个用到它的组件目录里都有一份拷贝（`scripts/sdk-sync.mjs` 负责刷，`--check` 只查不改）。改 SDK 之后**必须跑 `npm run sdk:sync`**，否则 `npm run test:sdk` 会红 —— 那条测试就是为"忘了同步"准备的，别把它删了。`public/widgets/` 下的官方组件**刻意不用 SDK**：它们是"不装 SDK 也能写"的证明，也是 SDK 的唯一回归基准。

已修（别再改回去）：**公开的演示钥匙不算身份**。内置目录（随应用发的那份 `public/store/`）是 `npm run dev` / `npm run build` 现场用仓库里那把**公开的** `scripts/dev-publisher.key` 签出来的（不签的话开箱就报"签名验不过"），而远端目录用发布者自己的钥匙 —— 于是同一个组件在两处有两把钥匙。以前从内置目录装过的人一切源就会看到红色的 "Publisher key changed"，而那是一次**没发生过的换人**：两把钥匙都是我们自己发的。现在 `runtime/catalogue.ts::isDemoPublisherKey` 把那把公开钥匙排除在钉子之外（`CatalogueSection` 算 plan 时当它不存在，`App.tsx` 也不写进 `trustedKeys`）。四条别踩回去：
- **这个例外只针对那一把公开钥匙，不要扩成"某几个 id 免检"**。给具体组件开后门，等于把第三道校验拆了。
- **换 `scripts/dev-publisher.key` 要同步 `DEMO_PUBLISHER_KEY`**，否则老机器上会重新开始弹提示（常量旁边写着原因）。
- **别的钥匙照样要人点头**。`tests/store-ui.tsx` 最后那段有两条对照：钉演示钥匙 → 照常 Install；钉别的发布者钥匙 → 仍然 "Publisher key changed"。
- **两把钥匙这件事本身是设计**（内置那份必须能在 clone 下来之后直接签），不是待修的 bug。要"统一成一把"，得先解决"没有私钥的机器怎么跑 `npm run dev`"。
