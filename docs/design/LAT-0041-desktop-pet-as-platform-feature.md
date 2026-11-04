---
status: draft
date: 2026-10-29
supersedes:
code: src-tauri/src/{pet.rs,pet_policy.rs,presence.rs}, src/petMain.tsx, src/runtime/pet/*, src/platform/PetSection.tsx
---

# LAT-0041 —— 桌宠升成平台功能（agent 的形象），形象是数据

## 1. 问题

`lattice.pet` 已经是这个仓库里最完整的一个组件：Canvas2D 骨骼（25 部件 / 11 组弹簧 / 11 种表情）、
自己散步、拖着走、点开气泡说话、还能通过 `assistant.ask` 真的挪动别的组件。但它现在的身份是**一个组件**，
这带来三件绕不开的事：

1. **它不在，agent 就没有脸。** 组件是用户摆上去的东西，可以摆也可以不摆。而"agent 长什么样"
   不该取决于用户有没有把某个组件拖到桌面上。
2. **它只能活在沙箱里。** 组件拿不到 `assistant_window.rs` 那个窗口的标题栏，所以界面里那个位置
   到现在还是 6×6 的一个色点；消息列表左边还是首字母圆形 `Avatar.tsx`。**同一个形象贯穿不了界面**，
   因为跨 iframe 的墙是设计出来的，不该为了它开洞。
3. **它的能力边界由清单决定。** "点它开小窗"这种平台级动作，写成组件的 `desktop:control` 权限是错的
   ——那不是组件该有的权力，而是平台自己的窗饰。

同时它有一个**硬阻塞**，和上面三条无关但排在它们前面：

### 1.1 那 84 张鲸鱼贴图现在在公开仓库和安装包里

`docs/PET_REFERENCE.md` 第 10 行与第 130 行写着「贴图不进仓库」「要发布就换成原创形象」。实测：

| 事实 | 证据 |
| --- | --- |
| 93 个文件在 git 里，其中 84 张 PNG | `git ls-files public/widgets/lattice.pet` |
| `.gitignore` 里没有任何 pet/whale 规则 | 只有 `public/store/` |
| 已进构建产物 | `dist/widgets/lattice.pet/whale/tex/*.png` 存在 |
| 随安装包和 Release 发出去 | `public/` → `dist/` → bundle |
| 远端是公开 MIT 仓库 | `github.com/unraveltao/Lattice`，匿名 API 200 |

授权状况：角色原设「溟月」、二创 ZipZipPipe、围裙上 **7 家公司商标**；Coopanion 的 AGPL 只覆盖代码，
贴图那部分明确写着「想在别处使用请自行确认权利」。**把宠物升成平台功能 = 把它装进安装包 = 更明确的再分发。**
所以这份设计的第 0 条不是架构，是**把贴图从仓库里拿出去**。

## 2. 候选

### 2.1 它归谁

| | A：平台写死一只 | B：渲染器归平台、形象是数据 | C：仍是组件 + 一条契约 |
| --- | --- | --- | --- |
| 换形象 | 要发版 | 换一个文件夹 | 换一个组件 |
| 常驻/置顶/不抢焦点 | 平台说了算 | 平台说了算 | 受 placement 管 |
| 界面里的头像 | 能 | 能 | **不能**（跨 iframe） |
| "藏起来"的语义 | 一个开关 | 一个开关 | 改组件 config，等于"隐藏一个组件" |
| 用户能不能加一只 | 不能 | 能（丢个文件夹） | 能（但要写代码、要权限、要签名） |

**选 B。** A 让截图里那个形象选择页失去意义；C 看着最省事，但它把"宠物在不在"变成 placement 的一个属性
——而 placement 是用户摆组件的地方，那不是「藏起宠物」该有的语义。B 的关键好处是**它不跑代码**：
不用沙箱、不用权限、不用签名、不用商店，于是"加一只形象"的成本和"换一张壁纸"是一个量级。

不违反INV-1（零内置）：那条说的是**平台不含任何组件**。平台自带窗口在这个仓库早有先例
（assistant 小窗、听写浮钮、对齐参考线），宠物是第四个。

### 2.2 状态由谁来说

| | A：宠物自己听 delta 猜 | B：平台存一份 presence | C：面板直接告诉宠物窗 |
| --- | --- | --- | --- |
| 看得到「等你批」 | **不能**（审批是前端 state） | 能 | 能 |
| 一次两轮在跑 | 分不清（delta 带 requestId） | 由报告方声明 | 分得清但两份状态 |
| 界面头像和桌宠 | 各猜一次 | 同一份 | 两份 |

**选 B。** 决定性事实：`AssistantPanel.tsx:395` 的 `approval` 是前端 state，agent 循环跑在
`src/platform/assistant.ts`——**审批那一步根本不在 Rust 里**。只听 `lattice:llm-delta` 永远看不到
「等你批」，而那恰恰是最该亮的姿态。而 `emit` 是广播（INV-9），所以一份 presence 天然能同时
喂桌面那只和界面里的头像，不用维护两套。

### 2.3 姿态用什么词

| | A：直接用 11 个表情名 | B：平台定 6 种姿态 | C：只给 3 种 |
| --- | --- | --- | --- |
| 换一只形象 | 它未必有 `shy` | 皮肤自己映射 | 皮肤自己映射 |
| 「等你批」 | 有 | 有 | **没有** |

**选 B**：`idle` / `working` / `waiting` / `done` / `error` / `asleep`。
A 把某一只宠物的美术细节焊成平台契约；C 丢掉 `waiting`，那这个功能就只剩装饰。

## 3. 决定

1. **窗口、渲染、状态、层级归平台**；**是哪一只归数据**。
2. **皮肤不跑代码。** 皮肤里只有 `pet.json` + 渲染器自己的数据 + 贴图。
3. **皮肤能"挑"动作，不能"造"动作。** `pet.json` 的 `actions` 是一张手势→动作 id 的表，
   动作 id 是平台的白名单。
4. **轮廓由平台在加载时算**，不再需要构建期的 `build-masks.py`（见 §5）。
5. **姿态由平台定义、由在场的一方报告**（`presence_report`），广播成 `lattice:presence`。
6. **宠物窗出生即 Top**（`runner.rs:561-569`：事后调 `set_always_on_top` 对无边框透明窗口
   返回成功但 `WS_EX_TOPMOST` 永远不出现）。
7. **84 张贴图从 git 移出**，商店下架 `lattice.pet`，组件保留为"只有你自己装"的本地组件。

## 4. 接口与数据

### 4.1 目录

```
pets/<id>/                 ← 用户目录，和 widgets/ 平级；随平台发布的放 resources/pets/
  pet.json                 ← 描述符，唯一必需的文件
  model.json               ← 渲染器自己的数据（pet.json 的 data 指向它）
  tex/*.png  feat/*.png …  ← 贴图，路径由渲染器数据决定，平台不解释
  portrait.png             ← 界面里的静态头像（可选）
```

**平台不认识 `pets/` 里除了 `pet.json` 之外的任何文件名。** 这条是"换素材"能成立的前提：
渲染器数据里的路径怎么写、贴图怎么切、有没有服装子目录，都是渲染器的事。

### 4.2 `pet.json`

```json
{
  "format": 1,
  "id": "whale",
  "name": { "zh": "大肥鱼", "en": "Whale" },
  "render": "rig",
  "data": "model.json",
  "size": { "w": 420, "h": 340, "minW": 340, "minH": 280 },
  "postures": {
    "idle": "neutral", "working": "unhappy", "waiting": "surprised",
    "done": "happy", "error": "angry", "asleep": "sleep"
  },
  "actions": { "click": "open-assistant", "doubleClick": "toggle-sleep", "drag": "move-window" },
  "portrait": "portrait.png"
}
```

- `format` 是**平台**的格式版本，不是皮肤的。见 §5.4。
- `render` 是渲染器 id，平台按名字选实现；不认识的**拒绝并说清楚支持哪些**。
- `data` 是渲染器数据文件的相对路径，必须落在皮肤目录内（不许 `..`、不许绝对路径、不许盘符）。
- `size` 越界**夹取，不拒绝**（用户的窗口比皮肤的假设更重要）。
- `postures` 缺哪个就退回 `idle`；写了平台不认识的表情名不报错（平台不知道皮肤有哪些表情，
  只有渲染器知道），渲染器自己退回 `idle` 并记一条日志。
- `actions` 里写了平台不认识的动作 id → **忽略那一条**，不拒绝整个皮肤（皮肤可能比平台新）。

### 4.3 动作白名单（平台定义，皮肤只能挑）

| 动作 id | 手势触发后发生什么 |
| --- | --- |
| `open-assistant` | 开/关 assistant 小窗（`assistant_window_toggle`） |
| `toggle-sleep` | 睡 ⇄ 醒。**睡着不是锁**：agent 一开始干活它就醒（见 §4.4 规则 3） |
| `move-window` | 按住拖动整个窗口（位移用 `movementX/Y`，见 PITFALLS） |
| `roam` | 自己散步（撞工作区边缘转身） |
| `bubble` | 冒一句话，内容来自 presence 的 `detail`，**没有 detail 就不冒** |
| `none` | 什么都不做（用来关掉某个手势） |

### 4.4 姿态与事件

```rust
pub enum Posture { Idle, Working, Waiting, Done, Error, Asleep }
```

三条规则，别的都在它们之下（`presence_policy.rs` 里逐条有测试）：

1. **同值重复报告不重置计时。** 流式出字时每 20ms 报一次 `working`，`since` 要是跟着动，
   任何"这个姿态持续了多久"的判断都失效。
2. **`done` / `error` 是瞬时的**，报完 `TRANSIENT_MS`（4 秒）回落到 `idle`。回落**只在平台做**
   —— 让每个报告方自己记定时器，就是 N 个定时器抢同一个字段。
3. **睡着不是锁。** 一开始写的是"睡着时 `working` 不叫醒它，只记着"，那是错的：那要再存一个
   `pending`，而 `pending` 醒来时还得判过期 —— 一个两字段的状态机，为一个几乎不会发生的场景。
   **真正"我不想看见它"的开关是隐藏（§4.7 的 `hidden`），不是睡觉。** 睡觉是装饰性的。

- 命令 `presence_report(posture, detail?)` —— **谁拥有这一轮谁说**：assistant 面板在开轮/收到
  工具调用/等审批/出错/收尾时各报一次；宠物窗自己报 `asleep`。
- 命令 `presence_get()` —— 后建的窗口（宠物窗重启、小窗刚打开）拿当前值，不用等下一次变化。
- 事件 `lattice:presence` → `{ "posture": "working", "detail": null }`，广播。

#### 4.4.1 表情层不是"以后再做"的那一半

原计划把"姿态 → 表情"和动画一起推到下一片。落地时撞到一件事：`tex/face.png` 是
**一张没有五官的脸**（只有皮肤和眼窝）。眼睛是 `feat/eyeL_ball` + `eyeL_iris` +
`feat/eyeL_lash` 三层合出来的（虹膜要 `source-atop` 才不越出眼框，眼睑要
`destination-out` 才擦得干净），嘴是 `feat/*_mouth` 一张贴图。少了这一层，
她站在桌面上是一个没有脸的团 —— 那不叫"先做静态版"，那叫"看不出她是谁"。

所以表情层必须和第一帧一起落地。判据：**静止姿态也要是一张认得出的脸。**
代价是一个 `faceFx` 部件（`z = 9`：压过 `eye_creases` 8.5 和 `brows` 8.6，
必须被刘海 13 盖住）加一次离屏合成；收益是"姿态 → 表情"**不用等动画** ——
它是查表，不是插值。

顺带一条：`pet-rig.js` 里 `U(x) = 128 + (x − X0)·S`、`V(y) = 256 − (FEET − y)·S`
那两个 `128` / `256` 不是魔数，**就是 `pivots.body`**。`masterToModel` 从数据里取，
皮肤换一张不同画布的原画也不用改代码。

### 4.5 窗口

`pet.rs` 建窗参数照抄 `runner.rs:540-586` 那一组（区域窗的三条硬要求都在那儿写着）：
`decorations(false)` / `shadow(false)` / `skip_taskbar(true)` / `focused(false)` /
`transparent(true)` / **`always_on_top(true)` 在 `build()` 之前**；再补一条 `WS_EX_NOACTIVATE`（点了不抢焦点）。
label 固定 `pet`，不走 runner、不查桥权限、不进 placement。

**顺序是 `show()` 再 `apply_to()`**：`ShowWindow` 会把窗口提到最前，反过来的话刚压到顶层的
窗口又被顶下去（`runner.rs:642` 同一个理由）。`apply_to` 之后贴空区域（渲染器上报之前她"不存在"），
收尾再 `set_always_on_top(true)` 确认一次 —— `runner.rs:678` 那条注释说少了这一步
"桌宠偶尔建出来是被浏览器压着的普通窗口"。

**皮肤资源走第二个协议 `lattice-pet://`**（根是 `app_data_dir/pets/`），不复用
`lattice-widget://`（根是 `widgets/`）：两者是**两套文件约定**（`manifest.json` vs `pet.json`），
混在一个根里之后"这个目录是组件还是皮肤"要靠试，而不是靠位置。处理逻辑是同一份
（`protocol.rs::serve`），差别只有根目录和"要不要往 HTML 里塞错误上报脚本"——皮肤里没有 HTML。

> 一条容易漏的前提：离屏画布读像素会被**跨域污染**，而贴图来自另一个 scheme。
> 所以 `<img crossOrigin="anonymous">` 和响应头的 `Access-Control-Allow-Origin: *`
> **缺一不可**（后者 `protocol.rs` 本来就回）。少任何一半，`getImageData` 抛 SecurityError，
> 症状是"宠物画出来了但点不到"（区域是空的）。

### 4.5.1 小窗挡住她的时候：让开，不改层级

宠物**必须**出生即 Top（否则被浏览器压住、点不到），而 assistant 小窗是故意不置顶的普通窗口
——所以她会压在聊天框上。层级是出生属性（§4.5 那条注释），改不了，于是**改位置**：

- `pet_policy::avoid(pet, window, work)` 试"贴着小窗的右 / 左 / 下 / 上"四个位置，
  各过一遍 `clamp_position`，取**挪得最少**的那个；四个都放不下（小窗铺满工作区）就原地不动。
- 由 `assistant_window` 的 `toggle` / `hide` 调 `pet::avoid_assistant`。
- **挪动不写盘**：让位是临时的，`pet-state.json` 里那个位置才是用户选的家。写进去的话，
  聊天窗开一次关一次，她的"家"就被改成被挤到角落的那个坐标了。

### 4.6 界面里的静态头像

`portrait.png` 可选。缺了就在宠物窗加载完成后把当前姿态渲染一帧、`toDataURL` 存进
`pet-cache/<id>-<posture>.png`（一次，之后走缓存）。**不做构建期生成**——那会让"换素材"多一步。

`Avatar.tsx` 加一条：有形象就用 `portrait.png`，没有就退回现在的首字母圆。
用在 assistant 小窗标题栏（替掉那个 6×6 色点）、消息列表左侧、设置页。

### 4.7 两个 `pet.json` 不是一回事（命名先钉住）

| 文件 | 在哪 | 谁的 | 里面是什么 |
| --- | --- | --- | --- |
| `pets/<id>/pet.json` | 皮肤目录里 | **皮肤的**（作者写） | 格式版本、渲染器、姿态映射、动作表 |
| `pet-state.json` | 应用数据目录 | **平台的**（用户改） | 选了哪只、藏没藏、窗口位置、缩放 |

第二个叫 `pet-state.json` 而不是 `pet.json`，就是为了在代码 review 里一眼能分开
——`assistant-window.json` 已经是这个命名法（状态带 `-state` 后缀或者用模块名，
皮肤描述符用名字）。混起来之后的症状是"换了个形象，我的窗口位置没了"。

```json
{ "version": 1, "skinId": "whale", "hidden": false, "rect": [x, y, w, h], "scale": 0.55 }
```

`hidden` 是**唯一**一个"我不想看见它"的开关，托盘菜单和设置页写的是同一个字段。

## 5. 换素材的三档（这份设计最该被保住的东西）

用户明说"后续我可能会换"。所以格式的目标不是"支持鲸鱼"，是**"平台不知道它是鲸鱼"**。

### 5.1 三档

| 档 | 换什么 | 要动什么 | 要重新构建吗 |
| --- | --- | --- | --- |
| 一 | 同一套 rig，重画贴图（换配色、换衣服、同一角色新表情） | 换 PNG | **不用** |
| 二 | 换结构：不同部件数、不同表情名、不同服装、不同尺寸 | 换 `pet.json` + `model.json` + 贴图 | **不用** |
| 三 | 换画法：不是网格变形（精灵图逐帧、SVG、骨骼动画） | 加一个渲染器 id + 平台发版 | 要 |

前两档是"换素材"，第三档是"换技术"。**把第三档的成本压到"加一个渲染器"而不是"改格式"**，
就是这份设计能给的兼容性上限。

### 5.2 为了让第一、二档真的"不用构建"，两件事必须做对

**(a) 轮廓在加载时算，不要构建期产物。** 现在 `art/rig-data.js` 是 `build-masks.py` 生成的，
里面有 `MARGIN=6 / GRID=6 / ALPHA=8 / SCALE=2` 算出来的三套并集轮廓。这意味着换一张贴图
就要跑一次 Python —— 那不是"换素材"，那是"改构建"。改成加载时算：把每个部件按静止姿态
画进离屏 canvas，扫 alpha，按 `GRID` 网格标脏块。25 个部件实测在几毫秒到几十毫秒量级，
一次性的，换来的是**皮肤目录里没有任何构建产物**。

**(b) 平台不解释贴图路径。** `model.json` 里 `tex` 是逻辑名、`src` 是相对路径（服装部件就用 `src`），
这个约定属于渲染器。平台只做一件事：**校验每条路径都落在皮肤目录内**，别的一概不看。

### 5.3 加字段是兼容的，改语义不是

- 平台**忽略**不认识的字段（前向兼容：皮肤可以比平台新）。
- 平台**不认识的动作 id** → 忽略那一条。
- 平台**不认识的渲染器** → 拒绝整个皮肤，原因码 `unknown_renderer`，并列出支持的渲染器。
  这条不能"尽力而为"：拿错渲染器画出来的是一堆错位的图，比明确拒绝糟得多。
- 平台**不认识的姿态**（`postures` 里写了 `sleepy` 这种）→ 忽略那个键。

### 5.4 版本闸只拦一个方向

`format` 比平台新 → 拒绝（`format_too_new`），并说清楚平台支持到几。
`format` 比平台旧 → 走迁移（现在只有 1，没有迁移代码，但闸的位置留着）。

只拦一个方向，和 `checkSdk` 那条同一个道理：**要的比平台新 = 装错了，必须拦；要的比平台旧 = 不保证能用，
但把桌面上已摆着的东西变成一排错误卡片，代价比它可能出的错还大。**

## 6. 失败模式

| 症状 | 原因 | 现在怎么报 |
| --- | --- | --- |
| 桌面上什么都没有 | 没有可用的皮肤 | 设置页形象页显示"还没有形象"，不是空白 |
| 一只白框 | 区域窗没 `transparent(true)` | 建窗时就是 true，不存在这个状态 |
| 点不到她 / 沉在浏览器下面 | 事后置顶（静默失效） | 出生即 Top；另有一条真机验收 |
| 宠物窗一重启就变回 idle | 没有 `presence_get` | 后建窗口先读当前值 |
| 换了一张贴图，轮廓还是旧的 | 轮廓被缓存了 | 轮廓随皮肤加载算，跟着文件 mtime 失效 |
| 换了一只形象，位置/大小乱跳 | `size` 被当成硬约束 | 越界夹取，用户的窗口优先 |
| 皮肤里的路径指到皮肤外 | 没校验 | `pet_policy` 拒绝，原因码 `path_escapes_skin` |

## 7. 验收

1. `rustc --test src-tauri/src/pet_policy.rs` 全绿，覆盖：版本闸两个方向、未知渲染器拒绝、
   路径逃逸拒绝、缺 `postures` 退回 idle、未知动作忽略、尺寸夹取。
2. 真机：宠物窗透明无白框、压在最上面、点击不抢焦点、拖得动、走得动。
3. 真机：assistant 跑一轮 → 桌面那只从 `idle` 变 `working`；弹审批 → 变 `waiting`；收尾 → `done` 再回 `idle`。
4. 换素材演练（**这条是这份设计的核心验收**）：把 `pets/whale/` 复制成 `pets/test/`，
   改 `pet.json` 的 `id`/`name`、换两张 PNG，重启后能选中并正常显示 —— **全程不碰任何构建脚本、不改一行代码**。
5. `git ls-files public/widgets/lattice.pet | grep -c png` = 0。

## 8. P0.4 架构审查补充（2026-11-05）

本节标注源码现状与待决边界，不改变 front matter 中的 `status: draft`，也不批准 LAT-0041。当前架构细节见[桌宠架构参考](../reference/desktop-pet-architecture.md)。

| 事项 | 状态 |
| --- | --- |
| 桌宠为平台原生窗口，不是普通 Widget | 当前实现已确认。 |
| Quick Chat 复用 AssistantPanel；Agent 任务和 Approval 复用现有 Runtime 与授权判据 | 当前实现已确认。 |
| Pet 姿态来自唯一 Presence 服务 | 当前实现已确认，桌宠呈现 Presence 快照 / 事件。 |
| Skin 资源不执行第三方代码 | 已确认的设计边界。 |
| Quick Chat 围绕 Pet 定位且不移动 Pet | 已批准方向；运行时使用当前显示器信息，不持久化 `Monitor.name`。 |
| Agent 六状态任务模型 | 未来概念方案；P0.4 不建设持久化任务系统，授权拒绝不等于 Task Cancelled。 |
| Character / Skin / Voice / Personality 独立配置 | 目标架构已批准；PetState v2 与迁移仅属未来方案，不纳入 P0.4。 |
| Dictation 与 TTS | Dictation 已实现；TTS 是独立待决能力，不属于 P0.4 已实现或基础依赖。 |
