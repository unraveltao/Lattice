---
status: accepted
date: 2026-10-26
code: src/runtime/catalogue.ts, src/platform/store.ts, src/platform/catalogue.ts, src/platform/SettingsMenu.tsx, src/platform/CatalogueSection.tsx, src/App.tsx, tests/catalogue.html
---

# LAT-0010 —— 目录源从一个变成一排

> 需求原文在 [`../ROADMAP.md`](../ROADMAP.md) 的 v0.6 第一条：**"`catalogueSource` 现在是
> `{ kind, url }` 单值，切源等于'上一份目录整个消失'。真生态里一个人会同时订阅官方源和
> 别人的源。"** 这一份只是把那一行写成能判定的形状。

> **现在的状态：落地完成。** 三条决定（列表 / 只并启用的 / 同 id 先到先得）都进了代码：
> `runtime/catalogue.ts` 里有 `CatalogueSource` 形状、`sourceIdFor`、`normalizeSources`、
> `mergeCatalogues`；`store.ts` 的 `catalogueSource` 换成 `sources: CatalogueSource[]`，
> v1 → v2 就地迁移，五个动作（加 / 改 / 删 / 挪 / 启停）一律走 `normalizeSources`；
> `platform/catalogue.ts` 的 `loadCatalogues()` 并发逐源 `try`，只有官方源退回随应用发的那份；
> 设置页的 Widgets 页是那张源列表，商店顶上有每源读况、卡片带来源角标。
> `tests/catalogue.html` 71 → **92 条**、`tests/catalogue-cache.html` 20 → **30 条**、
> `tests/store-ui.html` 63 条不动。**还剩的**只有第 6 节那段手工验收（要人点一次：加一个
> 真源、断网、换顺序、停用、删到剩一个、重启）。`status` 因此从 `draft` 抬成 `accepted`：
> 决定已经落地，剩下的不是"还没想清楚"，是"还没人点过"。
> 下面第 1 节描述的是**动手之前**的样子，别拿它当现状读。

## 1. 问题

用户装组件这件事已经能用了，但**"能装的组件从哪儿来"只有一个槽位**。

具体坏在三处：

- **切源 = 丢一批**。设置里把地址从自定义源改回官方，自定义源那一批组件当场从"可安装"
  里消失 —— 不是卸载，只是看不见了，而用户没有任何地方能同时看到两边。
- **"加一个源"这个动作不存在**。只能"换"。所以第二份目录没法跟官方那份并存，冷战期的
  唯一解法是来回切、记住哪个包在哪个源里。
- **源的状态只有一句**。读不到时整页只剩一行错误（`CatalogueSnapshot.error`），用户不知道
  是哪个源坏了、上次读到是什么时候、别的源还能不能用。

## 2. 候选

| | A：列表 + 合并展示 | B：列表但只按顺序找第一个能用的 | C：留单值，只记历史 |
| --- | --- | --- | --- |
| 做法 | `sources: [{id, kind, url, enabled}]`，全部读回来合并成一张表，每条记来源 | 同上，但只把**第一个成功**的源当作当前目录（failover） | 单值不动，设置里加一个"最近用过"下拉 |
| 换掉什么 | `catalogueSource` 字段与三档单选；商店的"一份快照"模型 | 同左，但商店仍只有一份 | 只改设置页 |
| 新增什么 | 合并纯函数 + 冲突规则、源列表编辑 UI、每源状态行、`state.json` v2 | 合并纯函数省了，但"另一个源里也有它"永远看不见 | 一个下拉 |
| 代价 | 每一个"目录"的消费方都从"一份"变成"多份"：store slice、合并规则、设置页从三档单选变成可增删列表、卡片上多一枚来源角标 | 用户订阅了三份却只看得到一份，等于没解决"同时订阅" | 切回去试试 —— 正是现在这个动作 |

B 被否：它把"订阅多份"偷换成"自动换源"，用户点开商店看到的永远只有一份，而他明明订阅了
三份。C 被否：它优化的是"切回去"这个动作，而问题正是"要切"。

## 3. 决定

**选 A。目录源是一个列表，商店是一张合并表。**

具体到四条，每条都要能一句话讲给用户听：

1. **默认只有一个源，就是官方那份**（`id: "official"`）。列表可以增删，但**不许空** ——
   删到最后一个时那条"删除"按钮是灰的。空目录源是一个无法自愈的状态（用户不知道填什么），
   而"至少留一个"是零成本的。
2. **只有 `enabled: true` 的源参与合并**。停用不是删除：地址和缓存都留着，翻回来不用重新粘。
3. **同一个 `widgetId` 出现在两个源里时，按列表顺序先到先得**，被盖住的那一份在卡片上
   明写一行"另一个源也提供它（源名）"。理由：同 id 两份 = 两段代码、两把钥匙，这不是
   "同一件事的两个版本"，静默合并等于替用户决定装谁。顺序由用户在设置里调（上移 / 下移），
   默认官方在前。
4. **只有官方源在读不到时退回随应用发的那份**（`bundled`）。其余源读不到就显示"读不到 +
   上次读到的时间"，**绝不用别人的内容顶替** —— 一份自定义源的名字底下列着演示目录的包，
   等于把包挂在错误的发布者名下，而界面上看不出来。

`kind` 保留（`url` / `bundled`）：`bundled` 是一个**可以加进列表的源**（离线时想只用随应用
发的那份），不再是一个隐式的兜底档。

**代价**（具体）：

- 合并逻辑进 `runtime/catalogue.ts`，`tests/catalogue.html` 要加一批断言（见第 6 节）。
- 设置页那一块从"三档单选 + 一个输入框"变成"一列源 + 增删 / 启停 / 上下移"，多出三种
  动作 —— 这一块是全篇最重的 UI 改动。
- 商店在订阅了不止一个源时多一段"每源读况"（名字 + 该源有多少条 / 为什么读不到 /
  已关掉），卡片上多一枚来源角标。单一源时两样都不出现 —— 一个源的时候它们每张卡
  都一样，纯噪声。
- `state.json` 升到 v2，`migrateState` 多一段（v1 的 `catalogueSource` → 一条源的数组）。
- 每多一个启用的源就多一次 HTTP（各自走 Rust 的 `store_load_catalogue`，缓存键本来就是
  按 URL 分文件的，**Rust 那侧一行不用改**）。

**什么时候该推翻它**：当"一个 id 两个源"开始真的打架（同一个组件两边都有、版本还各自往前
走）时，光靠"先到先得 + 一行提示"不够了，那时该给组件 id 加源命名空间（`sourceId/widgetId`），
那是协议级改动，得连 `.lattice`、`state.json` 的 `installedIds` / `grants` 一起动。现在不做。

## 4. 接口与数据

**不新增任何 Tauri 命令。** `store_load_catalogue({ url })` 本来就是按 URL 工作的，缓存文件
名也按 URL 分（`catalogue_policy::cache_file_name`）。多源只是**多调几次**，逐源各自拿
`{ text, at, stale, error, notModified }`。

**前端形状**

```ts
// store.ts：state.json 里那一份
export interface CatalogueSource {
  id: string;               // 稳定 id：官方是 "official"，其余由地址归一化得到（撞了加 -2）
  kind: "url" | "bundled";
  url: string;              // kind === "bundled" 时是空串
  enabled: boolean;
}

// catalogue.ts：一个源的读况（界面上的"上次读到 / 失败原因"就是它）
export interface SourceSnapshot {
  source: CatalogueSource;
  catalogue: Catalogue | null;
  error: string | null;
  origin: string;
  at: number;               // ms
  notice: CatalogueNotice | null;
  warnings: string[];
}

// runtime/catalogue.ts（纯函数，断言钉这里）
mergeCatalogues(list: SourceSnapshot[]): {
  entries: CatalogueEntry[];   // 每条上多两个可选字段：sourceId / alsoIn
  conflicts: Array<{ id: string; winner: string; shadowed: string[] }>;
}
```

- 合并顺序 = `sources` 在数组里的顺序；`enabled: false` 的源**不进合并**，而且**不发请求**
  （界面把它那行画成"已关掉"；不给它读时间是因为没读 —— 编一个"上次读到"就是在说假话）。
- `alsoIn` 是"另外还有哪些源提供同一个 id"，填的是**源的名字**（目录自己的名字，读不到
  就退回 id），因为那句话是给人看的。
- 版本不在合并时比较：两个源各有一份同 id 的目录条目时，**不挑版本高的**（那会让"我钉住
  的发布者钥匙和目录里写的不一样"变成一个静默的更新），只按顺序取第一个。

**落盘格式与迁移**（`state.json` v2）

```json
{
  "sources": [
    { "id": "official", "kind": "url", "url": "https://unraveltao.github.io/lattice-registry/registry.json", "enabled": true },
    { "id": "src-example-com-lattice", "kind": "url", "url": "https://example.com/lattice/registry.json", "enabled": true }
  ]
}
```

`migrateState(persisted, version)`：`version < 2` 且盘上有 `catalogueSource` 时，把它变成
一条源的数组（`id` 按同一套规则算，`enabled: true`），并删掉旧的 `catalogueSource`；
盘上什么都没有时补官方那一份。v0 → v1 那一小段（旧默认"内置 + 空地址"迁到官方）保留不动。

**要改的文件**

- `src/platform/store.ts`：`CatalogueSource` 的默认值留在这一侧（形状在 runtime），
  `catalogueSource` → `sources`，四个动作（加 / 改 / 删 / 启停 / 上移下移），
  `STATE_VERSION = 2` 与迁移，`partialize`。
- `src/runtime/catalogue.ts`：`CatalogueSource` / `SourceSnapshot` / `MergeConflict`、
  `sourceIdFor`、`sourceLabel`、`normalizeSources`、`mergeCatalogues`。
- `src/platform/catalogue.ts`：`loadCatalogues(sources)`（并发取、逐源 try、只有官方源退回
  bundled），`CatalogueView`（合并后的快照 + 每源读况 + 冲突）。
- `src/App.tsx`：`catalogue` 状态从"一份快照"变成"合并快照 + 每源读况 + 冲突"，
  `StoreBinding` 多 `sources` / `conflicts` / `sourceLabels`。
- `src/platform/CatalogueSection.tsx`：每源读况那一段 + 来源角标 + "另外还有来源提供它"。
- `src/platform/SettingsMenu.tsx`：Widgets 页的目录那块改成源列表（启停 / 上移 / 下移 / 删 /
  加），`sourceName()` 决定一行叫什么。
- `src/platform/icons.tsx`：`plus` / `up` / `down` / `trash` 四枚 16px 图标。
- `src/styles.css`：`.lattice-source-*`（设置页）与 `.lattice-store-sources`（商店）。
- `src/runtime/i18n/settings.ts` / `library.ts`：新句子（中英各一份）。
- `tests/catalogue.html`、`tests/catalogue-cache.tsx`、`tests/store-ui.tsx` 的绑定。
- 文档：本份、`docs/ROADMAP.md` 一行、`AGENTS.md` 的目录图、`GLOSSARY.md`（`目录源`）。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 一个自定义源挂了，整间商店空白 | 并发取却用一个 `Promise.all`，一个 reject 打断全部；或把第一个错误当全局错误 | 每源单独 `try`，失败的那个只让**自己**那行变红；有任何一个源读成功，商店就照常显示 |
| 自定义源读不到，列表里却冒出演示目录的包 | 对非官方源也套了"退回随应用发的那份" | 退回只给官方源；其余源显示"读不到（原因）"（Rust 的缓存会照常给 `stale`） |
| 同一个组件两张卡、各说一个版本 | 合并只按 id 之外还按了源，没去重 | 按 `widgetId` 去重，先到先得；被盖住的那份只用一行文字说出来 |
| 停用的源，包还挂在"可更新"里 | 合并时没看 `enabled` | 合并只吃启用的源；停用源的包从列表里消失，**但已装的那份照旧能更新**（更新看的是它所在的那个源，源停用则卡片显示"来源已停用"） |
| 同一个地址加两次，出现两行一模一样的源 | 归一化只按 id 去重 | 归一化时**先按地址去重**（地址就是缓存文件的键，两行同地址等于同一份数据说两遍） |
| 删光所有源之后商店永远是空的 | 允许空列表 | 最后一个源的删除按钮是灰的；空列表在迁移与归一化里都不允许存在 |
| 换源顺序之后，装过的组件弹"发布者钥匙变了" | 把"顺序"当成了"哪个源更权威"，顺手把钉住的钥匙也换了 | 顺序只决定同 id 冲突谁赢；`trustedKeys` 一律不动（钉住的是那次安装时的钥匙） |
| 旧机器的设置页一片空白 | 迁移没写，`sources` 是 undefined | v1 → v2 迁一段；读不到就补官方那份（和 v0 → v1 同一条规矩：坏值不许让商店打不开） |
| 三份目录各 300 ms，商店转圈 1 秒 | 串行 `await` | 并发取；"刷新"按钮在位，逐源完成就能先显示 |
| 设置页里改了地址，缓存和"上次读到"却还挂在旧地址上 | 就地改了 `url` 却没换 id | 加／删都走 `normalizeSources`（地址 → id 一处算），改地址请删掉重加 —— 缓存按地址分文件，换地址等于换了一份缓存 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/catalogue.html` | 71 → 92 | `sourceIdFor` 的归一化、去协议、压标点、封顶 40 字；`normalizeSources` 的空列表补官方 / 按地址去重 / id 撞名加后缀 / `enabled` 保留；`mergeCatalogues` 的顺序优先、`alsoIn` 与冲突行、关掉的源不进合并、不撞时没有 `alsoIn`；`sourceLabel` 读不到时退回 id |
| `tests/catalogue-cache.html` | 20 → 30 | v0/v1 → v2 迁移（旧默认落到官方那条、自定义地址一个字不动、id 由地址算、旧字段被删、列表不许空），以及 store 上那一列动作：加 / 同地址不会加两次 / 停用 / 上移 / 已在最上面不越界 / 删一个 / **最后一个删不掉** |
| `tests/store-ui.html` | 63（不变） | 单一源时不铺"每源读况"、卡片不带来源角标 —— 多源那一段的界面只在真机验（见下） |

**手工验一次**（`npm run tauri:dev`）：设置 → Widgets → 加一个自定义源（指向一个真的
`registry.json`）→ 商店顶上出现两行读况、卡片角标不一样 → 断网后刷新，只有自定义源那行
变红、官方那份照常 → 把顺序调换，同 id 的那条提示"另外还有来源提供它"换了个名字 →
停用一个源，它的包消失、那行写"已关掉"、已装的仍在 → 删到只剩一个时那颗垃圾桶是灰的 →
重启应用，源的顺序与启用状态都还在。
