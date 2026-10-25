---
status: draft
date: 2026-10-25
code: src/runtime/assistant.ts, src/runtime/skills.ts, src/runtime/hands.ts, src/platform/assistant.ts, src/platform/AssistantPanel.tsx, src-tauri/src/skills.rs, src-tauri/src/skills_policy.rs
---

# 0005 —— 技能包与工作区：把"怎么做"和"在哪里做"交给用户

> 用户的原话是"可以让项目的 agent 支持更高的权限吗，可以导入 skills 什么的处理文本之类的"。
> 这份文档回答两件事：**"更高权限"该落在哪儿**（不是第四档审批，是范围），以及**技能包装什么、不装什么**。
> 状态是 draft：还没开工，动手前先读 AGENTS.md §4 与 §7。

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

`assistant.json` v3 → **v4**，只多一个字段：

```json
{ "version": 4, "activeId": "…", "hands": { … }, "approvalMode": "ask", "workspace": "D:\\写作",
  "skills": { "enabled": ["weekly-report"] }, "profiles": [ … ] }
```

v3 读到时就地补 `skills: { enabled: [] }`（升级不替用户启用任何技能，和不变量 15 的"新权限不自动授予"同一条规矩）。

**Tauri 命令**（技能目录归 Rust，前端一条文件也读不到）

```
assistant_skills()                → { folder, skills: [{ id, name, description, tools, bytes, enabled, damaged }] }
assistant_skills_save({ enabled }) → 写 v4（顺带把读坏的 id 剔掉）
assistant_skill_import({ path })   → 拷一个目录或一个 .md 进 skills/<id>；撞名给 -2，不覆盖
assistant_skill_remove({ id })     → 删目录，并从 enabled 里剔除
```

**front matter 只有三个字段**（`skills_policy.rs` 解析，坏条目逐条丢）：

```
---
name: 周报
description: 把这几天的改动整理成一份周报
tools: files          # 可选：声明它要用哪几组手，只用于在面板上标"缺 Files"
---
（正文：什么时候用、步骤、注意什么）
```

**提示词**：`PromptOptions.skills?: SkillPrompt[]`（`{ id, name, description, body }`），`systemPrompt` 加一段 —— 一句"下面这几份是你被交代过的做法，先照它，再照我" + 每份一节。上限 4 份 / 每份 4 000 字 / 合计 8 000 字，**在启用时判**。

**审批**：`approvalFor(name, mode, ctx?)`，`ctx = { workspace?: string; args?: unknown }`；新增一处判定 —— `ask` 档下 `file.write` 的 `args.path` 落在 `workspace` 内 → `allow`。路径判定是纯函数 `insideWorkspace(path, workspace)`（`runtime/hands.ts`）：`/` 与 `\` 归一、去尾分隔符、`..` 先折叠再比、盘符不分大小写、`workspace` 为空一律 `false`。

**要改的文件**：`runtime/skills.ts`（新，纯逻辑：front matter 归一化、启用上限、提示词渲染片段）、`runtime/assistant.ts`（`approvalFor` 的第三参、`systemPrompt` 的技能段）、`runtime/hands.ts`（`insideWorkspace`）、`platform/assistant.ts`（把技能传给 `allTools`/`systemPrompt`）、`platform/AssistantPanel.tsx`（Assistant 区一段：导入 / 列表 / 开关 / 删）、`src-tauri/src/skills.rs` + `skills_policy.rs`（新）、`llm.rs`（v4）、`tests/skills.html`（新）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 技能启用了，模型还是按它自己的来 | 提示词只写了技能名字和描述，没写"先照它做" | 明确写"启用的做法优先于你的默认习惯"；技能正文第一行必须是"什么时候用" |
| 启用之后回答变慢、额度掉得快 | 正文太长且每轮都带 | 4 份 / 4 000 字 / 合计 8 000 字，超了在启用时直接拒并说清超了多少 |
| 技能里让"跑一下 scripts/build.ps1"，模型直接跑了 | 用户以为技能包是可执行包 | 仍然走 `shell.run`、仍然问一次、审计记命令形状；文档与面板都写明"装进来不会自动跑" |
| `workspace` 指到 `D:\`，之后 anywhere 都不问了 | 盘根被当成普通目录 | 保存时拒绝盘根与空串以外的"过宽"根（盘根、`C:\Users`、`%APPDATA%`），并提示"这棵树里写盘不再逐次确认" |
| 把 `workspace` 改成别处之后，旧路径突然又开始问 | 每次都重读配置（不缓存判定结果），这是**正确**行为 | 面板上那句提示要写"改这里会改变要不要问" |
| 技能目录里有 `../` 或是一个符号链接 | `skills_policy::resolve` 只认 `skills/<id>/SKILL.md`，id 走字母表 | 直接拒，别用"规范化后再判" |
| 同一个技能导入两次 | 覆盖等于静默换掉用户正在用的流程 | 第二份叫 `<id>-2`，面板上两行都能看见 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/skills.html` | ~35 | front matter 逐条丢、id 归一化与撞名、启用上限（4 份 / 8 000 字）与拒绝话术、提示词渲染、`insideWorkspace` 的 10 个路径（大小写 / `..` / 尾斜杠 / 不同盘 / 空 workspace） |
| `src-tauri/src/skills_policy.rs` | ~20 | 同上那一组在 Rust 侧（`rustc --test`，不引 crate），外加 `skills/<id>/SKILL.md` 的路径解析与 200 KB 导入上限 |
| `tests/assistant.html` | +8 | `approvalFor(name, "ask", { workspace, args })` 的四条、技能段的渲染与空表 |

**手工验一次**：真机导入一个技能目录 → 面板看到名字与描述 → 启用 → 问"按周报那个流程做" → 它照步骤调 `file.read` / `file.write` → 落在 workspace 内的写**没有确认条**、落在 `D:\GitDev\lattice` 的一次**有** → 审计里有那些调用形状 → 关掉技能再问，它回到默认做法。
