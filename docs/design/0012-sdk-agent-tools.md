---
status: accepted
date: 2026-10-26
code: packages/sdk/lattice.js, packages/sdk/lattice.d.ts, examples/counter/lattice.js, tests/sdk.html
---

# 0012 —— 让 SDK 包一层 `agentTools()`：把四条规矩收进一个口

> 这一份补的是 [`AGENTS.md`](../../AGENTS.md) §8 与 [`../ROADMAP.md`](../ROADMAP.md) v0.11
> 末尾留着的第三处缺口：**"SDK 还没包一层 `agentTools()`，作者要自己听 `agent-call`"**。
> 契约本身没变，还是 [`../WIDGET_SPEC.md`](../WIDGET_SPEC.md) §3.6 那五条硬规矩 + 四件必须做到的事；
> 这一份只决定**作者那一侧写成什么样**。

> **现在的状态：落地完成。** `packages/sdk/lattice.js` 的 `api.agentTools(handlers)` 返回一个只
> 摘自己那几条的 `off`，`.d.ts` 补了 `AgentToolHandler` / `AgentToolHandlers`，
> `npm run sdk:sync` 已把两份副本刷进 `examples/counter/`；`tests/sdk.html` 的 7.2 那一段
> **47 → 55 条**。`status` 因此是 `accepted`，不是 `draft`。

## 1. 问题

数据平面（v0.11）落地时，组件那一侧是一段**手写**的 `postMessage`：

```js
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.__lattice !== 1 || data.type !== "agent-call") return;
  const { callId, tool, args } = data.payload;
  const reply = (payload) =>
    event.source?.postMessage({ __lattice: 1, type: "agent-result", payload: { callId, ...payload } }, "*");
  // …这里才是作者要写的东西
});
```

这段信封不属于作者的业务逻辑，却**每个作者都要手抄一遍**，而 §3.6 对它有四条要求：

1. 一定回话，而且 `callId` 必须是同一个；
2. `ok: false` 要带一句能读的原因；
3. 返回值会被 `JSON.stringify`，超 4000 字符是**拒绝**；
4. `instanceId` 不进 `args`。

四条里任何一条抄错，坏法都是**静默的**：漏 `callId` → 平台认不出这次回话，等 8 秒告诉模型
"它没应"，用户看到"这个组件不听话"；`ok: false` 不写原因 → 模型只能猜；自己再套一层
`{ ok: true, result }` → 模型收到的是信封不是数据。而 SDK 的存在意义本来就是**信封归 SDK，
业务归作者**（`lattice.storage.get` 不会要求作者自己拼 `{ id, ok }`）。

另有一个只有 SDK 才看得见的问题：**一份文档里可以有好几个 SDK 实例**。组件的不同区块各建一个
client 是合法用法（`tests/sdk.html` 自己就这么用），而每个实例都挂着自己的 `message` 监听器。
消息是发给 `window` 的，所以**每个实例都会收到同一次 `agent-call`** —— 谁挂了实现谁就回一条，
没挂的那个回 `unknown tool`，平台先收到哪条全看监听器注册顺序。手写方案里这件事不存在
（作者只挂一个监听器），包一层之后就必须处理它。

## 2. 候选

| | A：SDK 加一个 `agentTools(handlers)` | B：不包，只把文档写清楚 | C：SDK 自己读清单、按 `agent.tools` 生成注册表 |
| --- | --- | --- | --- |
| 作者写什么 | 一张 `{ 名字: 函数 }` 表 | 一整段 `postMessage` 信封 | 什么都不写，但每个工具的实现得靠"约定名字"暴露 |
| 信封（`callId` / `ok` / `result`）谁负责 | SDK | 作者，抄一次 | SDK |
| 一处写错会怎样 | 最坏是"名字没对上"，有回话 | 静默超时 8 秒 | 契约藏在隐式约定里，读代码看不出来 |
| 多实例重复回话 | SDK 收敛掉 | 本来就没有 | SDK 收敛掉 |

## 3. 决定

选 **A**，五条边界：

1. **返回值就是 `result`，抛错就是 `ok: false`**。作者不拼信封。`throw new Error("the list is
   locked")` 之后模型收到的是 `{ ok: false, error: "the list is locked" }` —— 直接就是它要转述
   给用户的那句话。空消息（`throw ""` / 没有 `message` 的值）退成 `"the tool failed"`：
   §3.6 要求 `ok: false` 带人话，一条空的 `false` 等于让模型猜。
2. **`undefined` 落成 `result: null`**，不是省略 `result` 字段。`{ ok: true }` 和
   `{ ok: true, result: null }` 对平台是一回事，但对作者是两回事：前者读起来像"我忘了返回"，
   后者是"这个工具本来就不回东西"。真正会被 `JSON.stringify` 丢掉的 `undefined`（比如返回值
   里某个字段）不归 SDK 管，那是 JS 的事。
3. **没注册的名字回 `unknown tool: <名字>`，但要先让一拍**。所以回话是
   `setTimeout(…, 0)` 之后再认领：同一份文档里可能**另一个实例**挂了这个名字，同步就回等于
   抢答。0ms 足够让同一轮消息的所有监听器都跑完；平台那边有 8 秒预算，这一拍不影响任何事。
   宁可回一句"我没这个工具"，也不要让模型干等 8 秒再收到一模一样的结论。
4. **一次 `callId` 只回一条，跨实例**。认领表放在**模块级**（`agentClaims`），不是每个 client
   一份 —— 要挡的正是"同一个文档里两个 client 都收到"。上限 256 条，超了丢最老的：一次会话
   里的调用数是有限的，这个表只是防止无限长。
5. **`off()` 只摘自己那几条**。按 `handler` 的**身份**比对（`agentHandlers.get(name) ===
   handlers[name]`）：热重载 / 重复注册的场景里，后一次注册会覆盖同名项，先注册的那个 `off()`
   不该把后来者摘掉。名字没通过类型检查时抛 `TypeError`（不是静默跳过）—— 注册一次拼错，
   症状是"模型调它永远 unknown"，而抛错在开发时就看得见。

**为什么不让 SDK 读清单、按 `agent.tools` 自动生成注册表（候选 C）**：清单里的 `params` /
`required` 已经是 schema 的**唯一一份家**，SDK 再读一遍只会多出一份要同步的副本；而"每个工具
的实现挂在哪"仍然要靠约定（`window.someName` 之类的隐式表），比一张显式的 `{ 名字: 函数 }`
更难读。**名字对不上清单**这件事也不该由 SDK 拦：SDK 在沙箱里，判据在平台侧
（`runtime/widget-tools.ts::widgetToolSources`），一处判据一个家。

## 4. 接口与数据

```ts
export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: { callId?: string; tool: string },
) => unknown | Promise<unknown>;

export type AgentToolHandlers = Record<string, AgentToolHandler>;

/** 挂上实现，返回摘掉这次注册的函数 */
agentTools(handlers: AgentToolHandlers): () => void;
```

- **没有新的落盘字段、没有新权限**。权限仍是清单声明 + `agent:tools` 那一条独立的授权轴
  （`AGENTS.md` 不变量 4 / §3.6），SDK 不参与授权判断 —— 没授权时平台根本不会发 `agent-call`。
- **`context` 里带 `tool`**：一个函数挂两个名字时（通常不该有，但别名很常见）不用闭包再包一层。
  `callId` 原样透传，作者写日志时能对上平台那一侧。
- **`args` 已经是对象**。`payload.args` 缺省时 SDK 给 `{}`，所以 `args.text` 不会 TypeError；
  类型不合法（清单只允许 `string` / `number` / `boolean`）由平台在调用前拒掉，SDK 不重复校验。
- **回话长度不在 SDK 里判**。4000 字符的拒绝语义属于平台（`normalizeReply` 返回 `too-big`），
  SDK 判一遍等于把同一条上限写两个地方 —— 而两处上限一旦漂移，作者会看到"SDK 说没事、
  平台说太大"。
- **副本**：`packages/sdk` 是唯一真源，`examples/counter/lattice.js` / `.d.ts` 由
  `npm run sdk:sync` 刷；`npm run test:sdk` 逐字节比对。SDK 版本仍是 `0.1.1`，
  `SUPPORTED_SDK = "^0.1"` 不动：这是**新增**一个方法，没改任何已有形状，也没有任何地方校验
  清单里的 `sdk` 字段。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 模型每次调都收到"它没应"（8 秒） | 作者忘了回话 / 漏了 `callId` | 用 SDK；信封由它保证，作者只写业务 |
| 一次调用回出两条 `agent-result` | 文档里有多个 client，各自挂监听器 | 模块级认领表 + 没挂实现时 0ms 后再认领 |
| 模型说"工具不存在"，可清单里明明有 | `agentTools({…})` 里的名字和清单对不上 | 回 `unknown tool: <名字>`，让模型当场知道；名字拼写以清单为准 |
| `ok: false` 但 `error` 是空串 | 作者 `throw ""` / throw 了一个没有 `message` 的对象 | 退成 `"the tool failed"` |
| 模型收到的不是数据，是 `{ ok: true, result }` | 作者自己套了一层信封 | 返回值**就是** `result`；SDK 文档与 `.d.ts` 都写明 |
| 回话超 4000 字符被拒 | 把整份列表塞回去了 | 平台返回 `too-big`（拒绝不截断）；回摘要或前几条 |
| 热重载之后工具全没了 | 旧实例的 `off()` 把新注册摘掉了 | `off()` 按 handler 身份比对，只摘自己那条 |
| `agentTools(null)` 静默什么都不做 | 注册入参没校验 | 抛 `TypeError`（缺实现函数也抛），开发期就看见 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/sdk.html` | 47 → 55 | `typeof sdk.agentTools === "function"`；返回值直通 `result`；`callId` 原样回；抛错 → `ok:false` + `error`；返回 `undefined` → `result: null`；异步 handler；没注册的名字 → `unknown tool: <名字>`；`off()` 之后不再回话 |
| `npm run test:sdk` | 2 | `examples/counter` 那两份副本与 `packages/sdk` 逐字节一致；`SUPPORTED_SDK` 与清单要求对齐 |
| 全量自检 | 52 页 / 2 450 条 | 只在 `sdk` 页 +8，其余页一条没动 |
| `docs/WIDGET_SPEC.md` §3.6 | — | 先给 SDK 写法，再把原来的 `postMessage` 例子标成"不用 SDK / 想自己控制回话时机"那条路 |

**真机验一次**（`npm run tauri:dev`，浏览器预览里没有模型）：装一个声明了 `agent.tools` 的组件
（`examples/counter` 或 `lattice.diagram`）→ 授 `agent:tools` → 在 assistant 里说一句话让它调
那条工具 → 面板里那条工具结果一行里能看到返回值；再把授权撤掉，同一句话应该**看不见那条工具**。
