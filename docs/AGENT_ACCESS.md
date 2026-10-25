# Agent 接入

> 一句话：**一个执行器，四个接入面。** 底下那层（白名单动作 + 审计）是共用的，
> 它不对的话上面几层都要重写。

这份文档记录的是**已经做出来的**和**想清楚但还没做的**，两者分开写。看的时候先看每节
标题后面的状态标记：`[已实现]` / `[设计]`。

## 0. 先把四件事分开

"让 AI 调控桌面"这句话里其实有四件事，它们的风险、工作量、依赖完全不同：

| | 是什么 | 状态 | 要动什么 |
| --- | --- | --- | --- |
| **A 控制平面** | 外部 agent 摆组件、改布局、换主题、暂停 | `[已实现]` | 一条通道 + 一个新身份 + 审计 |
| **B 数据平面** | agent 读待办、加日历事件、查天气 | `[设计]` | 组件清单加一节 `agent.tools`，**所有组件作者要跟着改** |
| **C agent 当组件** | 一块看板：agent 刚才说了什么、改了什么 | `[已实现，组件在 v0.10 删了]` | 一个官方组件 + 一条 `say` 通道 + 一项新权限（桥与权限留着，第三方仍可自己画一块） |
| **D 内置 assistant** | 平台自己带模型（用户填地址 / 模型 / key），Ctrl+K 说话，它照着改桌面 | `[已实现]`（第 4 节） | 传输层 + key 落盘 + 工具循环 + 抽屉 |

顺序不能倒。B 要改组件规范（波及所有作者），C 依赖 A 已经能用；A 是地基；D 复用 A 的
执行器，但**不依赖 A 的端点**（它不需要端口开着）。

## 1. A 控制平面 `[已实现]`

### 1.1 为什么是 HTTP，不是命名管道

命名管道不开端口、不弹防火墙，但只有 Windows 客户端能用 —— 而 agent 宿主可能跑在
WSL 里、可能是 `curl`、可能是某个 Go 写的 MCP 服务。HTTP 是唯一"任何东西都会说"的
协议。

代价是端口，所以四道约束：

- 只绑 `127.0.0.1`（不是 `0.0.0.0`，局域网连不上）
- 端口取 0，由系统分配 —— 不撞车，也不占一个固定号
- **默认关，关着的时候根本不 bind**（不是"绑上但拒绝"：端口开着就是开着了，拒绝逻辑写错一次就漏一次）
- 每个请求都要 Bearer 令牌，常量时间比对

### 1.2 为什么执行器在前端

布局的权威在 `useLattice` 的内存状态里，`state.json` 只是它的落盘副本（`state.rs`
是**整份覆盖**写）。所以 agent 的请求必须落在那份状态上。

任何"后端自己改 state.json"的捷径都会和前端内存里的那份打架 —— 这个项目已经被孤儿
进程这么咬过一次（内存里那份把磁盘上的新布局盖掉）。所以：

```
HTTP 请求 → agent.rs → emit `lattice:agent` → platform/agent.ts 执行 → agent_reply
```

后端**不解释结果**：前端给的 JSON 原样当响应体发回去。少一层转译，少一处会不一致。

### 1.3 协议

只有一个 `POST /rpc`，加一个 `GET /health`（也要令牌，这样"401"和"连不上"能分开）。

```jsonc
// 读
{"op": "state"}

// 改
{"op": "act", "action": "placement.move", "args": {"instanceId": "lattice.clock#a1b2", "x": 40, "y": 40}}

// 说一句（agent 唯一的"嘴"，直接进审计日志，不经过前端）
{"op": "say", "text": "Moved the clock to the top right"}

// 第二层，先占位（现在回 unsupported）
{"op": "tool", "instanceId": "…", "tool": "todo.add", "args": {"text": "buy milk"}}
```

响应统一是 `{"ok": true, "result": …}` 或 `{"ok": false, "code": "…", "error": "…"}`。

状态码只表达**传输层**的事：`200` 处理了（哪怕业务上失败）、`400` 请求本身不对、
`401` 令牌不对、`403` 动作在白名单外、`413` 太大、`503` 窗口没答上来。业务失败用
`ok: false` + `code`，别混在状态码里 —— 否则 agent 分不清"重试有用"和"重试也没用"。

### 1.4 动作白名单

**白名单，不是黑名单。** 新增动作必须同时改三处：`agent_policy.rs` 的 `ACTIONS`、
`platform/agent.ts` 的 `AGENT_ACTIONS`、这张表。`tests/agent.html` 钉着两张表一致。

| 动作 | 参数 | 干什么 |
| --- | --- | --- |
| `placement.add` | `widgetId` | 加一份，落位用 `nextFreeSlot`（和界面同一个算法） |
| `placement.move` | `instanceId, x, y` | 移动，坐标取整 |
| `placement.resize` | `instanceId, w, h` | 缩放，夹到清单的 `minW/minH` |
| `placement.remove` | `instanceId` | 删掉，留一份 `lastClosed` 让用户能撤销 |
| `placement.pin` | `instanceId, pinned` | 固定位置与大小 |
| `placement.front` | `instanceId` | 置顶 |
| `theme.set` | `theme` | `light` / `dark` / `system` |
| `widgets.pause` | `paused` | 暂停全部组件 |

### 1.5 永远不给的

写在这里不是为了拒绝（`parse_action` 本来就不认），是为了让"为什么不给"有地方写，
也让测试钉住"哪天有人加进来就红"：

| 动作 | 为什么 |
| --- | --- |
| `widget.grant` | **提权**。agent 能给自己授权，前面所有闸门就都白设了 |
| `widget.install` | 装组件 = 跑别人写的代码，必须人点 |
| `widget.uninstall` | 卸载会连备份一起清，不可撤销 |
| `config.set` | 用户亲手填的值，需要一次界面确认 —— v1 没有确认流，所以先不给 |
| `storage.write` | 组件数据没有 schema，agent 只能瞎猜键名 |
| `state.clear` | 一条命令清空用户桌面 |
| `agent.set_enabled` | 自己给自己开门 |

`config.set` 和"安装"这两条**不是永远不做**，是"缺一个确认流"。补确认流的时候，
通道应该是界面上的一张卡片（谁、要干什么、点同意/拒绝），不是对话框 —— 对话框会被
训练成无脑点掉。

### 1.6 威胁模型（别高估令牌）

令牌文件在 `%APPDATA%\com.iron-tom.lattice\agent\endpoint.json`，**同一个账户下的
任何进程都读得到**。它挡的是别的用户、以及从网络上过来的东西；挡不住你自己账户里
跑着的程序。

桌面应用做不到进程级隔离，所以真正的防线不是密码学，是这四条：

1. 默认关，开的时候是人在界面上按的
2. 动作只有 8 个，全是可见、可撤销的布局操作
3. 每一步都进 `agent/audit.log`（一行一条 JSON：`at` / `op` / `detail` / `status` / `ms`）
4. 危险动作（授权、安装、卸载、清空）不在白名单里，agent 连试都试不到

跟 ✕ 那个 `close-guard` 是同一个思路：不追求"证明它是好人"，只追求"它做不了坏事
而你不知道"。

### 1.7 怎么用

设置菜单里打开 **Agent access**（默认关）。打开后：

```bash
npm run agent -- state
npm run agent -- act theme.set --args '{"theme":"dark"}'
npm run agent -- act placement.add --args '{"widgetId":"lattice.clock"}'
```

任何能跑 shell 的 agent 都能用这三条。MCP 那一层是**薄适配**，不是主入口 ——
把业务逻辑写进 MCP server，换个宿主就要重写一遍。

## 2. B 数据平面 `[设计]`

组件把自己的能力声明成工具，agent 通过平台调用。这是长期真正的价值，但它是一次
**规范变更**，所以放到最后。

### 2.1 清单里加一节

```jsonc
{
  "id": "com.example.todo",
  "agent": {
    "tools": [
      {
        "name": "add",
        "description": "Add one item to the todo list",
        "params": { "text": "string" },
        "result": { "id": "string" }
      }
    ]
  }
}
```

组件侧收到一条 `agent-call`，回一条 `agent-result`（和现有心跳同一个 postMessage 通道）。

### 2.2 三个必须先回答的问题

**一、调哪个实例？** `lattice.weather` 可以同时摆三份（上海、东京）。工具调用必须带
`instanceId`，而 agent 得能从 `state` 里看到这些实例 —— 这就是快照里 `placements`
带 `instanceId` 的原因。

**二、组件没在跑怎么办？** 这是最容易漏的一条。三种情况都会让调用落空：窗口不存在
（只在画布上，而主窗口收起）、被暂停、被别的窗口完全挡住（`occlusion.rs` 会把心跳
停掉）。桥调用本身不是定时器，被挡住也能回；**但窗口不存在时没有宿主页，没人能答**。
所以 `tool` 要么能唤醒（先把窗口建出来），要么回一句能看懂的话，而不是超时。

**三、要不要单独的授权轴？** 组件的 `grants` 是"这个组件能不能联网"，不是"agent 能不
能操作它"。这两个必须分开：用户允许天气组件联网，不等于允许 agent 往里塞数据。建议
一条独立授权：**allow agent to call this widget's tools**，默认关，按 `widgetId` 记。

### 2.3 一条原则

**agent 永远不碰原始存储。** 组件的 `widget-store/<id>.json` 是用户的便签和待办，
没有 schema，agent 读了也只能瞎猜。要数据就走组件自己声明的工具 —— 由组件的代码决定
暴露什么、怎么解释。平台不当数据出口。

## 3. C agent 当组件 `[已实现，组件后来删了]`

> **v0.10 末尾把这块看板连包删了**（用户原话："widgets 里的 now playing 和 agent 没有什么作用"；那句里的 "now playing" 说的是商店目录里一条旧条目，不是本仓库的组件 —— 音乐组件 `lattice.music` 留了下来）。删掉的是组件包，**不是这条口子**：`agent.activity` 与 `agent:activity` 权限还在 `WIDGET_SPEC` 的方法表里，第三方组件想自己画一块日志看板随时能接。读日志的默认姿势于是回到终端：`npm run agent -- state`。下面几节记的是当初为什么不做聊天窗 —— 那条判断不受影响。

一个官方组件 `lattice.agent`，但它**不是聊天窗，也不带模型**。

这个决定值得写下来，因为它把一整套攻击面直接删掉了：没有 baseUrl、没有 API key、没有
`network` 权限、不碰网络。它只做一件事 —— 读审计日志，把 agent 刚才说了什么、改了什么
列出来。

### 3.1 为什么不是聊天窗

最初的设计是"模型在窗里指挥平台"。真做的时候发现它要付三笔钱，而且第三笔最贵：

1. 组件的配置里要存一个 API key（用户的，落在 `widget-store` 里）
2. 要开 `network` 权限，而 `network.fetch` 的主机白名单是给固定域名的 —— 让用户自己
   填 baseUrl，白名单就形同虚设
3. **有嘴就有手**。一个能发请求的组件，离"能改布局"只差一条桥方法；那条口子开出去
   以后收不回来

而它想解决的问题 —— "我看不见 agent 在干什么" —— 不需要模型就能解决。agent 宿主
（Claude Desktop / CLI / 任何会说 HTTP 的东西）本来就有自己的界面，它只是**说不出话**。

> **这一条在 v0.10 被推翻了 —— 见第 4 节。** 推翻的不是理由，是**对象**：上面三条
> 说的是"**组件**不该自带模型"，后来发现我把它读成了"**平台**不该有模型"。平台自己
> 带一只，三条都不成立（key 在 Rust 侧、请求走 Rust、手就是下面这八个动作）。

### 3.2 所以给了它一条 `say`

`{"op": "say", "text": "…"}` 是 agent 唯一的嘴。它不走前端往返 —— `agent.rs` 直接写进
`agent/audit.log`，和 `act` 那几行并排。理由很实在：说一句话不需要等窗口答上来，
窗口没开的时候这句话也该留下。

两条约束：

- **压成一行**。审计日志是 JSONL，多行内容会把后面每一行都拆坏。所以
  `say_text` 用 `split_whitespace().join(" ")` 压平。
- **超长拒绝，不截断**。上限 500 字符。截断等于替 agent 决定"后半句不重要"，而它会以为
  自己说完了。拒绝它，它下次会说短一点。

### 3.3 看板为什么骗不了人

`act` 那几行是**平台**写的，`say` 那几行是 agent 自己的话，两者在数据里就是不同的 `op`。
组件只负责显示，不解释、不执行、没有任何调用动作的接口 —— 它结构上做不了事，也就没法
被诱导去做事。

另外它需要一项新权限 `agent:activity`：审计日志里有用户的操作历史，白给不合适。

`agent` 关着的时候它照样显示历史（过去发生过的事不会因为关掉开关就变成没发生过），
只是不再有新行进来。

### 3.4 以后真要做聊天窗

那就得先回答上面第 3 条 —— 组件的"手"从哪来。两个选项：

- 给 `127.0.0.1` 在 `network.fetch` 上开个口子：等于给**任何**组件开
- 一条专用桥方法：更干净，但平台从此内置了一个"能改布局的组件"

两条都要等 B 的授权轴（`2.2` 第三条）做完，因为那时才有"agent 能做什么"这个概念可以复用。
现在不做。

> **本条已被第 4 节取代。** 最后的答案是第三条路：**组件只拿嘴（`llm.chat`，不带工具），
> 手留在平台手里**（assistant 面板 + 现有的八个动作）。既没有给组件开 `127.0.0.1`，
> 也没有让组件能改布局。
>
> **v0.10 末尾又往前走了一步，但没走回头路。** 桌宠要"听一句话、替我把时钟挪过去"，
> 于是多了 `assistant.ask`（权限 `desktop:control`）—— 组件**借**平台的手，而不是长出一只
> 自己的：整轮工具循环仍然只在主窗口里跑，工具表还砍掉了 `placement.remove`。上面那两条
> 依然没做：`127.0.0.1` 没开口子，组件也没有一条"自己调执行器"的路。见 §4.7 与
> [WIDGET_SPEC §3.5](./WIDGET_SPEC.md)。

## 4. D 内置 assistant（模型在平台里）[已实现，v0.10]

一句话：**用户填一个 OpenAI 兼容的地址、模型名和 API key，Ctrl+K 说话，它用现有的八个
动作改桌面。**

### 4.1 和前三个的关系

| | 谁在说话 | 手从哪来 | 入口 |
| --- | --- | --- | --- |
| A 控制平面 | 外部 agent（Claude Desktop / CLI） | HTTP `POST /rpc` + 八个动作 | `127.0.0.1:<port>` |
| D 内置 assistant | **平台自己**带模型 | 同一个执行器（`runAgentAction`） | 桌面小窗（Ctrl+K，能拖；浏览器里退回主窗口抽屉） |
| W 组件借手 | 组件里的对话（桌宠、便签上的小助手） | 同一个执行器，工具表**砍掉 `placement.remove`** | 桥上的 `assistant.ask`（要 `desktop:control`），见 §4.7 |

两条路的执行器**是同一个**（`platform/agent.ts`）。这不是省事，是安全模型：白名单只有一份，
"agent 能改什么"的答案不会因为入口不同而不同。区别只在"谁在说"和"谁在听"。

### 4.2 key 在哪儿，为什么这么放

`%APPDATA%\com.iron-tom.lattice\assistant.json`：

```jsonc
{ "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "temperature": 0.6, "apiKey": "sk-…" }
```

- **前端只见掩码**（`sk-1…cdef`）。key 一旦进了 JS 状态，就会跟着调试面板、截图、某次
  `JSON.stringify` 一起外泄，而它换不了（用户得去后台吊销）。
- **组件见不到**。组件的 `llm.chat` 走桥 → Rust 读 key 发请求，组件全程不知道它长什么样，
  也没法改 baseUrl。
- **开发时可以完全不落盘**：`LATTICE_LLM_KEY` / `LATTICE_LLM_BASE_URL` / `LATTICE_LLM_MODEL`
  三个环境变量优先，界面上会标成"key 来自环境变量"。
- 明文 `http://` **只允许本机**（Ollama / LM Studio）：key 走明文发到外网等于贴在明信片上。

### 4.3 协议：只做 OpenAI 兼容

`POST {base}/chat/completions`，`tools` + `tool_choice: "auto"`。选它是因为一份代码能盖住
DeepSeek / OpenAI / Kimi / Qwen / Ollama / LM Studio —— 而"再多支持一家原生协议"是
`llm_policy.rs` 里一个函数的事，不是架构问题。地址归一化很宽容：`api.x.com`、
`https://api.x.com/`、`https://api.x.com/v1`、整条 `/chat/completions` 贴进来都认。

### 4.4 工具：就是那八个

`runtime/assistant.ts` 的 `TOOL_SPECS` 和 `AGENT_ACTIONS` **逐字一致**（`tests/assistant.html`
11 条断言钉着），每个工具的参数名也和执行器读的键逐个对上。新增动作时**三处一起改**：
`agent_policy::ACTIONS`、`AGENT_ACTIONS`、`TOOL_SPECS`。

仍然不给的，和 §1.5 一样：授权、安装、卸载、`config.set`、`storage.write`、清空。模型要是
被要求做这些，它该说"做不到" —— 系统提示里写死了这一条。

### 4.5 三条边界，别拆

1. **组件的嘴和平台的手分开。** `llm.chat` 永远不带工具；组件想有手，只能借
   `assistant.ask`（另一项权限、另一张更小的工具表），没有第三条路 —— 尤其没有
   "组件直接调 `runAgentAction`"。给组件授权，不等于把布局交给它。
2. **循环有上限**（6 轮，`MAX_STEPS`）。模型可以连着做几步，但不能自己转圈把额度烧完；
   Rust 那边还有 300ms 节流兜底。
3. **错误要说人话。** 401 是"key 被拒"，404 是"base URL 多了或少了 `/v1`"，429 是"额度/频率"。
   统一说"检查你的网络"是更新器踩过的坑（见 ROADMAP）。

### 4.6 小窗不是第二个执行者

assistant 现在是一个**独立窗口**（`assistant.html` 这个单独入口，不加载平台外壳，也就不加载
store）。这里有个必须想清楚的地方：**`state.json` 不是状态，它是主窗口那份 store 的磁盘副本。**
小窗要是自己跑一遍 `AGENT_ACTIONS`，它读到的快照是启动时那份，写回去就是把主窗口期间的所有
改动（用户新摆的组件、改过的主题）整块盖掉 —— 两份 store 互相盖，丢的是用户的布局。

所以动作只有一个执行者：

```
小窗 AssistantWindow ── invoke("assistant_snapshot") ──► agent.rs ──{op:"state"}──► 主窗口
                     ── invoke("assistant_act", …)   ──►          ──{op:"act", …}──► 主窗口执行
                                                                   ◄── 结果 + 压缩后的快照
```

- 走的是 agent 端点**同一条** `call_frontend` 通道（同一个 5 秒超时、同一个审计点），不是新开一条路。
- 动作仍然先过 `agent_policy::parse_action` 的白名单 —— 小窗不是特权入口，它只是另一个壳。
- 抽屉和小窗共用 `AssistantPanel.tsx`，两者的差别只有 `AssistantSurface` 一个对象
  （`localSurface(records)` / `remoteSurface()`），工具循环本身一行都没分叉。
- 三个窗口命令必须是 `async fn`：同步命令占着主线程等 `build()`，而 `build()` 要把建窗口投递回
  主线程 —— 真机上这一条表现为整个应用卡死，连托盘都不响应。

窗本身的取舍：**不置顶**（Ctrl+K 会把它提到前面，符合"叫它出来"而不是"永远压着你"）、
✕ 只是 `hide()`（webview 和那轮对话都留着）、位置只在拖动结束时写
`assistant-window.json`（拖的过程中不碰盘）。

### 4.7 组件借手（`assistant.ask`）[已实现，v0.10 末尾]

桌宠那类组件要的东西不是"再来一个聊天窗"，而是"我说一句、你替我摆一下"。这条路
（桥上叫 `assistant.ask`，权限 `desktop:control`）的形状是这样的：

```
组件 iframe ── lattice.assistant.ask({messages, persona}) ──► widgetHost/WidgetFrame
             ── invoke("assistant_ask") ──► agent.rs ──{op:"ask"}──► 主窗口
                                                                    ── runWidgetTurn()
                                                                       = 同一个循环 + toolsFor("widget")
                                                                    ◄── {text, actions}
```

四条都是"不许拆"级别的：

1. **循环只在主窗口里跑。** 组件那两个宿主里，桌面窗口 (`widgetHost.ts`) 连 store 都没有，
   让它自己跑工具循环等于拿启动时的旧快照往回写 —— 和 §4.6 小窗那条是同一个坑，代价也
   一样（丢用户布局）。所以 `assistant.ask` 在 Rust 侧**只是一次转发**，真正的执行器是主窗口
   里那份 store。
2. **工具表是砍过的，不是照抄的。** `toolsFor("widget")` 把 `placement.remove` 摘掉：模型
   在组件这条路上一旦调它，拿到的是"没有这个工具"，系统提示里另外写死了一句"这一轮你没有
   删除组件的工具，让用户自己按 ✕"。删一块便签是**不可撤销**的（`removePlacement` 的 8 秒
   `Undo` 只在 UI 上），而"桌宠误会了一句话"太容易发生。
3. **一轮只能有一条。** 同一个窗口里上一轮没回来时新的直接拒（`a turn is already running`）。
   不排队：两轮并发改同一份布局，结果一定有一半是错的，而且没有任何人能解释清楚哪一半对。
4. **超时是 180 秒，不是 8 秒。** 一轮最多 6 次模型往返，`call_frontend` 那个 8 秒的默认值
   会把正常的一轮砍断。`assistant.rs` 里 `ASK_TIMEOUT` 单列；SDK 那侧同样给这一条单独一个
   185 秒（默认 3 秒会先把组件坑掉）。审计写 `widget.ask`，只记组件 id 与字数。

**组件拿到的只有 `{text, actions}`。** 它看不到工具调用、看不到快照、也不能决定执行什么
（那是"借"，不是"长手"）。作者视角的契约见 [WIDGET_SPEC §3.5](./WIDGET_SPEC.md)。

### 4.8 浏览器预览里的 assistant（`npm run dev`）[已实现]

浏览器里没有 Rust，`isTauri()` 为 false，而 §4 的每一条路都是 `invoke("llm_…")`。所以
`npm run dev` 期间 dev server 自己挂了一个中间件（`scripts/dev-llm-proxy.mjs`），把
`llm_profiles` / `llm_profile_save` / `llm_profile_remove` / `llm_profile_activate` /
`llm_set_key` / `llm_models` / `llm_chat` / `llm_chat_stream` / `assistant_hands*` 搬到
`/api/llm/*` 上。前端只有一个分叉点：`platform/devLlm.ts` 的 `callCommand()`（`isTauri()`
为真走 IPC，为假走这条）。

**key 仍然不进前端。** 读写都发生在 Node 里，前端只看得见 `keyHint` 掩码；`llm_set_key`
会把用户**刚粘进来的**明文发过去（和桌面面板里打字是同一件事），发完就不回传。

**前端只认一个门：`platform/llm.ts`。** 它把那三个文件（`devLlm.ts` 的两种传输、
`assistant.ts` 的模型档与对话、`hands.ts` 的手）重新导出一遍，自己一行逻辑都没有、也不
另起名字。要用 assistant 就 `import { readLlmProfiles, runAssistantTurn } from "./llm"`，
不必知道底下分成几个文件、更不必知道现在跑在窗口里还是浏览器里 —— `callCommand` 自己认。
浏览器里同一个模块也能直接用（dev server 直译 `.ts`）：控制台里
`const llm = await import("/src/platform/llm.ts")`，`llm.readLlmProfiles()` 回来的和面板
是同一份数据（还是掩码）。两条边界：**三个源文件不许反过来 import 这个门**（会成环，而
环在这里不报错，只在某个加载顺序下变成 `undefined`）；**面板不在门里**（`AssistantPanel`
是 React 组件，从这儿再导出会把 JSX 和样式拖进"只想发一个命令"的调用方）。

三道闸，每一道都对着"这个口子会不会被人借走"：

1. **只认本机**（`req.socket.remoteAddress` 是回环）。就算有人把 dev server 开成 `--host`，
   这个口子也不会跟着出去。
2. **只认本机的 `Origin`**。组件 iframe 的源是不透明的 `"null"`，过不去。
3. **POST 必须是 `application/json`**。跨源请求要先过预检，而没人答那份预检 —— 不可信
   代码没法借这个口子花用户的 key。

**为什么不是那条 agent 回环端点**（`127.0.0.1:65401`，§1）：它默认关（预览时多半没在跑）、
请求体上限 64 KB（带工具的对话轻易超过）、没有流式增量，而且它是一道**有令牌的公开口子**
—— 拿到 token 的任何进程都能拿用户的 key 花钱。dev server 的中间件只在这台机器上、只在
`npm run dev` 期间存在，浏览器根本不用越过第二道口。

**这一层不复制的东西**：流式增量（`lattice:llm-delta` 是 Rust 从 SSE 切出来的）、六只手的
执行（`assistant_tool` 的白名单与额度都在 Rust 里，这里回一句 `desktop-only`）、审计
（`agent.rs::audit`）。所以浏览器预览是"能用"，不是"和桌面一样"：回答在结束时整句出现，
手一按会得到"桌面应用里才有"。

**这一层必须复制的东西**：`llm_policy.rs` / `llm.rs` 的那几条规则（base URL 归一化、三种
鉴权、错误翻译、`assistant.json` 的 v3 形状）。改一边要改另一边 —— `npm run test:llm-proxy`
（23 条）用 Rust 测试里的同一组样例钉住它，这是唯一的提醒。

### 4.9 六只手在真机上的样子 [已实现，2026-10-25 验过]

把 `callHand` 直接接到 `assistant_tool` 上逐只点名跑了一遍。四件事和"想当然"不一样，写在这里：

- **`workspace` 是默认位置，不是牢笼。** `fs_policy::path_is_under` 有 4 条断言，但
  `hands.rs` 一次都没调用它：`file.read` 读得了任意绝对路径（`..\..` 出去也行），
  `file.write` 只要目标目录存在就能写到外面。挡住它的是**审批条**（上面印着完整路径），
  不是路径校验。别在文档里把它写成沙箱；真要收，先回答"读要不要一起收"—— 读是自动放行的。
- **读自动放行，写 / 跑命令 / 点键鼠必问。** `file.list` / `file.read` / `file.search`
  不弹确认；其余走 `approve`，拒绝时回给模型的是那句 `the user declined this action —
  do not retry it; ask what they want instead`，模型于是会说"我没有改动任何东西"。
- **截图模型看不见。** `screen.capture` 回 `vision: false` 加宽高，模型拿不到像素 ——
  提示词里就是这么写的，别指望它"看一眼屏幕"。
- **增量是攒批的。** 一轮真网关的回答通常只来 1–2 个 `delta` 事件（Rust 按 60ms / 24 字
  攒批），短回答会并成一块；字仍然边出边显示，只是块更粗。

## 5. 明确不做（v1）

**后台自主调控。** 比如"每天按天气自动换主题"——那需要一个常驻订阅，而人在环（用户说
一句、它做一次）和无人环是两套完全不同的安全模型。先把有人的那条做顺。

## 6. 验证

| 部分 | 怎么验 |
| --- | --- |
| `agent_policy.rs`（HTTP 解析 / 令牌 / 白名单 / `say`） | 26 条 `rustc --test`，见 `.scratch/agent-test.rs` |
| `platform/agent.ts`（动作执行器） | `tests/agent.html` 57 条，跑的是**真 store** |
| `scripts/lattice-agent.mjs`（客户端） | `npm run test:agent`，14 条，起假端点测请求形状、`say` 的整句传递与退出码 |
| `llm_policy.rs`（地址 / 请求体 / 响应 / 工具调用 / 错误翻译） | 21 条 `rustc --test`，见 `.scratch/llm-test.rs` |
| `runtime/assistant.ts`（工具表 / 工具表裁剪 / 人设 / 历史裁剪 / 快照预算） | `tests/assistant.html` 114 条 |
| `assistant_window.rs` + 小窗那条转发 | **2026-10-25 实机验过**：`assistant_window_toggle` 回 `true`，CDP 查到 `assistant.html` 的 DOM（标题栏、面板、`Assistant · deepseek-v4.1-flash`、跟随主题），窗口里说一句 → 工具真的挪了桌宠（`lattice.pet#demo01` → 60,80）并回话；藏起来再叫回来还是同一个 webview、同一轮对话；拖完 `assistant-window.json` 落成 `{x:1300.0,y:444.0}` |
| `llm.rs` + 工具循环 + 组件那条路 | **2026-10-25 实机验过**：先起一个假的 OpenAI 兼容服务（`.scratch/fake-llm.mjs`），真点开、真打字 —— 卡片从 (32,40) 挪到 (300,120)，气泡里出现"✓ 移动 lattice.pet#demo01"和回复；两个 pet iframe 的 `llm.chat` 都回到 `{ok:true,text:"…"}`；把 key 换成错的之后 `listModels` 报"the provider rejected the API key (HTTP 401)"。**之后换成了真厂商**（天枢 Dubhe 网关，OpenAI 兼容根是 `…/v1/8686/v1`）：列出 4 个模型、`finish_reason: "tool_calls"` 的往返、`role: "tool"` 回填都被接受 |
| `assistant_ask` + 组件那条路（借手） | **2026-10-25 实机验过**：先在属性面板给 `lattice.pet` 勾上「替我调整桌面」（`grants` 变成 `["llm:chat","desktop:control"]`，卡片当场按新权限重载），再从主窗口 `invoke("assistant_ask", { widgetId: "lattice.pet", messages: JSON.stringify([{ role: "user", content: "把 lattice.pet#49898d37 这只挪到 700, 240，然后置顶" }]), persona: "你是一只桌宠…" })` —— 真网关回"挪到 700, 240 了，也置顶了…"，`actions` 两条都 `ok`，那只从 `(24,460)` 到 `(700,240)`；审计是 `widget.ask · lattice.pet · 71 chars`，加每一步的 `assistant.chat`（`tools: placement.move, placement.front`）。**删除真被挡住**：问"把 lattice.pet#demo01 删掉"，回的是"我删不了自己呀，手里没有删除工具。你在画布上点一下那个 ✕ 就行。"，`actions: []`，`placements` 一个字没动。**组件自己那条路也走通了**：画布里的桌宠点开气泡打"把 lattice.pet#9c90cc09 挪到 900, 100" → 气泡里出现回话加一行"· 移动 lattice.pet#9c90cc09"，盘上那只真的到了 `900,100`。中途踩的坑（`messages` 在线上是 JSON 文本）见 ROADMAP 那条 |
| `platform/llm.ts`（前端唯一的门）与 dev server 那条 `/api/llm` | **2026-10-25 验过**（`npx vite --port 1431`）：页面里 `await import("/src/platform/llm.ts")` 拿到 19 个值导出，`readLlmProfiles()` 回 `keyHint: "sk-d…1-hA"`（明文没出来）、`readHands()` 六组开关齐全、`listModels()` 列 4 个模型、`callCommand("llm_chat_stream")` 对真网关回 `"ok"`（`usage 38 → 24`）。三道闸（回环地址 / 回环 `Origin` / POST 必须 `application/json`）由 `npm run test:llm-proxy` 的 23 条钉着 |
| agent 端点的真机往返 | **2026-10-25 验过**：`agent_set_enabled` 从窗口里打开 → `%APPDATA%\…\agent\endpoint.json` 落成 `{port: 52276, token}`；`npm run agent -- ping / state / say` 三条都成（`state` 回 16 个组件的快照，`say` 回 `{ok:true}`）；`theme.set light` 经端点在真 store 上生效再还原成 dark；不带令牌回 401 `missing or wrong bearer token`；关掉之后 `endpoint.json` 消失、端口 0 个监听、CLI 退出 1 并说清"Lattice 没在跑，或者 Agent access 关着"。curl 8.21 用同一条 `POST /rpc` 也通（PowerShell 那次 `timed out reading the request` 是它自己把 JSON 里的引号吃了，不是端点的事） |
| 六只手（`assistant_tool`） | **2026-10-25 真机逐只跑过**：文件（中文目录 `中文 目录/hello.txt` 读出 `第一行：你好，世界`；二进制回 `binary`；`file.search` 命中中文；`file.write` 落 40 字节 UTF-8 无 BOM，`parents: true` 建出两层新目录）、`shell.run`（`Write-Output '你好，世界 😀'` 原样回、`exit 3` 回 `code: 3`、stderr 有内容、cwd 是 workspace；按 Stop 1517ms 后回 `cancelled` 且子进程没了；`timeoutMs: 2000` 跑 20 秒的睡眠 → 2013ms 回 `timedOut: true`、没留孤儿）、`web.fetch`（example.com 折成正文；`http://github.com` 跟到 `https://github.com/` 并报新地址；`ftp://` 回 `bad_args`）、屏幕（`screen.windows` 22 个窗口、焦点窗口排第一、认得出 `Tauri Window` 那份；`screen.capture` 落 3456×1081 PNG，签名与 IHDR 都对）、MCP（自建 stdio 探针：起 `node` 进程 → `initialize` → `tools/list` → `mcp.probe.echo` → `tools/call` 回 `probe echo: 你好 MCP`，第二次发现走缓存 3ms）、键鼠（`input.click` 落在算好的点、`input.type` 打出 `你好 😀!`、`input.key` 的 `Enter` 进到 contenteditable） |
| 一轮完整对话（Deny / Allow） | **2026-10-25 真机**：真网关、真 `runAssistantTurn`。让它写文件并 `approve → false`：确认条请求是 `Write 12 characters to …\denied-写.txt`，工具结果 `the user declined this action…`，模型回"你拒绝了这次写入，所以我没有改动任何东西"，**磁盘上确实没有那个文件**；换成 `approve → true`：写文件 + `shell.run Get-Date` 两条都 `ok`，落盘 19 字节 UTF-8、内容 `probe-write-允许`。读（`file.list` / `file.read`）不弹确认，和 `needsApproval` 一致 |
