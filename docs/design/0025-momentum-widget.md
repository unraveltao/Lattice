---
status: accepted
date: 2026-10-27
supersedes:
code: public/widgets/lattice.momentum/{manifest.json,index.html,style.css,widget.js,momentum-core.js,icon.svg}, tests/momentum.html, tests/momentum-trending.js, docs/ROADMAP.md
---

# 0025 —— 看一个项目的"长势"（`lattice.momentum`）

## 1. 问题

想判断一个项目"最近还行不行"：是在加速、在维持，还是已经停了。现在只能翻 commits 列表数日期，或者看 star 数——而 star 是**存量**，存量大的项目可能已经两年没提交。

**坏结果**：用户挑了一个 20k star 的库接进项目，三个月后发现它上一次发版是 2024 年。

## 2. 候选

**star 曲线能不能算**

| | A：只用官方 API 的活跃度 | B：自己翻 stargazers 攒曲线 | C：抓 trending 页（选中，见下） |
| --- | --- | --- | --- |
| 做法 | 提交 / 发版 / 未关闭 issue | `/stargazers` 逐页翻，带 `starred_at` | 读 `github.com/trending` 的 HTML |
| 代价 | **看不到 star 增长** | 10 万 star = **1000 次请求**，匿名额度 60/小时 → 跑 16 小时 | 不是 API，改版会断 |

**形态**

| | A：一个组件两个页签（选中） | B：只做榜单 | C：只做体检 |
| --- | --- | --- | --- |
| 回答的问题 | 「这个在涨吗」+「最近谁在涨」 | 只有后者 | 只有前者 |
| 代价 | 卡片要装两套状态 | 答不了"我看的那个项目还行吗" | 答不了"最近有什么好东西" |

## 3. 决定

**决定**：A（官方 API 的活跃度）+ C（抓 trending 页补上"最近谁在涨"），一个组件两个页签。

**实测（别凭印象推翻）**

- `/stats/participation` **一次请求就给 52 周的每周提交数**。`tauri` 近 4 周 101、前 4 周 126（略降温）；`wails` 近 4 周 139、前 4 周 97（在涨）。信号是真的，而且便宜。
- `github.com/trending?since=weekly` **一次请求 630 KB，解析出 15 条**，每条带仓库名、总 star、**本周新增 star**、语言、描述。那个"本周新增"正是 API 永远给不了的数字——`/stargazers` 要翻页才拿得到。
- 三个时间窗都能抓：daily 14 条 / 618 KB，weekly 15 条 / 630 KB，monthly 21 条 / 707 KB。**都低于 `network.fetch` 的 1 MB 上限**，但月度页已经贴着上限，解析器必须能吃"半截 HTML"。

**代价**（具体）：

- **抓取是会断的**。GitHub 改版，这个页签就废。所以解析失败必须说"trending 页面结构变了"，**不能说"今天没有热门"** —— 前者让人去修，后者让人以为一切正常。
- **白名单要开 `github.com`**，不只是 `api.github.com`。这是这个组件唯一一处权限面变大。
- **没有额度承诺**。trending 页没有文档化的限流，一小时刷一次是合理的，刷得勤可能被挡。
- **体检一个项目 3 次请求**（元数据 + 52 周提交 + 发版）→ 匿名额度下 20 个项目/小时。够用，所以 v1 **不带 token**（见 0026 关于密钥保管的那份）。

**什么时候该推翻它**：GitHub 真的出了 trending API（那时删掉解析器，别留着两套）；或者抓取连续被挡（那时砍掉榜单页签，只留体检）。

**被推翻的**：

- "自己翻 stargazers 攒 star 曲线" → **不做**。1000 次请求换一条曲线，而 trending 页白送增量。
- "让模型判断长势" → **不做**。提交数和发版间隔是确定的事实，让模型去"感觉"一个项目行不行，只会得到漂亮而无据的句子。模型只负责**解释**，不负责**判断**（见 §4 最后一条）。
- "近 4 周 = `weeks[-4:]`" → **错，要跳过最后一桶**。`participation` 的最后一项是**本周进行中**，拿它跟前三周比会系统性低估；对比用 `weeks[-5:-1]`，最后一桶在图上画成浅色。

## 4. 接口与数据

**桥方法：一个都不加。** 只用 `network.fetch` / `llm.chat` / `llm.status` / `shell.open` / `storage.*` / `schedule.every`。

**权限**：`network`（hosts: `api.github.com`、`github.com`）、`llm:chat`、`shell:open`、`storage`。

### 页签一：体检（3 次请求）

```
GET api.github.com/repos/{o}/{r}
  → stars / forks / open_issues_count / pushed_at / language / archived / created_at
GET api.github.com/repos/{o}/{r}/stats/participation
  → { all: [52 个周提交数，旧→新] }        ← 可能回 202（GitHub 正在算）
GET api.github.com/repos/{o}/{r}/releases?per_page=10
  → 发版日期（**按日期去重**，monorepo 同一天发 5 个包）
```

派生（全是纯函数，`momentum-core.js`）：

| 指标 | 算法 |
| --- | --- |
| 近 4 周 | `sum(weeks[-5:-1])` —— **跳过最后那个进行中的桶** |
| 前 4 周 | `sum(weeks[-9:-5])` |
| 变化 | `(近 - 前) / max(前, 1)` |
| 发版节奏 | 去重后的日期，相邻间隔的中位数（天） |
| 最新版本 | 距今几天 |

**判定（顺序不能换）**

1. 数据没拿到 → **不下结论**，显示"没读到"（把"没数据"说成"停更"是这里最严重的错误）
2. `archived` → **已归档**
3. `pushed_at` 早于 90 天 **且** 近 4 周为 0 → **停更**
4. 近 4 周 < 5 次提交 → **很安静**（3 次变 4 次是 +33%，那是噪声）
5. 变化 ≥ +20% → **加速**；≤ -30% → **放缓**；其余 → **平稳**

**页签二：最近在涨（1 次请求）**

```
GET github.com/trending?since=weekly|daily|monthly
```

按 `<article class="Box-row"` 切块，每块取：仓库（`<h2 class="h3 lh-condensed">` 里的 `href="/o/r"`）、总 star（`/stargazers"…</svg>` 后面的数字）、**增量**（`([\d,]+) stars? (today|this week|this month)`）、语言（`itemprop="programmingLanguage"`）、描述（`<p class="col-9 color-fg-muted my-1 pr-4">`，剥标签 + 反转义）。

- 三个时间窗是一个分段控件（今天 / 本周 / 本月），各缓存 1 小时。
- `truncated: true`（响应超 1 MB 被截）→ 用已解析的部分，顶上挂一行"榜单不完整"。
- 解析出 0 条 → **"页面结构变了"**，并给一个"去 GitHub 看"的链接。

**落地时抓下来才看见的两处**（改了解析器，没改这段的判断）：

- 描述那个 `<p>` 在真实页面上是 `class="col-9 color-fg-muted my-1 tmp-pr-4"` —— 上面写的 `pr-4` 对不上（GitHub 加了个 `tmp-` 前缀）。所以解析器只认 `col-9 color-fg-muted` 这两段，尾巴不管。
- 切块用 `split('<article class="Box-row"')`，不用一条跨块的全局正则：月度页 707 KB 贴着 1 MB 上限，被截断时最后一块只该丢它自己。

### 模型只写一句话，不参与判断

点「解读」或第一次查某个仓库时，把**最近 3 条 release 标题 + 最近 10 条 commit 标题**喂给 `llm.chat`，要一句人话（"最近在做 v3 重写，两周内打了 4 个 beta"）。

- **刷新时不自动调用** —— 一张摆在桌面上的卡片每小时烧一次模型调用是不可接受的。
- 没配模型时这一块整个不出现（不是显示一个空框）。
- 它写的话**不许改上面的判定**。判定只认数字。
- **提交标题那一条是第四条请求**（`/commits?per_page=10`），只在"解读"那一刻发 —— 体检本身仍然是三条。拿不到就只喂发版标题，不让解读失败。

### 落盘（键 `momentum`）

```json
{ "version": 1,
  "repos": { "tauri-apps/tauri": { "at": 1761…, "data": { … } } },
  "trending": { "weekly": { "at": 1761…, "items": [ … ] } } }
```

体检 24 小时、榜单 1 小时；过期**先显示旧的再后台重查**；`version` 不认识当空缓存、不落盘；最多 20 个仓库。

**清单**：`id: lattice.momentum`，`name: 长势 / Momentum`，420×380（最小 320×280），`layer: desktop`，`interactive: true`。配置两项：`window`（select：`weekly` / `daily` / `monthly`，默认 weekly）、`refresh`（number 小时，1–12，默认 3）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 一个明明很活跃的项目显示"停更" | 限流 403 被当成"没有提交" | 数据没拿到就不下结论，显示"没读到" |
| 曲线一片空白但数字都在 | `participation` 回 202（GitHub 正在算） | 隔 2 秒重试最多 2 次，仍 202 就只缺曲线、其余照常 |
| 近 4 周总是显得比实际少 | 把进行中的那一周算进了对比 | 对比用 `weeks[-5:-1]`，最后一桶画浅色 |
| 发版节奏显示"每 0 天一个版本" | monorepo 同一天发多个包 | 按**日期**去重再算间隔 |
| 榜单永远"今天没有热门" | 页面改版、解析 0 条 | 报"结构变了"并给链接，别报"没有数据" |
| 榜单只出来一半 | 响应超 1 MB 被截断 | 用已解析部分 + "不完整"提示 |
| 一个新建的空仓库显示"停更" | 没区分"从没有过提交"和"停止提交" | `created_at` 在 30 天内且 0 提交 → "刚建，还没有提交" |
| 中文描述变成 `&amp;` 之类 | 没反转义 | 解析时反转义实体（含 `&#39;` / `&#x27;`） |
| 摆着不动的卡片一天发几百次请求 | 用了 `setInterval` | `schedule.every`（最小 250ms，这里用小时级），窗口藏起来平台会停表 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/momentum.html` | ~55 | 判定顺序（含"没数据不下结论"）、跳过最后一桶、小样本不下结论、发版按日期去重、trending 解析（15 条真样本）、实体反转义、截断处理、缓存过期 |

**手工验一次**：查 `tauri-apps/tauri`（该显示平稳/放缓）和 `wailsapp/wails`（该显示加速）；查一个 archived 仓库；查一个今天刚建的空仓库；切三个时间窗看榜单；把网络断掉看是不是"没读到"而不是"停更"。
