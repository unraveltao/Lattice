# 常见改动的配方

> 这是 [`AGENTS.md`](../../AGENTS.md) 第 7 节的正文。**按任务查，别通读** —— 它回答"改这个要动哪几处"，不回答"为什么"。
>
> 什么时候读：已经决定要改什么、还没动手的时候。约束在 [`AGENTS.md` 第 4 节](../../AGENTS.md)（不变量），验证在它的第 11 节，坑在 [`PITFALLS`](../PITFALLS.md)。三者冲突时以代码为准。


## 加一个桥方法

1. 需要新权限 → **这一步五处，加上第 2 步的 `defineMethod` 一共六处**：`runtime/manifest.ts` 的 `Permission` 联合类型、`PERMISSION_READY`（`normalizePermissions` 读它，别另抄名单）、`PERMISSION_LABELS`、`runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS`、以及 `docs/WIDGET_SPEC.md` 的权限表。以及这六处里漏哪一处会静默失效，记在 [`verify.md`](./verify.md) 的 `check:bridge` 那一条
2. `runtime/bridge.ts` 里 `defineMethod("ns.method", "permission-or-null", handler)`；参数校验失败抛 `BridgeError("bad_params", ...)`
3. 要碰系统/文件 → 写 Rust 命令，注册进 `lib.rs` 的 `invoke_handler`
4. `docs/WIDGET_SPEC.md` 的方法表补一行（第三方只认这张表）
5. 权限未授予时**返回结构化错误**，不要抛异常——组件要能降级
6. 方法要"边跑边有话说"（流式输出、常驻进程、长任务）→ 先读INV-20：桥只回编号，正文走事件，补发缓冲 + 两条收尸路，一个都不能省

## 加一项组件配置

1. 清单里写 `config`（`runtime/config.ts` 的 `ConfigField` 是唯一真源，5 类：`toggle` / `number` / `text` / `select` / `date`）。**不要**为它加平台状态字段，也别让组件自己画设置 UI
2. 组件里 `config.get` 读一次 + 处理 `config-changed` 推送（WIDGET_SPEC §2.3）。两件事都要做：只读一次的话，用户拨开关组件不会动
3. 要加新的**字段类型**才需要动三处：`ConfigField` 联合类型、`normalizeConfig` 的 `switch`、`InspectorPanel` 的 `ConfigControl`。顺手补 `tests/config.html` —— 它钉住"坏字段丢弃 / 非法值退回出厂 / 未知键不外泄"
4. 属性面板、画布、桌面三条路都读 `resolveConfig`，不要在别处自己补默认值

## 加一个平台状态字段

1. `store.ts`：interface + 初始值 + action
2. `partialize` 里加上（不加 = 不持久化）。**新字段不加 `STATE_VERSION`** —— 落盘合并会给老状态填上默认值，版本号只留给"旧字段的含义变了"（`migrateState`）
3. 会**过期**的字段（回收站那种"留 7 天"）还要在读回路径上裁一次：关机那几天照样算过期，只在写入时裁的话，一台两周没开的机器回来会看到一堆早就该没了的东西。位置是 `onRehydrateStorage`（那里也是 `hydrated = true` 的地方，写完盘之前的状态才有意义）
4. 运行态要用的话，一路加下去：`buildSpecs` → `WidgetWindowSpec`（TS）→ `WidgetWindowSpec`（Rust）→ `HostConfig` → **`Applied`**

第 4 步最后那个 `Applied` 最容易漏。`Applied` 是"已经写进 Win32 的状态"，不在里面的字段永远不会触发窗口更新——撤销权限对已打开的桌面窗口无效，就是这么来的。

## 加一句界面文案 / 改一句文案

**平台自己的界面文案只有一套来源**：英文原句写在代码里，中文写在 `runtime/i18n/*.ts`。不新增第二套 key，也不在别处硬编码中文。

```tsx
const t = useT();                      // 组件里：语言一变就重渲染
<span>{t("Snap to grid")}</span>
<span>{t("Install v{version}", { version })}</span>
```

- **key 就是英文原句**（不是 `settings.snap`）。表里没有的句子原样显示英文 —— 漏一条的代价是"这句还是英文"，不是界面上出现一串点分键名。
- **组件里必须用 `useT()`**，模块级（`platform/*.ts`、`widgetHost.ts`）用 `t()`。模块顶层算出来的常量数组（`THEME_OPTIONS` 那种）**不能**在初始化时 `t()`：英文留在常量里，渲染时 `t(option.label)`。
- **中文写进哪个分片看归谁**：`common`（多处在用的词）、`shell`（外壳 / 画布）、`library`（组件库与商店）、`panels`（属性面板 / 说明 / 举报）、`settings`（设置浮层）、`assistant`（assistant 与调试面板）、`misc`（`platform/*.ts`、清单校验、权限名）。**同一句只有一种译法**，`tests/i18n.html` 会查。
- **英文必须写好**：它就是 en 这一门的成品。中文不许改 `{占位符}` 的名字，位置随意（可以把变量放句子中间）。
- **不翻**：代码注释、`console.*`、错误码与枚举、URL 与路径、日志与审计。
- **组件清单里的 `name` / `description` / `config` 标签 / `help` / `changelog` 是作者写的**，不进 `i18n/*`（平台不认识第三方组件的每一句话）。作者要双语就写成 `{ "zh": …, "en": … }`，平台按当前语言挑（`runtime/widget-text.ts` 的 `pickText`）；只写一个字符串永远有效，两门界面都显示它。组件 HTML 里那些字平台完全管不着 —— 组件自己读 `lang.get` / 收 `language` 推送（配方见下一条）。
- **翻**：可见文字、`placeholder`、`title`、`aria-label`。
- 桌面组件窗口是独立 webview、**不加载 store**，所以语言随 `HostConfig.lang` 下去当初值、变化走 `lattice:language` 广播（和 `lattice:theme` 同一套）。加一处新的"平台写给桌面端看的字"，记得两样都要接。
- 权限名走 `permissionLabel(p)`（`runtime/manifest.ts`），别直接读 `PERMISSION_LABELS` 上界面 —— 那张表是英文原文，也是中文表的 key。

## 加一句组件自己说的双语（作者文案）

**组件里的句子只有作者知道怎么翻。** 平台能做的是把"现在是哪一门"送到手上，别的都得组件自己挑：

```js
const { lang } = await call("lang.get");        // "zh" | "en"，首帧之后就是准的
const say = (zh, en) => (lang === "en" ? en : zh);
// 用户中途在设置里换语言：平台推一条，别只读一次
if (data.type === "language") { lang = data.payload.lang; repaint(); }
```

1. **两件事都要做**（`lang.get` + `language` 推送）。只读一次 = 换语言组件不动；只听推送 = 组件的语言停在建文档那一刻（权限变更重载、热更新都会碰上）。
2. **`lang` 只有 `zh` / `en`**。"跟随系统"是**平台**在设置里解析掉的（`runtime/i18n.ts::resolveLang`），组件不要去猜系统区域、也不要自己读 `navigator.language` 当权威。
3. **首帧先按一门画**（INV-18）：HTML 里写死一份、`lang.get` 回来再换。等桥的那几十毫秒里画"加载中"是把同一个等待画得更久。
4. **清单那边的双语是 `{ zh, en }` 对象**，走 `normalizeText` / `pickText`（`runtime/widget-text.ts`）—— 字段清单和上限见 WIDGET_SPEC §2.7。搜索是两种语言都建索引的（`textVariants`），别只挑当前语言。
5. **SDK 已经把这两件事包好了**：`lattice.language` + `lattice.on("language")`，启动时自动拉一次。手写桥的组件（内置组件全是手写的）照上面四行做。
6. **内置组件必须真做到**，不是"建议"。24 个官方组件的清单文案、`<html lang>`、卡片里画出去的字（星期 / 月份 / 上午下午 / 计数 / 按钮 / 提示行）全是双语，写死的那一门是**中文**。`tests/help.html` 第 5 段钉着两件事：清单里该双语的字段两门齐全；每个组件的源码里既有 `lang.get` 也有 `language` 推送。只做一半的症状很隐蔽 —— 只听推送的，热重载之后就停在旧语言；只读一次的，用户换语言卡片一动不动。


## 改内置 assistant / 加一项 AI 能力

一句话的形状：**key 只在 Rust 里，模型只认 OpenAI 兼容的 `/chat/completions`，桌面动作仍然是那八个；想要"自己动手"的能力走 `runtime/hands.ts` + Rust 的 `assistant_tool`，不进 `AGENT_ACTIONS`。**

1. **模型档与 key 落在 `assistant.json`，不落 `state.json`**。`llm.rs` 独占读写（临时文件 + 原子替换）。文件是 **v4** 的形状：`{version: 4, mode, skills: {enabled}, activeId, hands: {files, shell, web, screen, input, mcp}, approvalMode, workspace, profiles[]}`（`approvalMode` 由 0003 §3 的三档审批用、`mode` 由 0009 的两个模式用、`skills.enabled` 由 0005 的技能包用；文件和前端同名同义，**坏值一律往"权限更小"那边落**），每条档自带 `baseUrl` / `auth` / `apiKey` / `model` / `temperature`，所以在一台机器上同时留 DeepSeek 和本地 Ollama 是正常用法（**一条档一个端点**，同一端点存两条只会让用户自己分不清）。v1 的扁平 `{baseUrl, model, …}` 读到时就地升级成一条档，**key 跟着搬过去**，不要重输；**手一律落成"全关"**（升级不能替用户开一扇他自己没开过的门），`workspace` 落空串。加新字段时照着 `..AssistantConfig::default()` 补，别手写字面量 —— 以后再加字段就不会漏。前端拿到的是 `ProfilesView`：每条档一个 `keyHint`（`sk-1…cdef` 这种掩码），**任何命令都不回明文 key**。为什么不放 `state.json`：那份是前端整体回写的，两个入口（面板、组件宿主）会互相盖；而且把 key 交给渲染进程，等于任何一个组件 XSS 都直接拿到它。环境变量 `LATTICE_LLM_KEY` / `_BASE_URL` / `_MODEL` 只盖**当前那条档**（`keySource: "env"`），CI 与临时试验用这条路。
2. **协议只认 OpenAI 兼容形状，归一化只有一处**。`llm_policy::normalize_base` 补 `https://`、去尾斜杠、剥掉用户顺手粘进来的 `/chat/completions` `/completions` `/models`；`http://` **只放回环**（`127.0.0.1` / `localhost` / `[::1]`，IPv6 要走 `host_of` 拆括号，别用 `split(':')`）。鉴权只有三种形状（`llm_policy::normalize_auth` + 前端的 `runtime/llm-models.ts`），**两边必须认同一组别名**：`bearer`（`Authorization: Bearer …`，默认）、`api-key-header`（`api-key: …`，Azure 那类）、`none`（本地 Ollama / LM Studio，没 key 也算配好了）。别在 `AssistantPanel.tsx` 里再补一套——两套规则迟早不一致，症状是"设置里能测通、一发消息就 404"。
3. **模型能力按名字前缀查，不按用户填的服务商查**。`runtime/llm-models.ts` 的 `knownModel()` 取最长前缀：`deepseek-reasoner` 不能调工具也不能给 temperature、`o1` / `o3` 同理、`gpt-4o` 上下文 128k，**认不出来的一律从宽**（`{tools: true, temperature: true, context: 32_000}`）。所以界面上"这个模型不能调工具"是一条**警告**，不是禁用——猜错的代价是不许用户用，那比多试一次 API 更糟。`historyChars()` 把上下文折成字符预算（1 token ≈ 1 字符，上限 60k），`trimHistory` 的 `maxChars` 就吃它。
4. **加一个工具要改两处，且必须相等**：`platform/agent.ts` 的 `AGENT_ACTIONS`（真执行器）+ `runtime/assistant.ts` 的 `TOOL_SPECS`（名字、参数名、类型、required）。`tests/assistant.html` 会比对两边——名字集合相等、每个动作的参数键与执行器的 `EXECUTOR_KEYS` 对得上、`required` 是子集。**别在 `AGENT_ACTIONS` 之外新写一个"给模型用的"执行器**：那等于给模型开一条不受审计、不走 store 的旁路。**组件声明的工具是第四条路**（数据平面）：schema 从 `manifest.agent.tools` 来、执行走画布那个 iframe，四路都只从 `allTools` 这一个口进表，裁决仍然是 `approvalFor` —— 协议与限额见 WIDGET_SPEC §3.6，取舍见 AGENT_ACCESS §2。
5. **工具循环只在 `platform/assistant.ts`**：≤24 步（`MAX_STEPS`）、每步把执行器返回的 JSON 字符串当 `tool` 消息回填、`shouldStop` 让"停止"立刻断掉；一轮还带两道预算 —— 300 秒（`MAX_TURN_MS`）与 20 万字符（`MAX_TURN_TOKENS`），`overBudget()` 返回 `"time" | "tokens" | null`，到点了就把这一轮收尾而不是继续调工具。步数从 6 抬到 24 是因为"读三个文件再改一个"这种正经任务在 6 步里做不完。Rust 侧另有两道闸：`MAX_TOOL_STEPS = 8`（单条请求里模型一口气要调几个工具）、请求间 300ms（`MIN_GAP`，在 `spawn_blocking` 里 sleep）。
6. **工具只借不送**。`llm.chat` 永远 `tools: null`（模型真要调工具就抛 `internal`，"widgets cannot use tools"）；组件想要手，只有 `assistant.ask` 这一条（权限 `desktop:control`，标签 "Rearrange my desktop"）。它是**借**：整轮循环仍然只在主窗口里跑，桥那边只是一次转发，工具表用 `toolsFor("widget")` 砍掉 `placement.remove`（用户能自己按 ✕，"让桌宠替我删组件"不行），系统提示里另加一句告诉模型这件事。三条别拆：① 组件宿主里不许跑执行器 —— 桌面窗口连 store 都没有，跑了就是拿旧快照往回写（和下面第 11 条小窗那个坑同源）；② 同一窗口上一轮没回来时新的直接拒，不排队；③ 它慢，180 秒（`ASK_TIMEOUT`）不是 8 秒，SDK 那侧也单独给了 185 秒。这条是INV-2 的延伸：**能改变桌面的是平台，不是组件**，否则"你信不信任这段代码"就变成"你敢不敢让它动你的布局"。
7. **错误话要分得清是谁的错**。`describe_status` 把 401/403 说成"provider 拒了这把 key（HTTP 401）—— 去 Assistant settings 换一把"、404 提 `/v1`、429 说配额。别统一成"网络问题"——那条教训是拿更新器换来的（见INV-16）。
8. **审计只记形状不记内容**：`assistant.chat` 记模型名与字符数，`assistant.models` 记主机，`assistant.tool` 记工具名 + 那次调用的形状（路径 / 命令第一行 / 成不成），**不记文件内容、不记命令输出**。`agent.rs::audit` 已改成 `pub(crate)`，三条都只此一处复用。
9. **`llm_policy.rs` 必须保持不引 crate**。它要能在写不了 `target/debug/deps` 的机器上用 `rustc --test` 单独跑（把文件 `#[path]` 进一个壳子即可）——所以 JSON 读取是手写的（深度上限 32），`llm.rs` 才引 `serde_json` 拼返回值。往 `llm_policy.rs` 里加 `use serde::…` 会让那 50 条测试整批失去可运行性。
10. **一个面板，两块画布**。`AssistantPanel.tsx` 是唯一实现（两态：对话 / 设置），主窗口拿它当右下角抽屉（`variant="drawer"`，浏览器里也走这条），桌面小窗拿它当整块内容（`variant="window"`，壳是 `AssistantWindow.tsx` + 独立入口 `assistant.html` / `src/assistantMain.tsx`）。Ctrl+K 在 `App.tsx` 里只做一件事：Tauri 下 `invoke("assistant_window_toggle")`，浏览器下落回抽屉。样式只追加 `.lattice-assistant*`（`.is-window` 修饰类给窗内布局）。设置里"测试连接"打的是 `llm_models`，它同时是唯一一处验证 key 的地方；它既能打已存的档（传 `profileId`，缺的字段回退到文件里那份），也能打正在编辑的草稿（传 `baseUrl` / `auth` / `key`）——**没有 `profileId` 时才去信草稿**，否则等于让一次拼错的请求把已存的档盖掉。
11. **编辑一条档不等于切到它**。列表行点击 = 打开编辑，`Use` 按钮才改 `activeId`。合成一个动作的后果是"我只是想改个名字，结果整套对话换了模型"。
12. **动作只有一个执行者，小窗只是转发**。`store` 只活在主窗口里（`state.json` 是它的磁盘副本）；小窗若自己跑 `AGENT_ACTIONS`，就会拿读到的旧快照写回磁盘 —— 两份 store 互相盖。所以 `platform/assistant.ts` 抽出 `AssistantSurface`：主窗口 `localSurface(records)` 直接跑真执行器，小窗 `remoteSurface()` → `assistant_snapshot` / `assistant_act`（`agent.rs`，和 agent 端点同一条 `call_frontend` 通道）→ 主窗口执行、把结果和压缩后的快照回传。**加新动作两边都不用改**，只要还走 `AGENT_ACTIONS`。三条连带事实：① `assistant_window_*` 三个命令必须是 `async fn` —— 同步命令占着主线程等 `build()`，而 `build()` 要把建窗口投递回主线程，直接死锁（真机撞过）；② 小窗的 ✕ 是 `hide()` 不是 `close()`，webview 和对话都留着，再按 Ctrl+K 回来还是那一轮；③ 位置只在拖完存（`startDragging().then(save_pos)`），拖的过程中不写盘。
13. **流式只改"怎么读"，不改"谁在说"**。`llm_chat_stream` 和 `llm_chat` 共用 `prepare()` / `check_messages` / `build_body`，唯一多出来的是"边读边把增量发出去"。五条别踩回去：
    - **切帧按字节**（`llm_policy::take_line` / `SseBuffer`）。按 `String` 拼分片的症状是中文出现替换符、一半句子消失 —— `WinHttpReadData` 完全可能把三个字节的汉字从中间切开，而 `\n` 永远不会出现在多字节序列内部，所以"先按字节找 `\n`、再解码整行"是唯一安全的顺序。
    - **取消靠 1 秒读超时 + 标志位**。WinHTTP 是阻塞 API，正在 `WinHttpReadData` 的句柄**不能关**（未定义行为）。`network::stream` 把读超时设成 `STREAM_READ_TIMEOUT_MS = 1000`，超时后用 `sink.idle` 问一句还要不要继续。别改成"关句柄"或"另起一条线程去 close"。
    - **增量的载荷必须带 `requestId`**（INV-9：`emit` 是广播），前端按 id 过滤 —— 否则抽屉和桌面小窗同时各跑一轮时，两句话会串台。
    - **增量只用来画，不参与拼装**。前端最后拿命令的返回值**整条覆盖**气泡。这样拼增量这一步写错最多闪一下，不会留下一句错话 —— 而"用增量拼最终消息"是这类实现最常见的错法。
    - **工具参数不进事件、按 `index` 累加**，拼完整才解析；用户按停止后**不再执行任何工具**（半截参数可能解析成功但少一个字段，模型会拿错的值去改桌面）。
14. **给 assistant 加一只手（文件 / 命令 / 网页 / 屏幕 / 输入 / MCP）**。设计在 [docs/design/LAT-0004-agent-hands.md](../design/LAT-0004-agent-hands.md)，落地分两处：前端的 **schema 与审批**（`runtime/hands.ts` + `platform/assistant.ts`），Rust 的 **执行与开关**（`hands.rs`）。要动的文件就这六个：`runtime/hands.ts` 的 `HAND_SPECS`（名字 + JSON Schema）和 `HAND_LABELS`（界面上那一行字）、`runtime/hands.ts` 的 `handGroup` / `needsApproval`、`runtime/i18n/assistant.ts` 的中文、`hands.rs` 的 `run()` 加一个分支、`hands_policy.rs` 的 `group_of`（工具名 → 能力组），再补 `tests/hands.html` 一条断言。八条别踩回去：
    - **能力组默认全关，而且两边都要判**。前端 `handsTools()` 只把"开着的组"的 schema 递给模型，Rust `run()` 再查一次 `Hands::enabled` —— 少了前者的后果是模型一直调一个永远被拒的工具、白烧步数；少了后者的后果是把安全边界交给一个前端 bug。**永远不要为了"少写一处"让 Rust 只信前端送来的组名。**
    - **读自动放行，写 / 命令 / 点击 / MCP 都要问**。`needsApproval` 的兜底是 `true`：**没列进白名单的名字一律要问**（新增工具忘了归类，代价是多一次确认；反过来忘了就要了一次静默提权）。只有 `file.list/read/search`、`web.fetch`、`screen.windows`、`screen.capture` 是只读的。
    - **审批必须在 `assistant_tool` 之前 `await` 完**。`platform/assistant.ts` 的 `approve()` 返回一个 Promise，用户按 Allow / Always this turn / Deny 才 resolve；**Deny 不抛异常**，回 `{ok:false, code:"denied"}` 的 tool 消息 —— 模型要能从"我不干"里继续，而不是整轮崩掉。`Always this turn` 的键是**工具名**，`send()` 里清空（跨轮记住等于用户以为关掉的一扇门还开着）。
    - **`requestId` 每个手调用都要带，并且真的能取消**。INV-9：`emit` 是广播。`hands_cancel{requestId}` 和 `llm_chat_cancel` 是两条独立通道（一轮里可能同时有流式回答和一条跑着的命令），`cancelActiveTurn()` 两条都发。`shell.run` 每 25ms 查一次标志，取消/超时都**真的 `kill()`**，不是"忽略结果"。
    - **额度写在 `*_policy.rs` 里，不写进 `hands.rs` 的分支里**。文件是 `fs_policy.rs`（4MB 读 / 2MB 写 / 一次 200 行 ~ 4000 行硬上限、二进制判定、搜索跳过 12 个目录）、命令是 `shell_policy.rs`（60 秒默认 / 1–300 秒夹紧 / 输出 16k 字符按行截断）。它们**不引 crate**，就是为了能在本机用 `rustc --test` 跑 —— 数值散进执行代码里等于这批断言从此测不到。
    - **`spawn_blocking` 里跑，别占异步运行时**。文件系统和 `Child::wait` 都是阻塞的；一条 `shell.run` 跑满 60 秒会把整个 IPC 拖着不动，界面上表现出来是"assistant 小窗卡死"。
    - **审计只记形状**：`agent::audit(app, "assistant.tool", <工具名> + 路径 / 命令首行, status, ms)`。**文件内容、命令输出一个字符都不许进审计日志** —— 那是用户的数据，而审计日志会在 `%APPDATA%` 里躺很久。
    - **手永远不给组件**。`handsTools(hands, "widget")` 直接回 `{}`：`assistant.ask` 那条借手路径只借桌面动作，不借文件系统和命令。桌面窗口连 store 都没有，更不该有 `C:\Users`。
15. **MCP 服务是"用户自己配的外部进程"，不是第八个内置工具**。工具名是 `mcp.<server>.<tool>` 三段：`server` 是 `mcp.json` 里的 `id`（Rust 生成、`[a-z0-9]` ≤32），`tool` 是服务自己报的名字压成 `[a-z0-9_-]`（撞名加 `_2`）。六条别踩回去：
    - **发现是"用户按一下"，不是每轮都敲**。`mcp_tools` 默认吃内存里那份 `CACHE`（一次应用运行一份），`refresh: true` 才重新握手。把它塞进每轮对话，等于每句话都先起一遍服务进程 —— `npx` 那种冷启动好几秒，用户看到的是"assistant 不回话"。
    - **一次调用一条连接，不复用**。stdio 服务起进程、写完就关（`StdioSession` 的 `Drop` 先关 stdin、等 300ms 再 `kill()`；直接 kill 会把最后一条 JSON 掐在半路）；HTTP 服务每次现 POST。慢是真的（`npx` 每次冷启动），但"常驻一个第三方进程"要回答的信任问题比"慢"大得多 —— **别为了快加连接池**。
    - **握手顺序不能改**：`initialize`（带 `protocolVersion: "2024-11-05"`）→ 读回 `result` → 发 `notifications/initialized` → 才能 `tools/list`。少了中间那条通知，不少服务会拒掉后面的请求，而报的错跟"协议版本不匹配"长得一样。
    - **审批照旧要问，判的是工具名**。`needsApproval` 把 `mcp.*` 全归到要问，`Deny` 之后**一个字节都不发出去**（审批在 `assistant_tool` 之前 `await` 完，见第 3 条第 14 项）。MCP 服务是本平台的一个**新信任方**，它能干什么平台不知道 —— 所以是每次调用问一次，不是每轮问一次。
    - **只交正文，40k 字符封顶**。`tools/call` 回来的 `content` 里只挑 `type: "text"` 拼起来；图片 / 音频 / 资源链接一律丢掉（模型没有视觉，收了也读不懂）。超了截断并置 `truncated: true`，让模型知道自己看到的不是全部。
    - **没有沙箱**。stdio 服务拿的是当前用户的全部权限 —— 它本来就是用户自己装的程序，装它那一步已经是授权。别在文档里暗示"平台替它隔离了"。
    - **websocket 传输没做**。`transport` 只有 `stdio` / `http` 两种，别的值一律按 stdio。别把 `ws://` 地址塞进 `url` 然后指望它能通。
16. **审批档三档：一次判，两处判**。0003 §3 的 `ask` / `auto` / `readonly`（默认 `ask`）不是三处 if，是一个函数：`runtime/assistant.ts` 的 `approvalFor(name, mode) → "allow" | "ask" | "deny"`。`platform/assistant.ts` 的动作循环、`toolsFor` 的工具表、`systemPrompt` 的措辞三处都读它 —— 加第四处调用可以，加第二套判据不行。六条别踩回去：
    - **三档差的只是「写类怎么处理」**：`ask` = `needsApproval(name) || DANGEROUS_ACTIONS.has(name)` → 问；`auto` = 只有 `DANGEROUS_ACTIONS`（目前只有 `placement.remove`）还问；`readonly` = 写类直接 **deny**（不是 ask —— 问一个注定被拒的问题是骚扰），而且 `handsTools` / `toolsFor` 先把写类从表里剪掉，模型压根看不见它。
    - **Rust 是第二道闸，不是装饰**。`hands_policy::readonly_blocks(mode, name)` 与前端 `approvalFor` 是同一句判据；`hands.rs` 真的回 `code:"readonly"`（HTTP 面 403）。别把安全边界只留在一个 React 组件里。
    - **`auto` 不等于「什么都不问」**。用户把删除交给模型时仍然要点头 —— 自动档卖的是「别每读一个文件都弹一次」，不是「别管我桌面」。
    - **只读档的桌面工具表是空的，这是对的**。八个 `AGENT_ACTIONS` 全会改状态，而桌面快照在提示词里，不需要一个 `desktop.state` 工具。
    - **一键全关不许把档位改回 `ask`**（`turnAllOff` 里显式保留 `approvalMode`）。从 `readonly` 被「重置」成 `ask` 是一次静默放宽，而且发生在用户最没防备的那一刻。
    - **界面那三个标签与三句提示**在 `runtime/hands.ts` 的 `APPROVAL_LABELS`、中文在 `runtime/i18n/assistant.ts`；`normalizeApproval` 只认小写三选一，别的字符串（包括 `read-only`）一律回 `ask` —— 存进来的值宁可从宽，也不要让一个拼错把用户关进只读档。

## 改三栏布局

`App.tsx` 的 `<main class="lattice-main">` 是个三列 grid：组件库 280 / 画布 1fr / 属性 320。收起态是 `is-left-collapsed` / `is-right-collapsed` 两个修饰类，把那一列压成 40px 竖条（按钮还在，随时能拉开）。改这块要连着看三处：

- 40px 得容得下 `.lattice-icon-btn.is-large`（30px），别收得比按钮还窄
- `.lattice-panel` 上的 `overflow: hidden` 不能删：列宽动画中间列会比内容窄，删了卡片会溢到画布上
- `nextFreeSlot` 按画布**实际宽度**换行，收起面板后画布变宽是预期行为 —— 不要为了"位置稳定"给画布设 min-width

## 加一个官方组件

```
public/widgets/<id>/
  manifest.json    id 必须是反向域名、version 是语义化版本
  index.html       入口，文件名与 manifest.entry 一致
  icon.svg         图标（manifest.icon 指过来）；16×16 视框、1.4 描边
  widget.js        自己写 call()/主题映射（参考 lattice.todo）
  style.css
```

然后 `npm run widgets:index`（`dev` / `build` 会自动跑），商店那条路再跑 `npm run store:index`（打包 + 签名 + 写目录）。注意：

- **改了组件就要抬 `version`**。`planInstall` 判的是版本号，不是文件内容 —— 忘了抬，商店里那个条目永远是"已是最新"，用户拿不到你的改动（开发期可以直接删掉重装绕过，但那不是发布流程）。
- **图标只当形状用**：平台拿它当 CSS 遮罩、用 `currentColor` 上色，所以 SVG 里 `fill` 写什么色都行，深色浅色自动对。也因此**永远不要**把组件的 SVG 内容直接塞进主窗口的 DOM（第三方内容，`<script>` 会跟着跑），只让它以图片身份参与遮罩。
- **不要用原生表单控件**。沙箱文档的 `color-scheme` 被强制成 `normal`，原生 checkbox/radio 会按浅色主题画，在深色卡片上几乎看不见。用 `appearance: none` 自绘。
- **"整行可拖"和"整行可点"必须分得开**。`lattice.todo` 的行既能拖起来排序，又能点一下勾掉：判据是 4px 阈值，且抬手后浏览器补的那次 `click` 要吃掉（`suppressClick` 用 `setTimeout(..., 0)` 复位 —— click 在它之前同步派发）。别用 HTML5 拖放：沙箱是不透明源，跨文档的 `dataTransfer` 靠不住；自己算还能控制让位动画。
- **要定时器就用 `schedule.every`，不要 `setInterval`**。组件里开定时器等于绕开平台的"不可见就停摆"（INV-10）。`schedule.every({ every: 1000 })` 拿一个订阅号，`tick` 消息里带着它，认准自己那一条再刷新；组件卸载 / 重载时 `schedule.clear(id)`。第一次要立刻显示的话（速率类指标靠两次采样做差）在 `every()` 之后自己先调一次数据方法建基线 —— Rust 侧第一次采样一定返回 0，那是设计，不是 bug。
- **卡片顶上给窗饰让位**。桌面窗口右上角那排按钮浮在组件内容之上且**能点**，通栏的输入框 / 第一行文字会被它压住。标题栏留出 `padding-right: 120px`（待办 / 便签 / 音乐都是这个数）或顶上一条 24px 状态条，见 WIDGET_SPEC §5.1。
- **组件拿不到 `localStorage`、读不到 `parent` 的 DOM，一切能力走桥。**
- **组件里所有颜色从 `--lattice-*` 变量来，别硬编码明暗。**
- **要用户调的参数写进清单的 `config`，别在卡片里画设置 UI。** 卡片只有 240×140，而且组件自己的存储是按 `widgetId` 的 —— 两个实例会共享同一份偏好。属性面板按实例渲染，那才是用户期望的粒度（见下面的配方）。

## 试第三方组件 / 改安装链路

`examples/counter` 就是现成的样本（计数器，用 `storage` 权限）。把它整个目录拖进应用窗口即可安装，改完再拖一次会覆盖旧版本（`install_widget` 先删后拷）。要换样本就照着它的四个文件改，`id` 必须与目录名一致。

安装这条路只有三个环节，出问题按顺序查：

1. `App.tsx::installFromPaths` —— webview 的 `onDragDropEvent` 给的是真实路径，直接丢给 `install_widget`
2. `widgets.rs::install_widget` —— 校验 id、删旧目录、递归复制
3. `registry.ts::loadRegistry` —— 重新扫描，`source === "user"` 的包自动算已安装

## 发一个版本 / 换目录地址

```
1. 改组件，把 manifest.json 的 version 往上抬（必须三段，`1.2` 会被清单校验拒掉）
2. npm run store:index        # 打包 + 签名 + 写 public/store/registry.json
3. 把 public/store/ 整个传上去；内置目录则跟着应用一起发
```

- **签名只有一份实现**：`scripts/sign-widget.mjs` 用 Node 的 `crypto.sign(null, bytes, key)`，Rust 侧 `signature.rs` 用 `ed25519-dalek` —— 同一套算法。要换其中一边，先跑 `npm run sign:widget -- --selftest`，它里面有一条两边都认的向量。
- **`publisher` 写在目录根上**（一处写、所有条目共用），条目级也可以覆盖。`parseCatalogue` 是"条目级优先、没有就继承根级" —— 改格式时两处一起改，只改一边的症状是"每个条目都说没有 publisher key"。
- **目录地址是一个列表**（设置菜单 → `Widget catalogue`）：`store.sources: [{ id, kind, url, enabled }]`（`state.json` v2，见 [design/0010](../design/LAT-0010-multi-source-catalogue.md)）。官方那份 id 固定 `official`，其余由地址算（`runtime/catalogue.ts::sourceIdFor`）。并发读、合并成一张表，**同 id 按列表顺序先到先得**（不挑版本高的 —— 两个源里的同 id 是两段代码两把钥匙）。`enabled: false` 的源不发请求、不进合并。远端地址只允许 http/https，取目录走 `store_load_catalogue`（2MB 上限 + 按 URL 分文件的磁盘缓存 + ETag），取包走 `store_download`（16MB，缓存到 `store-cache/<sha256>.lattice`）。**别在渲染进程里直接 `fetch` 远端目录**：那样 CSP 和出网白名单都得为平台自己开一个口子。**退回内置那份只给官方源** —— 让演示目录的包顶在一个第三方源的名字底下，等于把包挂在错误的发布者名下，界面上还看不出来。
- **目录缓存有四种结局，别只测一种**：200（正常）、304（`If-None-Match` 命中，用缓存文本）、网络失败但有缓存（`stale: true` + 原因，界面上多一行 "Showing an older copy"）、网络失败且没缓存（`Err`，退回内置那份并标 "Offline"）。缓存文件在 `%APPDATA%\com.iron-tom.lattice\catalogue-cache\<sha256(url)[..16]>.json`，删掉它就能回到"第一次装"的状态。纯逻辑在 `catalogue_policy.rs`（有单测），网络那半只能在真机验。
- 本地钉住的钥匙在 `store.trustedKeys`（`widgetId → key`），跟着 `state.json` 走。要重来一遍"第一次安装"，删掉那个组件再装。

## 改窗口行为

都在 `src-tauri/src/desktop.rs`：扩展样式（`WS_EX_NOACTIVATE` / `TOOLWINDOW` / `LAYERED|TRANSPARENT`）、WorkerW 挂载、`SetWindowRgn` 圆角。圆角半径 `CORNER_RADIUS = 12`，和画布 `.lattice-widget` 对齐。

**"能不能打字"由清单的 `interactive` 决定，不要按组件名硬编码。** `interactive: true`（默认）的组件不挂 WorkerW、去掉 `WS_EX_NOACTIVATE`、压到 `HWND_BOTTOM`，并且挂一个**底层守卫**（子类化拦 `WM_WINDOWPOSCHANGING`，给"往上提"的请求加上 `SWP_NOZORDER` —— 原地不动）。守卫是关键：Windows 激活窗口时会顺手把它提到最前，点一下便签它就窜到浏览器上面、切走再掉回去 —— 一进一出就是"闪来闪去"。拦掉 z 序不影响激活，键盘照样进得来（实测：窗口不动、`SendInput` 的字符照样落进 textarea 并落盘）。改了这块要同时看三处：`desktop::apply` / `desktop::set_sink` / `install_guard`、`manifest.ts` 的归一化、以及 `apply_to` 里的线程与顺序问题（见下）。

**"窗口看不看得见"由 `visibility.rs` 说，不由 `document.visibilityState` 说。** 主窗口最小化之后 `visibilityState` 仍然是 `visible`（实测），所以可见性从 Rust 观测、按窗口下发 `lattice:window-visible`。触发点有两个，**少一个就会出现"最小化能停、收起不能停"**：`WindowEvent::Resized`（最小化/还原在 Windows 上都是 `WM_SIZE`）+ `hide()` / `show()` 之后显式 `sync()`（这两条不动尺寸，不触发 Resized）。`sync()` 自己按 label 去重，只在**变化**时发 —— 拖边缩放会连着触发几十次 Resized，每次都发等于让组件把心跳重排几十遍。载荷带 `label`，因为 `emit_to` 是广播（INV-9）。

**页面这边还得自己拉一次初始状态。** 事件是"变了才发"，而页面可能是在窗口**已经**最小化之后才加载的（热更新、权限变更重载、改完 Rust 重启），那一次变化早就过去了。所以 `hookWindowVisibility` 在订阅之后补一句 `isMinimized()`，把初始状态对齐 —— 少了它，热更新一次就要等用户再最小化一遍才会重新停摆。

**守卫是"开关 + 子类化"两件事，顺序不能反。** 开关是一个窗口属性（`set_sink`，任意线程可同步翻转），子类化只能回窗口线程装（`install_guard`，跨线程会静默返回 0）。`apply_to` 里必须**先翻开关再落层级**：否则切"置顶"那一下的 `HWND_TOPMOST` 会被还活着的守卫吃掉，组件永远上不去。

**`shape: "region"` 的窗口有两件事只能在建窗口时定，事后补不回来。** 两条都是真机量出来的，症状都长得像"组件写错了"：

- **必须 `.transparent(true)`**（`runner::create` 里按 `spec.shape` 分支）。区域裁的是"哪一块算它"，可区域之内没被画到的像素仍由 WebView2 用窗口底色填上 —— 浅色壁纸上那就是组件周围一圈黑框（实测亮背景上它身边亮度 23，去掉窗口 234）。区域是矩形粒度，救不了这条，只有窗口本身逐像素透明才行。顺带 `desktop::strip_frame` 摘掉非客户区（`WS_BORDER|WS_DLGFRAME` + 三个 edge 扩展位）并关掉 DWM 的非客户区渲染 —— 边框没了投影还在，是最难查的那种"剩一半"。`apply_to` 与 `set_region` 各调一次 `strip_frame` 不是冗余：一次盖"建窗口"，一次盖"换轮廓"。
- **置顶必须 `.always_on_top(layer == Top)`**。事后 `set_always_on_top(true)` / `SetWindowPos(HWND_TOPMOST)` 对这类无边框透明窗口**静默失效**：返回 TRUE、`WS_EX_TOPMOST` 却始终不出现（同一个进程里的普通窗口反倒正常，所以很容易误判成"代码没跑"）。结果是她沉在浏览器下面、点不到（命中测试落在别人窗口上）。建的时候指定，窗口一出生就在顶层那一档。（`apply_to` 里仍保留一次 `set_always_on_top(layer == Top)`，那是给**运行时切层级**用的，不是给建窗口收尾用的。）

区域窗口还有两条连带事实：它没有窗饰，所以**没有桌面端的缩放手柄** —— 要调大小只能建 `config`（桌宠的「大小」就是这条路），别指望改窗口尺寸；区域里的透明像素连命中测试一起消失（`WindowFromPoint` 直接跳过），所以"看得见"就等于"点得到"，不用另写一套。

**想往屏幕上画东西，先想清楚能不能用"两条 1px 叠层窗口"。** 桌面拖拽的对齐参考线（`guides_overlay.rs`）就是这条路：`WS_EX_LAYERED | WS_EX_TRANSPARENT` 的 1px 窗口 + `UpdateLayeredWindow` 逐像素 alpha，一条竖的一条横的，**不是**一个透明 WebView2 窗口（逐像素透明的 WebView2 在软件渲染的机器上建不出来，见上面那条 `0x8007139F`）。五条别踩回去：① 窗口归**专用线程**所有、由它泵消息，跨线程 `SetWindowPos` / `UpdateLayeredWindow` 会等窗口线程处理，而窗口线程不泵消息就互相等死；② 位图只跟屏幕尺寸/颜色有关，拖动时只 `UpdateLayeredWindow` 换位置和尺寸（一次调用同时给目的地和大小），**别每帧重建全屏位图**（3456×1080×4 是 15MB）；③ 每帧 `SetWindowPos(HWND_TOPMOST)` 提一次 —— 被拖的那扇窗口常常正好压在线上；④ 收线不能只靠前端：宿主页崩了就没人发 `Hide`，叠层线程 4 秒没新坐标要自己收（前端拖动期间每秒补一发心跳，所以"指针停住看对齐"不会误触发）；⑤ 线形和画布用同一套数（4px 亮 / 4px 空、62% 亮度、没有中段实线也没有端头淡入），线段长短也只有一个实现（`align-guides.ts::guideLines`：以被拖的窗口为中心、两端各伸出「半个窗口 + 48px」，总长 = 2 ×（窗口尺寸 + 48px），再夹进工作区）—— `guide_policy.rs` 是像素规则、`styles.css` 的 `.lattice-guide` 是对应写法（一个 `repeating-linear-gradient` + `currentColor`，位置和长度走内联 style）。**别往那个元素上加 `mask-image` 或 `filter`**：它们会连子内容一起遮/一起模糊（历史上两端淡入就是这么只剩 5% 亮度的）。线是局部的，所以叠层窗口的**尺寸每帧都在变**，`len` 记得夹到位图那一维以内。

**不要加 `--disable-gpu-compositing`**，它会关掉 DirectComposition，WebView2 建不出来（`HRESULT 0x8007139F`）。GPU 相关的启动参数在 `lib.rs`，用 `LATTICE_GPU=1` 可以恢复默认。
