---
status: accepted
date: 2026-10-25
code: src/runtime/assistant.ts, src/runtime/skills.ts, src/runtime/hands.ts, src/platform/assistant.ts, src/platform/hands.ts, src/platform/AssistantPanel.tsx, src/runtime/i18n/assistant.ts, src-tauri/src/skills.rs, src-tauri/src/skills_policy.rs, src-tauri/src/llm.rs, src-tauri/src/lib.rs, tests/skills.html
---

# LAT-0005 —— 技能包与工作区：把"怎么做"和"在哪里做"交给用户

> 用户的原话是"可以让项目的 agent 支持更高的权限吗，可以导入 skills 什么的处理文本之类的"。
> 这份文档回答两件事：**"更高权限"该落在哪儿**（不是第四档审批，是范围），以及**技能包装什么、不装什么**。
> 状态是 **accepted**：已落地。权限那一半后来又被 [0009](./LAT-0009-assistant-modes.md) 接了手（"全权"是模式开关，不是免问区），这份只管"在哪里做"和"怎么做"。
> 结论沉在 [ROADMAP](../ROADMAP.md) 的 v0.12 那一行，断言钉在 `tests/skills.html` 与 `src-tauri/src/skills_policy.rs`。

## 1. 问题

两件具体会坏的事：

- **要么每步点一次，要么整个盘都归它。** `ask` 档下 `file.write` 每一次都要一张确认条 —— 用户想"把这 12 个 md 的日期格式统一"，就要点 12 次 Allow；于是他改拨 `auto`，而那等于连 `D:\Windows` 也一起放行。今天没有中间那一档，因为 `workspace` 只是**相对路径的默认起点**（`runtime/hands.ts` 那行注释写得很清楚："不是围栏"）。
- **流程每次都要重讲一遍。** 让 agent 按固定步骤做（周报、把 CSV 洗成一张表、生成 docx），用户只能把步骤打进对话框；`assistant-sessions/` 记住的是**对话**，不是**这件事该怎么做**。模型不是缺权利，是缺领域流程。

## 2. 候选

| | A：第四档 `unrestricted` | B：每组一份策略文件 | C：工作区免问区 + 技能包 |
| --- | --- | --- | --- |
| 做法 | 审批档加一档，连 `placement.remove` 也不问 | 工作目录、命令白名单、主机白名单各写一份 | `workspace` 里的 `file.write` 不问；技能 = 目录 + 开关，正文进提示词 |
| 换掉什么 | 不可逆动作的最后一道确认 | 二进制开关 | "workspace 只是默认值"这条语义（不变量没有一条依赖它） |
| 新增什么 | 一个模式值 | 三份配置 + 三套校验 + 面板三块 | `skills/<id>/SKILL.md`、4 条命令、启用清单、提示词一段、路径判定 |
| 代价 | 删组件与写盘都静默，8 秒 Undo 也救不回来 | 用户要理解三种白名单，写错一条就是"它怎么又不动了" | 技能要 Files 组开着才有用；每轮常驻最多 8 000 字 |

A 被否：三档已经把"问不问"表达完了（`ask` 全问 / `auto` 只问不可逆 / `readonly` 不问只读），再往上只剩"删也不问"，那不是更多能力，是更少后悔药。B 被否：三个策略文件意味着三套"坏了会怎样"，而真正的病只有一处 —— 没划定"这棵树里随便动"。

（用户后来还是要了 A 那个"全权"，但**换了个形状**：不是第四档审批，是一个存盘的模式开关 —— 见 [0009](./LAT-0009-assistant-modes.md)。两者是两件事：模式回答"它碰得到什么"，免问区回答"在哪儿动手不用每步签字"。）

## 3. 决定

**选 C，分两件事落地。**

1. **`workspace` 升级成"免问区"**：`ask` 档下，`file.write` 的目标落在 `workspace` 里就不再弹确认条；落在外面照旧问。**只对 `file.write` 生效**：`shell.run` 一条命令就能写出这棵树，把它一起算进来是自欺；`auto` 档不变（本来就不问）；`readonly` 不变（照样拒）。
2. **技能包是说明书，不是权限**：`skills/<id>/SKILL.md` 的正文进系统提示（启用的才进）。技能**不新增任何执行通道**，它让模型做的事仍然走那六只手，审批与审计照旧。技能里带的脚本要用，就得走 `shell.run`、就会被问，也就会进审计。

**代价**：技能正文常驻提示词，4 份 × 4 000 字 = 8 000 字，等于每轮多花约 2 000 token（1 token ≈ 1 字符的保守估计，见 `runtime/llm-models.ts::historyChars`）。超限的做法是**在启用时拒绝**并说明，不是截断 —— 截断过的步骤等于半份说明书，模型会照半份做。

**什么时候该推翻它**：用户常态化启用超过 4 个技能，或单个技能的正文稳定超过 4 000 字 —— 那时改成"提示词只放索引 + `skill.read(id)` 按需读"（渐进披露），代价是多一次往返。

**这一版不做**（都不是"以后随便加"，是各有明确的反对理由）：

- **剪贴板读写**：剪贴板里可能是密码，读它等于给提示词注入开一条新入口。要做先想清楚"读之前要不要每次都问"。
- **浏览器自动化 / 任意 HTTP 方法**：`web.fetch` 只 GET、且默认关；改成 POST 就等于给了一条把用户数据送出去的通道。
- **多根 workspace**：一个根够用，多个根就要回答"优先级、包含关系、删除哪一个"。

## 4. 接口与数据

**落盘格式与迁移**

`assistant.json` v3 → **v4**，多两个字段（`mode` 是 [0009](./LAT-0009-assistant-modes.md) 一起加的，同一次升级里到位）：

```json
{ "version": 4, "mode": "internal", "activeId": "…", "hands": { … }, "approvalMode": "ask",
  "workspace": "D:\\写作", "skills": { "enabled": ["weekly-report"] }, "profiles": [ … ] }
```

v3 读到时就地补 `mode: "internal"` 与 `skills: { enabled: [] }` —— 升级既不开全权模式，也不替用户启用任何技能（和不变量 15 的"新权限不自动授予"同一条规矩）。临时文件 + 原子替换。

**Tauri 命令**（技能目录归 Rust，前端一条文件也读不到）

```
assistant_skills()                 → { folder, skills: [{ id, name, description, tools, body, bytes, enabled, damaged }] }
assistant_skills_save({ enabled }) → 校验 id 存在、没坏、不超预算，然后写 v4（顺带把读坏的 id 剔掉）
assistant_skill_import({ path })   → 拷一个目录或一个 .md 进 skills/<id>；撞名给 -2，不覆盖，**不启用**
assistant_skill_remove({ id })     → 先从 enabled 里剔掉，再删目录
```

`body` 也在载荷里：提示词要用它，而渲染进程没有文件系统 —— Rust 不递，这一轮就只能"知道有这么个技能"却读不到它写的步骤。`bytes` 是磁盘体积（面板显示），`damaged` 是"这个目录里有 `SKILL.md`，但读不成一份技能"（坏的不拦列表，只是不给开关）。

导入是三道路上的额度：单个文件 200 KB、一次导入合计 2 MB、最多 200 个文件、最多往下 4 层；`SKILL.md` 必须**解析得成**，否则整次导入拒掉（不会留下一个装不进去的半份）。

**front matter 只有三个字段**（`skills_policy.rs` 解析，坏条目逐条丢）：

```
---
name: 周报
description: 把这几天的改动整理成一份周报
tools: files          # 可选：声明它要用哪几组手，只用于在面板上标"缺 Files"
---
（正文：什么时候用、步骤、注意什么）
```

`id` 不由 front matter 决定，是**目录名**（`skills/<id>/SKILL.md`），走 `[a-z0-9_-]`、≤48 字；导入时按 `name` 生成 slug（中文 slug 成 `skill`，撞名加 `-2`）。id 进了提示词的小标题，也进了 `enabled` 清单 —— 所以**改目录名等于换了一份技能**。

**提示词**：`PromptOptions.skills?: readonly SkillPrompt[]`（`{ id, name, description, body }`），`systemPrompt` 在"手"那一段之后加一段，两句话不能省："先照它们写的步骤做"（不写这句模型只当背景资料）与"不给你任何新工具"（不写这句它会在正文里见到"跑个脚本"就去调一个没有的工具，然后开始编）。**空表一个字符都不加**。上限 4 份 / 每份 4 000 字 / 合计 8 000 字，按**码点**算，**在启用时判**（渲染时判等于静默截断），由 `runtime/skills.ts::checkBudget` 返回原因与数字、界面说话。

**审批**：`approvalFor(name, mode, ctx?)`，`ctx = { everything?: boolean; path?: string; workspace?: string }`；`ask` 档下 `file.write` 的 `args.path` 落在 `workspace` 内 → `allow`。路径判定是纯函数 `insideWorkspace(path, workspace)`（`runtime/hands.ts`）：`/` 与 `\` 归一、去掉 `.` 与尾分隔符、`..` **先折叠再比**、盘符与目录名不分大小写、相对路径算在里面、`workspace` 为空或指向盘根一律 `false`。**它是"要不要多问一句"的输入，不是围栏。**

> **"不是围栏"这句要说全**：Rust 侧**也没有**第二道 `insideWorkspace`。`fs_policy::path_is_under`
> 是有的（`fs_policy.rs` 的 14 条断言里 4 条钉着它），但 `hands.rs` **从来没调用过它** ——
> 今天"写到哪儿"完全由前端那条 `approvalFor` 决定。`shell.run` 就更不受它管。
> 所以免问区只改变**问不问**，不改变**能不能**；这也正是"假装它是围栏比不设更危险"那句话的意思。

顺序上还有一条（0009 定的）：写平台自身配置（`assistant.json` / `mcp.json` / `state.json` / `skills/**`）的调用**在 `everything` 之前**就返回 `ask` —— 一份能被模型改写的 `assistant.json` 会把模式、开关、免问区一起变成"它说自己有就有"。

**要改的文件**（都落地了）：`runtime/skills.ts`（新，纯逻辑）、`runtime/hands.ts`（`insideWorkspace`）、`runtime/assistant.ts`（`ApprovalContext`、免问区那一条、`systemPrompt` 的技能段）、`platform/assistant.ts`（把 `path` / `workspace` 递给审批、把技能递给提示词）、`platform/hands.ts`（四条命令的 IPC 面）、`platform/AssistantPanel.tsx`（Assistant 区一段：导入 / 列表 / 开关 / 删 + 缺组的标记）、`runtime/i18n/assistant.ts` + `styles.css`、`src-tauri/src/skills.rs` + `skills_policy.rs`（新）、`llm.rs`（v4 + `skills_enabled` / `set_skills_enabled`）、`lib.rs`（注册四条）、`tests/skills.html`（新）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 技能启用了，模型还是按它自己的来 | 提示词只写了技能名字和描述，没写"先照它做" | 明确写"启用的做法优先于你的默认习惯"；技能正文第一行必须是"什么时候用" |
| 启用之后回答变慢、额度掉得快 | 正文太长且每轮都带 | 4 份 / 4 000 字 / 合计 8 000 字，超了在启用时直接拒并说清超了多少 |
| 技能里让"跑一下 scripts/build.ps1"，模型直接跑了 | 用户以为技能包是可执行包 | 仍然走 `shell.run`、仍然问一次、审计记命令形状；面板上写明"打开它只是把那些字加进提示词，不加任何工具" |
| `workspace` 指到 `D:\`，以为从此 anywhere 都不问了 | 盘根被当成普通目录 | 盘根 / 空串**一律不算落在里面**（`insideWorkspace` 返回 `false`），于是每条写都照旧问 —— 少问一句才是错，多问一句只是烦 |
| 把 `workspace` 改成别处之后，旧路径突然又开始问 | 每次都重读配置（不缓存判定结果），这是**正确**行为 | 面板上那句提示写"改这里会改变要不要问" |
| 技能目录里有 `../` 或是一个符号链接 | `skills.rs` 只认 `skills/<id>/SKILL.md`，id 走字母表；导入跳过符号链接与点开头的文件 | 直接拒，别用"规范化后再判" |
| 同一个技能导入两次 | 覆盖等于静默换掉用户正在用的流程 | 第二份叫 `<id>-2`，面板上两行都能看见 |
| 一份技能的 `SKILL.md` 被手改坏了 | 扫描时读不成就标 `damaged`，开关变灰、不进提示词 | 坏一份不拦整张列表（和"坏条目逐条丢"同一条规矩）；模型看到半份步骤比没有更糟 |
| 导入完以为它已经在用了 | 导入只是拷进来，**不启用** | 面板上明说"想用它的时候再打开"；启用清单只由用户那一下写入 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/skills.html` | **55** | front matter 逐条丢与两种引号、id 归一化与撞名、`charCount` 按码点、三道上限与三种拒绝原因、`promptsOf`（只挑启用且没坏）、提示词那一段（空表 / 标题 / 两句话）、`missingGroups`、`approvalFor(name, "ask", { path, workspace })` 的四条、`insideWorkspace` 的整张路径表（大小写 / `..` / 尾斜杠 / 不同盘 / 相对 / 盘根 / 空 workspace） |
| `src-tauri/src/skills_policy.rs` | **19** | 同一组在 Rust 侧（`rustc --test`，不引 crate）：三键解析与坏行、id 字母表与 `slug` / 撞名后缀、三道上限（码点）、`skills/<id>/SKILL.md` 的路径形状 |
| `tests/assistant.html` | 180（**未增**） | 审批 ctx 那几条落在 `skills.html`，因为那是一个页面验完的事，不拆两处 |

**真机那一步还没做**（记在 AGENTS.md §8）：导入一个真实技能目录 → 面板看到名字与描述 → 启用 → 问"按周报那个流程做" → 它照步骤调 `file.read` / `file.write` → 落在 workspace 内的写**没有确认条**、落在 `D:\GitDev\lattice` 的一次**有** → 审计里有那些调用形状 → 关掉技能再问，它回到默认做法。`npm run tauri:dev` 起得来的机器上照着走一遍，走不通就回来补这一节。
