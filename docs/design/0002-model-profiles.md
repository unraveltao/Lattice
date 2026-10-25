---
status: accepted
date: 2026-10-25
code: src-tauri/src/llm.rs, src-tauri/src/llm_policy.rs, src-tauri/src/network.rs, src/platform/assistant.ts, src/platform/AssistantPanel.tsx, src/runtime/llm-models.ts
---

# 0002 —— 模型配置从"一个表单"变成"几档 + 流式"

## 1. 问题

`assistant.json` 现在是四个平铺字段：`baseUrl` / `model` / `temperature` / `apiKey`。四件具体会坏的事：

- 用户同时留着公司中转站和本地 Ollama，切一次就要重粘一次 key、改一次地址，切回来再粘一次。
- 本地模型（`http://127.0.0.1:11434/v1`）根本不要 key，可 `llm_models` 见到空 key 直接报 `no assistant key yet` —— "测试连接"永远点不动，界面永远显示未配置。
- 推理模型（`deepseek-reasoner`、`o1`）不收 `temperature`，`llm_policy::build_body` 一律带上 → 400，而 `describe_status` 只认 401/404/429，用户看到的是一段原始 JSON。
- 一次往返 10–30 秒，界面上只有一句 `Thinking…`，没有一个字先出来。

## 2. 候选

| | A：最近地址列表 | B：多档 profile + 能力表 + 流式 | C：搬进 `state.json` |
| --- | --- | --- | --- |
| 做法 | 记住最近 5 个 baseUrl，一个下拉 | `profiles[]` 每条自带 key/auth/model；能力表按模型名决定送不送 temperature；`/chat/completions` 走 SSE | 前端 store 持有全部字段，整份回写 |
| 换掉什么 | 只省打字 | 单档形状、`llm_status/save/set_key` 三个命令、整包读的传输 | "key 不进渲染进程"这条 |
| 新增什么 | 一个下拉历史 | 4 个命令、`llm-models.ts`、SSE 解析与取消、v1 迁移 | 无 |
| 代价 | key 仍要重粘，本地模型仍不可配 | 迁移 + 只有真机能验的传输层；UI 多一个档列表 | key 进前端 = 任何一个组件 XSS 直接拿到；两个入口互相覆盖（v0.10 已踩过） |

C 是**本来想选的那个**（"别的设置都在 store 里，它凭什么特殊"），被 v0.10 的两条事实否掉：`state.json` 是前端整体回写、抽屉和小窗会互相盖；key 一进 JS 状态就会跟着调试面板、截图、某次 `JSON.stringify` 一起外泄。A 被否，是因为它没解决三件真会坏的事里的两件。

## 3. 决定

**选 B。**

**代价**

- `assistant.json` 升 v2，要写迁移，而且"v1 读坏不许写回"要单独测 —— 否则用户一次解析失败就永久丢 key。
- 多 4 个命令加一张能力表；每认一个新模型名是一次手工维护。
- 流式落在 `network.rs`：`read_body` 那个循环要能边读边回调。WinHTTP 是阻塞 API，取消只能靠"1 秒读超时回来查标志"，**不能**去关一个正在 `WinHttpReadData` 的句柄。
- SSE 的工具参数是**分片**来的（`index` 增量），累加器写错的表现是"工具偶尔少半个参数"——只有真模型撞得出来，所以纯逻辑必须先在 `llm_policy.rs` 里钉死。
- 档列表让"当前用哪一档"变成一个新的可见状态，`AssistantPanel` 的设置页要从"一个表单"改成"列表 + 表单"。

**什么时候该推翻它**

- 如果主流 provider 开始各走各的协议（Anthropic 原生 messages、Gemini），"只存 baseUrl + auth 三值"就撑不住，那时要加 `kind` 和每型适配器。现在不做，因为 OpenAI 兼容是事实上的通用面。
- 如果真机上 SSE 的取消/半包比预期贵得多，**流式那一半可以单独撤**（退回非流式 + 进度条），profiles 不受影响 —— 这也是把两者放在一份文档里却分两步落地的原因。

## 4. 接口与数据

**Tauri 命令**

```
llm_profiles()                                        -> { activeId, profiles: ProfileView[] }
llm_profile_save({ id?, label, baseUrl, auth, model, temperature }) -> { activeId, profiles }
llm_profile_remove({ id })                            -> { activeId, profiles }
llm_set_key({ id, key })                              -> { activeId, profiles }   // 空串 = 删这把
llm_models({ profileId?, baseUrl?, auth?, key? })      -> string[]
llm_chat({ messages, tools, profileId? })              -> 形状不变
llm_chat_stream({ requestId, messages, tools, profileId? }) -> 见下
llm_chat_cancel({ requestId })
```

`ProfileView` = `{ id, label, baseUrl, auth, model, temperature, models, keyHint, configured, source }`，**没有 `apiKey`**。
流式：增量走事件 `lattice:llm-delta`（`{ requestId, text }`），命令本身在结束时返回拼好的完整消息（和 `llm_chat` 同形状）。工具参数不进事件，Rust 里按 `index` 拼完整后随结果一次回来。
载荷必须带 `requestId`：`emit` 是广播（不变量 9），抽屉和小窗可能同时各跑一轮。

**落盘与迁移**

```json
{ "version": 2, "activeId": "p-…", "profiles": [
  { "id": "p-…", "label": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1",
    "auth": "bearer", "apiKey": "sk-…", "model": "deepseek-chat",
    "temperature": 0.6, "models": ["deepseek-chat", "deepseek-reasoner"] } ] }
```

- v1（无 `version`，四个平铺字段）→ 包成一条 `p-1`，`label` 取地址的主机名。**读失败不写回**，只有用户下一次保存才落盘。这条比迁移本身重要：现在的 `read_config` 已经把坏文件当"没配"，如果顺手写一次空配置，用户的 key 就没了。
- 坏档逐条丢（缺 id、`baseUrl` 不合法）；全坏 = 未配置，但仍不写回。
- `LATTICE_LLM_KEY` / `_BASE_URL` / `_MODEL` **只覆盖 `activeId` 那一档**，`source: "env"` 只挂在那一条；其余档照旧读文件。
- 前端保存只发"这一档的可编辑字段"，key 单独走 `llm_set_key` —— 整份回写会把别的档的 key 抹掉。

**auth 三值**：`bearer`（`Authorization: Bearer`，默认）| `api-key-header`（`api-key: …`，Azure 一类）| `none`（不发鉴权头，本地 Ollama）。`none` 时 `configured` 不看 key。

**能力表** `runtime/llm-models.ts`：`knownModel(id) -> { tools, temperature, context }`。前缀表 + 最长前缀匹配 + 未知走宽松默认（`{ tools: true, temperature: true, context: 32_000 }`）。只收"真的撞过的"三条：`deepseek-reasoner`（无 temperature、无 tools）、`o1`/`o3`（无 temperature）、`gpt-4o`（128k 上下文）。**不猜厂商规格**：被 provider 拒一次就把那条加进来，这张表是"踩过的坑的索引"。`trimHistory` 的预算从 `context` 推，与现有的 32 条 / 60k 字上限取更小者。

**要改的文件**：`llm.rs`（形状 + 迁移 + 命令）、`llm_policy.rs`（SSE 切帧、工具参数累加、auth 头）、`network.rs`（`read_body` 支持回调）、`AssistantPanel.tsx`（档列表 + 模型下拉 + 流式气泡）、`platform/assistant.ts`（事件 → 增量）、`runtime/llm-models.ts`（新）、`runtime/i18n/assistant.ts`（新文案）、`tests/llm-models.html`（新）、`tests/assistant.html`、`docs/WIDGET_SPEC.md`（不改：`llm.chat` 那条不受影响）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 本地 Ollama 显示"未配置"，测试连接报缺 key | 仍在用"key 非空"判断 | `auth: "none"` 时不要求 key、不发鉴权头；配置好 = base + model 齐 |
| 切到第二档第一条就 401 | chat 读的是"当前表单"而不是该档 | 每次请求按 `profileId` 现读该档；id 随机、永不复用 |
| 推理模型 400，界面弹原始 JSON | 能力表没命中，temperature 照样送 | 命中就不送；未命中被拒时翻成"这个模型不收 temperature，重试会自动不带"，并给该档记 `noTemperature` |
| 流式中文乱码 / 半个字 | 按 `String` 拼分片 | 按字节缓冲，切到 `\n\n` 才解码 |
| 工具参数缺一半 | 只取最后一帧的 `arguments` | 按 `index` 累加字符串，`finish_reason` 到了才解析 |
| 点了停止，字还在冒 | 只在步与步之间查标志 | 每个 delta、每次读超时（1s）都查一次 |
| 两个窗口各开助手，字串台 | `emit` 是广播 | 载荷带 `requestId`，各自过滤 |
| 升级后 key 没了 | v1 迁移写坏，或"读坏写回" | 迁移是纯函数；读失败绝不写；手工验一条"v1 原文件升级后 key 还在" |
| 存这一档，别的档 key 空了 | 前端整份回写 | 前端只发可编辑字段；Rust 读-改-写 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/llm-models.html`（新） | 12 | 前缀最长匹配、未知走宽松默认、上下文 → 预算、`reasoner` 不送 temperature |
| `tests/assistant.html` | +14 | profiles 归一化、v1 迁移、坏档逐条丢、`auth: none`、`activeId` 悬空时回退第一条 |
| `llm_policy.rs` | +24 | SSE 字节切帧（半包 / 多字节 / `[DONE]` / 坏帧）、工具参数按 index 累加、auth 头三值 |

**手工验一次**：真机跑 DeepSeek 直连（字一个个出来、停止立刻断、工具调用那一轮参数完整）、切到 Ollama（无 key 能通）、手工造一份 v1 的 `assistant.json` 再启动（key 还在、档名是主机名）。自动断言测不到 SSE 与 WinHTTP 的真实分片节奏 —— 这一层只有真机算数。

## 7. 落地情况（与上面几节的出入）

两半都落了，`status` 改成 `accepted`。和计划不一样的地方只有三处，都是实现时才看清的：

- **命令多了一个**：`llm_chat_stream` / `llm_chat_cancel` 之外，`llm_chat` 和 `llm_chat_stream` 都多收一个可选的 `profileId`。原来两条路各读一次 active 档，抽出 `prepare()` 之后顺手统一了 —— 少一处"流式按 A 档、整包按 B 档"的可能。
- **增量只在气泡里滚，不参与拼装**。设计里写的是"命令结束时返回拼好的完整消息"，实现在此之上又定了一条：前端**不**拿增量拼最终消息，最后用返回值整条覆盖。这样"拼增量拼错了"最多让字闪一下，不会留下一句错话。工具参数仍然不进事件。
- **`SseBuffer` 按 `\n` 切，不按 `\n\n` 切**。第 5 节表格里写的是"切到 `\n\n` 才解码"；实现是"按字节切行 → 攒 `data:` 字段 → 空行收尾成一条事件"。两者等价，但后者顺带把"一条事件多行 `data:`"这件事做对了，而多字节字符永远不会被切开（`\n` 不在任何多字节序列内部）。
- 断言数：`llm_policy.rs` 新增 **23** 条（不是 24），`tests/llm-models.html` 26 条、`tests/assistant.html` 118 条。全仓 Rust 单测 219 条。

