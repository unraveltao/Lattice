---
status: accepted
date: 2026-10-28
code: public/widgets/lattice.note/{note-images.js,note-md.js,widget.js,index.html,style.css,manifest.json}, src/runtime/{save-file.ts,bridge.ts}, src-tauri/src/{export.rs,export_policy.rs}, tests/{note-images.html,note-save.html,export.html}, docs/{WIDGET_SPEC.md,ROADMAP.md}
---

# LAT-0031 —— 便签导出三种形状：自包含 .md / zip / 单文件 .html

> 用户原话：**"我倾向于图片放进去后是以字母文本格式保存，最后这个 Note 可以导出 MD 文档之类的。其他文档也可以。"**
>
> 0028 已经把"字母文本"这一半做完了（图片就是正文里的一行 base64）。这一份补的是**交出去的那一头**：一份带图的东西，用户到底想拿到什么。

## 1. 问题

0028 的导出只有一条路：有图就打 zip（`note.md` + `images/`）。

这条路的毛病不在功能，在**场景**：

- **把 `.md` 拷到别处，图就断了。** 用户从 zip 里只拿 `note.md` 扔进笔记库 / 发给自己 —— 那三张截图留在没被拷走的 `images/` 里。症状是"导出的时候图还在，过两天全成了破图标"。
- **聊天窗口和手机预览不了 zip。** 用户想"发给我自己看一眼"，收到的人得先解压、再找一个能读 Markdown 的程序。而这张便签里其实什么都有。
- **不写 Markdown 的人拿它没办法。** 周报、会议纪要的接收方不是编辑器用户。

不做的话：导出这条路的终点永远是一个压缩包，而"便签是一份文档"这件事只对写 Markdown 的人成立。

## 2. 候选

三条轴，各自至少两个方案。

**A. 自包含的 Markdown 怎么写**

| | A1：正文原样交出去 | A2：`{width}` 改写成 `<img width>`、src 仍是 data URI | A3：抽出 `images/`（0028 现状） |
| --- | --- | --- | --- |
| 交出去的东西 | 便签里那一段字 | 同一份，但宽度变成 HTML 属性 | 一个 zip |
| 自包含 | **是** | 是 | 否 |
| 谁的渲染器认 | Typora / Obsidian（`{width}` 是它们的方言） | 认 HTML 的渲染器 | GitHub / Obsidian |
| 转换代码 | 0 行 | 一段正则 | 抽字节 + 编号 + 改写 |

**B. 网页从哪来**

| | B1：复用预览渲染器（`note-md.js` 加一个 `doc` 模式） | B2：另写一个导出专用的渲染器 | B3：引一个 Markdown 库 |
| --- | --- | --- | --- |
| 代码量 | +20 行（两处分支） | 300 行，两份要一起改 | 一棵要审计的依赖树 |
| 和预览一致 | 天然一致 | 迟早分叉 | 方言和预览不一样 |
| 代价 | 一个渲染器两种输出 | 维护两份方言 | 组件是纯静态目录，一个依赖都不许引 |

**C. 平台怎么知道"这份文本是网页"**

| | C1：桥加 `document: "md" \| "html"` | C2：让组件把 `.html` 写进 `name` | C3：平台按 `files[0].name` 的扩展名推 |
| --- | --- | --- | --- |
| 用户改了名字之后 | 仍然有效（`document` 没变） | **失效**：改完看不出本来是什么 | **失效**：内层名字是组件写的，但平台在猜 |
| 参数个数 | +1 | 0 | 0 |
| 隐式契约 | 无 | "名字里的后缀等于内容" | "内层文件名等于输出格式" |

## 3. 决定

**A1 + B1 + C1。** 加上 0028 那条 zip 保留，一共三种形状：

```
md    正文一个字都不改 —— 自包含，图片是 data URI
zip   note.md + images/（GitHub 认的那种）
html  渲染成一份网页，图片内联，双击就能看
```

理由：

1. **A1 是零转换**。0028 花力气把图片压进正文，换来的就是"正文自己就是那份文档"。导出时再改写一遍，等于把那个前提又拆掉一点 —— 而改写买不到任何东西：GitHub 反正剥 `data:` URI，认 `{width}` 的渲染器本来就是目标读者。
2. **B1 只有两处差别**。`doc` 模式改的正好是"卡片里不能做、文档里必须做"的两件事：链接变成真 `<a href>`，内联图不再带预览用的 `data-note-index`。两处，一眼能数完 —— 这是"一个渲染器两种输出"能成立的前提。
3. **C1 是唯一在用户改名之后仍然有效的方案**。用户在保存框里把 `周报` 改成 `周报.md` 时，C2 和 C3 都会把一份 HTML 写进 `.md` 文件 —— 而"别信用户在对话框里敲的名字"正是 0028 立下的规矩。

**代价**（写具体）：

- **桥多一个参数，五处要改**：`save-file.ts`（校验）、`bridge.ts`（透传）、`export.rs`（解析 + 挑过滤器）、`export_policy.rs`（补扩展名）、`WIDGET_SPEC` §3.8。漏一处不报错，症状是"导出的网页后缀是 .md"。
- **`note-md.js` 有了两种输出**。将来加语法要记得两条路都验；压住风险的办法是 `doc` 只允许影响那两件事，第三条一旦出现就该拆函数。
- **HTML 里那份 CSS 是抄预览的**。改预览排版时要同步（两边都写了注释）。抄的那份是文档版（白底、44rem、跟着系统深浅色），不是卡片那份（透明底、13px）。
- **单文件 `.md` 在 GitHub 上看不见图**（它剥 `data:` URI）。所以 zip 不能删 —— 三种形状各自服务一类读者，没有一种能替代另外两种。
- **导出菜单多一次点击**。底栏放不下三颗按钮（最小宽度 180px），所以「导出」从"一个动作"变成"开一张菜单"。这是这次唯一变慢的地方。

**什么时候该推翻它**：如果三种形状里有一种从来没被用过（看用户反馈），删掉它 —— 一个没人选的菜单项比没有这个功能更糟。

## 4. 接口与数据

**桥方法**（只加一个可选参数，其余不变）

```
file.save      权限 file:save
参数: { name: string, document?: "md" | "html", files: Array<{ name, text?, base64? }> }
返回: { ok: true, path } | { ok: false, cancelled: true }
错误: permission_denied / bad_params / internal
```

- `document` 缺省 `"md"` —— 老调用方一个字都不用改。
- **不认的值一律 `bad_params`**：`"zip"` 不是一个 document（打不打 zip 由内容决定，认它会让同一个参数有两套意思）、大小写不认、非字符串不认。猜一个的代价是用户拿到一个后缀不对的文件，而他不会去看日志。
- 扩展名与过滤器：

| 内容 | `document` | 落盘 | 对话框过滤器 |
| --- | --- | --- | --- |
| 多文件，或任一给了 `base64` | 不参与 | `.zip` | Zip |
| 单文本 | `md` | `.md` | Markdown |
| 单文本 | `html` | `.html` | HTML（`html` + `htm`） |

**落盘格式**：没有新格式。便签的 `text` 仍然是那份 Markdown；导出的三种形状都是它的投影。

**组件侧（`lattice.note` 0.4.0）**

- `note-images.js` 三个纯函数，一个形状一个：`inlinePlan`（原样）、`exportPlan`（抽成 `images/`）、`htmlPlan`（交给渲染器 + `htmlDocument` 包壳）。
- `note-md.js`：`render(source, doc)`，`doc=true` 时链接出 `<a href>`、图不带 `data-note-index`。
- `widget.js`：底栏「导出」开菜单，三项各自调 `exportNote(format)`。菜单关闭有三条路：选了其中一项、点了别处、按 Esc。
- `htmlDocument` 自己带一份内联 CSS（`color-scheme: light dark`），一个外部引用都没有。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 导出的 `.md` 在 GitHub 上没图 | GitHub 剥 `data:` URI | **不是 bug**。zip 那条就是给它的；菜单项的 title 里写明"Typora / Obsidian 认" |
| 导出网页，文件后缀却是 `.md` | `document` 没传到 Rust，或 `with_extension` 没按它补 | 五处都要改（见 §3 代价）；`export_policy.rs` 有一条单测专钉这个 |
| 用户把名字改成 `周报.md`，导出的却是网页 | 平台按名字推格式了（C2/C3 的错） | 格式只认 `document`，名字里的后缀一律被换掉 |
| 网页里的链接点不开 | 渲染器没走 `doc` 模式 | `doc=true` 才有 `<a>`；`note-save.html` 钉住 `note.html` 里出现 `<title>` |
| 网页里出现破图标 | 图不是 `data:` URI（外链在渲染时就被降级成 alt 文字） | 只认 `data:image/`、`blob:`、相对路径，和预览同一条规矩 |
| 菜单挡住正文 | 没有关菜单的路 | 三条关闭路径，缺一条就会在 200px 高的卡片里留下一块浮层 |
| 卡片拉到最小宽度，菜单溢出 | 菜单比卡片宽 | `min-width: 96px` + 贴左边；`tests/note-layout.html` 量正文起点，不受影响 |
| 导出一份只装一个文件的 zip | `format: "zip"` 被当成了意图 | 打不打 zip 只看内容 —— 没图的"zip"退化成一份 `.md` |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/note-images.html` | 60 → 77 | 自包含 `.md` 一个字都不改、`htmlDocument` 的转义与自包含、`htmlPlan` 的名字与格式 |
| `tests/note-save.html` | 21 → 35 | 菜单开合、三种形状各自递了什么给桥、有图时 zip 才是真 zip、网页里的图仍是 data URI |
| `tests/export.html` | 27 → 32 | `document` 缺省 md、不认的值拒掉、`.html` 的补/换扩展名 |
| `src-tauri/src/export_policy.rs` | 14 → 16 | 同上（Rust 侧那一份），外加"要 zip 时 `document` 不参与" |

**手工验一次**：

1. 带一张图 → 导出「单文件 .md」→ 把那一份文件单独拷到桌面 → Typora 打开，图还在
2. 同一个便签 → 导出「zip」→ 解压后 `images/1.webp` 在，GitHub 上预览有图
3. 同一个便签 → 导出「单文件 .html」→ 双击打开，图在、链接能点、暗色系统下是深底
4. 在保存框里把名字改成 `周报.md` 再存网页 → 落盘的是 `周报.html`
5. 卡片拉到 180px 宽 → 点「导出」，菜单三行都读得全，不超出卡片
