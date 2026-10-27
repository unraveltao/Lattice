---
status: draft
date: 2026-10-27
supersedes:
code:
---

# 0024 —— 找一个项目的"同类"（`lattice.related`）

## 1. 问题

看到一个新项目，想知道"还有谁在做同一件事"——谁更成熟、谁的 star 更多、有没有更好的替代品。现在只能靠搜索引擎翻博客，或者凭记忆想名字。

**坏结果**：用户根本不知道 `wails` / `neutralinojs` 存在，于是选了一个 3k star 的库，而同一件事有个 36k star 的实现。

## 2. 候选

**相似度谁来算**

| | A：纯代码（topic + 语言 + 描述词） | B：纯模型 | C：模型提名 + 代码核对（选中） |
| --- | --- | --- | --- |
| 做法 | 用源仓库的 topics/language 组检索式，按 star 排 | 让模型直接报"相似的有哪几个" | 模型给名字，代码拿名字换真实 star |
| 换掉什么 | 零配置、离线也能跑 | 没有模型的机器上这个工具不存在 | 多一次模型调用（花钱、要配模型） |
| 代价 | **只能给"同类"，给不了"同题"**（见 §3 的实测） | 模型会编 star、编不存在的仓库 | 两段都可能失败，要各自有降级 |

**形态**

| | A：组件卡片（选中） | B：主窗口面板 | C：独立小窗 |
| --- | --- | --- | --- |
| 做法 | 一张卡，粘贴或拖一个 GitHub 地址进去 | 和组件库并列 | 像 `assistant.html` |
| 代价 | 列表窄，一屏七行 | 得先打开主窗口，用一次要走三步 | 第二条分发路径，目录 / 安装都用不上 |

## 3. 决定

**决定**：C + A —— 模型提名、代码核对、组件卡片。

**实测（这是这个设计唯一的地基，别凭印象推翻）**

拿 `tauri-apps/tauri` 跑三种检索：

- `topic:desktop-app language:rust` 按 star 取前六：`cc-switch`(148k)、`Pake`(62k)、`ChatGPT 桌面版`(54k)、`BongoCat`(24k)……**全是用 Tauri 写出来的应用**。topic 说的是"这东西是什么"，不是"这东西干什么"。
- `desktop webview framework in:readme` 前八有六个 `awesome-*`：它们 README 里什么都提一句，所以什么都命中。
- 让模型点名再核对：`electron`(123k)、`wails`(36k)、`flet`(17k)、`neutralinojs`(8.6k) —— **一次搜索就全核对上了**（`q=electron OR wails OR flet OR neutralinojs in:name`）。

**代价**（具体）：

- **要花用户的钱**。每次查询一次 `llm.chat`。没配模型时降级到 A 的结果，界面上必须写明"这是按标签找的同类，不是替代品"—— 不写清楚，用户会以为这工具就是不准。
- **额度是硬约束**。核心 API 未认证 **60 次/小时**，搜索 **10 次/分钟**。所以：不拉候选的 README（每个候选一次核心请求，10 个候选就吃掉 1/6 的时额度）；一次查询只花 **1 次核心 + 1 次搜索**。
- **拿不到 token**。平台没有给组件的密钥保管，GitHub token 写进 `config` 就是明文落 `state.json`。所以 v1 不带 token，额度靠"一次查询只花两次请求"和缓存来省。
- **只回答"还有谁"，不回答"哪个更好"**。star 是尺子不是判据，界面上不写"推荐"两个字。

**什么时候该推翻它**：平台有了给组件的密钥保管（那时该上 token，额度从 60/小时变成 5000）；或者 GitHub 出了公开的相似仓库端点（那时模型可以退成"写一句话"）。

**被推翻的**：

- "拉候选的 README 算 TF-IDF" → **不做**。每个候选一次核心请求，10 个候选就吃掉 1/6 的时额度，而效果还不如模型一句话。
- "按相似度排序" → **相似度当筛子，star 当尺子**。纯 star 排序会把 148k 的 `cc-switch` 顶到第一，而它根本不该出现。
- "拖 GitHub 链接进来" → **v1 只做粘贴**。拖放要宿主页那一段转发（`docs/design/0023` 三期），那条通道还没做；粘贴是零平台依赖的，先到先得。
- "让模型直接报 star" → **代码核对**。模型对数字的记忆是幻觉重灾区，star 只能来自 API。

## 4. 接口与数据

**桥方法：一个都不加。** 只用现成的 `network.fetch`、`llm.chat`、`llm.status`、`shell.open`、`storage.*`。**Rust 一行都不用动** —— 这是这个组件最值钱的一条，和 0023 正好相反。

**权限**（四条，每条都要在 `help` 里说清是干什么的）

| 权限 | 为什么 |
| --- | --- |
| `network`（hosts: `api.github.com`） | 读仓库元数据、批量核对候选 |
| `llm:chat` | 让模型提名候选（没配模型时这条用不上，降级） |
| `shell:open` | 点一行，在浏览器里打开那个仓库 |
| `storage` | 缓存上一次结果，省额度 |

**一次查询的三步**

1. `GET https://api.github.com/repos/{o}/{r}` → `{ full_name, description, topics, language, stargazers_count }`（**1 次核心请求**）
2. `llm.chat`：把上面四个字段给模型，要它列最多 12 个"做同一件事的项目"，一行一个，格式 `owner/repo | 一句话为什么像`
3. `GET /search/repositories?q=<名1> OR <名2> … in:name&sort=stars&per_page=50` → **按名字精确匹配**（忽略大小写），取真实 star（**1 次搜索请求**）

然后：去掉源仓库自己、去掉 fork、按 star 从高到低、取前 10。模型那句话原样显示在每一行下面。

**核对失败的候选要报数**："提名 10 个，核对到 6 个" —— 不报数的话，用户会以为模型只想到 6 个，或者以为工具漏了。

**输入解析**（纯函数，`related-core.js`）

```
https://github.com/tauri-apps/tauri            → tauri-apps/tauri
https://github.com/tauri-apps/tauri/tree/dev   → tauri-apps/tauri（去掉尾巴）
github.com/wailsapp/wails                      → wailsapp/wails（补协议）
tauri-apps/tauri                               → tauri-apps/tauri
https://github.com/tauri-apps                  → 拒绝："这是一个用户主页，不是仓库"
```

**降级模式**（`llm.status` 的 `configured` 为假）

一次搜索：`q=<language> topic:<最热门的那个 topic>&sort=stars`，按 **topic 交集数**过滤（≥1 才留），再按 star 排。顶上挂一条横幅：**"没配模型：下面是同标签的项目，不是替代品"**。

**落盘**（键 `related`，`storage`）

```json
{ "version": 1, "cache": { "tauri-apps/tauri": { "at": 1761…, "mode": "model", "items": [ … ] } } }
```

- 只留最近 50 个仓库、24 小时过期。过期不是删掉而是**先显示旧的、后台重查**（和目录缓存同一条规矩：缓存是加速，不是真相）。
- `version` 不认识 → 当空缓存，**不落盘覆盖**。

**清单**：`id: lattice.related`，`name: 相似项目 / Related`，440×420（最小 320×260），`layer: desktop`，`interactive: true`。配置一项：`count`（number，3–12，默认 10）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| "没有相似项目"，但明明有 | 403 限流被当成空结果 | 读 `X-RateLimit-Remaining` / `X-RateLimit-Reset`，写"额度用完了，约 7 分钟后再试" |
| 模型给了 10 个，界面只出 3 个 | 核对时被静默丢掉 | 报数："提名 10，核对到 3"，并把丢掉的写成一行小字 |
| star 数和 GitHub 页面对不上 | 模型报的 star | star 只来自 API，模型的话一个字都不进数字位 |
| 第一行是 `cc-switch`（和源项目毫无关系） | 走了 topic 降级，界面没说 | 降级横幅必须显眼，且写"不是替代品" |
| 用户粘了一个 issue 链接 | 只认仓库地址 | 明确报"这是 issue，不是仓库"，别只说"格式不对" |
| 私有仓库一直转圈 | 404 被当成网络错误重试 | 404 直接说"读不到（私有库或拼错了）"，不重试 |
| 一分钟内连点五次，后面全红 | 搜索额度 10 次/分 | 连点合并成一次（同一仓库 2 秒内只发一次）；限流时按钮变灰并倒计时 |
| 模型返回的格式是 markdown 表格 | 只按行解析 | 容忍 `-` / `*` / `1.` 前缀和 `|` 分隔；认不出就整段丢掉并报"模型没给出候选" |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/related.html` | ~45 | 地址解析（五种输入 + 两种拒绝）、模型输出的解析（前缀 / 分隔符 / 乱格式）、名字精确匹配、去自己/去 fork/star 排序、缓存过期与 `version` 不认识时不落盘、限流文案 |

**手工验一次**：粘 `tauri-apps/tauri` → 十行里应该有 electron / wails / neutralinojs；点一行能打开浏览器；把模型 key 删掉再查一次，看降级横幅；一分钟内连点五次，看第 6 次是不是变灰。
