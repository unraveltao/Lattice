# 文档地图

> 这一页是**归属表**，不是内容索引（各文件的标题已经说明内容）。它回答三件事：
> **每份文档在什么时态、给谁看、新东西该放哪。**
> 和代码冲突时以代码为准，并顺手回来改这一页。

## 一、这套文档长什么样

按**时态**分三层，一份文档只有一个坐标——没有第二套分类轴：

| 层 | 它回答 | 文档 | 谁读 |
| --- | --- | --- | --- |
| **过去** | 为什么长成这样（分层、沙箱、窗口、数据） | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 想改一个"看着奇怪"的设计之前 |
| **过去** | 哪些决定被现实撞翻过 | [`ROADMAP.md`](./ROADMAP.md)「被推翻的十个决定」 | 同上，先看这里再动手 |
| **过去** | 已定案的推理（`accepted` / `superseded`） | [`design/`](./design/) | 想知道当时否掉了什么 |
| **过去** | 每个版本当时怎么做的、验到什么程度 | [`reference/history.md`](./reference/history.md) | 想知道某段代码当初是怎么撞出来的 |
| **过去** | 撞到过什么、怎么绕开的（**按症状**分组） | [`PITFALLS.md`](./PITFALLS.md) | 见到一个说不通的症状时，先 `Ctrl+F` 这里 |
| **现在** | 这个词到底指什么 | [`../GLOSSARY.md`](../GLOSSARY.md) | **所有人**，包括 AI |
| **现在** | 我卡住了 / 这算不算 bug | [`FAQ.md`](./FAQ.md) | 用这个应用的人，**先查这里再开 issue** |
| **现在** | 组件作者必须遵守什么 | [`WIDGET_SPEC.md`](./WIDGET_SPEC.md) | 写组件的人 |
| **现在** | 改平台代码不许碰什么 | [`../AGENTS.md`](../AGENTS.md) | 改平台的人，人或 agent |
| **现在** | 查一下就好：文件在哪 / agent 接入 / 签名 / 素材 / 邻仓 / 构建发版 | [`reference/structure.md`](./reference/structure.md)、`AGENT_ACCESS.md`、`CODE_SIGNING.md`、`PET_REFERENCE.md`、`VELA-REUSE.md`、[`reference/build.md`](./reference/build.md) | 碰到那一块的时候 |
| **未来** | 下一版做什么、还没做的事怎么想 | [`ROADMAP.md`](./ROADMAP.md) 待办 + [`design/`](./design/)（`draft`） | 要开一件新事的人 |

「现在」这一层分三块：`GLOSSARY` 是**前提**（词先定，别的才谈得上），`WIDGET_SPEC` / `AGENTS` 是**契约**（不遵守就出错），最后一条是**参考**（查一下，不构成约束）。契约只有两份，别再加第三份。

根 `README.md` / `README.zh-CN.md` 不在这张表里 —— 它是**项目入口**，不是文档体系的一部分，跟着版本走（见第五节第 1 条）。第一次来这个仓库的人该读它，不是读这一页。

`ROADMAP.md` 在这张表里出现两次，不是重复：**待办是未来，被推翻的决定是过去**。它同时是这两个时态的家。

撑起上面全部的是**一条铁律：一份事实只有一个家**。见第四节——它是这套文档不烂的唯一原因。

这张表还有一个**机器读的版本**：[`catalog.json`](./catalog.json)。它只记两件事 —— 路径，和那一份属于哪个时态。`check:docs` 拿它和上面这张表对账，两边说的时态不一致就红。所以这张表能一直是真的，靠的不是有人记得回来改。**别往 catalog 里加第三个字段**：`owner` 在表里是句子不是枚举，抄进 JSON 就是同一句话的第二份；"现行 / 归档"是第二根分类轴，而第 9 行立的是"一份文档只有一个坐标"。

### `.agents/skills/` 不在这张表里

八份 `SKILL.md` 是**给 agent 看的工序**，不是第四种文档，按"什么时候用得着"分成两串：

- **动手前**：[`invariants`](../.agents/skills/invariants/SKILL.md)（该守哪几条不变量）/ [`new-widget`](../.agents/skills/new-widget/SKILL.md)（加组件的顺序）/ [`domain-modeling`](../.agents/skills/domain-modeling/SKILL.md)（这次要用的词怎么定）。
- **怎么想和怎么写**：[`define-goal`](../.agents/skills/define-goal/SKILL.md)（把一句话变成可判定的目标）/ [`grilling`](../.agents/skills/grilling/SKILL.md)（交付前把方案烤一遍）/ [`context-engineering`](../.agents/skills/context-engineering/SKILL.md)（上下文怎么花、什么该落盘）。
- **收尾**：[`verify`](../.agents/skills/verify/SKILL.md)（改完按什么阶梯验）/ [`writing-for-agents`](../.agents/skills/writing-for-agents/SKILL.md)（文档按什么工序写）。

它们不进这张表，是因为它们**不构成事实的家**。每份开头都写着"正文在 `AGENTS.md` 第 N 节"，自己只给顺序和判据。所以它们过期的方式也不同：**结论错了去改 `AGENTS.md`，工序错了才改这里**。往这三份里补一句"权限一共 12 个"就是违规 —— 那已经是别人的家了。

根目录的 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 同一类：它只写"从 clone 到 push 之间的顺序"和"什么会被拒"，一条规矩都不重复，全是链接。第一次给这个仓库提东西的人读它，不读这一页。

### 这些页面在应用里也能读

「设置 → 获取帮助」直接渲染这个目录里的 Markdown：`src/runtime/docs.ts` 里有一张十条的清单，其余文件（专题、`design/`）不在清单里，但正文的相对链接能跳过去。两个后果，写文档时要记住：

- **改了文档要重新打包才进应用。** 应用读的是打进包里的那份，不是磁盘上这份 —— 所以它永远不会比 `main` 更旧，也不会替你去校验链接。
- **别依赖只有网页才有的东西。** 远程图片会被降级成 alt 文字（离线读不了），指向非 `.md` 的相对链接会在浏览器里打开 GitHub。写"看一眼这张图就懂了"的句子之前，先确认图在 `docs/` 里。

### 语言分工

| 文件 | 语言 | 谁读 |
| --- | --- | --- |
| `README.md` | 英文 | 第一次来的外部读者 |
| `README.zh-CN.md` | 中文 | 同上 —— **和英文那份是同一份东西**，改一份就得改另一份 |
| `AGENTS.md`、`docs/**`、`GLOSSARY.md` | 中文 | 要改这个仓库的人（含 agent） |

不给 `docs/` 做全量翻译：翻译是最贵的维护成本，三个月后必然只有一半是新的，而读者分不清哪一半。外部读者要深入，读根 `README` 的 *How it works* 和 *The desktop is a surface* 两节；推理只写中文，代码是最终依据。

## 二、按你要做的事找

| 你要做的事 | 读这份 | 花多久 |
| --- | --- | --- |
| 想知道某个词到底指什么 | [`../GLOSSARY.md`](../GLOSSARY.md) | 1 分钟 |
| **装上之后某个地方不对劲** | [`FAQ.md`](./FAQ.md)（按"卡在哪一步"分组，搜症状） | 1 分钟 |
| 写一个组件（从零跑起来） | [`../README.md`](../README.md#write-a-widget) 的 *Write a widget* + [`../examples/counter`](../examples/counter) | 30 分钟 |
| 查组件的契约（方法表 / 配置字段 / 清单规则） | [`WIDGET_SPEC.md`](./WIDGET_SPEC.md) | 按需 |
| 改平台代码 | [`../AGENTS.md`](../AGENTS.md)（先读第 4 节的不变量；按你要动的挑，别通读） | 20 分钟 |
| **找某个文件 / 某个目录是干什么的** | [`reference/structure.md`](./reference/structure.md)（`AGENTS.md` 第 3 节只留五条） | 1 分钟 |
| 加一个能力（桥方法 / 权限 / 窗口行为） | [`AGENTS.md` 第 7 节"常见改动的配方"](../AGENTS.md) + `WIDGET_SPEC` 对应章节 | 按需 |
| 想知道某个奇怪设计为什么是这样 | [`ROADMAP.md`](./ROADMAP.md)「被推翻的十个决定」 | 按需 |
| **手上有个说不通的症状** | [`PITFALLS.md`](./PITFALLS.md)（`Ctrl+F` 搜现象，别搜原因） | 1 分钟 |
| 要编译 / 打包 / 发版 | [`reference/build.md`](./reference/build.md) | 15 分钟 |
| 要动 agent 接入 | [`AGENT_ACCESS.md`](./AGENT_ACCESS.md) | 20 分钟 |
| 要动签名 / 发布 | [`CODE_SIGNING.md`](./CODE_SIGNING.md) + `ROADMAP` v0.7 | 15 分钟 |
| 让 agent 按这个仓库的规矩动手 | [`.agents/skills/`](../.agents/skills/invariants/SKILL.md) 八份（`invariants` / `new-widget` / `domain-modeling` / `define-goal` / `grilling` / `context-engineering` / `verify` / `writing-for-agents`） | 按需 |
| **要做一件还没做的事** | [`design/README.md`](./design/README.md) | 按需 |

## 三、新内容放哪

三问，从上往下，命中就停：

1. **它是"还没做的事"动手前的推理吗？** → 未来。写 `design/` 一份，结论沉回 `ROADMAP` 一行。
2. **三个月后还有人要照着它做吗？** 没有 → 参考。放 `docs/reference/`（现在有 `build.md` 和 `history.md` 两份，都是「照着做一次就不再翻」的东西）。
3. **它是别人必须遵守的吗？** → 契约。`docs/` 根，一份，不拆。

三问都不命中 → 它大概不该是文档，是代码注释或 `AGENTS.md` 配方节里的一行。

**术语表不走这三问。** 它是三问的**前提**——先有词，才谈得上"别人必须遵守什么"。定下一个术语、或裁掉一个撞名，直接改 `GLOSSARY.md`，别为它新开文件，也别在 `WIDGET_SPEC` 里再写一遍定义（那边只写"必须怎样"）。

**反例，别做**：不要新建 `总览.md` / `说明.md` / `开发文档.md`。这类文件名说明作者还没想清楚它属于哪一类，而它一旦存在，就会变成第三个"事实的家"。

## 四、一份事实只有一个家

重复是文档腐烂的起点：两处写着同一件事，改了一处，另一处就开始骗人。

| 事实 | 家 | 别处怎么提 |
| --- | --- | --- |
| 桥方法表、参数校验、权限闸门 | `src/runtime/bridge.ts` | 文档写"有什么、为什么"，**不抄签名** |
| 权限清单 | `src/runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS` | `WIDGET_SPEC` 写语义，不写代码 |
| 术语的准确定义 | `GLOSSARY.md` | 别处用同一个词，**不重复定义**，要解释就给链接 |
| 组件作者契约 | `docs/WIDGET_SPEC.md` | 别处给链接 |
| 改代码的约束 | `AGENTS.md` | 别处不重复 |
| 决定与代价 | `docs/ROADMAP.md` | `design/` 只写推理，结论链接过去 |
| 坑：症状 / 真实原因 / 解法 | `docs/PITFALLS.md` | 别处只说「见 PITFALLS」，**不要顺手把解法再抄一遍** |
| 用户该点哪儿、报 issue 带什么 | `docs/FAQ.md` | 别处给链接，**不要在产品文案里重写一遍** |
| 构建与发版的步骤 | `docs/reference/build.md` | `ROADMAP` 只写为什么这么定 |

判断方法：**这段内容如果代码改了要不要跟着改？** 要 → 它不是文档，是指针，改成链接。

`FAQ` 和 `PITFALLS` 都按症状分组，别混：**FAQ 回答"我该点哪儿"**（用这个应用的人，不许出现文件名和函数名），**PITFALLS 回答"这段代码为什么长成这样"**（改这个仓库的人）。同一件事两边都写，就是两处各自漂。

## 五、发版时要同步哪三处

这三处最容易过期，而且过期了不会报错：

1. `README.md` 的 **By the numbers** —— 现在是六项：组件数、权限数、Tauri 命令数、浏览器断言数、Rust 单测数、文档坑数；底下那张 `Code, roughly` 是另外六行行数。数字变了要重数一遍，别估。
2. `ROADMAP.md` 的**进度总览**表 —— 一条版本从"进行中"变"已完成"。
3. `AGENTS.md` 的**已知缺口**表 —— 补掉一条就删一条，别留着当"历史"。

能自动对的不用人记：`npm run check:docs` 会拿 `public/widgets/index.json`、`KNOWN_PERMISSIONS`、`#[tauri::command]`、`PITFALLS.md` 的条目数去对账，顺带查全仓库每一份 `.md` 里的相对链接，以及**每一份 md 是不是恰好有一个归属**（`catalog.json` 与第一节那张表互相印证）。行数那六行按 **1% 容差**比 —— 它们每次提交都会动，要求精确相等等于让每个 PR 都去改 README，而一张没人愿意维护的表最后会被删掉。**断言数只能手数**（浏览器 3 995 条 / 76 页、Rust 504 条），脚本只核中英文两份写的是不是同一个数，别指望它发现你数错。CI 里跑同一条命令。

## 六、别做的事

- **别为了完整复制代码。** 抄过来的那一刻就开始过期。
- **别把一个决定写在三份文档里。** 结论在 ROADMAP，推理在 design，约束在 AGENTS —— 各写各的那一半。
- **别在规范里写教程。** `WIDGET_SPEC` 回答"必须怎样"，不回答"我该从哪学起"；后者是 `README` 和 `examples/` 的活。
- **别删旧文档。** 错了就标 `superseded` 并指向新的。这个仓库的价值有一半在"知道哪些路走不通"。

### 文风

只对**新写和重写**的文档执行，不回头批量改旧文档 —— 那种 diff 会淹掉真正的改动。

1. **正文用第二人称「你」。** 读者就是改代码的人，不是"用户"，也不是"开发者们"。
2. **不用「我们」。** 这个项目没有"我们"，只有"这份代码"；写"我们认为"的地方，其实是在说"这里选了这个"。
3. **中文正文全角标点，代码 / 路径 / 命令一律反引号。** 半角逗号夹在中文里，眼睛要停顿一下才分得清断句。
