# 改了什么，就怎么验

> 这是 [`AGENTS.md`](../../AGENTS.md) 第 11 节的正文。**按区查，别通读** —— 找到你动的那一块，跑它那几条，再看"只能真机"那一段有没有你。
>
> 根文件里只有底线四条（`typecheck` / `check:guards` / `test:browser` / 真机）和"交付要说清什么"。这一页是逐区的命令、断言页和验法。

- `npm run typecheck` —— 必跑，当前是干净的
- **`npm run check:tokens`** —— 三张表（字号 / 圆角 / 间距）的守门人，扫 `src/**/*.css`，越界就红并指出行号；`npm run test:tokens` 钉规则本身（半像素、`font` 简写、豁免、以及"仓库现状是干净的"）。改样式前后各跑一次，比肉眼数 `10.5px` 靠谱。真要写规矩外的值，行尾加 `/* token-ok 理由 */`，理由不写会被报。
- **`npm run check:guards`** —— 七条"不报错、只是不工作"的对账，pre-push 一次串完；CI 里逐条拆开跑（`check:policy-tests` 在 rust job，其余在 frontend job），所以**链里加了新的、`verify.yml` 里也得加一行** —— 只进链不进 CI，就是 pre-push 红、CI 绿，两边说的不是一回事。这个状态由 `check:gates` 拦。
  - `check:stats`：文档里每一处"现在有多少条 X"都要和 `scripts/stats.mjs` 数出来的对上。**数的实现只有那一份** —— 以前 `check:docs` / `check:bridge` / `check:commands` 各写了一条正则，先失配的那份会打印 0 并退出 0（体检全绿、数字全错）。它同时管**历史数**：`docs/design/` 靠 front matter 的 `date:` 说话（没有就红），其余文档靠那一行或所在小节的版本号 / 日期 / "当时"。分不清的后果是历史数和写错的数是**同一串字符**，读者没法分辨。**全局 vs 局部**也在这里：`agentActions` 是局部数，写的时候必须带主语（"agent 的九个动作"），不带就红。
  - `check:bridge`：一个权限要落**六处**（哪六处见 [`recipes`](./recipes.md) 第 1 节，这里不重述），其中三处漏了不会报错 —— `PERMISSION_READY` 少一条，`normalizePermissions` 就**静默丢掉**那个名字，组件清单里写着、平台当没有。顺带对 WIDGET_SPEC §4 的方法表（方法名和每条的权限）与 ARCHITECTURE §3 那两个"现在 N 条"。
  - `check:commands`：`invoke("cmd")` 拼错、`#[tauri::command]` 声明了没进 `generate_handler!` —— 两者都只在运行时 reject 一句 `Command x not found`，界面上表现成"这块数据没加载出来"。命令名是变量的（`devLlm.ts` 那处）跳过并打印出来。
  - `check:policy-tests`：`*_policy.rs` 的存在意义就是零依赖、能 `rustc --test` 单跑（本机跑不了 `cargo test`）。谁在里面 `use crate::state;`，这条就红 —— 否则那些断言会悄悄退回成"只有 CI 跑"。需要兄弟模块的会自动拼一个 shim 根；`catalogue_policy.rs` 因为用 `serde_json` 在豁免名单里，**它一旦能单跑也要红**（名单不腐烂）。
  - `check:version`：三处配置（`package.json` / `Cargo.toml` / `tauri.conf.json`）必须同一个数，两份 README + 这一页的"源码版本"那句话必须写着那个数。**它不管"能下载到的是哪个版本"** —— 那个数在 GitHub Releases 上，写进仓库就一定会脱钩。改版本时四处一起改，改完这条会告诉你漏了哪处。
  - `check:csp`：`tauri.conf.json` 的 `app.security.csp` 被悄悄放开（多了 `'unsafe-inline'` / `'unsafe-eval'` / 外部源 / 外部连接）、入口 HTML 里出现内联脚本或 `style` **属性**、平台代码直连外网、`tests/csp.html` 那份证明与配置脱钩 —— 四条都不报错，只是"某天打包后白屏"。注意它读 `dist/`，必须排在 `npm run build` 之后；而 **`tauri dev` 下主窗口根本没有 CSP**，所以这个症状只在打包后出现。
  - `check:gates`：查的不是代码，是**门禁自己会不会被跑到** —— `verify.yml` 里点名的 npm 脚本是否真存在（拼错一个字母本机不红、YAML 也合法）、`ci.yml` 里有没有多写命令（多写就又是两份清单）、release 的 build 有没有 `needs` 门禁、每个 `scripts/guards/*.mjs` 是否既在 `check:guards` 链里又在 `verify.yml` 里。**新写守门人必须两处都登记**，否则等于没写。
- **`npm run test:browser`** —— 跑一遍 `tests/*.html` 里的全部断言（**页数和条数只有 README 的 By the numbers 该记，这里和别处都别跟着抄** —— 抄一遍就多一个会飘的数）。先 `npm run dev` 起 dev server（默认 1420），另一个终端跑它；`--filter catalogue` 只跑匹配的页。它用 headless Chrome 的 `--dump-dom` 读 `<pre id="out">`，所以**页面的断言必须写成 `PASS …` / `FAIL …` 两行式**，别的格式它数不到。CI 里这条是 `browser` job，红在哪一页会直接打出来。**改断言就顺手 `grep -n '<页名>' AGENTS.md docs/`**：这一页和 §3 / §7 / `docs/AGENT_ACCESS.md` 里有十几处手写的「N 条」，**总数**由 `check:stats` 盯着，**逐页的条数**没人替你核，飘了不会红。
- **断言页别等 iframe**。`--virtual-time-budget` 会让虚拟时钟一路快进到 9 秒，而 iframe 的 `load` 走真实网络 —— 谁先到看运气，快进赢了就 dump 到一个空的 `<pre>`，`test:browser` 报"0 条 —— 一条断言都没跑完"。那个症状和"页面没有断言"一模一样，别去调 budget（调大只是让赌局更偏一点，还是赌）。正确做法是**同步加载**：组件把纯逻辑挂在 `window.__latticeXxx` 上，普通 `<script src>` 引进来就能断言；拿不到那个对象时也要先 `log(false, …)` 再 `flush()`，否则页面永远吐 0 条。
- 改了组件 UI：`npm run dev` 后在浏览器里看；要截固定尺寸的图，用 Edge headless：
  ```bash
  msedge --headless=new --disable-gpu --force-device-scale-factor=2 \
    --virtual-time-budget=2000 --window-size=340,300 \
    --screenshot=out.png "http://localhost:1420/widgets/<id>/index.html"
  ```
  `--virtual-time-budget` 必须给，否则会截到 transition 的中间态。
- 改了主窗口导航 / Workspace 保活 / Sidebar：`npm run test:browser -- --filter navigation`。该页验证 Dashboard 默认状态、Canvas DOM 身份与尺寸、非活动页 inert/ARIA 隔离、手动折叠持久化，以及 1280px 手动折叠和 980px 响应式 Rail 下偏好不变。
- 改了 Workspace 调度兼容：`npm run test:browser -- --filter schedule`，并按当前组件行为复核 `tests/schedule.html`。该页应覆盖 opt-in 可视订阅暂停与单拍恢复、旧订阅持续运行、无隐藏期间的补发；`npm run test:browser -- --filter dictation` 验证 Dictation 的 Tauri Event Plugin Mock 与监听清理。
- Phase 4C 第一批自动化验收（本轮运行，2026-11-04）：`npm run test:browser -- --base http://127.0.0.1:1421` 全量通过，88 页 / 4,502 条断言 / 0 失败；其中 Workspace 调度 31/31、Dictation 29/29。测试使用本地 Vite 服务端口 1421。
- Phase 4C 第一批 Windows Tauri 人工验收（用户报告，2026-11-04）：Assistant 本地 Ollama `qwen3:4b` 对话正常；流式回复跨 Dashboard / Workspace 切换完整；Assistant 关闭重开后正常；主窗口语言切换同步到独立 `lattice.clock`。
- Agent 动作成功重试的脱敏审计证据：`00:34:22 +08:00` 的 `qwen3:4b · tools: placement.front` 请求 HTTP 200；`00:34:28 +08:00` 模型结果 HTTP 200，Assistant 动作卡片为 `ok: true`。审计没有保存 Tauri `requestId`；动作结果与工具 / 模型日志共同支持这一次成功往返，但不是 requestId 级关联。
- 尚未单独验收 `ask` 确认卡片的展示、允许 / 拒绝交互；Assistant 曾偶发 Provider 超时，根因未确认。二者保持为开放缺口，不能写成通过。
- 改了桥 / 组件存储：`tests/bridge-storage.html` 与 `tests/note-save.html` 是自检页（`npm run dev` 后打开 `http://localhost:1420/tests/bridge-storage.html`）。前者验证并发写不丢键、跨窗口读到最新值；后者验证便签的保存顺序与载入竞态。动过存储或便签保存逻辑，先看这两个页面是不是全绿。
- 改了配置链路：`tests/config.html`（归一化、默认值、夹紧、未知键、`config.get`）。这条链路**在浏览器里就能验完**：属性面板 → store → 宿主 → 组件全在前端，只有桌面窗口那一段需要 Rust 透传。用 CDP 连画布 iframe 的 target（`type: "iframe"`）读组件里的文本，就能确认"拨一下开关，组件当场变"。
- 改了窗口行为：只能 `npm run tauri:dev` 实机看。**改 Rust 会重启应用**；`desktopMode` 与 `restoreOnLaunch` 都落盘，重启后组件窗口会自己回来（位置和数据都在），不用重新投放。
- **重启前先确认没有孤儿进程。** 杀掉 dev 任务不一定杀掉 `lattice.exe`：孤儿实例还活着时会**用它内存里的旧状态覆盖 `state.json`**（手动改文件会被它盖回去），而且它占着 WebView2 的用户数据目录，新进程会以 `HRESULT 0x800700AA "The requested resource is in use."` 在 `setup` 里 panic（表现为"改完 Rust 应用起不来了"，其实跟代码无关）。判据：`Get-Process lattice` 为空。真要改 `state.json` 就先退出应用。
- 改了协议 / 安装链路：拿 `examples/counter` 当样本 —— 拖进窗口 → 出现在「已安装」→ 放到画布 → 授权 `storage` → 点几下 → 看 `%APPDATA%\com.iron-tom.lattice\widget-data\demo.counter.json` 有没有写进去。协议本身只能在应用里探（浏览器态没有 Rust，`lattice-widget.localhost` 压根不解析）：预期真文件 200 + 正确 `Content-Type`，`..` / 大写 id / 不存在的组件全部 404。
- 改了 **SDK**（`packages/sdk/lattice.js`）：改完**立刻** `npm run sdk:sync`，再 `npm run test:sdk`（2 条，`node:test`，不需要 dev server：所有内嵌副本必须和源字节一致、`SUPPORTED_SDK` 的主次版本必须和 SDK 包版本对得上）。行为本身看 `tests/sdk.html`（55 条）—— 它自带一个假宿主，覆盖请求配对、超时、`permission_denied`、主题长名 / 别名、存储往返、`store-changed`、`config-changed`、`tick` 路由、`stop()`、网络透传、`assistant.ask`（参数形状 + 它自己那条 185 秒超时盖过实例的短 `timeout`）、顶层窗口立刻失败。**跨窗口的断言要用 `waitFor` 轮询**：`postMessage` 是宏任务，`await` 子窗口的 promise 只排微任务，直接断言会偶发失败。
- 改了 **`.lattice` 打包 / 安装**：`npm run pack:widget -- examples/counter`，产物在 `dist-packs/`（已 gitignore）。打包要验**确定性**：连打两次，`sha256` 必须一样。解包侧用壳子跑 `package_policy.rs` 的 11 条（含篡改 CRC、路径穿越、绝对路径；`package.rs` 自己一条 `#[test]` 都没有，它是 `#[cfg(windows)]` 的胶水），装完看 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\` 里是不是原样。交叉验一下更稳：Node 打的包用 Python 的 `zipfile.ZipFile(...).testzip()` 读一遍。
- 改了**商店 / 签名 / 更新**：
  - 纯逻辑：`tests/semver.html`（43 条）+ `tests/catalogue.html`（92 条）+ `tests/store-ui.html`（94 条，挂的是真的 `LibraryPanel`）。前两个是纯函数，第三个验的是"接上 React 之后还对不对"（按钮接没接上回调、文案用的是不是过滤后的数据）。
  - 目录缓存 / 断网兜底 / 默认源：`tests/catalogue-cache.html`（47 条，含 `persist` 的 v0 → v1 迁移、v2 → v3 那条"电池并进系统"（0030）和那条 "Showing an older copy" 的横幅）。改默认目录源、改 `CatalogueSnapshot` 的字段、抬 `STATE_VERSION`，都先跑它 —— 迁移写错的表现是"老用户看不到官方目录"，没有任何报错。**v3 那条尤其要盯着 `desktopRects`**：桌面窗口按那次摆放的尺寸开（`buildSpecs` 里 `placed.h` 优先于 `placement.h`），只抬 `placement.h` 的话画布里是对的、桌面上却把底栏切掉半行。
  - 签名两侧：`npm run sign:widget -- --selftest`（一条 Node 自己签、自己验的向量）；Rust 侧那条向量是**用 Node 生成后贴进去的**，别凭印象写。
  - 端到端只有真机：`npm run store:index` 之后起 `tauri:dev`，在设置里把目录切成 Bundled，装一个 → 改版本再装一次（看 `widget-backups/` 出现）→ 回滚（看两个版本互换）→ 举报（看 `%APPDATA%\com.iron-tom.lattice\reports\<id>-<时间戳>.json`）。**验签失败的三条要各自单独造**：改目录里的 `sha256`（摘要不符）、改包里的一个字节（同上）、把 `publisher.key` 换成另一把（签名不符）。三条报的错必须**不一样**，否则等于没验。
  - 界面上"该不该装"的判断全在 `planInstall` 里，别在 JSX 里再写一份 —— 两份判断的后果是"卡片说能装、点了报错"。
  - winget 清单（v0.7 那条免费的分发路）：`npm run test:winget`（11 条，`node:test`，**不需要安装包**）、生成跑 `npm run winget:manifest`（从 `src-tauri/target/release/bundle/nsis/Lattice_<版本>_x64-setup.exe` 现算哈希，写 `dist-winget/`）。**只有 `winget validate` 加一次真 PR 才算验过** —— 本机能验的是"三份 YAML 的形状对不对"。三条别踩回去：`sha256Hex` 给小写、清单要大写，`.toUpperCase()` 那一步别省；直链的附件名与 `PackageVersion` 必须同源，别手改其中一个；`Publisher` 取 `identifier` 的第二段（Tauri 的默认规则，这台机器上是 `iron-tom`），别换成"看起来更好看"的名字 —— 那会连带换掉卸载信息所在的注册表路径，已装的用户会多一条残留。
  - 发公共目录：`npm run publish:widget -- <组件目录> --key ../lattice-registry/.keys/publisher.key`。它把打包、签名、写 sidecar、跑 registry 的 `build.mjs` 串成一次执行，最后只说"要提交哪几个文件"。**验收标准是幂等**：同一个目录连跑两次，registry 的 `git status` 必须是空的 —— 第二次不能因为把 sidecar 的 `published` 改成今天而脏一份 `registry.json`。
  - **目录里显示的名字 / 描述 / 图标取自最新那一版包的清单**（`build.mjs` 里按版本挑，不是按文件名）。所以"本地清单改成 `{ zh, en }` 了、商店里还是英文名"只有一个原因：新版本还没发上去。三个连带事实：改了名要发新版本，只改本地清单不够；图标要另放一份 `registry/icons/<id>.svg`（包里的 `icon.svg` 不会被目录读）；`registry.json` 的排序遇到 `{ zh, en }` 先挑 `en` 再比，别把 `localeCompare` 直接用在对象上。
- 改了**调试面板**：`tests/debug.html`（43 条，总线 + 过滤 / 统计纯函数）+ `tests/debug-panel.html`（15 条，把真组件挂起来点按钮）。后者**必须 `import "../src/styles.css"`**，否则面板渲染成裸 HTML。它同时也是一张验收图：`--screenshot` 出来的就是面板长什么样。
- 改了**媒体控制 / 声音折线**：`tests/music.html`（71 条）自带假宿主，覆盖"有会话 / 没会话 / 权限被拒 / 直播没时长 / 点按钮 / 改轮询间隔"。它替身的坑记住一条：`setConfig()` 要 `Object.assign` 到 handler 捕获的那个对象上，否则 `config.get` 回的还是启动时那份，用例会假通过。
- 改了**数据平面**（`agent.tools` / `agent-call`）：纯逻辑跑 `tests/widget-tools.html`（55 条：归一化逐条丢、名字从右边拆、多份实例合成一条、授权轴、回话超长拒绝），接缝跑 `tests/agent.html`（70 条：`runWidgetCall` 的第二道校验 + 小窗那份 `widget-call` 信封）与 `tests/assistant.html`（合表 / 审批三档 / 提示词那一段），清单与执行的归属按 [0013](../design/LAT-0013-widget-tools-across-windows.md) —— **列清单与跑工具都归 `AssistantSurface`**，主窗口与小窗只递参数。**端到端只能在真机**：给一个组件加上 `agent.tools` 与 `agent:tools` 权限，在抽屉里说一句"往待办里加一条"，看它是不是调了 `widget.<id>.<tool>`、确认条上写着工具名、加完之后组件真的变了。
- 改了组件库（列表 / 搜索 / 安装态）：`tests/library-search.html`（36 条）钉的是**判定规则与顺序**（空查询不筛、大小写与空白归一、多词 AND、权限名算命中、不做模糊匹配、档位 > 字段权重、同分保持原顺序）。判据只在 `runtime/library-search.ts` 里写一份（`matchScore` → `matchesWidget` / `rankWidgets`），组件里别再复制一遍 —— 复制的后果是"测试过了，界面上还是不对"；加字段就改 `scoredFields` 那一张表并补权重，别在调用点另算一遍分。
- 改了错误通道 / 兜底页：`tests/diagnostics.html`（识别边界、两条通道不撞、去重指纹、主错误选择）。注入规则本身跑 `npm run test:injection`（9 条，`node:test`，**不需要 dev server**，fixture 和 Rust 单测是同一批：`<head>` 带属性、`<header>` 别认错、doctype 兜底、幂等、压行后行号不变、多字节安全）。Rust 那边 14 条单测在 `diagnostics.rs` 里，但**这台机器跑不了 `cargo test`**（安全策略拦 `target/debug/deps` 下新写的 exe，见 [docs/PITFALLS.md](../PITFALLS.md)「构建、工具链与验证」）。绕法：写个只有一行的壳子 `#[path = "../src-tauri/src/diagnostics.rs"] mod diagnostics;`，然后 `rustc --test 壳子.rs -o 壳子.exe && ./壳子.exe` —— 断言还是模块里那一份，不复制。
- 改了内置组件的注入：**两条路都要看**。dev 下 `curl -s http://localhost:1420/widgets/lattice.clock/index.html | grep -c 'data-lattice="diagnostics"'` 应该是 `1`（不是 `2`：中间件要幂等，否则 vite 自己把 `public/` 也注一遍就重了）；`npm run build` 之后再看 `dist/widgets/*/index.html`，构建日志末尾会有一行 `[lattice] 错误上报已注入 N 份内置组件文档`，`N` 要等于内置组件个数。**行数也要对**：`wc -l dist/widgets/<id>/index.html` 必须和 `public/widgets/<id>/index.html` 一样多，多一行就是压行失效、行号全错。
- **驱动真机 UI**：键盘事件能进 WebView2（`SetForegroundWindow` 之后发 `Ctrl+R` 能刷新、往输入框打字能落盘）；`mouse_event` 的点击**在宿主页的窗饰和错误卡上是生效的**（重载按钮就是这么验的），只是要先 `SetCursorPos` 再等 200–400ms —— 窗饰是 `body:hover` 才淡入的，移过去立刻点会点在还没出现的按钮上。往组件 iframe 里点则不可靠。
- **CDP 连真机：这台机器上已经开不出来了。** 加 `--remote-debugging-port` 之后应用会起来、窗口标题也在，但**一个 `msedgewebview2` 子进程都没有**，端口不监听，日志里只有两行 watcher —— 看起来像"卡住"，其实是 WebView2 创建直接失败了。判据：`Get-Process msedgewebview2` 里没有带 `com.iron-tom` 的那个；去掉环境变量立刻正常。**别在这上面耗时间**，改用下面的替代验法。
- **替代验法：把要验的状态临时默认成打开，截图，再改回来。** 面板 / 弹层这类"点一下才出现"的东西，临时把 `useState(false)` 改成 `useState(true)`（改完 HMR 立刻生效），用 `GetWindowRect` + `ImageGrab(bbox=…, all_screens=True)` 截窗口，然后**把代码改回去**。合成点击（`mouse_event`）在这台机器上进不了 WebView2 的渲染进程，`SetForegroundWindow` 从后台进程调也经常静默失败（还会有别的应用突然抢到前台）—— 交互逻辑一律放进能自动化跑的页面，真机只看渲染出来的样子。
- 下面这段是 CDP 还能用时的记法，留着给别的机器：
  ```bash
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--in-process-gpu --remote-debugging-port=9333" npm run tauri:dev
  curl -s http://127.0.0.1:9333/json/list
  ```
  关键在 `lib.rs` 只在环境变量**没设过**的时候才注入 `--in-process-gpu`，所以自己设一份就整个覆盖掉了（以前这里写着"对 Tauri 无效"，是错的）。三个要点：组件 iframe 在列表里是 `type: "iframe"`，不是 `"page"`；画布那份和桌面那份 URL 一样，用 `window.outerWidth` 区分（画布那份等于主窗口宽度）；`public/` 下的 `widget.js` / `style.css` 改完，vite 会给新文档，但**同一个 iframe 里 `Page.navigate` 到同一 URL 不会重新拉模块**，得带个 `?__bust=<ts>`。
  最小化 / 还原可以直接在主窗口里 `invoke("plugin:window|minimize", { label: "main" })` —— capabilities 里已经开了 `core:window:allow-minimize`。
- **调宿主页（`widget-host.html`）不必启动 Tauri**：它整条启动链只有 `invoke("widget_host_config")` 一个入口依赖 Rust。用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前塞一个假的 `__TAURI_INTERNALS__`（`metadata.currentWindow.label` + `transformCallback` + `invoke`，`invoke` 对 `widget_host_config` 回一份固定配置、其余一律 resolve），再 `Page.navigate` 过去，页面就能在普通浏览器里跑起来。错误卡、底板、窗饰的样式都能这么调 —— 别为了看一眼卡片去重启应用。**注意这只是调 UI 的便利**：窗口真行为（置底、圆角裁剪、拖拽、点击穿透）还是只有实机能验。
- 数心跳要数**调度器的输出**，不要看界面数字（数字可能因为系统空闲而恰好不变）：在组件 iframe 里挂 `window.addEventListener("message", …)` 数 `type === "tick"`，再读一个计数器。**监听器只装一次、计数器挂在 `window.__probe` 上** —— 每次运行都 `addEventListener` 一个闭包的话，第 N 次运行就有 N 个监听器往同一个变量上加，3 拍被数成 12 拍，看着像"定时器越跑越多"，其实是被自己的探针骗了（真骗过一次）。
- **纯策略模块的单测跑法**：`cargo test` 在这台机器上跑不了（安全策略拦 `target/debug/deps` 下新写的 exe），绕法是写一个只有一行的壳子：
  ```rust
  #[path = "../src-tauri/src/network_policy.rs"] mod network_policy;
  ```
  `rustc --test 壳子.rs -o 壳子.exe && ./壳子.exe`。**这就是"纯逻辑要单独拆成一个文件"的原因 —— 拆出来才测得到**。断言只有一份（`#[cfg(test)] mod tests` 在模块内部），壳子别复制。
  能这么跑的有多少条，`node scripts/guards/policy-tests.mjs` 会自己数（编译一次、缓存住）。**别在这里抄一个数** —— 这一句原来写的是"457 条 / 31 个文件"，而实测已经到 524 条 / 33 个文件，差着 67 条没人发现：它不属于 `check:stats` 管的四类（组件 / 权限 / 桥方法 / 命令），也没进那张按短语形状扫的网。其中绝大多数**不引 crate** —— 连 `serde` 都不许用，就是为了在任何一台机器上能单跑；`catalogue_policy.rs` 是例外（用了 `json!` 宏，单跑要先有一个 rlib，跟着 `cargo test` 走）。剩下那些碰 Win32 / 文件 / 网络的（`llm.rs`、`hands.rs`、`mcp.rs`、`protocol.rs`、`widget_store.rs` …）只有 `cargo test` 能跑，本机跑不了 —— 改动它们时靠 review 和真机验证。
  **壳子会过期，过期了要修，不要当它不存在**：`extract-test.rs` 曾经在 `package.rs` 加上验签之后编不过（`extract` 多了第三个参数、还引用了 `signature_policy` 和 `backup`），但 `rustc` 编译失败时旧的 `.exe` 还在，`&&` 串起来的写法会**跑那个旧二进制并显示全绿** —— 那才是最坏的情况。所以：编不过就是红，先看 `rustc` 的退出码，别信后面那行 `test result`。修法是给壳子补 `#[path]` 把 `signature_policy.rs` 编进来，`backup` 依赖 `tauri` 编不进来，就写一个签名对得上的桩（四条用例传的都是 `None`，走不到那条分支）。
  `package.rs` 要用到 `flate2` / `serde_json`，`signature.rs` 要用到 `ed25519_dalek` / `sha2`，壳子得额外指路：`rustc --edition 2024 --test 壳子.rs -L src-tauri/target/debug/deps --extern flate2=<rlib> --extern serde_json=<rlib> -o 壳子.exe`（rlib 从 `target/debug/deps/` 里按 `libflate2-*.rlib` 找）。只给 `--extern` 不给 `-L` 会报 `can't find crate`。`csp.rs` 那个桩的值要抄对（`"lattice-widget"`，不是 `"lattice"`），抄错了单测会红 —— 这次正好被它抓了一下。
  **raw `rustc` 的默认 edition 是 2015**，不带 `--edition` 编出来的 panic 消息不认内联捕获（`assert!(cond, "{index}")` 会报 unused placeholder，断言本身照样成立）。想安静就照着 crate 的 edition 给一个：`rustc --edition 2024 --test src-tauri/src/guide_policy.rs -o 壳子.exe`。
  **别把纯逻辑塞回带依赖的模块里**：`watch.rs` / `autostart.rs` 的解析和拼串本来就是搬出去的，搬回去等于这 10 条断言从此没人跑。
- **CDP 选 target 必须认"完全相等"，不能只认"包含"**：主窗口是 `http://127.0.0.1:1420/`，宿主页是 `http://127.0.0.1:1420/widget-host.html` —— 后者**包含**前者的前缀，`url.includes(selector)` 会把主窗口的探针静默跑到宿主页上，返回空值也不报错（真踩过：以为桥坏了，其实是在一个已经卸载的页面上 `evaluate`）。所以先 `t.url === selector`，找不到再退到 `includes`。
- **宿主页在 CDP 里没有唯一 URL**：所有桌面窗口都是同一个 `widget-host.html`，靠 URL 分不出是谁。按 `host:<widgetId>` 取的办法是先连上每个 `widget-host.html` target，`evaluate("document.querySelector('iframe')?.getAttribute('src')")`，再按里面的组件 id 挑。想验崩溃隔离就 `Page.crash` 那个 target（组件 iframe 是 `type: "iframe"`，宿主页才是 `type: "page"`）。
- **验联网用一次性的探针组件，内容全英文**：在 `%APPDATA%\com.iron-tom.lattice\widgets\<探针id>\` 放一份 manifest（`"permissions": ["network"]` + `"network": {"hosts": ["127.0.0.1:8787"]}`）和两个文件，**别用真实组件、别填任何个人信息**。配套起一个本地服务（一个 `/ok` 回 JSON、一个 `/redirect` 302 到另一个端口），再在"另一个端口"上挂一个只要被请求就打日志的端点 —— **重定向有没有被跟随，看的是那个端点的日志，不是响应的状态码**。验完删目录、把 `state.json` 从备份还原。
- **托盘在不在，不用点菜单**：`EnumWindows` 枚举该进程的窗口，出现 `tray_icon_app` 这个类名就说明图标建成了（菜单项本身调的就是 `toggle_paused` / `show_main` / `app.exit`，那三个另有验法）。
- 抓真机窗口用 `PrintWindow(hwnd, hdc, 2 /*PW_RENDERFULLCONTENT*/)`，被别的窗口盖住也能抓到；配合 `ShowWindow(h, 4 /*SHOWNOACTIVATE*/)` 不抢用户焦点。
- **[`known-gaps`](./known-gaps.md) 的 8.1 那些待验的行，验完之后要留东西，否则等于没验。** `ROADMAP` 写着"每条验收要么变成一条断言，要么变成 [`known-gaps`](./known-gaps.md) 的 8.1 里被划掉的一行，没有第三种结局"—— 这句话是对的，但它漏了中间那一步：**验的那一次本身要有痕迹**。换个人接手时，一堆待验会变成"从头想一遍怎么验"，而六个版本正是这么一直挂着的。所以每验完一条，同时留三样：
  1. **一条能重跑的东西** —— 一个脚本路径（`.scratch/<name>-probe` 是现成的先例，终端那次就是这么留的），或者验的是窗口行为、写不出脚本时，就写清"手点的顺序 + 看哪个窗口的哪个位置"；
  2. **那一次的实际输出** —— 数字、时间戳、截图路径。落在 `docs/reference/history.md` 对应版本那一段，或者 §8.4 那条"已修"里，**不要只写在提交信息里**（提交信息会被 `git log --oneline` 折叠掉）；
  3. **划掉 [`known-gaps`](./known-gaps.md) 8.1 那一行** —— 不是标"已验"。[`known-gaps`](./known-gaps.md) 的 8.1 的定义就是"还没验"，留着它只会让下一个人重验一遍。
  两条禁令：**不许为了让断言变绿去改行为**（[`known-gaps`](./known-gaps.md) 8.1 的抬头已经写了，这里再钉一次）；**不许把"输出出现了"当通过** —— 终端那四处要验的是顺序与收尸，`dir` 打出东西来只证明它跑起来了。
  一个正例：终端"四处没验"那条，按新规矩应当留下的是 `.scratch/term-probe` 的路径 + 三次 `Start-Sleep 350ms` 的到齐时间戳 + 划掉 [`known-gaps`](./known-gaps.md) 的 8.1 那一行；验完 Stop 按钮之后再加一条"任务管理器里那只 `powershell.exe` 真没了"。
- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 前缀，一句话说清"改了什么"，不写"update file"。
