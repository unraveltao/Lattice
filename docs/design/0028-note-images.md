---
status: accepted
date: 2026-10-27
supersedes:
code: src/runtime/{save-file.ts,bridge.ts,manifest.ts,catalogue.ts,i18n/misc.ts}, src-tauri/src/{export.rs,export_policy.rs,lib.rs}, src-tauri/Cargo.toml, src-tauri/capabilities/{default.json,widget.json}, public/widgets/lattice.note/{manifest.json,index.html,style.css,widget.js,note-md.js,note-images.js}, tests/{note-images.html,export.html,note-md.html}, docs/{WIDGET_SPEC.md,ROADMAP.md}, AGENTS.md
---

# 0028 —— 便签装图片：内联压缩 + 导出成 zip

> 用户原话：**"note 这个组件可以添加图片。图片在里面可以缩小一下。方便保存。最后可以导出为 Markdown 这类文本格式。方便用户整理信息。"**
>
> 第二轮确认时他说：**"可以把便签里的图片直接压缩成代码。"** —— 这句就是"内联 base64"的决定，后面所有取舍都从它来。

## 1. 问题

便签现在只能写字（0.2.0 已经有 Markdown 预览）。用户要往里贴截图：会议纪要里的白板、报错弹窗、设计稿。而且贴进去之后要能**带着图**交给别的工具（Obsidian、仓库、周报）。

不做的话：图只能放别处，便签里写"见截图 xxx.png" —— 一周之后那张图找不到了，这句话就成了死链。

## 2. 候选

图片的字节放哪：

| | A：内联 base64 + 插入时压缩 | B：正文短标记 + 独立字节键 | C：只存网络链接 |
| --- | --- | --- | --- |
| 正文长什么样 | 自包含的 Markdown | `![图1](img:1)`，字节在另一个键 | 只有 URL |
| 每次自动保存写多少盘 | 压缩后约 40KB/张 | **一样**（整份 JSON 重写，跟几个键无关） | 0 |
| 导出 | 正文自己就够 | 要另外拼 | 图片根本不在本地 |
| 代价 | textarea 里一行 50KB 的 base64 | 两份数据要同步，删图要两边删 | 断网看不见；要 `network` 权限 |

导出到哪：剪贴板（零新能力，图片只能变 `data:` 或丢掉）／新增 `file.save` 单文件（图片内联 base64）／`file.save` + zip（`note.md` + `images/`）。

## 3. 决定

**A + 导出 zip。**

三条理由：

1. **B 省不了任何东西**。存储是一整个 JSON 文件，`widget_store_update` 改一个键也要把整份读上来、改完写回去，还留一份 `.bak` —— 字节放哪个键，写盘量一模一样。B 换来的只是"正文好看"，代价是"正文不再自包含"。
2. **A 让正文自己就是可导出的 Markdown**。导出时唯一的活是"把 data URL 抽出来变成文件"，而不是"把两份数据拼起来"。
3. **压缩是硬前提**。一张 300KB 的截图压到长边 480 / 质量 0.8 之后约 40KB —— 一个放八张图的便签 400KB，400ms 自动保存写三份盘（`text` + `backup` + `.bak`）也就 1.2MB，无感。**不压缩的 A 才是灾难**。

**代价**（写具体）：

- **编辑态会看到一行 50KB 的 base64**。光标经过它要横向滚很久。缓解只有两条：字数统计先剥掉图片再数；插入后光标落到图片下一行。这条改不了 —— 除非换成 contenteditable（那是重写编辑器）。
- **平台要多一个权限和一个插件**：`file:save` + `tauri-plugin-dialog`。
- **一个便签最多 1MB**（单张压完 ≤ 120KB、最多 8 张）。再往上就该回到"字节放独立键"了。
- **zip 写入是新代码**：`package.rs` 只有读（`extract` / `read_entry`），没有写。

**什么时候该推翻它**：如果用户抱怨"编辑时那行 base64 太烦"的次数超过"导出的图在别处看不到" —— 那就换成 B，并且导出时改成"图片单独写一个文件夹"。这两件事是一起变的。

## 4. 接口与数据

**桥方法**

```
file.save      权限 file:save
参数: { name: string, files: Array<{ name: string, text?: string, base64?: string }> }
返回: { ok: true, path: string } | { ok: false, cancelled: true }
错误: permission_denied / bad_params / internal
```

四条规矩：

- **一个文件且给的是 `text`** → 直接写那个文件（扩展名由 `name` 决定）。
- **多个文件，或者任一给了 `base64`** → 打成一个 zip，`name` 就是 zip 的名字。
- **用户取消不是错误**。返回 `{ ok: false, cancelled: true }`，界面一个字都不要说 —— 把"我不想存了"报成红字是这个仓库反复踩过的坑。
- `name` 只当**文件名**用，自己过一遍形状检查（不含 `\ / : * ? " < > |`、不含 `..`、长度 ≤ 120）。别直接塞进 `fs_policy::normalize_path` —— 那个函数是给「用户指的路径」用的，它允许目录。

**为什么不叫 `file:write`**：`file.write` 在 `hands.rs` 里已经是"助手直接写盘"（带审批、能覆盖任意路径）。组件这条路是**每次弹对话框、用户自己选位置**，是另一种东西，名字必须分开 —— 一个词两个意思，后面所有人都会搞混。

**落盘格式**：没有新格式。便签的 `text` 仍是 Markdown，只是多了这种写法：

```
![](data:image/webp;base64,UklGR…){width=240}
```

`{width=N}` 是方言（pandoc / Obsidian 认）。**导出时它必须被改写**，见下。

**要改的文件**（一条能力五处）

1. `src/runtime/bridge.ts` —— `file.save`
2. `src/runtime/manifest.ts` —— `Permission` 联合加 `"file:save"`、`PERMISSION_READY` 加一项、文案；`src/runtime/catalogue.ts` 的 `KNOWN_PERMISSIONS` 同步（**漏这里不报错**，症状是"装好了，点授权没反应"）
3. `src-tauri/src/export.rs`（保存对话框 + 写文件 + zip 布局）+ `src-tauri/src/export_policy.rs`（纯逻辑：文件名清洗、单文件还是 zip、zip 头字节）+ `lib.rs` 的 `generate_handler!`。**dialog 插件要在两个 capability 文件里都放行**：`capabilities/default.json`（画布上的组件，桥跑在主窗口）和 `capabilities/widget.json`（桌面窗口，桥跑在宿主页）—— 漏一个的症状是「桌面上能用、画布上不能用」，而且不报错。
4. 落盘：无
5. `tests/export.html` + `export_policy` 的 Rust 单测 + `docs/WIDGET_SPEC.md` §3 权限表 + `AGENTS.md`

**组件侧（`lattice.note` 0.3.0）**

- **进来**：`textarea` 上接 `paste` 和 `drop`，拿 `File` → `createImageBitmap` → canvas 缩到长边 480 → `toDataURL("image/webp", 0.8)`（浏览器不支持 webp 时退 `image/jpeg`）→ 插入 `![](data:…){width=…}`。
- **显示**：`note-md.js` 加一条图片规则（**必须先于链接规则**，否则 `![x](y)` 里的 `[x](y)` 会被链接吃掉 —— 那个文件开头已经写着这句话）。只认 `data:` / `blob:` / 相对路径。
- **缩小**：预览态里图片右下角三档按钮，点一下循环 25% / 50% / 100%，改的是源文本里的 `{width=N}`。
- **导出**：扫正文，把 data URL 抽成 `images/1.webp`…，`{width=N}` 改写成 `<img src="images/1.webp" width="N">`（Markdown 没有图片尺寸语法，HTML 是唯一所有渲染器都认的写法），然后一次 `file.save`。
- **默认文件名**：正文第一行是 `# 标题` 就用 `标题.md`，否则 `便签 2026-10-27 10-44.md`；用户在保存对话框里可以改。

## 5. 失败模式

| 症状 | 原因 | 正确行为 |
| --- | --- | --- |
| 贴一张 4K 截图，卡片卡两秒 | 在主线程上解 4K 图再压 | 先看尺寸，长边 > 2000 就先降采样；压缩期间把状态行改成"处理图片…" |
| 粘贴没反应 | 接在了 `document` 上，而桌面窗口的 z 序守卫/焦点把它吞了 | 只接 `textarea` 的 `paste`；`drop` 接在卡片上并 `preventDefault` |
| 预览里出现字面量 `![](data:…)` | 渲染器没有图片规则，或者被链接规则先吃了 | 图片规则写在链接规则之前 |
| 存盘重开之后图没了 | 存的是 `blob:` URL（只在进程内有效） | **只存 `data:`**；`blob:` 只用于当场的预览 |
| 导出的 zip 里图片是 0 字节 | base64 解码失败还继续写 | 先全部解码、全部成功再写包；失败就整包失败，**不写半个包** |
| 点了保存又取消，界面弹红字 | 把取消当成错误 | 取消返回 `{ok:false, cancelled:true}`，界面不说话 |
| 便签超过 1MB 之后打字发涩 | 每次停手重写整份 + 备份 | 插入时就拒绝并说清楚（单张 120KB / 共 1MB / 8 张） |
| 用户改了文件名，导出后没有扩展名 | 对话框里只改了主干 | `export_policy` 按内容补 `.md` / `.zip`，别信用户输的 |

## 6. 验收

| 文件 | 条数 | 钉住什么 |
| --- | --- | --- |
| `tests/note-images.html` | 49 | 压缩参数、base64 剥离与回填、`{width}` 解析与改写、导出切分、字数统计忽略图片、上限拒绝 |
| `tests/export.html` | 27 | 文件名清洗、单文件 vs zip 的判定、取消、扩展名补齐 |
| `src-tauri/src/export_policy.rs` | 14 | 同上（Rust 侧那一份），zip 头字节与 EOCD |

**手工验一次**：

1. 贴一张 300KB 截图 → 卡片里出现图 → 关掉重开还在（`widget-data/lattice.note.json` 里是 `data:image/webp`）
2. 预览里点两下宽度 → 50% → 重开还是 50%
3. 导出 → 保存对话框 → 得到一个 zip → 解压后有 `note.md` 和 `images/1.webp`，用 VS Code 预览能看到图、宽度是对的
4. 在保存对话框里点取消 → 界面一句话都不说
5. 贴到第 9 张 → 拒绝并说清楚上限；此时文件大小不超过 1.1MB
6. 断网状态下整条链路照常（不依赖任何网络）
