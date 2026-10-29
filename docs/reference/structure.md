# 文件都在哪

> 一句话一个文件：**它在哪、它管什么、它的真源是不是别处**。
>
> 这张表只回答"在哪"，**不回答"必须怎样"** —— 约束在 [AGENTS.md](../../AGENTS.md) 第 4 节，组件作者的契约在 [WIDGET_SPEC](../WIDGET_SPEC.md)。和代码冲突时以代码为准，并顺手回来改这一行。
>
> 按目录排，不按时间。**加了文件就补一行**（`AGENTS.md` 第 3 节只留五条落地前就要知道的，逐文件的说明在这里）。

```
src/
  App.tsx                 平台外壳：顶栏、编排、桌面窗口回传事件的处理
  main.tsx                React 入口（平台外壳）
  assistantMain.tsx       React 入口（assistant 小窗）：只挂 `AssistantWindow`，**不加载 store**
  styles.css              平台样式层（CSS 变量 + 语义类，不引 Tailwind）
  widgetHost.ts           桌面窗口的宿主页：装 iframe、画窗饰、处理拖拽缩放
  widgetHost.css          窗饰与缩放手柄样式
  platform/
    store.ts              Zustand + 文件落盘适配器（Placement / 授权 / 主题 / desktopRects / 回收站）；`instanceIdFor` 是新实例 id 的唯一拼法
    Canvas.tsx            画布：放置、空态、缺失组件占位
    WidgetFrame.tsx       画布里的一个组件实例 = 一个沙箱 iframe + 拖拽缩放；**也是数据平面答话的那一份**（挂载时登记 `agent-call` 处理器，卸载按 handler 身份删）；`desktopMode` 下另有一份真窗口在跑时它退成静态卡（`poster`，判据 `canvasNeedsLiveFrame`），不挂 iframe
    LibraryPanel.tsx      组件库：已安装 / 可安装 / 加载失败 + 搜索过滤 + 评分与举报入口 + 回收站那一段（有内容才画）
    LibSection.tsx        可折叠的一段：标题行（开合 + 计数）+ 右侧动作位（组件库与属性面板共用）
    CatalogueSection.tsx  商店区：目录条目的一行（可展开：版本 / 权限差集 / 指纹）、安装 / 更新 / 换钥匙确认
    HelpContent.tsx       组件的"怎么用"：分节正文 + 可折叠变更记录；属性面板与卡片 `?` 共用这一份
    ReportDialog.tsx      举报与评分对话框（没有服务端，落成一份 JSON 文件）
    InspectorPanel.tsx    属性面板：三段折叠（层级与尺寸 / 外观 / 权限与选项）；**没有移除按钮** —— 那件事在卡片右键菜单里（`WidgetMenu`），这页只留一行指路的小字
    WidgetMenu.tsx        卡片的右键菜单（portal 到 body）：组件名一行 + 层级切换（标签跟着当前层级翻）+ 复制一份（`duplicatePlacement`：几何 / 层级 / 配置跟着原件，挪 16px，选中新的）+ 移除（红的那一行沉底）；iframe 里面的右键**不接管**（组件自己的退出口）
    SettingsMenu.tsx      设置面板：左导航七区（Account / Appearance / Language / Desktop / Widgets / Assistant / About）+ 焦点陷阱（Ctrl+, 唤出）
    ProfilePanel.tsx      档案页：资料编辑 + 使用热力图（53 周）+ 清除记录 / Sign out（危险区沉底）
    Avatar.tsx            共用的首字母头像（顶栏齿轮、设置身份块、档案页）
    icons.tsx             16px 图标集（Glyph / ICON / ThemeGlyph / PanelGlyph / WidgetIconMark），顶栏、菜单、面板共用
    desktop.ts            Placement → WidgetWindowSpec，坐标换算，投放/收回命令
    autostart.ts          开机自启的读写与"路径漂移"判定（`Run` 注册表项）
    catalogue.ts          商店客户端：读目录（内置走 fetch / 远端走 IPC）、下载安装、备份与回滚、写举报
    DebugPanel.tsx        调试面板：桥调用与组件 console 的实时抽屉（Ctrl+Shift+D）
    assistant.ts          assistant 的 IPC 面：读写模型档（profiles）、列模型（测试连接）、跑一轮对话（工具循环 ≤24 步、审批、预算）、会话的读存删（`listSessions` / `loadSession` / `saveSession` / `deleteSession`，一条会话一个文件）；动作交给 surface（主窗口本地跑 / 小窗转给主窗口），新手交给 `platform/hands.ts`（走 Rust）—— `handGroup(name)` 非空就是后者（`AssistantSurface`）
    hands.ts              assistant 的手的 IPC 面：`assistant_tool` / `hands_cancel` / 开关读写（`assistant_hands*`）/ 模式（`assistant_mode*`）/ 技能包四条；参数序列化成字符串递过去，返回 `AgentReply` 形状
    agent.ts              agent 动作执行器：白名单动作走真 store，回快照（带每个组件的说明首句 `about`，没写说明就是空串）（`tests/agent.html` 70 条）
    widget-tools.ts       数据平面的执行面：画布实例的登记表（一个 instanceId 一个「能答话的 iframe」）+ `callWidgetTool`（8 秒超时、回话归一化、`not-running`）+ `listWidgetTools`（这一轮能调什么：清单 × 摆放，判据在 `runtime/widget-tools.ts`；小窗那份也是问它）；纯逻辑在 runtime/widget-tools.ts
    AssistantPanel.tsx    assistant 的面板：一列模型档 + 表单 + **模式胶囊**（内部 / 完全访问，0009；`mode` 的值仍叫 `internal` / `everything`；**只有状态，没有按钮**；0035 起从"横贯一整行"变成对话区顶上一颗胶囊）+ **输入卡左下那颗警示色药丸**（完全访问的入口/出口：`Enable Full access` ↔ `Turn off full access`，0009 §7）+ 六组能力开关（设置态那个入口是手那一段头上一颗「Enable Full access」，和药丸走同一个 `requestFullAccess` 的统一确认：勾「我明白风险」才能按、确认时顺手把六组拨开、只读档压住时按钮是灰的；完全访问期间六组画成勾且锁上）+ **审批档三选一**（Ask / Automatic / Read-only，`APPROVAL_LABELS`）+ 审批确认条 + **两栏**（0034：左 208 会话栏 / 右对话；会话按 今天/昨天/更早 分组，悬停「⋯」重命名或删除，底部一颗设置；设置态复用同一条栏做四格分区，`hidden` 一次只显示一块）+ **会话栏可收起**（0035：顶栏 ☰ 与 `Ctrl+B`，收起时 `＋`/`⚙` 落到顶栏，状态存 `assistant-window.json` v4 的 `sidebar`）+ **输入卡**（0035：`＋` 加号菜单 / 模式药丸 / 元信息 / 麦克风贴发送 / 圆形三角发送，空草稿时发送钮是灰的，忙碌时变方块 Stop；`textarea` 随内容长到 6 行封顶）+ 空态三颗可点的例子（点了填进输入框，不直接发），工具结果一行一个（抽屉与小窗共用这一个组件）
    AssistantWindow.tsx   assistant 小窗的壳：标题栏（底板 / 锁 / 藏 —— **没有"浮窗↔桌面"那颗**，它长得像最大化、2026-10-25 删了，见 0007；换层级现在走底板面板里那行 `On the desktop` 开关）+ 面板 + 底板三层（canvas 壁纸 / veil 底色 / 内容）+ 三个缩放手柄；底板面板是**一个明暗开关 + 浓度 + 模糊 + 一行层级开关**（`isDarkTint`，别改回三颗药丸）；标题栏图标一律 SVG + `currentColor`（emoji 是彩色的，一排里只有它不听话）；**没有 store**，动作走 `remoteSurface()`，窗口自己的状态走 `assistant-window.json` v4（0007 / 0035 / 0036：v3 多一个 `sidebar`，v4 多一个 `fontScale`）
  runtime/
    manifest.ts           清单校验与归一化；Permission 类型与中文标签（唯一真源）；`agent.tools`（组件声明的工具，规则在 runtime/widget-tools.ts）
    config.ts             每实例配置：清单 schema（5 类字段）、归一化、值合并
    help.ts               组件说明与变更记录：清单里的 `help` / `changelog`、上限、逐条丢弃（纯函数，`tests/help.html` 钉着）
    registry.ts           组件发现：bundled（public/widgets）+ user（%APPDATA%）；入口地址解析
    bridge.ts             RPC 桥：方法表、权限闸门、平台内置方法
    save-file.ts          `file.save` 的参数规则：名字只当文件名（不是路径）、单文件还是 zip、扩展名按内容补、取消不是错误（纯函数，`tests/export.html` 27 条钉着；Rust 侧那一份是 `export_policy.rs`）
    term.ts               终端的事件形状（`TermEvent` / `TermState`）：两个宿主只按 `instanceId` 转发，不解释正文
    appearance.ts         底板外观模型：归一化、合成色、亮度阈值
    diagnostics.ts        错误通道：认出组件报上来的错、去重指纹、挑主错误
    widget-reporter.js    注入进组件文档的上报脚本（**唯一真源**，两条发文档的路都读它）
    schedule.ts           心跳时间轴：可见性取"与"、不可见停摆、回来补一拍
    screen-fit.ts         纯几何：锚点选屏、夹紧（入参一律物理像素，`tests/screen-fit.html` 钉着）
    close-guard.ts        ✕ 该不该认这一下：指针序列 + 命中测试（纯函数，`tests/close-guard.html` 钉着）
    assistant.ts          assistant 的纯逻辑：8 个工具的函数表 + JSON Schema、工具表裁剪（`toolsFor`）与合表（`allTools` = 桌面动作 + 手 + MCP + **组件声明的工具**，四路都从这一个口进）、**三档审批的唯一判据 `approvalFor(name, mode, ctx)`**（`allow` / `ask` / `deny`，`ctx` 带 `everything` / `path` / `workspace`；`readonly` 排最前、平台自身配置在任何档任何模式下都要问，只读档连桌面表一起剪空）、system prompt（含手那一段、组件工具那一段与只读档的开口）、人设片段、历史裁剪（条数 + 字符数两道上限）、线上形状（`parseAskMessages` / `normalizeAskMessages`）、OpenAI 消息形状、快照压缩、商店里还没装的组件那一段（`CatalogueHint` / `aboutLine`，最多 8 条）（`tests/assistant.html` 188 条）
    skills.ts             assistant 的技能包（0005）的纯逻辑：`charCount`（按码点）、`normalizeTools` / `missingGroups`（"这个技能要用 Files，而它关着"）、`checkBudget`（4 份 / 4 000 / 8 000，返回原因与数字，话由界面说）、`promptsOf`（只挑启用了且没坏的）、`skillsPrompt`（"先照它，再照你自己的习惯" + 每份一节）（`tests/skills.html` 55 条）
    hands.ts              assistant 的手的纯逻辑（0004）：六个能力组、11 个工具的 JSON Schema、**两个模式的判据 `effectiveHands` / `modeIgnoresSwitches`**（0009：内部照存的开关、完全访问一律算开、不写盘）与 `grantAllHands`（**只写那六个开关**，由「Enable Full access」那道确认调用：先拨开六组、再写模式，所以你按完看到的六个勾就是它拿到的权力）、`HAND_READY`（拨得动 ≠ 接好了）、`handGroup` / `needsApproval` / `handsTools` / `handsPrompt` / 确认条那一行、MCP 发现结果合表（`mcpToolSpecs`）与命令行切词、一轮的预算（`tests/hands.html` 130 条）
    llm-models.ts         模型档的纯知识：按模型名前缀查能力（能不能调工具 / 能不能给 temperature / 上下文多大）、历史字符预算、三种鉴权形状（bearer / api-key-header / none）、七个服务商的预置填写（纯函数，`tests/llm-models.html` 42 条）
    llm-errors.ts         供应商失败的**前端那一半**（0014）：把 `@@llm:{…}` 抬头拆成「码 + 状态 + 供应商原话」，按码挑句子（`describeFailure`）；认不出就原样返回，所以每个错误位都能无脑套（`tests/llm-models.html` 钉着抬头字面量与 `llm_policy.rs` 一致）
    align-guides.ts       拖动时的对齐吸附：每条轴只挑一条获胜线，容器边界也是候选、且认原点；`guideLines` 再把获胜线变成一段局部虚线（以被拖的那张为中心、两端各伸出半个卡 + 48px，再夹进容器）（纯函数，画布与桌面共用，`tests/align-guides.html` 钉着）
    library-search.ts     组件库搜索：切词 + 命中判定 + 排序（档位 × 字段权重；`matchScore` 是唯一判据，`matchesWidget` 与 `rankWidgets` 都从它出去）（纯函数，`tests/library-search.html` 36 条钉着）
    trash.ts              组件回收站的纯逻辑（VELA §3.3）：留 20 条 / 7 天、同一实例一个坑、`canRestore`（组件还装着才让恢复）；条目就是 `ClosedPlacement`，不另存一份快照（纯函数，`tests/trash.html` 20 条）
    onboarding.ts         首次引导的纯逻辑（0011）：`firstRunVisible`（只在"没按过 `Got it` **且**一件都没装"时出卡 —— 少了后一条，老机器升级上来会被问一次"要开始吗"）、`catalogueDeadEnd`（源里没东西 / 全都装过早，两种"没得装"各说各的；搜索中闭嘴）（纯函数，`tests/onboarding.html` 22 条）
    i18n.ts               界面文案的中英切换：**key 就是英文原句**、缺翻译退化成英文、`useT()`（组件）/ `t()`（模块）/ `setLanguage()` / `languagePayload()`（给组件看的"现在是哪一门"，`tests/i18n.html` 钉着）
    i18n/*.ts             中文表按域分片（common / shell / library / panels / settings / assistant / misc）；**纯数据，一个 import 都不许有**
    widget-text.ts        组件**作者写的**文案：字符串或 `{ zh, en }`、`pickText` 按语言挑（缺一门退另一门）、`textVariants` 给搜索建两门索引、`normalizeLine` 管日期/单位（`tests/widget-text.html` 钉着）
    assistant-window.ts   assistant 窗口的**纯逻辑**（0007）：两个模式、尺寸上下限、`clampAssistantRect`、`defaultAssistantRect`、`migrateAssistantWindow`（v1 → v2、坏值逐项退回、坏文件坏 rect 都给一个能用的窗口）（`tests/assistant-window.html` 33 条）
    widget-tools.ts       数据平面的**纯逻辑**：清单 `agent.tools` 的归一化（坏条目逐条丢、最多 8 条 / 每条 6 个参数）、工具名 `widget.<组件 id>.<工具名>` 的拼与拆（**从右边切**）、给模型的 schema（同一组件的多份实例合成一条，`instanceId` 只在多于一份时必填）、谁能进表的唯一判据 `widgetToolSources`（装上了 + 授了 `agent:tools` + 真声明了）、回话归一化（超 4000 字符**拒绝不截断**）（`tests/widget-tools.html` 55 条）
    debug.ts              调试总线：环形缓冲 400 条、攒批镜像到主窗口、过滤 / 统计纯函数
    semver.ts             版本号与范围：解析 / 比较 / `^ ~ >= <= > < =` / 通配 / `||`（纯函数，`tests/semver.html` 钉着）
    usage.ts              使用记录与热力图：本地日键、固定阈值分档、53 周网格、连续天数、两种读回形状（纯函数，`tests/usage.html` 钉着）
    catalogue.ts          目录解析与安装计划：三道校验、挑版本、权限差集（纯函数，`tests/catalogue.html` 钉着）
assistant.html            assistant 小窗的宿主页（vite 第三个 input；独立入口 = 小窗不加载平台外壳与 store）
public/widgets/           官方组件包（未安装前只是"可发现"）
public/store/             内置商店目录（`npm run store:index` 生成：registry.json + packages/*.lattice，**不进仓库**）
examples/counter/         第三方组件的参考实现（用 SDK），拖进窗口即可安装
packages/sdk/             @lattice/sdk：零依赖 ES module + .d.ts + README（**唯一真源**）
scripts/
  widget-index.mjs        生成 public/widgets/index.json
  widget-diagnostics-plugin.mjs  给内置组件注入上报脚本（dev 中间件 + build 收尾）
  widget-diagnostics.test.mjs    注入规则的单测（`npm run test:injection`）
  create-widget.mjs       脚手架：`npm run create:widget -- <id>`
  pack-widget.mjs         目录 → .lattice（手写确定性 ZIP）
  sign-widget.mjs         ed25519 签名 / 验签 / 生成密钥（`npm run sign:widget`）
  store-index.mjs         打包 + 签名所有内置组件，写 public/store/registry.json（`npm run store:index`）
  winget-manifest.mjs     一个 NSIS 安装包 → winget 的三份 YAML（`npm run winget:manifest`）：直链与 SHA-256 都从那个 exe 现算，写 `dist-winget/`（不进仓库）
  winget-manifest.test.mjs  上面那道的形状：哈希大写、直链与附件名同源、Publisher 取 identifier 第二段、两次生成逐字节相同（`npm run test:winget`，11 条）
  dev-publisher.key       **开发用**签名种子（故意进仓库，见不变量 15）
  sdk-sync.mjs            把 packages/sdk 的两个文件刷进所有内嵌副本（`--check` 只查不改）
  sdk.test.mjs            副本一致性 + SUPPORTED_SDK 版本对齐（`npm run test:sdk`）
  check-tokens.mjs        三张表（字号 / 圆角 / 间距）的守门人，只读（`npm run check:tokens`）
  check-tokens.test.mjs   上面那道的测试：规则本身 + 仓库现状（`npm run test:tokens`）
  tauri.mjs               tauri CLI 包装（补工具链 PATH）
  lattice-agent.mjs       agent 客户端 CLI（`npm run agent -- state|act|ping`，零依赖）
  lattice-agent.test.mjs  上面那道的测试：起假端点，测请求形状与退出码（`npm run test:agent`）
  dev-llm-proxy.mjs       浏览器预览那条 `/api/llm` 中间件：`llm.rs` / `llm_policy.rs` 的替身（base URL、三种鉴权、失败码与那条 `@@llm:` 抬头、`assistant.json` 的读写）；**认得的归一化、不认识的顶层字段照抄回去**（0015）
  dev-llm-proxy.test.mjs  上面那道的测试：起假 provider，测请求形状、失败抬头与配置往返（`npm run test:llm-proxy`，28 条）
src-tauri/src/
  lib.rs                  命令注册、WebView2 启动参数、自定义协议注册、主窗口关闭守卫
  protocol.rs             lattice-widget:// 静态文件服务（用户组件的 HTML/CSS/JS）
  csp.rs                  组件文档的 CSP：一处生成策略，protocol.rs 只负责挂头
  egress.rs               出网闸门：WebView2 层拦帧导航，组件出不去
  guides.rs               桌面参考线：邻居窗口矩形 + 工作区交给前端算吸附，再把线交给叠层窗口
  guides_overlay.rs       参考线的两条 1px `WS_EX_LAYERED` 窗口 + 专用消息线程（不是透明 WebView2；每帧连尺寸一起改，所以线是局部短段）
  guide_policy.rs         上面那道的纯逻辑：虚线节拍、亮度、颜色解析（5 条 `rustc --test`）
  network.rs              出网代理（WinHTTP）：权限 → 白名单 → 形状，三道闸
  network_policy.rs       上面那道的纯逻辑：URL 解析 + 主机白名单匹配 + 白名单来源（12 条单测）
  crash.rs                ICoreWebView2::add_ProcessFailed 胶水：认崩溃类型、记账、重载
  crash_policy.rs         上面那道的纯逻辑：何时重载 / 何时放弃（9 条单测）
  diagnostics.rs          组件坏了给人看的东西：兜底页 + 注入的错误上报脚本
  runner.rs               Placement → 真实窗口的增量同步、宿主页配置、事件回传、暂停开关
  tray.rs                 托盘图标与菜单（打开主窗口 / 暂停全部 / 退出）
  watch.rs                组件目录监听（ReadDirectoryChangesW + 300ms 静默去抖）
  watch_policy.rs         上面那道的纯逻辑：读通知缓冲区（5 条单测）
  autostart.rs            HKCU Run 注册表项：开机自启的读写与修复
  autostart_policy.rs     上面那道的纯逻辑：命令行的拼 / 剥（5 条单测）
  desktop.rs              Win32：WorkerW 挂载、HWND_BOTTOM/TOPMOST、圆角裁剪、扩展样式、底层守卫
  visibility.rs           真实可见性：最小化 / 收起 / 被整个盖住，发 lattice:window-visible
  occlusion.rs            遮挡判定（Win32）：九点 WindowFromPoint + DWMWA_CLOAKED，点透窗口跳过
  occlusion_policy.rs     遮挡的纯逻辑：采样点怎么取、几个没命中算挡住（8 条 rustc --test）
  usage.rs                使用记录：按窗口焦点每分钟 +1，内存累加、每 5 分钟 / 退出落盘（usage.json）
  usage_policy.rs         上面那道的纯逻辑：日键校验、分钟累加、400 天裁剪（8 条 rustc --test）
  open.rs                 打开外链：把 shell.open 交给系统默认浏览器（协议由 open_policy 卡）
  open_policy.rs          上面那道的纯逻辑：只放 http/https、像地址栏一样补协议头（5 条 rustc --test）
  export.rs               `file_save`：一次系统保存对话框（`tauri-plugin-dialog`）+ 写一个文本文件，或者按 `files` 打一个 zip（deflate，压不小就 stored）；**先全部解码再弹框**，写得进去才动盘
  export_policy.rs        上面那道的纯逻辑：名字清洗（与 `save-file.ts` 各判一遍）、单文件还是 zip、base64 解码、CRC32、DOS 时间、zip 头字节与 EOCD（14 条 rustc --test，**不引 crate**）
  power.rs                电源读数（系统卡片上电池那一行用）：一次 `GetSystemPowerStatus` 拿交流 / 电池两态、百分比、剩余分钟与省电模式，直接调 Win32 不引 crate。0.3.0 起电池组件下架，命令仍是独立一条（卡上挂两条心跳：1000ms 指标 / 30000ms 电源）
  power_policy.rs         上面那道的纯逻辑：255 这类「不知道」的哨兵值、百分比上界、剩余时间只在放电时给（6 条 rustc --test）
  agent.rs                Agent 端点：只绑 127.0.0.1 的 HTTP、令牌、审计、转发给主窗口（默认关）；小窗要的 `assistant_snapshot` / `assistant_act` / `assistant_widget_tools` / `assistant_widget_call` 也复用这条转发（后两条是数据平面，见 0013）
  agent_policy.rs         上面那道的纯逻辑：HTTP 三态解析、Bearer 常量时间比对、动作白名单、`say` 的单行化与超长拒绝（26 条 rustc --test）
  llm.rs                  内置 assistant 的模型面：`assistant.json`（v4：`{version, mode, skills: {enabled}, activeId, hands, approvalMode, workspace, profiles[]}`）读写与 v1 就地升级、环境变量覆盖、十六个命令（llm_profiles / llm_profile_save / llm_profile_remove / llm_profile_activate / llm_set_key / llm_models / assistant_config_path / assistant_config_open / assistant_config_import / llm_chat / llm_chat_stream / llm_chat_cancel / assistant_hands / assistant_hands_save / assistant_mode / assistant_mode_set）、**模型档导入**（`assistant_config_import`：认三种形状 —— 裸数组 / `{profiles: […]}`（整份 `assistant.json`）/ v1 的平铺 `{baseUrl, model}`；同 id 先、其次同地址，空 key 不覆盖已有 key，手与工作区与审批一概不导 —— 语义写在 `merge_profiles` 上方）、**没带 key 的本机地址落成 `auth: none`**（空 Bearer 只会换来 401，和 `migrate_legacy` 同一句判断），**两个模式（0009）的存盘与切换也在这里**（`mode` 坏值一律落 `internal`，切换进审计）、**技能启用清单的存盘**（`skills_enabled` / `set_skills_enabled`，目录归 `skills.rs`）、出网走 `network::send` 或 `network::stream`、审计只记模型与字数
  llm_policy.rs           上面那道的纯逻辑：base URL 归一化与回环判定（`is_loopback` 判主机、`loopback_base` 判整个 base —— "没带 key 的本机地址"靠它认）、三种鉴权形状的请求头、档位 id 与显示名、请求体拼装（stream 只是多一个字段）、消息与工具校验、`/chat/completions` 与 `/models` 的应答解析、SSE 切帧与增量累加、401/404/429 的给人看的话（50 条 `rustc --test`，**不引 crate**）
  hands.rs                assistant 的手（0004）：`assistant_tool` 分发与 `hands_cancel`，文件（list/read/search/write）、命令（shell.run：PowerShell 子进程、25ms 轮询、超时/取消都真的 `kill()`）、网页（web.fetch：跟 ≤5 跳重定向、HTML 折成正文）、屏幕（screen.windows 列可见窗口 / screen.capture 拼 PNG）、键鼠（input.click/type/key 走 SendInput）、审计只记形状；**完全访问（`everything`）那两道闸在这里**（`mode_now` 每次调用现读配置、审计写不进去就不执行、行尾 ` · everything`）；`spawn_blocking` 里跑，别占异步运行时
  skills.rs               技能包（0005）的目录面：四条命令（assistant_skills / assistant_skills_save / assistant_skill_import / assistant_skill_remove）、扫 `skills/<id>/SKILL.md`（读不成的标 `damaged`，不拦列表）、导入（目录或一个 .md，撞名 `<id>-2`，200 KB / 2 MB / 200 个文件三道额度）、删目录并从启用清单里剔掉；**导入不启用**，正文随清单递给前端
  skills_policy.rs        上面那道的纯逻辑：front matter 三键解析（坏行逐条丢、BOM/CRLF 都认）、`id` 字母表与 `slug` / 撞名后缀、4 份 / 每份 4 000 字 / 合计 8 000 字三道上限（按码点算，超了**拒**不截断）（19 条 `rustc --test`，**不引 crate**）
  hands_policy.rs         上面那道的纯逻辑：工具名 → 能力组 / 审批档、`mcp.<server>.<tool>` 的形状、六个开关、**三档审批**（`APPROVAL_MODES` / `normalize_approval` / `readonly_blocks`：只读档拦的正是 `needs_approval` 为真的那些，和前端 `approvalFor` 同一句判据）、**两个模式**（`ASSISTANT_MODES` / `normalize_mode` / `effective_hands` / `everything_overrides`：坏值落 `internal`、`readonly` 优先，和前端 `runtime/hands.ts` 同一份判据）（21 条 `rustc --test`，**不引 crate**）
  fs_policy.rs            文件那几只手的额度：路径归一化、二进制判定、行/字数上限、搜索跳过表、子树判定（14 条 `rustc --test`，**不引 crate**）
  shell_policy.rs         命令那道的形状：超时夹紧、空命令/NUL/`\r` 拒绝、输出按行截断（9 条 `rustc --test`，**不引 crate**）
  web_policy.rs           网页那道的形状：`Location` 解析（绝对 / `//` / `/` / `?` / 相对 + `.`/`..` 折叠）、HTML 折正文（去 `script`/`style` 体、块级换行、实体表）、字符上限与截断（21 条 `rustc --test`，**不引 crate**）
  screen_policy.rs        屏幕那道的形状：窗口判据（不可见 / cloak / 无标题 / 零尺寸）、标题压平与按字符截断、截图落点、PNG 容器（签名 / IHDR / IDAT / IEND、CRC32、每行滤波字节、stored zlib）（21 条 `rustc --test`，**不引 crate**）
  input_policy.rs         键鼠那道的形状：键名 → 虚拟键码（含 F1–F24 与 OEM 标点）、`Ctrl+S` 解析、文字 → UTF-16 按键序列（中文 / emoji / 换行）、虚拟桌面归一化到 0..65535（23 条 `rustc --test`，**不引 crate**）
  term.rs                 终端组件（`lattice.term`）的那条常驻 shell：一实例一条 `powershell.exe`（`pwsh` 兜底）、哨兵切分、输出按 `lattice:term` 事件推、环形补发、两条收尸路（实例销毁 / 应用退出）；三只命令 `term_write` / `term_stop` / `term_state`，外加 `term_dispose`
  term_policy.rs          上面那道的纯逻辑：哨兵与命令脚本（UTF-8 → base64 那条通道）、preamble、安全前缀切分（**整段**哨兵也要留住，等换行）、`Done` 解析、退出码（cmdlet 失败不借上一条原生命令的旧码）、环形缓冲上限、单命令 64KB 夹紧（16 条 `rustc --test`，**不引 crate**）
  mcp.rs                  assistant 的第六只手（0004 的 P6）：`mcp.<server>.<tool>` 的发现与执行 —— `mcp.json`（`{version, servers: [{id, label, transport, command, args, url}]}`）读写、两种传输（stdio：`cmd /C` 起子进程 + 换行分隔的 JSON-RPC + `CREATE_NO_WINDOW`；http：streamable POST + SSE `data:` 帧 + 回 echo `Mcp-Session-Id`）、`initialize` → `notifications/initialized` 握手、`tools/list` 发现与 `tools/call`、三个命令（mcp_servers / mcp_servers_save / mcp_tools）；**一次调用一条连接，不复用**；`spawn_blocking` 里跑
  mcp_policy.rs          上面那道的纯逻辑：工具名三段形状（`mcp.<server>.<tool>`）、服务 id 的字母表与撞名去重（`_2`）、工具段压成 `[a-z0-9_-]`、`cmd /C` 的命令行拼装与引号、换行分隔 JSON 的切帧、三种请求体（initialize / tools-list / tools-call）（17 条 `rustc --test`，**不引 crate**）
  assistant_session.rs    assistant 的会话存档：`assistant-sessions/<id>.json` 的读写列删（四条命令 assistant_sessions / assistant_session_load / assistant_session_save / assistant_session_delete），保存时按 200 条 / 1 MB 两道预算裁最老的、`truncated` 写回文件让人知道"它掉过头"；标题取第一句用户的话前 12 个字（算不出来就存空串，界面自己翻）；坏文件不拦列表，标 `damaged: true`
  assistant_session_policy.rs  上面那道的纯逻辑：id 形状、标题截断（按码点不按字节）、留哪些行的三道筛（坏行丢 / 条数 / 字节）、熵源 → 4 位后缀（15 条 `rustc --test`，**不引 crate**）
  assistant_window.rs     assistant 的桌面小窗（0002 / 0007）：建 / 开关 / 藏、两种模式（浮窗 / 桌面，「桌面」走 `interactive` 那条路而**不是** WorkerW —— 挂了就拿不到键盘焦点）、底板、锁、缩放、**子类化去边框**（0036：`frame_proc` 把 `WM_NCCALCSIZE` 归零 + `DWMWA_BORDER_COLOR` 关 DWM 那 1px，两半都要做）；状态 `assistant-window.json` v4（v1 的 `{x, y}` 就地升级）；十条命令全在册（`toggle` / `hide` / `save_pos` / `state` / `mode` / `appearance` / `locked` / `sidebar` / `font_scale` / `save_rect`，一律 `async fn` —— 同步命令会占着主线程去等主线程）
  wallpaper.rs            截壁纸（宿主页底板的第一层）
  metrics.rs              系统指标（sysmon 组件用）：整机 + 逐核 CPU、内存与提交量、磁盘、网络、开机时长 / 进程计数，直接调 Win32 不引 crate
  metrics_policy.rs       上面那道的纯逻辑：累计计数 → 占用率、核数变了返回空而不是错位（5 条 rustc --test）
  media.rs                SMTC 媒体会话：读当前播放 + playPause/next/previous/stop（WinRT）
  audio.rs                声音高低：默认输出设备的 WASAPI 回环采集，一个后台线程写、命令只读（只出一个 0..1）
  audio_policy.rs         上面那道的纯逻辑：RMS → 分贝 → 0..1、释放曲线、包络（6 条 rustc --test）
  package.rs              .lattice 解包：inflate + 核 CRC + 原子安装（先解到 .incoming 再换名）
  package_policy.rs       上面那道的纯逻辑：读中央目录、路径规则、体积上限（11 条单测）
  signature.rs            ed25519 验签 + sha256（三道校验的前两道，4 条单测含一条跨语言向量）
  signature_policy.rs     上面那道的纯逻辑：hex / base64 / 指纹 / id 规则（8 条单测）
  backup.rs               覆盖安装前的备份与回滚（回滚是**交换**，只留一代）
  store.rs                商店命令：取目录、下载包（带缓存）、验签安装、写举报
  instance.rs             单实例：命名互斥体 + 命名事件
  state.rs                平台状态落盘（state.json，原子替换）；**读的时候先剥 BOM** —— 这份文件可手改、可备份回去，而记事本 / `Set-Content -Encoding utf8` 会写 `EF BB BF`，前端 `JSON.parse` 一抛就落默认值、再整份写回去（布局静默归零，见 PITFALLS「状态落盘」那条）
  widget_store.rs         组件私有存储落盘（widget-data/<id>.json）
  secrets.rs              密封密钥（0026）：`secrets.bin` = 文件头 + DPAPI blob（`CryptProtectData`），一个文件一次原子写 + 一代 `.bak`；四条命令（secret_set / secret_get / secret_delete / secrets_status）；**解不开就拒绝写** —— 覆盖一份换回原账户还能用的密文等于把它弄丢
  secrets_policy.rs       上面那道的纯逻辑：键名拼接（组件够不到 `llm.*`）、magic 头、迁移判定与 seal → verify → clear 的顺序（16 条 `rustc --test`，**不引 crate**）
  widgets.rs              用户组件的扫描 / 安装 / 卸载
src-tauri/installer-hooks.nsh  NSIS 钩子：卸载时删掉 Run 注册表项（只此一处）
src-tauri/capabilities/
  default.json            主窗口权限
  widget.json             组件窗口权限（widget-* 标签）
  assistant.json          assistant 小窗权限（window "assistant"；含 `start-dragging`）
tests/                    纯逻辑与布局的浏览器断言（tests/*.html，跑在 dev server 上）
docs/                     架构、组件规范、路线图与踩坑、代码签名取舍
```
