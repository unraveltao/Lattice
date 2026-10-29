---
status: draft
date: 2026-10-29
supersedes:
code:
---

# LAT-0039 —— 把"教 agent 造组件"做成一个能自己证明自己的闭环

## 1. 问题

一个陌生人在 r/desktop 看到 Lattice，想给自己的桌面写一块天气卡。他手上只有：一个 README、一份 `WIDGET_SPEC`、一条 `npx skills add`。

他会停在三步之内：

1. **脚手架。** [`new-widget`](../../.agents/skills/new-widget/SKILL.md) 技能第一步是 `npm run create:widget` —— 那是**这个仓库**的脚本，不是平台的命令。没有 clone 就没有脚手架。
2. **打包。** 想发给朋友 → `npm run pack:widget`，同样在仓库里。目录仓库 `lattice-registry/scripts/zip.mjs` 的文件头写着"**只读** ZIP 解析 —— 够读 `.lattice` 里的 `manifest.json` 就行"，`sign.mjs` 只能给**已经存在**的包签名。所以 [`WIDGET_SPEC`](../WIDGET_SPEC.md) §9.2 和 `lattice-registry/CONTRIBUTING.md` 第 17 行那句"没有 Lattice 源码也能走完"**是错的**：他签不了一个他打不出来的包。
3. **自检。** 唯一能跑的是 `npm run test:browser` —— 要 dev server、要 1420 端口、要整个仓库。他跑不了，也读不懂。

结果：**第三方作者今天唯一可行的路是 clone 一个 Rust 3 万行 + TS 2.8 万行的 Tauri 仓库，为了写 200 行 HTML。** 这条路本身就把人筛掉了。

三个后果，按严重度：

- **产品**：组件生态的入口锁在仓库里。24 个官方组件全是你写的，第 25 个也只能是你写的。
- **获客**：`npx skills add` 装完什么都干不了 —— 第一次体验就是失败，比没有这个技能更糟。
- **外部可见度**：10-29 那封信要的是"外面有没有人在乎"，而"有人在用你的东西做出东西"是唯一能被外部数出来的信号。工具不在外面，信号不会有。

## 2. 候选

| | A：只发 SKILL.md | B：发 kit（CLI + 从宿主源码编出来的校验器 + 公开 skill） | C：网页版 playground |
| --- | --- | --- | --- |
| 做法 | 把 `.agents/skills/new-widget` 整理一下放出去 | `new / dev / check / pack / sign` 五个子命令，npm 零依赖 | 静态站点 + iframe + mock 桥，浏览器里写、浏览器里看 |
| 换掉什么 | 什么都不换 | 把"作者需要仓库"换成"作者需要一个 npm 包" | 把"装应用"换成"打开网页" |
| 新增什么 | 一份会过期的文档 | 一个发布物、一个构建步骤、一条版本契约 | 第二个产品 + 一套 mock 桥 |
| 代价 | 零成本，也零效果 | 多一个要跟着宿主走的发布物 | 大；而且它证明不了"装得上" |
| 谁受益 | 没有人 | 第三方作者 + 组件生态 | 尝鲜者，看到的是假桌面 |

**A 为什么不行**（三条都能当场验证，不是判断）：

1. 它第 96 行写着 `--key ../lattice-registry/.keys/publisher.key` —— **维护者的私钥路径**。发出去等于教所有人"私钥该放哪儿"。
2. 它假设 `public/widgets/`、`npm run store:index`、`tests/help.html`、`scripts/test-browser.mjs` 都存在。
3. 它教的"验收"是跑不了的东西 —— 一份教人做不到的事的文档，比没有更伤。

**C 不是不好，是不该现在做**：mock 桥只能证明"画得出来"，证明不了"装得上"，而作者卡住的恰恰是后者。但 C 的一半该现在做 —— `kit dev` 里的浏览器预览几乎不要钱，而且是唯一能批量产出截图的地方。

## 3. 决定

**决定**：做 B，但砍到"一个能自己证明自己"的最小闭环 —— `@lattice/kit`（npm，零依赖，Node 22）+ 一份**公开的** `SKILL.md`。校验器不重写，**从宿主源码编出来**。

四条边界：

1. **不新增第二份规范。** [`docs/WIDGET_SPEC.md`](../WIDGET_SPEC.md) 仍是唯一契约文本；kit 里带的是它的快照（头部标 `spec: 0.2`）。但**判据是 `check`** —— 文档和 check 不一致时以 check 为准，然后回来改文档。这和"代码是最终依据"是同一条。
2. **不发布内部技能。** `invariants` / `verify` / `grilling` / `context-engineering` 讲的是**这个仓库**怎么干活，对外是噪音，也是维护负债。
3. **公开 skill 与内部 skill 是两份文档，不是一份的两半。** 内部那份的工序是"改官方组件"（要 `store:index`、要 dev 钥匙、要跑全量断言），公开那份是"从零到能装上"。共享的**判据**（七条硬约束、权限、窗饰留白）住在 `WIDGET_SPEC`，两份 skill 只写顺序 —— 这正是 [`docs/README.md`](../README.md) 第 43 行已经立的规矩：结论错了改别处，工序错了才改这里。
4. **kit 是契约的客户端，不是平台的分支。** 不许有自己的清单校验、自己的签名实现、自己的 semver。

**代价**（具体）：

- 多一个 npm 发布物 + 一条 CI：`kit:build` 之后工作树必须干净，否则红。形状和现有的 `sdk:sync` / `test:sdk` 一样 —— 那个"拷出去的副本会漂"的问题这个仓库已经解过一次，这次是同一个问题的第二个实例，不是新机制。
- **要在 [`src/runtime/widget-text.ts`](../../src/runtime/widget-text.ts) 上切一刀。** 那个文件现在同时住着纯函数和 `useText()` 这个 React hook（第 33 行 `import { useCallback } from "react"`），`pickText` 的默认参数还读 `lang()`（来自同样 import React 的 `i18n.ts`）。不拆，编出来的校验器会把 React 拖进一个 CLI。拆法：`widget-text.ts` 只留纯函数，新 `use-text.ts` 放 hook，约 40 行搬家 + 宿主侧改几处 import。
- 错误文案不用维护第二张表：`t()` 找不到键就回退到键本身（[`i18n.ts:159`](../../src/runtime/i18n.ts) 的 `TABLES[language][text] ?? text`），而清单校验的键就是英文原句。所以 CLI 里一个 15 行的 `t` 替身就能出英文错误。
- **承诺**：`sdk: "^0.1"` 一旦对外，删方法 / 改返回形状就要走 deprecation，不能直接换。这条现在还没生效，因为 `sdk` 字段被 `normalizeManifest` 归一化成默认值（[`manifest.ts:244`](../../src/runtime/manifest.ts)）之后**没有任何地方比对它** —— [`semver.ts`](../../src/runtime/semver.ts) 里 `satisfies()` 早就写好了，只用在了 [`catalogue.ts:328`](../../src/runtime/catalogue.ts) 挑版本。**kit 之前必须先接上这条**，否则"kit 说兼容、宿主说不兼容"没有裁决者。

**什么时候该推翻它**：

- 三个月内没有一个非维护者发布组件 → 问题不在工具链，在"没人想要这个产品"。那时该停的是分发，不是加功能。
- 宿主出现第二个平台 → kit 要分叉，那是另一件事。
- 真做了 Web playground → `kit dev` 应被它吸收，别两边各养一套预览。

## 4. 接口与数据

```
npx @lattice/kit new <id> [--name …] [--permissions a,b] [--layer desktop|top] [--interactive]
npx @lattice/kit dev [--port 4173]     # 静态服务 + mock 桥 + 窗饰框，给肉眼和截图用
npx @lattice/kit check [--json]        # 退出码 0/1
npx @lattice/kit pack [--out dist]     # 确定性 zip，连打两次 sha256 相同
npx @lattice/kit sign --key k.pem [--name "…"]
npx @lattice/kit publish --registry <dir> --key k.pem [--dry-run]
```

`publish` 只做到"文件摆好 + 打印下一条 git 命令"，**PR 仍要人提**。自动开 PR 需要 token，而"没有服务端"是这个产品的立身之本。

`check` 的输出是唯一跨工具的形状，要定死：

```json
{ "ok": false,
  "errors":   [{ "code": "permission_missing", "file": "widget.js", "line": 42, "message": "…" }],
  "warnings": [{ "code": "timer_interval", "file": "widget.js", "line": 17, "message": "…" }] }
```

`code` 是稳定字符串，人话会改，脚本不该跟着改。

**check 查什么**（每条都对着一个已经发生过的事）：

| 检查 | 判据 | 防的是 |
| --- | --- | --- |
| 清单 | 宿主 `normalizeManifest` 原函数 | 装得上、永远不生效 |
| 权限声明 vs 实际调用 | 调 `storage.*` 但清单没 `storage` → error；声明 `network` 却一次没调 → warn | 目录仓库拒稿理由第 2 条 |
| `localStorage` / `parent.document` | 出现即 error | 沙箱里没有，静默坏 |
| 绝对路径 `/assets/…` | 出现即 error | 用户组件走 `lattice-widget://`，绝对路径 404 |
| `setInterval` | warn，指到 `schedule.every` | 藏起来时不停、最小间隔 250 ms |
| 硬编码颜色 | 复用 [`check-tokens.mjs`](../../scripts/check-tokens.mjs) 那三张表 | 底板变浅时不翻转 |
| 窗饰留白 | 根节点既没有 ≥100px 的 `padding-right`、也没有 24px 状态条 → warn | 第一行字压在关闭按钮底下 |
| 原生表单控件 | `input` / `select` 没有 `appearance: none` → warn | `color-scheme` 被强制成 normal |
| 打包确定性 | 连打两次比 sha256 | "这个包是不是你发出去的那个" |
| 体积 | 单文件 8 MB / 总量 64 MB / 500 条目 | 装包三道闸，早报比晚报好 |

窗饰那条现在是**查不了只能猜**的：`120px` 在 24 个官方组件里有 **17 个**硬编码（`grep -l 120px public/widgets/*/style.css`），每个文件里还各写一段注释解释这个数从哪来。给作者的第一课不该是一个没来历的魔数。**顺手的正解**：宿主注入 `--lattice-chrome-inset`，组件写 `padding-right: var(--lattice-chrome-inset, 120px)`，check 改成"别硬编码 120"。这条不进 kit 也能单独做，但 kit 是它唯一的传播理由。

**公开 skill 的目录**（8 节，只写顺序，不写判据）：

1. 三十秒决策：这个组件该不该存在（纯展示 / 要存储 / 要联网，三种骨架）
2. `kit new` 之后立刻 `kit dev`，先看它动
3. 七条硬约束 —— 每条一句话 + 指到 `WIDGET_SPEC` 的节号，不抄数
4. 权限：声明一条就等于向用户要一次，写清"为什么这条必须"
5. 双语：清单里 `{zh,en}`，画出去的字要 `lang.get` + `language` 推送两件都做
6. `agent.tools`：把能力压成一行文本，别传对象
7. `check` 的六个错误码怎么修
8. 发出去：`pack` → `sign` → 提 PR；**check 绿 ≠ 能发**，附截图自检清单

**要改的文件**（动手时）：

- `packages/kit/`（新）：`cli.mjs`、`bundle/validate.mjs`（生成物，带宿主版本戳）、`SKILL.md`、`examples/`（两个：一个最小、一个"七条里错了三条再改对"）
- `src/runtime/widget-text.ts` + 新 `src/runtime/use-text.ts`
- `src/runtime/manifest.ts`：`sdk` 字段接上 `satisfies()`（**前置**，见 §3 代价）
- `scripts/kit-build.mjs`、`scripts/kit.test.mjs`
- `.github/workflows/ci.yml`：`kit:build` 后 `git diff --exit-code packages/kit/bundle`
- [`docs/WIDGET_SPEC.md`](../WIDGET_SPEC.md) §1 那张表：把"需要 Lattice 仓库"改成 `npx @lattice/kit`
- `lattice-registry/CONTRIBUTING.md` 第 17 行那句错话

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| `check` 全绿，装进应用报 `internal` | bundle 落后于宿主（有人改了 `manifest.ts` 没重编） | CI 红在提交那一刻；`check` 第一行回显"对照 sdk ^0.1 / spec 0.2"，版本不一致时先警告 |
| 作者装了 kit 却跑不起来（公司网络、没 Node） | 只有一个安装渠道 | README 给"下 zip 直接 `node kit.mjs`"的兜底；skill 里那段"贴进 AGENTS.md"的块不依赖 CLI |
| 作者机器上好看，别人装上糊了 | 他在浏览器里直接开 `index.html`，没走宿主 | `kit dev` 必须带窗饰框和 mock 桥，且**故意**用 240×140 默认尺寸 |
| 私钥被提交进仓库 | 文档教了 `--key` 没教 `.gitignore` | `sign` 首次运行就在私钥同目录写 `.gitignore`；`check` 扫到仓库里有 `*.key` 即 error |
| agent 写出"能过检查但很丑"的组件 | 机械检查只覆盖七条里能查的五条 | skill 里必须有一段"check 绿 ≠ 能发"+ 截图自检清单 |
| 发出去三个月，零外部组件 | 工具对了，受众没到 | 这不是失败模式，是判据：见 §3 推翻条件 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `scripts/kit.test.mjs` | ≥ 8 | 同一批清单，宿主 `normalizeManifest` 与 bundle 输出**逐字相同**（2 个正例 + 6 个坏例） |
| 同上 | ≥ 4 | `pack` 连打两次 sha256 相同；`..` 路径被拒；超 8 MB 被拒 |
| 同上 | ≥ 6 | `check` 六个错误码各有一个最小复现目录 |
| CI | 1 | `kit:build` 之后工作树干净 |

**手工验一次**（这一步才是真验收）：找一台**没有 clone 过 Lattice** 的机器，只按 kit 的 README 走：

1. `npx @lattice/kit new demo.weather --permissions network`
2. `npx @lattice/kit dev` —— 看见东西在动
3. `npx @lattice/kit check` —— 绿
4. 故意写一句 `localStorage.setItem` —— 红，且 `code` 是 `sandbox_api`
5. `npx @lattice/kit pack` —— 拿到 `.lattice`，拖进装好的 Lattice —— 装上、出现在"已安装"

第 5 步如果还要回仓库找东西，这份设计就没成。

## 7. 成败怎么量

10-29 那封信要四样：社区采纳、外部文章、独立讨论、机构背书。**工具一样都不产生** —— 它是这四样的前提，不是这四样本身。所以不能按下载量量。

| 指标 | 现在 | 三个月目标 | 为什么是这个数 |
| --- | --- | --- | --- |
| 非维护者发布的组件数 | 0 | ≥ 5 | reviewer 打开目录能数出来 |
| 提交过 PR 的外部账号 | 0 | ≥ 3 | "contributors" 这个词唯一的硬定义 |
| 引用 kit 的外部文章 / 视频 | 0 | ≥ 1 | 拒信原文的 "external articles" |
| 你自己发的 Show HN / 社区帖 | 0 | 2 | 这条只能人做，kit 只负责把素材备好 |

三件很便宜的配套：

1. **`kit share`** —— 一条命令产出 2× PNG + 一段可直接粘的英文文案（组件干什么、要什么权限、一行安装命令）。作者发帖最大的摩擦是"没有好看的图"。
2. **目录首页**从 `registry.json` 渲染"N 个组件、M 个发布者"。reviewer 要的"采纳"在一个页面上就能看见。
3. **kit 的 README 第一段写立场，不写功能表**："A widget is a directory. No build step, no bundler, no npm install." 能被引用的是立场。

**第一批该去找谁**：Rainmeter 的皮肤作者。他们写的就是"桌面上 240×140 的一小块"，用的是 2009 年的栈（ini + Lua），换过来是降维。没有这个答案，上面那张表全是零 —— 所以 §3 的推翻条件写在"三个月"而不是"一年"。

一个反直觉的结论：**kit 发出去那天最该做的，是去别人的社区回答问题，不是发公告。** 拒信数的是"独立讨论"，公告不是讨论。
