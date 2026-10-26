# 组件规范

写给要开发棂组件的人。看完这一页你就能写出一个能跑的组件。

**怎么读**：第一次写，从第 1 节顺读，第 7 节有完整示例；只想查字段，直接跳第 2 节；要发布，看第 9 节。

| | |
| --- | --- |
| [1. 组件包结构](#1-组件包结构) | 一个目录、两个文件、没有构建步骤 |
| [2. manifest.json](#2-manifestjson) | 清单的全部字段，含尺寸、配置项、双语文案 |
| [3. 权限](#3-权限) | 12 项能力各自意味着什么，以及什么时候该拒绝 |
| [4. 桥 API](#4-桥-api) | 23 个方法、参数、错误码 |
| [5. 沙箱限制](#5-沙箱限制) | 为什么有些最普通的写法在这里不成立 |
| [6. 排版](#6-排版) | 卡片里能用的单位、字号、留白 |
| [7. 最小示例](#7-最小示例) | 从零到能跑，一个完整组件 |
| [8. 调试](#8-调试) | `Ctrl+Shift+D`、自检页、常见静默失败 |
| [9. 发布、版本与签名](#9-发布版本与签名) | 打包、签名、提交到目录 |

## 1. 组件包结构

一个组件就是一个目录，最少两个文件：

```
my-widget/
  manifest.json     必需，清单
  index.html        必需（文件名由 manifest.entry 指定）
  icon.svg          可选，组件图标（manifest.icon 指过来，见 §2.1）
  ...               其余文件随意：js / css / 图片
```

不需要构建、不需要打包工具。

**怎么让它出现在平台里**，两条路：

| 场景 | 做法 | 文件去哪儿 |
| --- | --- | --- |
| 你改的是随应用分发的内置组件 | 目录放进 `public/widgets/`，执行 `npm run widgets:index` | 跟着前端资源打包 |
| 你写的是第三方组件 | 把**目录**从资源管理器拖进棂的窗口 | 复制到 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\` |
| 你要把组件发给别人 | `npm run pack:widget -- <目录>`，把产出的 `.lattice` 拖进窗口 | 解开到同一个地方 |
| 你要发到商店 | `npm run store:index`（打包 + 签名 + 写目录），把 `public/store/` 整个传到一个静态地址 | 用户在设置里填目录地址，见 §9 |

拖进来之后平台会自己扫描、安装、出现在「已安装」里，点一下就放到画布上。安装时会校验 `id`（只允许小写字母、数字、`.`、`-`），不合法的包会被拒绝并在组件库顶部提示原因。

**`.lattice` 是什么。** 就是一个 zip，里面是组件目录的内容（`manifest.json` 在根上，不是套一层目录）。它存在的理由是"发一个目录给别人"很别扭：微信、邮件、网盘都会把目录压成 zip 或者干脆不认，而 zip 又容易被套一层 `my-widget/my-widget/`。`.lattice` 定死布局，装的时候还能先校验再落盘。

```bash
npm run pack:widget -- examples/counter          # 产出 dist-packs/counter.lattice
npm run pack:widget -- examples/counter --out out/  # 指定目录
```

打包是**确定性**的：同样的输入两次打包字节完全一样（文件按名字排序、时间戳固定成 1980-01-01）。所以"你手上这个包是不是我发出去的那个"这个问题是可以回答的 —— 商店的签名校验正是建立在这个前提上（见 §9）。

装包时的三道闸：路径不许 `..` / 绝对路径 / 盘符（防 zip-slip）、单个文件 ≤ 8MB 且总量 ≤ 64MB、条目数 ≤ 500。任何一条不过就整包拒绝，不做"部分安装"。

内置组件和用户组件的加载协议不一样，但对你透明 —— 你只管在 HTML 里写**相对路径**：

```html
<link rel="stylesheet" href="style.css" />   <!-- ✅ -->
<script src="js/app.js"></script>            <!-- ✅ -->
<img src="/assets/logo.png" />               <!-- ❌ 绝对路径会被当成别的组件的文件 -->
```

用户组件由自定义协议 `lattice-widget://` 提供，地址形如 `<协议>/<id>/<相对路径>`，第一段永远是组件自己的 id。任何试图跳出自己目录的路径（`..`、盘符）都会 404。

## 2. manifest.json

```json
{
  "id": "lattice.clock",
  "name": "时钟",
  "version": "0.1.0",
  "description": "大字号时钟，显示日期与时区",
  "author": "Lattice",
  "entry": "index.html",
  "size": { "w": 240, "h": 140, "minW": 160, "minH": 110 },
  "layer": "desktop",
  "permissions": ["clock", "storage"],
  "interactive": true,
  "sdk": "^0.1"
}
```

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | — | 反向域名风格，全局唯一。只允许小写字母、数字、`.`、`-` |
| `name` | 否 | 目录名 | 显示名 |
| `version` | 是 | — | 语义化版本，**必须三段**（`1.2` 会被拒）。商店按它判更新，见 §9.1 |
| `description` | 否 | `""` | 一句话说明，显示在组件库 |
| `author` | 否 | `未知作者` | |
| `entry` | 否 | `index.html` | 相对组件目录的入口 |
| `icon` | 否 | `""` | 相对组件目录的图标（SVG 优先）。不写就退回"名字首字"，见 §2.1 |
| `size` | 否 | `240×140` | `w/h` 初始尺寸，`minW/minH` 缩放下限 |
| `layer` | 否 | `desktop` | `desktop` 贴桌面 / `top` 置顶 |
| `permissions` | 否 | `[]` | 申请的平台权限，见下表 |
| `network` | 否 | `{ "hosts": [] }` | 联网白名单，只有授予 `network` 时才起作用，见 §3.2 |
| `interactive` | 否 | `true` | 要不要键盘输入。纯展示的组件设 `false`，见下 |
| `shape` | 否 | `rect` | `rect` = 平台圆角卡片；`region` = 轮廓由组件上报（桌宠、挂件），见 §2.5 |
| `appearance` | 否 | `{ "tint": "auto", "alpha": 1, "blur": 0 }` | 底板外观的出厂值，见 §2.2 |
| `config` | 否 | `[]` | 可配置项，平台据此渲染属性面板表单，见 §2.3 |
| `help` / `changelog` | 否 | — | 怎么用、改了什么，见 §2.4 |
| `agent` | 否 | `{ "tools": [] }` | 组件声明成工具的能力（要 `agent:tools` 权限），见 §3.6 |
| `sdk` | 否 | `^0.1` | 依赖的 SDK 版本区间 |

清单不合法时组件不会消失，而是出现在组件库底部的「加载失败的组件」里并给出原因 —— 便于排错。

### `interactive`：能不能打字

贴在桌面上的窗口默认带 `WS_EX_NOACTIVATE`，还会被挂到 WorkerW 下面变成桌面的子窗口 —— 这两件事叠起来，点进去键盘事件根本进不来，笔记、待办就只能看不能写。

所以清单里 `interactive`（默认 `true`）决定走哪条路：

* `true`（默认）：不挂 WorkerW，留在顶层窗口层但压到 `HWND_BOTTOM`，并且去掉 `WS_EX_NOACTIVATE`。点一下能拿到焦点、能打字；同时挂一个"底层守卫"，点它不会窜到别的窗口前面，也不会在失焦时掉回底层 —— 换句话说，它既写得进字，又一直老老实实待在桌面层。
* `false`：挂 WorkerW、保持 `WS_EX_NOACTIVATE`，是真正的"桌面背景"，最省事也最不打扰。

**纯展示的组件（时钟、倒计时、天气）建议显式写 `false`**：少一次激活，也就不会在点桌面的时候抢焦点。

### 2.5 `shape: "region"`：不是一张卡片的组件

时钟、便签、待办都是**卡片**：底板、圆角、右上角那排窗饰都由平台画。但桌宠、
悬浮挂件不是卡片 —— 它只有"身体那几块像素"存在，其余位置应该像桌面本身一样。

清单里写 `"shape": "region"`，窗口就不再是矩形：

```json
"shape": "region",
"layer": "top",
"interactive": true
```

三件事同时发生：

| 变化 | 含义 |
| --- | --- |
| 平台不裁圆角、不画底板、不画窗饰 | 一块被裁成宠物形状的窗口没有"卡片"可画 |
| 可见性由 `window.setRegion` 决定 | 没上报之前窗口是**空的**（不是一块色块） |
| 点击命中跟着区域走 | 区域外点下去，点到的是桌面或后面的窗口 |

**画出来的形状必须等于上报的区域。** 这是这条路上唯一一条硬规矩，因为：

- 画得比区域大 → 看得见的那一块点不到（"透明但能点"的反面：看得见、点不到）
- 画得比区域小 → 没画的地方仍然会挡住桌面上的点击

图片类组件（桌宠、悬浮挂件）的做法可以参考：轮廓在**构建期**从图片 alpha 算好、存成
一张横条表（形如 `art/masks.json`），画图的位置和上报的坐标读同一张表，两边不会对不上。
（运行期读 alpha 是不行的 —— 沙箱 iframe 是不透明源，`getImageData` 直接抛。）

**美术约束（很重要）：**

- **硬边缘**。区域外的像素不存在，投影、外发光、半透明羽化都会被切掉，边缘看着像刀切的。
- **轮廓即包围盒**。别在身体四周留大片透明留白 —— 留白就是"能收到点击但看不见"的死区。
- **动作用整体位移，不用形变**。拉伸 / 旋转会让区域和画面错位。走路 = 平移；眨眼这类不改变轮廓的动作随便做。
- **窗口背景必须是透明的**，而且区域内能被看到的每一个像素都得是"画出来的"。

**上报。** 坐标是**物理像素**、相对客户区左上角（和圆角裁剪同一个口径），
所以要乘 `devicePixelRatio`：

```js
await call("window.setRegion", {
  parts: [
    { kind: "ellipse", x: 22, y: 14, w: 114, h: 92 },   // 头
    { kind: "rect", x: 120, y: 108, w: 32, h: 13 },     // 尾巴
  ],
});
```

- `kind` 只有 `rect` / `ellipse` 两种；`w` / `h` 是宽高，不是右下角坐标
- 最多 **256 块**（一块宠物十来块够了；几千块说明算错了，Rust 会拒）
- 返回 `{ ok: true, applied: true }`；画布预览里是 `applied: false` —— 那里没有窗口，别继续报
- 窗口尺寸变了（`resize`）要**重新上报**：平台不会替组件重算轮廓
- 一块都不报（或报空数组）= 窗口什么都不是（空的），所以第一帧之前别清空它

代价要说清楚：**区域边缘没有抗锯齿**（系统裁剪不做羽化），而且一旦开始上报，
右上角的 ✕ 就不存在了 —— 组件得自己给退出口（桌宠用的是右键 → `window.close`）。

### 2.6 `window.moveBy`：让组件自己走两步

`shape: "region"` 的窗口没有窗饰，也就没有可以按住的标题栏。一个会动的组件
（桌宠走来走去、被自己身上的指针拖着走）必须能**自己挪自己**：

```js
// 拖动：按下的那一刻抓住指针，之后每一次移动只报「这次动了多少」
pet.addEventListener("pointerdown", (event) => {
  pet.setPointerCapture(event.pointerId);   // 指针出了窗口也还能收到 move
  let last = [event.screenX, event.screenY];
  pet.addEventListener("pointermove", (move) => {
    const dx = move.screenX - last[0];
    const dy = move.screenY - last[1];
    last = [move.screenX, move.screenY];
    void call("window.moveBy", { dx, dy });
  });
});

// 散步：每帧走一点点。0.5px 这种位移不会被吃掉（平台替你攒零头）
void call("window.moveBy", { dx: speed * dt, dy: 0 });
```

几条规矩：

- **`dx` / `dy` 是组件文档的 CSS 像素**，和 `pointermove` 的位移同一个口径。
  别自己乘 `devicePixelRatio` —— 跨屏时那个值和窗口的 scaleFactor 不是一回事。
  （注意和 `window.setRegion` 的区别：那边吃的是画布坐标，要乘；这边吃的是
  JS 算出来的位移，不乘。）
- **用 `screenX/screenY` 或 `movementX/movementY` 算位移，不要用 `clientX`**：
  窗口会跟着指针一起动，`clientX` 于是几乎不变 —— 拿它算位移，宠物在你手里
  会立刻停住。
- **平台负责夹紧**。撞到工作区边缘就停在那儿，回执里的 `x` / `y` 是**真实落点**
  （物理像素），组件据此把"走到头了"画成转身，而不是继续空走。
- **位置会落盘，但不是每帧**。停下来约 1 秒（一直在走则每 3 秒）平台把当前位置
  写回 `desktopRects`，所以下次启动还在那儿。这条也是"组件挪窗口"和"用户摆布局"
  不打架的原因：placement 仍然是用户的，组件只是临时挪了一下。
- **画布预览里是 `applied: false`**（那里没有窗口），组件据此停掉走动和拖动。
  不要把它当错误，也不用 catch。
- **心跳不可见时是停的**（不变量 10），走动自然跟着停 —— 这正是想要的：
  桌宠不该在窗口被藏起来的时候还在消耗 CPU 走路。

动作用**整体位移**，不要用窗口内部的大小变化去模拟（同 §2.5 的美术约束）。

### 2.7 中英文：作者写的字由作者挑

平台界面可以在设置里切成中文或英文。**组件里那些字是作者写的，平台不翻** ——
它不知道 `"偶尔走两步"` 对应哪句英文。所以给作者留了一个双语写法：

```json
{
  "name": { "zh": "大肥鱼", "en": "Big Fishy" },
  "description": { "zh": "一条会冒泡的桌宠", "en": "A desktop fish that blows bubbles" },
  "config": [
    {
      "key": "wander",
      "type": "select",
      "label": { "zh": "她自己走动吗", "en": "Does she wander?" },
      "help": { "zh": "关掉就站在那儿", "en": "Turn this off and she stays put" },
      "options": [
        { "value": "still", "label": { "zh": "站着别动", "en": "Stay still" } }
      ]
    }
  ],
  "help": {
    "sections": [
      {
        "title": { "zh": "怎么玩", "en": "How to play" },
        "items": [
          { "zh": "点她一下会冒泡", "en": "Click her and she says something" }
        ]
      }
    ]
  },
  "changelog": [
    {
      "version": "0.2.0",
      "date": "2026-02-14",
      "changes": [
        { "zh": "加了中文和英文", "en": "Added Chinese and English" }
      ]
    }
  ]
}
```

**上面这两处写错是静默的。** 配置项的键叫 `type`，不叫 `kind`；`help` 是 `{ "sections": [...] }`，不是数组。写错了平台**不报错**，代价是那一项配置或整份"怎么用"直接不出现 —— 你会以为是自己没写对地方。§2.4 是同一件事的另一个例子。

**可以写成两种形状的地方**（能写的字段就这些，别自己发明）：

| 位置 | 形状 |
| --- | --- |
| `name`、`description` | `"一句话"` 或 `{ "zh": …, "en": … }` |
| `config[].label`、`.help`、`.placeholder`、`options[].label` | 同上 |
| `help.sections[].title`、`help.sections[].items[]` | 同上 |
| `changelog[].changes[]` | 同上 |

**不朽的单字符串。** 只写一个字符串 = 这门语言**和**另一门语言都显示它。
第三方组件不写英文照样能用（英文界面里看到它的中文名），老包一个都不用改。
这条和平台文案的方向一致：缺的那一份退化成**另一种语言**，而不是变成空白或者键名。

**上限按语言各算。** `help` 一条 `items[]` 160 字、`title` 40 字、`changelog.changes[]` 160 字、
`options[].label` 40 字、`placeholder` 80 字 —— 中英文各算各的，不共享额度。
`date` / `unit` 这类**只有一个值的短字段**没有双语形式（`date` 是 ISO 日期，`unit` 是 `"cm"` 这种单位符号）。

**坏的那一半逐条丢。** `{ "zh": "中文", "en": 42 }` → 英文那一份被丢掉，
这份文字按"只有中文"处理。整条都坏（两个都不是字符串）才丢这一条，
和 §2.4「坏条目逐条丢」同一条规矩。

**卡片里的字（HTML 里写的那些）平台一点都管不着** —— 那是组件自己的文档。
组件要跟着界面语言走，就自己读：`lang.get` 拿初值、`language` 推送跟着变（§4.4），
包里各留一份文案自己挑。SDK 把这两件事包成了 `lattice.language` + `lattice.on("language")`。

**官方组件全部是双语的，写法就是上面那两条**，另外加一条首帧规矩：

- **HTML 里写死中文那份**，`lang` 默认 `"zh"`，`lang.get` 回来再翻。中文界面上
  看到的直接就是最终样子；英文界面上会有一帧中文（几十毫秒），换来的是不用先画
  一遍"加载中"（§4.8 第一条）。反过来写（默认英文）只是把这一帧换个方向 ——
  中文是这个产品的主要语言，就按中文写死。
- **`lang.get` 别塞进首屏那条链**（`config.get` → `schedule.every` → `ready`）：
  问语言慢一拍不该拖住第一帧。它自己一条 `call("lang.get").then(applyLanguage)`。
- **换语言要重画，不是等下一拍**：月份 / 星期 / 上午下午 / 计数 / 按钮文字 / 已经
  画出来的提示行，`applyLanguage` 里直接调那个组件自己的重画函数。
- `tests/help.html` 会核对每个内置组件"两门齐全 + 接了 `lang.get` 与 `language`"，
  所以漏一处不是"看着有点怪"，是红的。

搜索是**两种语言都建索引**的：作者写了英文名，用户在中文界面里搜 `fish` 也能搜到。

### 2.1 `icon`：组件图标

写一个相对组件目录的路径就行（`"icon": "icon.svg"`）。平台把它显示在三处：组件库的卡片色块、画布卡片的标题条、属性面板的标题前。

**图标只当形状用。** 平台不是把 SVG 塞进 DOM（那是第三方内容，`<script>` 会跟着跑），而是拿它当 CSS 遮罩，用当前文字颜色上色。所以：

* SVG 里 `fill` / `stroke` 写什么颜色都无所谓 —— 最后都是单色
* 深色主题下自动变亮、浅色主题下自动变深，不用你准备两套
* 彩色图标会被压成剪影。30px 的色块里，单色比彩色整齐得多

画的时候按 **16×16 视框、1.4 描边、round 端点**来，跟平台自带图标一个规格：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"
     stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="8" cy="8" r="5.6" />
  <path d="M8 4.9v3.3l2.1 1.3" />
</svg>
```

不写 `icon`、或者路径写错（绝对地址、带 `..`、带引号）都**不会让组件加载失败** —— 图标是锦上添花，退回"名字首字"那块色块就是了。


### 2.2 `appearance`：底板

底板（卡片那块背景）是**平台**画的，不是组件画的 —— 跟圆角、右上角那排按钮一样。所以组件不用为它写一行代码，清单里给个出厂值，用户在属性面板里按实例调。

```json
"appearance": { "tint": "#ffffff", "alpha": 0.22, "blur": 24 }
```

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `tint` | `"auto"` 或 `#rgb` / `#rrggbb` | `auto` = 跟随明暗主题 |
| `alpha` | 0 – 1 | **底色浓度**，见下 |
| `blur` | 0 – 40 | 磨砂半径（逻辑像素），连续滑杆 |

![三种底板](screenshot-backplate.png)

**`alpha` 不是"窗口透明度"。** 桌面窗口始终是不透明的（逐像素透明要 DirectComposition，见 `src-tauri/src/desktop.rs`），它调的是"底色盖住磨砂层的比例"：

* `alpha = 1` → 纯色实心，跟没有这个功能时一模一样
* `alpha = 0` → 只剩磨砂层，看到的是**糊掉的桌面壁纸**
* `blur = 0` → 壁纸透上来但没糊

它透不出"压在这个组件后面的浏览器窗口" —— 那是系统 acrylic 才有的东西，而系统的模糊半径写死，做不成滑杆。两者只能选一个，这里选了滑杆。

**宿主怎么画。** 三层叠起来，从下往上：

```
canvas   按窗口位置从桌面截下来的一块壁纸，filter: blur(Npx)
veil     底色 rgba(tint, alpha)
iframe   组件内容
```

壁纸是 `PrintWindow(Progman)` 截的（只含壁纸和桌面图标，不含任何窗口），按窗口位置裁一块，比卡片四周各大 `2 × 40px` —— 模糊的边缘落在卡片外面，四条边才不会发黑。窗口挪动、改尺寸、拖滑杆都会重截一张。

**组件要配合的两件事：**

1. **`html, body` 必须保持透明**（`background: transparent`）。自己刷一层不透明底色，磨砂就白做了。示例组件都是这么写的。
2. **颜色走令牌，别写死。** 平台会把 `--lattice-text` / `--lattice-text-muted` / `--lattice-accent` 按"底色盖上去之后到底有多亮"翻一遍：浅底板上给深字，深底板上给浅字。写死 `#ecebe6` 的组件在浅色底板上就是白字白底。

主题字典里的 `--lattice-surface` 在开了底板之后变成**合成色**（底色盖在壁纸平均色上的结果），可以直接当"这块卡片大概是什么颜色"用。

**右上角那排按钮不吃底板的色。** 窗饰是平台界面，不是用户调的底板，所以它用一对固定的中性色（卡片浅就白、深就炭）。底板是花的时候，按壁纸平均色算出来的按钮颜色会跟它压着的那一小块壁纸对不上，看着像没对准。

归一化（非法值退回出厂、范围夹紧、`#abc` 摊成 `#aabbcc`）与合成色/亮度阈值都有断言钉着：`tests/appearance.html`。


### 2.3 `config`：每实例配置

组件要"可配置"的地方（12/24 小时制、目标日期、显示几条、字号……）**不要自己画设置 UI**，在清单里声明 schema，平台会在属性面板里渲染表单。

```json
"config": [
  { "key": "hour12", "type": "toggle", "label": "12-hour clock", "default": false },
  { "key": "showSeconds", "type": "toggle", "label": "Show seconds", "default": false },
  { "key": "target", "type": "date", "label": "Target date", "default": "" },
  { "key": "caption", "type": "text", "label": "Caption", "default": "", "maxLength": 40 },
  { "key": "size", "type": "number", "label": "Font size", "default": 13, "min": 11, "max": 24, "step": 1, "unit": "px" }
]
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `key` | 是 | 组件里读值的键名。字母开头，允许字母数字 `_` `-`，≤40 字符 |
| `type` | 是 | `toggle` / `number` / `text` / `select` / `date` 之一 |
| `label` | 否 | 控件上方那行字，默认用 `key` |
| `default` | 否 | 出厂值。类型必须对得上，否则按下面的规则退 |
| `help` | 否 | 控件下面的一句说明，默认不显示 |
| `min` / `max` / `step` / `unit` | `number` 用 | 默认 `0 / 100 / 1 / ""`；`min > max` 会自动交换 |
| `options` | `select` 用 | `["c", "f"]` 或 `[{ "value": "c", "label": "Celsius" }]` |
| `placeholder` / `maxLength` | `text` 用 | `maxLength` 默认 120，硬上限 2000 |

**值是按实例存的，不是按组件。** 桌面上摆两个时钟，一个 24 小时制、一个 12 小时制，互不影响 —— 这正是 `placement` 的粒度。这一点和权限相反（权限按 `widgetId`，因为问的是"你信不信任这段代码"）。

**读值只有一条路**：`config.get`（§4），返回的永远是**完整**对象 —— 没改过的键用 `default` 补上，所以你不用写 `?? 默认值`，也不会因为平台升级多了一个字段就拿到 `undefined`。

```js
const config = await call("config.get");   // { hour12: false, showSeconds: false, ... }
render(config);

// 用户在属性面板里改了一项：宿主推一条 config-changed（不重载组件）
if (data.type === "config-changed") {
  config = data.payload.config;
  render(config);
}
```

**别忘了处理 `config-changed`。** 只在启动时读一次的话，用户拨一下开关组件不会有任何反应 —— 而平台**不会**为了改配置重载 iframe（重载会冲掉没落盘的草稿）。这条推送和 `store-changed` 的区别：配置是用户调的参数，存储是组件自己的业务数据。

**写坏了的字段会被单独丢弃，不会让整包加载失败。** 键名不合法、类型不认识、`select` 没有可选项 —— 这些字段在属性面板里不会出现，`config.get` 也拿不到它，行为等同于"没声明"。同理，非法值（越界、类型错、日期不存在）一律退回 `default`，绝不把 `NaN` 递给组件。

**最多 12 项。** 属性面板只有 320px 宽，再多就不是"配置"了 —— 那种组件该自己画一个设置页，或者拆成两个组件。

**`date` 类型是给日期的**（`YYYY-MM-DD`，`""` 表示没设）。用它的理由不是省事：原生 `<input type="date">` 在深色卡片里会变成一块黑药丸，组件得自己按底板亮度猜 `color-scheme`（倒计时原来就写了这么一段）。属性面板在平台窗口里，`color-scheme` 跟着主题走，这件事天然是对的。

### 2.4 `help` / `changelog`：怎么用，改了什么

组件总有"特殊功能"，而属性面板只能放一行 `help` 说明（那是**配置项**的说明）。整份"怎么用"写在清单里：

```json
"help": {
  "sections": [
    {
      "title": "Priority dots",
      "items": [
        "Click the dot to cycle: High → Medium → Low → no priority.",
        "An empty circle means no priority yet."
      ]
    }
  ]
},
"changelog": [
  {
    "version": "0.2.0",
    "date": "2026-10-24",
    "changes": ["Drag a row to reorder.", "Press Esc mid-drag to drop it back."]
  },
  { "version": "0.1.0", "changes": ["First release."] }
]
```

| 字段 | 说明 |
| --- | --- |
| `help.sections[]` | 一节 = 一个小标题 + 若干条。**最多 6 节**，每节**最多 6 条** |
| `sections[].title` | 小标题，≤40 字符。没标题的整节会被丢掉 |
| `sections[].items` | 一条一句，≤160 字符。空字符串会被丢掉 |
| `changelog[]` | 面向用户的变更记录，**最多 12 条**，每条**最多 8 项** |
| `changelog[].version` | 必须是合法版本号，否则整条丢掉 |
| `changelog[].date` | 可选，`YYYY-MM-DD` |
| `changelog[].changes` | 一项一句，≤160 字符 |

**为什么在清单里，而不是包里的 `README.md`**：组件是纯静态目录，平台没有 Markdown 渲染器、也不允许运行时依赖。写在清单里就跟着包走 —— 同一个目录、同一次提交、同一个签名，离线能看、第三方组件也能用、还能被单测对账（`tests/help.html` 会真的把每个清单读出来查覆盖率）。

**它出现在两个地方，内容只有一份**：属性面板里一段可折叠的 `How to use · N`；组件库卡片右上角一颗 `?`（没写说明的组件不画这颗按钮）。变更记录收在 `What changed` 折叠层里 —— 它是"我想知道这版改了什么"才点开的东西，不该顶在最前面。

**写坏了逐条丢，不连累整包。** 和 `config` / `icon` 一样：一节没标题、一条是空串、版本号不合法 —— 丢那一节 / 那一条，组件照常加载。说明是锦上添花，不该有"让组件打不开"的权力。

**上限是故意的。** 6 × 6 × 160 字是"一张 320px 面板里读得完"的量。想写长篇，那是文档的事，不是卡片的事。

**`changelog` 是给用户的，`ROADMAP` / commit 是给开发者的。** 所以写"拖动排序"、"不再丢时间"，不写"重构 advance() 为纯函数"。改了组件行为就同时补一条 —— 用户更新完打开说明，第一眼就该看到"这一版多了什么"。


## 3. 权限

默认全拒，用户在属性面板里逐项勾选。**申请了但没被授予时，调用会返回 `permission_denied`，组件必须自己降级。**

| 权限 | 授予后可用 | 状态 |
| --- | --- | --- |
| `clock` | `clock.now` | 可用 |
| `storage` | `storage.get` / `storage.set` / `storage.remove` | 可用 |
| `clipboard:write` | `clipboard.write` | 可用 |
| `system:monitor` | `system.metrics` / `power.status` | 可用 |
| `network` | `network.fetch`（还要求清单里列了目标主机） | 可用 |
| `media:control` | `media.get` / `media.control`（系统媒体会话，见 §4.5） | 可用 |
| `audio:level` | `audio.level`（扬声器现在的响度，见 §4.6） | 可用 |
| `shell:open` | `shell.open`（用系统默认浏览器打开 http/https 链接，见 §3.3） | 可用 |
| `agent:activity` | `agent.activity`（本机 agent 做过的操作，读的是审计日志） | 可用 |
| `llm:chat` | `llm.chat`（用**用户自己配的**模型说一句话，花的是用户的额度，见 §3.4） | 可用 |
| `desktop:control` | `assistant.ask`（让平台的模型**替你动桌面**，见 §3.5） | 可用 |
| `agent:tools` | 组件清单里 `agent.tools` 声明的那几条工具可以被 agent / assistant 调用（见 §3.6） | 可用 |
| `terminal:exec` | `term.write` / `term.stop` / `term.state`（在这个卡片里跑命令，见 §4.9） | 可用 |

只申请你真正用到的。申请一堆用不上的权限，用户会直接不装。

`terminal:exec` 是**最重**的一条：它能执行任意命令、读写你的文件、花你的时间。平台判断不了一条命令危不危险（`shell_policy.rs` 开头写过为什么：`Remove-Item` 和 `Get-ChildItem` 的差别在参数和变量里，任何黑名单都能被一行 `& $x` 绕过去），所以防线只有三处 —— 默认不授、授权那一屏把后果写成正文、商店卡片读同一句文案。**没有"只给内置组件"的例外**：第二套规则总有一天会被绕过，而绕过它不需要任何人犯错。

`llm:chat` 是唯一一条"会花钱"的权限：它不碰网络、拿不到 key，但每次调用都在消耗用户充进去的额度。所以它和其它权限一样**逐项授权、按 widgetId**，而且默认拒绝 —— 授权界面上那行字叫 "Use my AI model"，用户看得懂自己点了什么。

`desktop:control` 比 `llm:chat` 更重一层：它不但花钱，还可能**改变用户摆好的布局**。所以它是一条**独立的权限**，不是 `llm:chat` 的附加项 —— 用户装一块桌宠，不该被迫接受"它还能挪我的时钟"。授权界面上那行字叫 "Rearrange my desktop"。

`media:control` 一项权限同时管读和按。拆成"读会话"和"控制播放"两行，用户没法凭一行字分清区别，只会多点一次授权。

`audio:level` **故意没有并进 `media:control`**：读会话拿的是歌名歌手，这条线拿的是**正在播出来的声音本身**（WASAPI 回环采集）。并在一起的话，一个组件只要说"我要控制播放"，就顺带拿到了"听你电脑在放什么" —— 授权面板上那行字不该替用户做这个决定。

`network` 是**两道锁**：用户授予权限只是第一道，第二道是清单里的 `network.hosts`（§3.2）。只授权、不列主机，等于哪儿都连不上。

`agent:activity` 泄露的是**用户的操作历史**：谁在几点挪了什么、agent 说了什么。一块同时有 `network` 权限的组件拿到它就能把这份历史发出去 —— 所以默认不授，只在用户明确要看「agent 干了什么」时才给。

`schedule.*` 不需要任何权限 —— 它只影响组件自己那条时间轴，碰不到系统资源。

### 3.1 授权是活的

用户可以在任何时候撤销一项权限，**包括组件正在运行的时候**。撤销之后：

- 下一次桥调用立刻返回 `permission_denied`，不需要等组件重启；
- 桌面窗口和画布实例都会重新加载入口页，让组件按新权限重走一遍初始化。

所以组件必须做到两件事：**每次调用都处理 `permission_denied`**（别把"已授权"缓存在自己的变量里），以及**重载后能恢复到正确的状态**（数据在 `storage` 里，别只存在内存里）。

反过来说，重新授权同样会触发一次重载 —— 组件里没落盘的临时状态（比如正在输入但还没写进去的草稿）会丢。

**更新版本时多申请一项权限，用户必须重新确认。** 平台不会因为"新版本想要"就自动授予：更新完组件照旧能用，新权限那些方法返回 `permission_denied`，同时卡片上出现 `Review` 标记、主窗口底部弹一条不会自己消失的横幅，直到用户点 `Allow` 或 `×`。所以清单里**别预埋"以后可能用到"的权限**（§9.5）。

### 3.2 联网：两道锁 + 不自动跟随重定向

要联网的组件做三件事：清单里申请 `network`、清单里列 `network.hosts`、让用户授予。

```json
{
  "permissions": ["network"],
  "network": { "hosts": ["api.example.com", "localhost:8080"] }
}
```

**组件不直连。** 组件文档的 CSP 里 `connect-src` 只有它自己的协议源，`fetch("https://…")` 在浏览器层面就抛 `TypeError` —— 这不是配错了，是设计。出网只有一条路：桥上的 `network.fetch`，由 Rust 侧代发。

这条路比"在本地起一个 HTTP 代理、把 `connect-src` 指向它"更严：没有本地端口，就没有绕过去的路；白名单在 Rust 侧按**实例**校验，组件改不了自己的清单；每次请求都能留痕（设 `LATTICE_NET_TRACE=1` 会把每条请求打到 stderr）。

白名单两种写法：

| 写法 | 匹配 |
| --- | --- |
| `example.com` | 只匹配标准端口（http 80 / https 443） |
| `example.com:8080` | 只匹配这个端口 |

**不支持通配符。** `*.example.com` 的边界问题（`evil.example.com.attacker.net` 这类）靠人一遍遍想不划算，多列一行的成本几乎为零。

画布上的预览**也能联网**：那里的实例不是一个独立窗口，宿主页会把清单里的主机名单随请求一起交给 Rust，所以同一个组件在设计器和桌面上行为一致。你不需要为"预览态"写任何分支。

其余几条硬限制：

- 只允许 `http` / `https`。`file:` / `ftp:` / `javascript:` 一律拒。
- 方法限于 `GET` / `HEAD` / `POST` / `PUT` / `PATCH` / `DELETE`。
- 请求体 ≤ 256KB，响应 ≤ 1MB（超出**截断**并把 `truncated` 置 `true`，不报错）。
- 请求头最多 32 条；头名或头值里有换行会被拒（那是注入）。
- **重定向不自动跟随。** `https://good.com` 302 到别处，跟着走就等于白名单只检查了第一跳。3xx 原样返回给组件，要跟就再调一次 —— 那时会重新过一遍白名单。
- URL 里的 userinfo（`user:pass@host`）会被丢掉，不会写进日志。

写坏的条目只丢那一条，不让整包加载失败 —— 和图标同一个理由。丢掉的后果是那个主机连不上（明确的拒绝），而不是悄悄放宽。

### 3.3 打开外链：唯一一扇"往外递东西"的门

`shell.open` 把一条链接交给系统默认浏览器。它要 `shell:open`，而且**只放 `http` / `https`**。

这一条必须单独说清楚，因为它是 §3.2 那套白名单的**另一面**：

- `ShellExecuteW` 不认协议。`file:` 会把本地文件交给默认程序打开，`ms-settings:` 能直接翻到系统隐私设置页，`search-ms:` / 任何注册过的自定义协议一样照办。
- 所以"打开链接"如果不限协议，就等于给组件一条绕开白名单的路 —— `file:///C:/Users/…` 比联网更彻底。

允许的写法（和浏览器地址栏一致）：

| 写法 | 打开 |
| --- | --- |
| `https://example.com/x` | 原样 |
| `github.com` | `https://github.com/`（补协议头） |
| `example.com:8080/x` | `https://example.com:8080/x`（冒号后是端口，不是协议） |

其余一律拒，错误信息会说明"只支持 http/https"。规则只有一份实现在 `src-tauri/src/open_policy.rs`；桥那层只做形状检查（长度、非空），**别在组件里自己写一套放行规则**。

三条边界：

- **是"交给浏览器"，不是"在组件里显示网页"**。组件的 frame 仍然被 `egress.rs` 钉在自己的文档上，`shell.open` 不会改变这件事。
- **撤权后返回 `permission_denied`**，组件要说人话（"需要「打开链接」权限"），不要静默失败 —— 用户点了没反应只会当成 bug。
- **纯浏览器预览（`npm run dev`，没有 Tauri）里没有系统 shell**，这条路返回 `internal`。桌面应用里的画布实例是能打开的（走的是同一座桥）。

### 3.4 用用户的模型说话（`llm.chat`）

`llm.chat` 把几句话发给**用户自己配置的模型**，回一段文本。它要 `llm:chat`。

```js
const { text } = await lattice.llm.chat({
  messages: [
    { role: "system", content: "你是一只桌宠，回答要短。" },
    { role: "user", content: "今天适合做什么？" },
  ],
});
```

四条必须知道的：

- **拿不到 key**。key 存在本机的 `assistant.json` 里，由 Rust 读、由 Rust 发请求。组件既看不见它，也换不了 baseUrl —— 想让请求指向别处是不可能的。
- **没有工具**。这条路只给嘴不给手：请求里不会出现 `tools`，模型没法借它改桌面。真要摆组件，那是用户在 assistant 面板里说、或者外部 agent 端点（有自己的白名单）的事。万一模型还是回了工具调用，平台会返回 `internal`（一句能读懂的话），而不是给你一个空字符串。
- **有上限**：最多 60 条消息、单条 12000 字、合计 60000 字、role 只认 `system` / `user` / `assistant`。超了是**拒绝**（`bad_params` / `internal`），不是截断 —— 悄悄砍掉历史会让模型自信地答非所问。
- **会花钱**。用户没配模型时 `llm.chat` 返回 `internal`，`message` 里是"没有 key / 没有模型"这类人话；配置状态可以先问 `llm.status`（**不需要权限**，返回 `{ configured, model }`），据此决定是显示输入框还是提示去设置里填。

平台侧每次调用都会写一行审计（`assistant.chat`，只记字数 / 工具名，不记内容），节流 300ms。

### 3.5 借平台的手（`assistant.ask`）

`llm.chat` 只给嘴不给手。如果一块组件想让"模型替你摆组件"，走 `assistant.ask`。它要 `desktop:control`。

```js
const { text, actions } = await lattice.assistant.ask({
  messages: [{ role: "user", content: "把时钟挪到右上角，天气预报小一点" }],
  persona: "你是一只桌宠，说话要短，可以吐槽。",
});
// text:    模型这一轮说完的话（给你显示用）
// actions: [{ detail: "moveWidget", ok: true }, { detail: "resizeWidget", ok: false, error: "..." }]
```

**它不是"第二个 assistant"，是同一个 assistant 换了一张更小的工具表。** 平台替你跑完整个工具循环（系统提示、快照、≤6 步、执行、审计），你只拿到两样东西：一句回话，和这次真做了什么的一行行明细。你**拿不到工具调用本身**，也**不能自己决定执行什么** —— 这是有意的：能改桌面的逻辑只在主窗口里（`state.json` 是那边 store 的磁盘副本，组件这儿连 store 都没有）。

七条必须知道的：

- **工具表被砍过**。组件这条路上没有 `placement.remove` —— 用户可以自己按 ✕，但"让桌宠替我删组件"不行。一次误会的对话删掉一块便签，比"删不掉"难受得多。系统提示里会多一行告诉模型"这一轮你没有删除工具"，它自己会说"这个得你来点 ✕"。
- **`system` 位置只能当人设**。你可以把 `{ role: "system" }` 放在最前面写角色（"你是一只桌宠"），平台把它当**人设片段**塞在规则**之后**、快照**之前**，并且截到 1200 字。**它覆盖不了平台的任何一条规则** —— 写在后面的东西不改前面的规则，这是顺序，不是礼貌。
- **上限**：16 条消息、单条 4000 字、合计 16000 字。超了是拒绝（`bad_params`），不是截断。
- **一条一轮，第二条会被拒**。同一块组件在上一轮还没回来时再问一次，返回 `internal`（"a turn is already running"）—— 不是排队：两轮并发改同一份布局，结果全会是错的，而且谁也解释不清。
- **它很慢**。一轮带工具最多 6 步，每步都是一次模型往返。超时按 **180 秒**算，不是别的方法那种 8 秒。所以：**别在关键路径上调它**，也别等它回来才画第一帧（不变量 18）；发了就去更新一句"我想想……"，回来再改。
- **花钱，而且花得比 `llm.chat` 多**（一轮可能好几步）。没配模型的时候和 `llm.chat` 一样返回 `internal`，先问 `llm.status`。
- **`actions` 是"已经发生的事实"，不是计划**。里面的 `detail` 是动作名（`moveWidget` / `resizeWidget` / `pinWidget` / `setTheme` / `addWidget` / `focusWidget` …），`ok: false` 的带 `error`（多半是"找不到那个组件"或"参数不合法"）。**别把它当真值去驱动 UI 状态** —— 想知道现在的布局，问 `agent.activity`（要另授权）或者干脆不显示。它是给你写一句"我把时钟挪过去了，天气预报没找到"用的。

平台侧每次调用都会写一行审计（`widget.ask`，记组件 id 与字数，不记内容）。

### 3.6 把能力声明成工具（`agent.tools`）

`assistant.ask` 是组件**借平台的手**；这一条是反过来：组件把自己的能力**声明成工具**，模型（内置 assistant，以及将来走同一个执行器的 agent）来调你。它要 `agent:tools` 权限。

**为什么不让 agent 直接读你的存储**：`widget-data/<id>.json` 没有 schema，agent 读了只能瞎猜。要数据走你声明的工具 —— 暴露什么、怎么解释，由你的代码决定，平台不当数据出口（`docs/AGENT_ACCESS.md` §2.3）。

清单里声明：

```jsonc
{
  "id": "com.example.todo",
  "permissions": ["storage", "agent:tools"],
  "agent": {
    "tools": [
      {
        "name": "add",
        "description": "Add one item to the todo list",
        "params": { "text": "string" },
        "required": ["text"]
      },
      { "name": "list", "description": "List the items still open", "params": {} }
    ]
  }
}
```

五条硬规矩：

- **名字 `[a-z][a-z0-9_-]{0,31}`，最多 8 条工具、每条最多 6 个参数**。参数类型只有 `string` / `number` / `boolean` —— 够写待办和时间，不够"传一个对象进来让我猜"。`instanceId` 是平台留的那一格，写了也不收。整张表另有一道 **32 条**的全局上限（所有声明工具的组件加起来）：超出的那几条**静默不出现**，没有提示 —— 装了一堆都声明工具的组件时，排在后面的会莫名其妙地少工具。
- **写坏一条只丢那一条**，包照常加载（和不变量 17 同一条规矩）。描述超长会截到 120 字，而不是把这条丢掉。
- **工具名会变成 `widget.<你的 id>.<工具名>`**，例如 `widget.com.example.todo.add`。前缀是平台加的：`widget.` 这一段是"这是组件自己的工具"的唯一判据，别在描述里重复它。
- **`agent:tools` 是独立的授权轴**。"允许这个组件联网"不等于"允许 agent 往里塞数据" —— 没授这条权限，你声明的工具**一条都不会出现在模型那一侧**，一次都不会被调用。授权界面上那行字叫 "Agent tool calls"。
- **一个组件摆了几份时，调用带 `instanceId`**。只摆一份的话模型可以不写（平台替你补上），摆两三份就必须写——三份天气各在哪个城市，只有实例 id 分得清。

用 `@lattice/sdk` 的话，这一侧只剩一件事：**把名字挂上实现**。返回值就是 `result`，抛错就是 `ok: false` + 那句 `error.message`，不用自己拼回话：

```js
const off = lattice.agentTools({
  add: (args) => {
    items.push(String(args.text ?? "").trim());
    save();
    return { count: items.length };
  },
  list: () => items.slice(0, 5),
});
```

没注册的名字 SDK 会回一条 `unknown tool: <名字>` —— 比让模型干等 8 秒再收到"它没应"要好。`off()` 摘掉这次注册。

不用 SDK、或者想自己控制回话时机时，原始协议是**一条消息进、一条消息出**，走和桥同一个 `postMessage` 通道，只是方向相反：

```js
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.__lattice !== 1 || data.type !== "agent-call") return;
  const { callId, tool, args } = data.payload;
  const reply = (payload) =>
    event.source?.postMessage({ __lattice: 1, type: "agent-result", payload: { callId, ...payload } }, "*");

  if (tool === "add") {
    const text = String(args.text ?? "").trim();
    if (!text) return reply({ ok: false, error: "the text is empty" });
    items.push(text);
    save();
    return reply({ ok: true, result: { count: items.length } });
  }
  reply({ ok: false, error: `unknown tool ${tool}` });
});
```

四件事必须做到：

- **一定回话，而且带上同一个 `callId`**。不回的那一次，平台等 8 秒然后回去告诉模型"它没应"，用户看到的是"这个组件不听话"。
- **`ok: false` 要写一句能读的原因**。模型会把它转述给用户，也会据此改参数重来；一句空的 `false` 等于让它猜。
- **返回值会被 `JSON.stringify` 之后交给模型，上限 4000 字符**。超了是**拒绝**（`too-big`），不是截断 —— 半截 JSON 会让模型把残片当真。所以别把整份列表塞回去，回摘要或者回前几条。
- **`instanceId` 不进 `args`**。它是平台那一格（选哪一份实例），调用方已经替你选完了。

还没解决的两件事（写在 `docs/AGENT_ACCESS.md` §2.2）：**答话的是画布上那一份实例**（桌面窗口那份不参与，但它和画布那份共用同一份 `widget-data`，收到 `store-changed` 会自己重读；你的工具实现按"跑在自己的 iframe 里"写就行）；组件没装、或者画布上那张已经是破卡时，调用回 `not-running` —— v1 **不唤醒**窗口（建窗口 → 等宿主页 boot → 再投递是一串会输的竞态），模型会转述给用户而不是重试。另外 `npm run dev` 的浏览器预览里没有模型，这条链路只有桌面应用能跑完整。


## 4. 桥 API

### 消息格式

组件 → 宿主：

```js
parent.postMessage(
  { __lattice: 1, type: "request", id: 1, method: "clock.now", params: {} },
  "*"
);
```

宿主 → 组件：

```js
{ __lattice: 1, type: "response", id: 1, ok: true, result: {...} }
{ __lattice: 1, type: "response", id: 1, ok: false, code: "permission_denied", error: "..." }
```

`id` 自增，用于把响应配回请求。**每次请求都应该设超时**，宿主无响应时不能让 UI 卡死。

### 方法表

| 方法 | 权限 | 参数 | 返回 |
| --- | --- | --- | --- |
| `clock.now` | `clock` | — | `{ now, epochMs, timeZone, utcOffsetMinutes }` |
| `storage.get` | `storage` | `{ key }` | 存进去的值，不存在返回 `null` |
| `storage.set` | `storage` | `{ key, value }` | `{ ok: true }`；`value` 为 `null` 等同于删除 |
| `storage.remove` | `storage` | `{ key }` | `{ ok: true }` |
| `clipboard.write` | `clipboard:write` | `{ text }` | `{ ok: true }` |
| `system.metrics` | `system:monitor` | — | `{ cpu, memory, disk, network, system, sampledAt }`，见 4.2 |
| `power.status` | `system:monitor` | — | `{ ac, percent, charging, noBattery, critical, saver, minutesLeft }`，没有电池的机器照样回（`noBattery: true`），见 §4.3 |
| `schedule.every` | — | `{ every }` | `{ id, every }`；`every` 会被夹到 250ms–24h，订阅满 8 条返回 `bad_params` |
| `schedule.clear` | — | `{ id }` | `{ ok: true }` |
| `config.get` | — | — | 这个实例的配置，已按清单 schema 合并出厂值，见 §2.3 |
| `theme.get` | — | — | CSS 变量字典，见下 |
| `lang.get` | — | — | `{ lang: "zh" \| "en", locale }`；平台当前界面语言，见 §2.7 与 §4.4 |
| `network.fetch` | `network` | `{ url, method?, headers?, body? }` | `{ status, ok, headers, body, truncated }`，见 §3.2 |
| `media.get` | `media:control` | — | 当前媒体会话，没有播放器时返回 `null`（不是错误），见 §4.5 |
| `media.control` | `media:control` | `{ action }` | `{ ok }`；`action` 是 `playPause` / `next` / `previous` / `stop` |
| `audio.level` | `audio:level` | — | `{ level, running }`；`level` 是 0..1，没有设备时 `running: false`，见 §4.6 |
| `shell.open` | `shell:open` | `{ url }` | `{ ok: true }`；只收 http/https（`github.com` 这类会补成 https），见 §3.3 |
| `agent.activity` | `agent:activity` | `{ limit? }` | `{ enabled, entries }`；`entries` 是审计日志最后几条，新的在**后**（组件自己倒序） |
| `llm.status` | — | — | `{ configured, model }`；只是"用户配没配模型"，拿不到 key，见 §3.4 |
| `llm.chat` | `llm:chat` | `{ messages }` | `{ text }`；`messages` 是 `{role, content}` 数组，role 只认 `system` / `user` / `assistant`，见 §3.4 |
| `assistant.ask` | `desktop:control` | `{ messages, persona? }` | `{ text, actions }`；平台替你跑一整轮带工具的对话，见 §3.5 |
| `term.write` | `terminal:exec` | `{ command }` | `{ id }`；输出走 `lattice:term` 事件，见 §4.9 |
| `term.stop` | `terminal:exec` | — | `{ ok: true }`；杀掉这条 shell，下一条命令会自动起一条新的 |
| `term.state` | `terminal:exec` | `{ since? }` | `{ running, cwd, shell, seq }`；带 `since` 时把之后缓冲的事件重发一遍 |
| `window.close` | — | — | 关闭当前组件实例的窗口，**但不删用户的 placement** |
| `window.setRegion` | — | `{ parts }` | `{ ok, applied, parts }`；`shape: "region"` 才有 `applied: true`，见 §2.5 |
| `window.moveBy` | — | `{ dx, dy }` | `{ ok, applied, x?, y? }`；`dx` / `dy` 是 **CSS 像素**位移，撞到工作区边缘会被夹紧，`x` / `y` 是夹紧后的**物理像素**落点，见 §2.6 |

**`window.close` 只是关窗，不是删组件。** 调用之后窗口消失，但用户摆在画布 / 桌面上的那个 placement 还在 `state.json` 里，下次启动照样回来；本次运行内不会再自动冒出来（平台记着"它自己退出了"）。真正删掉用户布局的只有用户自己按宿主页那颗 ✕。所以组件别把这个方法当"自毁"用 —— 它是"我先歇着"。

**写入是键级的，不是整份覆盖。** 平台在 Rust 侧加锁做「读 → 改这一个键 → 原子替换」，所以主窗口和桌面窗口里的同一个组件同时保存时，改不同键不会互相抹掉。组件不要自己去读整份 map 再写回去 —— 那等于绕过锁，又会退回成互相覆盖。

**读永远读盘，没有内存缓存。** 同一份数据在别的窗口被改过，下一次 `storage.get` 就能看到。代价是一次 IPC，几 KB 的文件不值得为它做缓存。

**读失败 ≠ 没有数据 —— 读失败时绝对不许把默认值写回去。** 这两个状态必须分开处理：`null`（键不存在，可以种一份默认数据并保存）和 reject（权限被拒、IPC 失败、文件读不了）走的是两条路。把 reject 也当成 `null` 处理，就会在"用户明明有数据、只是这一下没读到"的时候用种子数据把真数据覆盖掉 —— 平台里真实发生过一次，便签和待办的用户内容被换成了出厂示例。所以 `.catch()` 里只许把界面标成"没读到"，不许 `storage.set`。

**盘上永远留着上一版：`<组件 id>.json.bak`。** 每次覆盖（内容真的变了才算）之前，平台把旧文件挪到同名 `.bak`，只留一代。所以"把用户的数据写坏了"这件事不再是不可逆的 —— 至少能退回上一次。组件不需要管这个文件，也不要自己去读写它：它是给人用的，不是给代码用的。卸载组件时 `.bak` 一起删掉。

**但是：光"读得到"不够，还得知道"该读了"。** 同一个组件可以在画布上有一个实例、桌面上又有一个，两份各自持一份内存副本。平台在每次落盘后广播 `store-changed`（见下），收到就重读 —— 不做这件事，后写的那份会把对方刚加的内容整块覆盖，用户看到的是"加了几条，回头只剩一条"。

### 4.1 定时器用 `schedule`，不要 `setInterval`

组件的所有周期性工作都该挂在平台的时间轴上：

```js
const grant = await call("schedule.every", { every: 1000 });   // { id, every }

// 收到 tick 时刷新。一条时间轴上可能挂着好几条心跳，认准自己那一条
if (data.type === "tick" && data.payload.id === grant.id) refresh();

// 组件自己不再需要时（比如切成静态视图）
await call("schedule.clear", { id: grant.id });
```

为什么不是 `setInterval`：平台把**一个组件实例的所有心跳收进一条时间轴**，一次只有一个计时器在飞（永远取最近的到期时刻）。窗口被最小化 / 收起时整条时间轴停摆，用户看不见的东西不烧电；回来只补一拍，不会补一串。

三条边界：

- **最细 250ms**。再密就是拿 `postMessage` 当 `requestAnimationFrame` 用 —— 要逐帧动就自己开 rAF，那才是对的工具。
- **最多 8 条订阅**。一个组件本来也就一两条心跳，第 9 条会返回 `bad_params`。
- **不可见期间不累积**。心跳是"现在是什么样"，不是"这段时间里每一拍"，别在组件里自己补算。

`every` 的返回值是**夹紧之后**的间隔，用它校准自己的显示（比如写"每 5 秒刷新"），别用你传进去的那个数。

### 4.2 `system.metrics` 的形状

```json
{
  "cpu":     { "usage": 0.41, "cores": 16, "perCore": [0.05, 0.12, 0.99, 0.31] },
  "memory":  { "usage": 0.82, "used": 27311403008, "total": 33648160768,
               "commitUsed": 32000000000, "commitLimit": 48000000000 },
  "disk":    { "mount": "C:", "usage": 0.45, "used": 121899466752, "total": 268435456000 },
  "network": { "rxPerSec": 3342, "txPerSec": 812, "rxTotal": 918273645, "txTotal": 12837465 },
  "system":  { "uptimeSec": 273600, "processes": 142, "threads": 2143, "handles": 61234 },
  "sampledAt": 1792747537787
}
```

- `usage` 是 0–1 的比例，不是百分数。
- 字节数一律是 `u64`，自己格式化成 KB / MB / GB。
- **`rxPerSec` / `txPerSec` 第一次调用一定是 0**：速率要两次采样做差，没有前值就编不出来。所以启动时先调一次建基线，第一次心跳拿到的才是真数。
- **`cpu.perCore` 第一拍是空数组**，核数刚变过（休眠唤醒 / CPU 热插拔）时也是空数组。**别按索引硬对上一次的数组** —— 那会把 A 核的计数减到 B 核头上，画出来是一条看着合理、其实全错的曲线。空数组时把逐核那一条收起来，下一拍自然恢复。长度等于 `cores`。
- `cpu.usage` 是**整机**的平均（一个核跑满，16 核机器上是 6% 左右）。想知道"是哪个核在忙"只能看 `perCore`。
- `memory.commitUsed` / `commitLimit` 是提交量，含页面文件。物理内存满了系统只是变慢，撞到提交上限会**直接拒绝分配** —— 后者才是"要出事"的信号，但它不在任务管理器首屏。
- `disk` 只有**系统盘**（`%SystemDrive%`），`mount` 是盘符（`C:`），别的盘不算。
- 平台在 Rust 侧有 1 秒缓存，几个组件在同一秒里轮询只会真采一次 —— 但别指望它，心跳间隔比采样间隔更细是没意义的。

### 4.3 `power.status`：电池读数

```json
{
  "ac": true,
  "percent": 87,
  "charging": true,
  "noBattery": false,
  "critical": false,
  "saver": false,
  "minutesLeft": null
}
```

- **权限是 `system:monitor`，没有单独的电源权限。** 知道 CPU 占用和知道还剩多少电是同一类同意（"让我看看这台机器的状态"）；每个指标一条权限，属性面板会变成一张读不懂的清单。
- **字段是已经解释好的事实**，不用认 `255` / `u32::MAX` 那两个哨兵 —— Rust 那半已经翻过了，判据在 `power_policy.rs`（6 条 `rustc --test`）。
- `ac` 三值：`true` 接着电、`false` 用电瓶、`null` 读不出来。`percent` 读不出来就是 `null`：**别把它夹到 100**，那会把"读坏了"画成"满电"。
- `minutesLeft` 只在**用电瓶**、且系统估得出来时才有值。插着电谈"还能用多久"没有意义，所以那时是 `null` 而不是一个大数字；超过一周的读数按坏读数处理。
- `noBattery` 是台式机：卡片该说"没有电池"，而不是画一个 0%。`saver` 是 Windows 的节电模式，`critical` 是"马上就要关机"。
- **平台不缓存这条**：一次调用就是一次 `GetSystemPowerStatus`。电量变得慢，节流放在组件那一侧（`schedule.every`，窗口不可见时整条停摆）。
- 浏览器预览里没有系统调用，这条方法回 `null`（不是抛错），卡片据此画"没有读数"。

### 4.4 宿主 → 组件的推送

| 消息 | 时机 | 载荷 |
| --- | --- | --- |
| `{ __lattice: 1, type: "theme", payload }` | 主题切换、组件加载完成 | CSS 变量字典 |
| `{ __lattice: 1, type: "language", payload }` | 界面语言切换、组件加载完成 | `{ lang: "zh" \| "en", locale }`，见下 |
| `{ __lattice: 1, type: "tick", payload }` | `schedule.every` 到期 | `{ id, at }`，`id` 就是订阅号 |
| `{ __lattice: 1, type: "store-changed", payload }` | 本组件的私有存储被**任意**实例写入了 | `{ key }`，`key` 为空串表示整份文件被替换 |
| `{ __lattice: 1, type: "config-changed", payload }` | 这个实例的配置被改了（属性面板） | `{ config }`，完整对象，见 §2.3 |
| `{ __lattice: 1, type: "agent-call", payload }` | agent / assistant 调了你声明的工具 | `{ callId, tool, args }`；**必须**回一条 `agent-result` 带上同一个 `callId`，见 §3.6 |
| `{ __lattice: 1, type: "term", payload }` | 终端组件的命令输出（Rust 的 `lattice:term` 转过来） | `{ instanceId, id, seq, kind, … }`，见 §4.9 |
| `{ __lattice: 1, type: "ready" }` | 组件主动发出，表示已就绪 | 宿主收到后会立刻推一次主题和配置 |

`store-changed` 的标准处理方式（两个示例组件都是这么写的）：

```js
if (data.type === "store-changed" && (!data.payload.key || data.payload.key === "items")) {
  // 1. 自己有没落盘的改动 / 光标在输入框里 → 本地优先，直接跳过
  // 2. 否则重读这个键，内容没变就不要重画（自己的写入也会回声过来）
  reload();
}
```

不要收到通知就立刻写回，那会变成两个实例互相触发、无限刷新。

主题字典的键：`--lattice-bg`、`--lattice-surface`、`--lattice-text`、`--lattice-text-muted`、`--lattice-border`、`--lattice-accent`、`--lattice-radius`、`--lattice-font`。

组件应当把这些值写到自己根元素的 CSS 变量上，这样明暗主题切换是零成本的。

**语言也是"拉一次 + 收推送"两件事。** `lang.get` 拿初值，`language` 推送跟着变：

```js
let lang = (await call("lang.get")).lang;      // "zh" 或 "en"
const say = () => {
  hint.textContent = lang === "zh" ? "点我一下" : "Click me";
};
say();

// 用户在设置里换了语言：平台会推一条，别只读一次
if (data.type === "language") {
  lang = data.payload.lang;
  say();
}
```

两条都别省：只读一次的话，用户换语言组件不会动；只听推送的话，组件在"语言早就切过"
之后才加载（重载、热更新、权限变更）就永远停在建文档那一刻的值。
`lang` 只有 `zh` / `en` 两种 —— "跟随系统"是**平台**在设置里解析掉的，组件不用管
系统区域设置。`locale`（`zh-CN`、`en-US`）只在要排版日期、数字的时候用。

### 4.5 `media.get`：系统媒体会话

Windows 的 SMTC（System Media Transport Controls）—— 就是按音量键时左上角那个浮层背后的那套东西。凡是往它注册过的播放器（Spotify、浏览器里的 YouTube、系统播放器）都能读到。

```js
const session = await lattice.media.get();     // 需要 media:control
if (!session) return render("Nothing playing");
```

```json
{
  "title": "Ocean Drive",
  "artist": "Ducktail",
  "album": "Nightfall",
  "source": "Spotify",
  "status": "playing",
  "canPlayPause": true,
  "canNext": true,
  "canPrevious": true,
  "positionMs": 187000,
  "durationMs": 400000
}
```

四条要注意的：

- **`null` 是正常状态**，不是错误。桌面上没开播放器太常见了，组件该显示"没在放"，不该红字警告。
- **`status` 是字符串**，取自 WinRT 的 `MediaPlaybackStatus`：`closed` / `changing` / `stopped` / `playing` / `paused`。判断"在不在播"用 `status === "playing"`。
- **能力位可能和状态不一致**。有的播放器报 `status: "playing"` 但 `canPlayPause: false`。按钮的可用性看 `can*`，图标看 `status`。
- **`durationMs` 可能是 0**（直播、某些播放器）。别画一条永远停在 0 的进度条 —— 那看着像坏了。

`media.control` 是**异步**的：`{ ok: true }` 只表示"请求已经交给系统"，播放器真正开始播可能还要几百毫秒。想让按钮立刻响应，就在本地先翻转一次状态，等下一次 `media.get` 回来再校正 —— `public/widgets/lattice.music/` 就是这么做的。

`positionMs` 是"上次报告的位置"。播放中它会自己往前走，但不会实时更新 —— 要画连续进度条的话，拿到位置的那一刻记下时间戳，之后按经过的毫秒自己插值。

### 4.6 `audio.level`：扬声器现在有多响

SMTC 只有歌名歌手，**没有音量** —— 想知道"现在有多响"，唯一的办法是自己去听输出设备在放什么。`audio.level` 走的是 WASAPI 的**回环采集**（把正在播给扬声器的那一路复制一份出来），每块只算一个 RMS 就把采样丢掉。

```js
const { level, running } = await lattice.audio.level();   // 需要 audio:level
```

- `level` 是 0..1，已经做过分贝映射（-60dB..0dB 铺满）和释放曲线（峰值之后按 120ms 时间常数往下掉）。直接当高度用，别自己再取一次对数。
- 它**不是**"这首歌的响度"，是"这台机器现在有多响"：游戏、视频、系统提示音都算，没开媒体会话时照样有值。
- `running: false` 表示采集没跑起来（没有输出设备 / 被独占 / 正在重连），此时 `level` 恒为 0。画一条平线就行，不要提示错误 —— 两秒后它会自己重试。
- **这是采样，不是订阅**：后端每 40ms 更新一次那个数，你问一次拿一次。要画折线就自己攒一个环形缓冲，80ms 左右一问；问得更密不会更新得更快，只会把桥压满。

后端只保留一个 `f32`：不缓存音频、不落盘、不出进程。所以它不需要任何系统级授权，也不会弹"允许录音"，更拿不到单个应用的音轨。

### 4.7 用 `@lattice/sdk` 少写点样板

上面这套 `postMessage` + 自增 id + 超时 + 权限判断，手写一遍大概六十行。`@lattice/sdk` 把它封好了：

```js
import { createLattice, isPermissionDenied } from "./lattice.js";

const lattice = createLattice();
await lattice.ready;                                    // 配置和主题已经就位

lattice.schedule.every(1000, () => render());
const session = await lattice.media.get();
```

`lattice.js` 和 `lattice.d.ts` 是**两个普通文件**，从 `examples/counter/` 或 `npm run create:widget` 的产物里拷进组件目录即可 —— 不需要 `npm install`，不需要打包。这样"组件不用构建"这个前提保住了。

它替你做的事：请求 / 响应配对、超时、`LatticeError`（带 `code` 和 `permission`）、启动时先拉配置 / 主题 / **语言**再报 `ready`、主题令牌写成 CSS 变量（长名 + 短别名）、`store-changed` / `config-changed` / `tick` / `language` 的分发。

双语的那两件事也在里面：`lattice.language`（`{ lang, locale }`）和 `lattice.on("language", …)`。

它**不**做的事：不重试、不替你决定降级策略、不绕过权限。

`public/widgets/` 下的内置组件一个都没用它 —— 它们是"不装 SDK 也能写"的证明。什么时候值得装：组件有存储、有心跳、要处理权限失败。只有一个 `clock.now` 的纯展示组件就不必。

细节见 `packages/sdk/README.md`。

### 4.8 启动顺序：先画，再问

`config.get` 和 `storage.get` 都是**往返**，宿主忙的时候要几十毫秒，宿主不在（比如你直接双击打开组件页调样式）要等到超时——`config.get` 3 秒、`storage.get` 3 秒，加起来 6 秒。如果第一帧画在它们后面，卡片就是一块空白，而且空多久由宿主决定。

所以顺序固定成这样：

```js
// 1. 先按默认值画一帧。要画的通常只是 00:00.00 或者 m → ft
render(blank);

// 2. 再去问
const saved = await call("storage.get", { key: "units" }).catch(() => null);

// 3. 回来再改 —— 但只在用户还没动过手的时候
if (!touched && saved) apply(saved);
```

`touched` 那个闸门不能省。桥回来之前用户完全可能已经点过分类、打过数字了，这时候把存档盖上去等于把他刚做的选择撤销掉。宁可这次不恢复，也不能吃掉用户的操作。

也别用"加载中"占位：空白卡片和骨架屏是同一个等待，只是后者多画了点东西。默认值本来就是合法的界面。

### 4.9 `term.*`：一条常驻 shell 的皮肤

`lattice.term` 用这一组。它和别的方法有三处不一样，写在这里是因为第三方组件也可能想做同一类东西（一个"运行脚本"的卡片、一个"日志尾巴"的卡片）。

**每个实例一条进程，不是每条命令一条。** 平台按 `instanceId` 挂一条 `powershell -NoProfile -NonInteractive -Command -`，命令从 stdin 进去、输出从 stdout 出来。实测启动约 480ms、之后每条约 40ms —— 每条命令起一个进程的话，"敲一条等半秒"就是硬伤。代价：跑不了 `vim` / `ssh` / 任何要控制台的程序，`Ctrl+C` 也没有（停止 = 杀掉 shell 再起一条，`cd` 和变量会丢）。

**输出走事件，不走返回值。** `term.write` 只回一个编号：

```js
const { id } = await call("term.write", { command: "ping -n 10 127.0.0.1" });
// 之后从 { type: "term" } 推送里一段段收正文（见 §4.4）
```

事件形状（`payload`）：

| 字段 | 说明 |
| --- | --- |
| `instanceId` | 哪个实例的终端。宿主页按它转发，组件一般不用看 |
| `id` | 这一条命令的编号（`term.write` 的返回值） |
| `seq` | 单调递增的事件序号，`term.state` 拿它跟平台对账 |
| `kind` | `chunk` / `done` / `lost` |
| `stream` | `chunk` 才有：`stdout` / `stderr` |
| `text` | `chunk` 才有：这一段的正文（已经按行归一过 `\r`） |
| `code` | `done` 才有：退出码，拿不到时是 `null` |
| `truncated` | `done` 才有：这一条输出超过 64KB，后面的被丢掉了 |

**`lost` 不是错误，是事实**：shell 自己 `exit` 了、被杀软干掉了、用户按了停。组件该做的是说清楚，然后让下一条命令起一条新的（平台就是这么做的，不需要额外调用）。

**回话可能比输出晚 —— 编号要从事件里认领。** Rust 是先把命令写进 shell 的 stdin、再把编号回给组件，所以快命令（`cd C:\Windows`、`echo hi`）的 `chunk` 可以比 `term.write` 的返回值**先到**（真机上量到早 5ms）。组件此刻还不知道 `id`，如果按"先拿到返回值再挂监听"的写法，那条命令的事件就会被当成"不认识的主人"整段丢掉 —— 卡片上一个字都没有，而 shell 明明跑完了。正确写法是**从第一条事件里认领编号**：

```js
// 事件处理里：还没有在飞的命令，就把这一条的编号认下来
if (event.id && !state.active) state.active = event.id;
// 回话到达时：只在还空着的时候才填，别覆盖已经认领的
if (reply && typeof reply.id === "string" && !state.active) state.active = reply.id;
```

**`term.state` 的 `since` 用来补齐。** 窗口藏起来回来、权限变更导致 iframe 重载，中间那段事件可能没画上；带上手里最后那个 `seq`，平台会把之后缓冲的事件重发一遍（环形缓冲，最多 512 条 / 200KB）。

**能力边界要写在组件自己的说明里**，别让用户以为这是 Windows Terminal：没有 ANSI 颜色、没有补全、没有多标签、跑不了交互式程序。

## 5. 沙箱限制

组件跑在 `sandbox="allow-scripts allow-forms"` 的 iframe 里，**没有** `allow-same-origin`。所以：

| 不能用 | 替代方案 |
| --- | --- |
| `localStorage` / `sessionStorage` | `storage.*` 桥方法 |
| `fetch()` 读**别人的**文件 | 组件自己目录里的文件可以 `fetch("./data.json")`（见 5.2）；外部地址一律被 CSP 拦掉 |
| 访问 `parent` 的 DOM 或变量 | 桥方法 |
| Cookie / IndexedDB | 暂不支持 |
| `alert` / `confirm` | 在组件内自己画 UI |
| 原生表单控件（`checkbox` / `radio` / `select`） | 沙箱文档的 `color-scheme` 被强制成 `normal`，原生控件按**浅色**主题绘制，在深色卡片上几乎看不见。用 `appearance: none` 自绘，勾选色取 `--lattice-surface`（深色主题浅底配深勾、浅色主题深底配白勾）。**如果这个控件是用来调设置的**，别在卡片里画它 —— 声明成 `config`（§2.3），属性面板会按平台的样子渲染 |

这些限制不是缺陷，是安全边界：**组件是不可信代码**，它唯一能做的事就是通过桥申请能力。

`allow-forms` 是单独给的：沙箱里少了它，浏览器会把整个提交过程拦掉，`submit` 事件**根本不会触发**。也就是说 `<form>` + 输入框 + 回车这套最普通的写法会静默失效 —— 字打进去了，回车没反应，什么都不发生，连报错都没有。它不扩大权限面（表单只能提交到组件自己的不透明源，外发请求本来就能用 `fetch` 发），所以默认开着。

## 5.1 右上角要留出来

桌面窗口的功能图标（拖动 / 层级 / 别针 / 重载 / 收回）浮在卡片右上角 `top: 6px; right: 6px`，整条大约 **120×28**，鼠标移进卡片就淡入。它盖在组件内容**上面**，而且是真的能点的。

所以组件的右上角是一块"窗饰保留区"：

- 不要在那里放输入框、按钮、可点的列表项 —— 用户点下去，点到的是"收回"。
- 顶部通栏的控件（比如待办清单的输入框）要么整体下移一行，要么像 `lattice.todo` 那样先放一条 22px 的标题栏，把这一行让出去。
- 正文从顶上就开始排的组件最容易栽在这里，而且症状不是"点错"，是"看不见"：打字的人手在键盘上、指针一动不动，窗饰也就一动不动地压着**正在写的那一行**。便签原本就是这样，写到第一行末尾得歪头看。
- 纯展示的组件（时钟、图片）不用管，那块地方本来就是空的。
- 卡片第一行就是正文的（曲名、状态值），让**那一行自己**让出 120px（`padding-right: 120px`）比再加一条标题栏省一行高度 —— `lattice.music` 就是这么做的：曲名提前省略，但不会被按钮压住。

`lattice.todo` 的标题栏写法可以直接抄：一行 `22px` 高、`padding-right: 120px`（`120` 减去卡片自己的 `12px` 内边距），左边放标题、右边放计数。视觉上窗饰正好落在这条标题栏的右端，谁也不压谁。

不过"标题栏"这个词容易读偏：那一条里写的应该是**这个组件此刻**的东西 —— 计数、进度、保存状态、当前城市 —— **不是组件的名字**。画布上的平台标题条已经写着名字了（`widget-host.html` 的窗口标题），组件里再写一遍就是同一句话说两次，还白占一行。`lattice.anki` 和 `lattice.calculator` 以前就是左边一个组件名、右边一个计数，现在前者只留计数，后者干脆把那条 22px 删掉、让页签行自己让出 `120px`（就是下面 `lattice.music` 那种解法）。

`lattice.note` 是同一条规矩的另一种解法：它没有标题，就把底栏的保存状态（`Saved` / `Saving…`）挪到顶上，做成 24px 高、同样 `padding-right: 120px` 的一条。正文于是从 `40px` 起排，稳稳在窗饰下沿（`34px`）之下。**留出来的这一条不能是空的** —— 一块什么都没有的 24px 会让人以为排版坏了；填一条真正有用的元信息，它才像标题栏而不是像缺口。

> 窗饰以后再加按钮，这两个数都要跟着加（每颗按钮 22px + 1px 间距）。`tests/note-layout.html` 里的 `PILL_WIDTH` 是这三个地方的第四份，改一处忘三处的代价是一条被压住的正文。

这两处几何都是被测试钉住的，`tests/note-layout.html` 会直接量正文起点与安全区宽度，改回去就红。

## 5.2 CSP：组件文档带着一套很紧的策略

组件文档的响应头里有一条 CSP。它管的是**"组件能把数据发到哪里"** —— 沙箱挡住了"碰不到宿主"，但挡不住网络。组件作者只需要记住五条：

| 通道 | 允许什么 |
| --- | --- |
| `fetch` / `XHR` / `sendBeacon` | 只有组件自己的协议源。`fetch("./data.json")` 可以，`fetch("https://…")` 抛 `TypeError` |
| `<img>` / `<video>` / `<audio>` / 字体 | 自己的协议源 + `data:` / `blob:`。**外链图片不会显示** |
| `<iframe>` / `<object>` / `<embed>` | 全部禁止 |
| `<form action="…">` | 禁止提交（`<form>` 本身能用，见上一节） |
| `eval` / `new Function` | 禁止 |
| `location.href = "https://…"` / 顶层跳转 | 禁止。导航在发生前被平台取消，页面停在原地 |

落到写法上：

- 图标内联 SVG，或者 `data:` URI。不要 `<img src="https://…">`。
- **不要指望 CDN**：脚本、样式、字体都得跟着组件包一起发。这条同时意味着组件离网也能用，是好事。
- 依赖 `eval` 的库跑不起来（部分模板引擎、旧版 bundler 的 dev 产物）。换非 eval 的构建。
- 要联网走 `network.fetch`（§3.2），`fetch("https://…")` 永远不通。**别用 try/catch 把 `TypeError` 咽掉然后显示"暂无数据"**，那会让用户以为接口挂了。
- **跳走也不行**。`location.href = "https://…"` 会被平台在导航发生前取消，页面原地不动、控制台不会给什么有用的提示。`<a href="https://…">` 同理（点了没反应）。想让用户看网页，只能请主窗口用 opener 打开，那是平台的事，不是组件的事。

一个例外要说清楚：**这条头只加在用户目录里的组件上**。内置组件跟着应用一起发、走前端资源管线，拿不到这条头（它们随二进制分发，信任级别和平台本体一样）。所以同一份代码装成内置和装进用户目录，**联网**行为可能不一样 —— 这是已知的不对称，不是你的 bug。错误上报没有这个不对称（两条路都注，见 8.2）；兜底页仍然只在 `lattice-widget://` 上，内置组件的文件跟着应用一起打包，缺文件在构建时就暴露了。

## 6. 排版

组件窗口都很小，字号和字距的容错率比普通页面低得多。四条规矩：

**字体栈统一用这一串**（平台推下来的 `--lattice-font` 也是它，所以直接 `font-family: inherit` 就对）：

```css
--font: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
  "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
```

拉丁字母交给 Segoe UI，汉字落到 YaHei UI——这是 Windows 自己的组合。**不要**把 `system-ui` 放最前面：它解析到 Segoe UI，而 Segoe UI 没有汉字，浏览器只能按自己的兜底字体补，混排时基线和字重会对不齐。

**不要写 `-webkit-font-smoothing: antialiased`。** 这条在 macOS 上是"让字更细腻"，在 Windows 上恰好相反：它关掉 ClearType 次像素渲染，中文小字立刻变细、发灰，像没对上焦。

**字号只有四档**：11（胶囊/元信息）、12（次要说明）、13（正文）、40+（大数字）。中文低于 12px 笔画会粘在一起，`11px` 只用于不承载信息的标签。

**数字和中文单位之间不加空格。** 正确写法是 `2027年1月1日`、`24小时制`、`49字`；写成 `2027 年 1 月 1 日` 是把西文词间距套到中文上，视觉上会散成五段。汉字与**阿拉伯数字**之间留一个空格是对的（`距离 2027年1月1日`），单位不算。

时间类数字一律加 `font-variant-numeric: tabular-nums`，否则秒数跳动时整行会左右抖。

## 7. 最小示例

先给三条路，从快到慢，按你手上有什么选：

- **`npm run create:widget -- demo.mine`** —— 生成一个已经会跳秒的组件，属性面板里还带一个能改的标题（`config` 里那个 `caption`）。先跑起来再改，最省事；改清单记得重跑 `npm run widgets:index`
- **`public/widgets/lattice.weather`、`lattice.focus`** —— 两个真实场景的完整例子。前者是联网组件的全套：两个 host、三档刷新、断网时留着上一次的数、权限被拒时说的话；后者是"同一份状态被两张卡片同时改"该怎么写（时间存绝对时刻、阶段推进写成纯函数）
- **下面这份** —— 不装 SDK、只有六十行的裸桥版本。它的用处不是让你照抄，而是证明"组件就是个普通网页"：没有构建、没有依赖，`postMessage` 就是全部协议

`manifest.json`：

```json
{
  "id": "lattice.hello",
  "name": "Hello",
  "version": "0.1.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "size": { "w": 200, "h": 100, "minW": 120, "minH": 60 },
  "permissions": ["clock"]
}
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; }
      body {
        display: grid;
        place-items: center;
        color: var(--fg, #ecebe6);
        font: 13px system-ui, "Microsoft YaHei", sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="out">…</div>
    <script src="widget.js"></script>
  </body>
</html>
```

`widget.js`：

```js
let seq = 0;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ __lattice: 1, type: "request", id, method, params }, "*");
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("超时：" + method));
    }, 3000);
  });
}

addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.__lattice !== 1) return;

  if (data.type === "theme") {
    const map = {
      "--lattice-text": "--fg",
      "--lattice-text-muted": "--muted",
      "--lattice-accent": "--accent",
      "--lattice-border": "--border",
    };
    for (const [source, target] of Object.entries(map)) {
      if (data.payload[source]) {
        document.documentElement.style.setProperty(target, data.payload[source]);
      }
    }
    return;
  }

  if (data.type !== "response") return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  data.ok ? entry.resolve(data.result) : entry.reject(Object.assign(new Error(data.error), { code: data.code }));
});

call("clock.now")
  .then((info) => {
    document.getElementById("out").textContent = new Date(info.epochMs).toLocaleTimeString();
  })
  .catch((error) => {
    document.getElementById("out").textContent =
      error.code === "permission_denied" ? "Needs clock permission" : "Could not read the time";
  });

parent.postMessage({ __lattice: 1, type: "ready" }, "*");
```

## 8. 调试

### 8.1 组件坏了会看到什么

v0.3 之前组件出错只有一种表现：白屏。分不清是路径写错、文件没装、还是组件自己的 JS 崩了。现在分三种情况：

| 情况 | 你看到 | 出现在哪 |
| --- | --- | --- |
| 入口文件 / 子文件不存在 | **兜底页**：`File not found` + 组件 id、请求路径、找过的目录、该怎么修 | 桌面窗口、画布 |
| 组件目录不存在 | **兜底页**：`Widget not installed` | 同上 |
| 组件 JS 抛异常 / Promise 未处理 / 资源加载失败 | **错误卡**：红色那条，带消息、`文件:行:列`、可展开的堆栈、`Reload` | 桌面窗口是贴底的大卡；画布上只有一行 |

两种页面都不盖住整个组件：兜底页本身就是内容，错误卡贴在底边，上面还能看见组件坏成什么样 —— 排查的时候"哪一块炸的"和"炸成什么样"一样重要。

兜底页只出现在 `lattice-widget://` 上（也就是你装的组件）。内置组件的文件跟着应用一起打包，真缺了在构建时就会暴露，所以那条路上只有错误卡。

**错误卡显示的是"主错误"，不是"最后一条"。** 脚本异常和未处理的 rejection 压过资源加载失败，因为缺一张图经常是前面那个异常的结果。真机上就是这样：组件在第 15 行抛 `undefinedThing is not defined`，紧接着 `<img>` 加载失败 —— 只显示后到的那条的话，你看到的是一句 "Failed to load img"，真正的原因被盖掉了。右上角的 `+N` 悬停能看到其余几条。

### 8.2 错误是怎么到宿主的

组件跑在 `sandbox="allow-scripts"` 的 iframe 里，源是不透明的，宿主读不到它的 `window.onerror`。所以平台在**发组件 HTML 的时候注入一段上报脚本**，插在 `<head>` 之后（赶在组件自己的脚本之前，第一行就抛的错也能抓到）。

几个后果值得知道：

- 你在 DevTools 里看组件文档的源码，`<head>` 里会多一个 `<script data-lattice="diagnostics">`。那是平台的，注释里带 `lattice-diagnostics` 标记，别删。
- **行号不会错位。** 注入的脚本压成了一行，文档的总行数不变 —— 早先版本多占了一行，结果第 15 行抛的错报成了 `index.html:67:25`。
- 注入只发生在**发文档的那一刻**，所以有两条路，各自注一次：`lattice-widget://`（你装的组件）由协议层注；内置组件走应用自己的源（dev 是 vite，打包后是 tauri 资源协议），由构建管线注。**对你的组件来说没有区别** —— 你装的组件和官方组件，报错行为完全一样。
- 上报脚本只有一份源码。它被压成一行之后编进二进制，同时也被前端构建注进内置组件的 HTML；两边读的是同一个文件，所以不存在"官方组件的错误卡和我的不一样"。

### 8.3 重载

两个地方能重载，都不用重启平台：

- 桌面窗口：右上角窗饰第 4 颗按钮（圆形箭头），或者错误卡上的 `Reload`
- 画布：错误卡右边的 `Reload`

重载就是给 `src` 加一个时间戳重新导航，所以**改完文件存盘再点重载就能看到新内容**，不会被缓存挡住（协议层本来就发 `no-cache`）。

### 8.4 还是查不出来的时候

- 清单写错时组件库底部会列出原因，先看那里。
- 桥调用全部返回 Promise，务必 `.catch()`，否则权限未授予时会静默失败。
- 用户组件加载不出来时，先确认三件事：目录在 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\`（组件库标题右边那颗文件夹图标能直接打开）、`manifest.json` 的 `id` 和目录名一致、HTML 里全是相对路径。
- 想单独验证协议有没有把文件发出去：`curl -i http://lattice-widget.localhost/<id>/index.html`（Windows 上是这个形式）。返回 404 就是路径不对，返回 200 但白屏就是组件自己的 JS 出错。
- 打开**调试面板**（顶栏那颗终端图标，或 `Ctrl+Shift+D`）：组件的每一条 `console.log/warn/error`、每一次桥调用（方法名、耗时、错误码）都会实时滚在这里。桌面窗口里发生的调用也会汇进来，所以"这个组件到底有没有在调桥""那次为什么失败"不用再开 devtools 猜。
- 用 `curl` 探一个**不存在**的文件时，返回的是空 body，不是兜底页 —— 因为 `curl` 不发 `Sec-Fetch-Dest`，也没有 `Accept: text/html`，协议把它当成"组件在取资源"。这是故意的：组件 `fetch("data.json")` 拿到 HTML 会抛一个和真实原因毫无关系的解析错误。想看兜底页就在浏览器里直接访问那个地址。

---

## 9. 发布、版本与签名

这一节是给"想把组件发出去"的人看的。平台没有服务端，所以"发布"是**把两个东西放到一个静态地址上**：一份 `registry.json`，一批 `.lattice` 包。

### 9.1 版本号决定一切

`version` 必须是三段式（`1.2.3`，`1.2` 会被清单校验拒掉），而且**只有版本号变高，用户才会看到"可更新"** —— 平台比的是版本号，不是文件内容或时间戳。改完组件忘了抬版本，商店里那个条目会一直显示"已是最新"。

平台认的范围写法：`^1.2.3`、`~1.2.3`、`>=1.0.0 <2.0.0`、`1.x`、`*`、`a || b`。**不认**连字符区间（`1.2.3 - 2.0.0`）和 npm 那套"预发布版本的例外规则" —— 少一条隐式规则，就少一类"版本明明对得上却装不上"。写错的范围一律当成"不满足"。

### 9.2 打包与签名

```bash
npm run pack:widget -- ./my-widget            # → dist-packs/my-widget-1.0.0.lattice
npm run sign:widget -- --gen-key --out publisher.key    # 只做一次，私钥自己收好
npm run sign:widget -- dist-packs/my-widget-1.0.0.lattice --key publisher.key
```

发到**公共目录**（`lattice-registry`）不用手工走这三步，一条命令做完打包、签名、写 sidecar、重建 `registry.json`：

```bash
npm run publish:widget -- public/widgets/lattice.note --key ../lattice-registry/.keys/publisher.key
```

它只回答一件事：registry 仓库里改了哪几个文件、下一条 `git` 命令是什么。两道闸值得知道：**同一个版本号但内容变了会被拒**（版本号没变，装过旧包的人收不到更新，等于把新代码埋了），确实要覆盖加 `--force`；同样的内容重发是幂等的，不会产生一个"什么都没变"的提交。`npm run store:index` 是另一件事 —— 它生成跟着应用一起发的**内置演示目录**，用的是仓库里那把公开钥匙，别和真私钥混用。

**没有 Lattice 源码、只想往公共目录提一个包**也是同一条路，只是打包那步在目录仓库里做：`node scripts/sign.mjs <包文件> --key publisher.key --name "你的名字"` 产出同名 sidecar（ed25519，和 `sign:widget` 同一套），把 `.lattice` + `.json` 一起提 PR，五步写在目录仓库的 `CONTRIBUTING.md` 里。合并之后 Actions 重算 `registry.json`、核对**提交上来的那份和重算结果一字不差**（不一致就红 —— 有人改了包却没更新目录），再把目录与包装到 Pages。**CI 不签名**，私钥只在你机器上；一把钥匙就是一个身份，丢了就没法给已有组件发新版，只能换 id 重来。目录**只收包，不收代码**。

签名是 **ed25519，签的是整个包文件的字节**（不是清单、不是文件树）。输出的 `publicKey` 和 `sha256` 要写进目录条目。一份真实的目录长这样（`npm run store:index` 生成的那份）：

```json
{
  "schema": 1,
  "publisher": { "name": "Lattice", "key": "<你的公钥，64 位 hex>" },
  "widgets": [
    {
      "id": "lattice.clock",
      "name": "Clock",
      "description": "A large clock with the date",
      "author": "Lattice",
      "icon": "../widgets/lattice.clock/icon.svg",
      "versions": [
        {
          "version": "0.2.0",
          "url": "packages/lattice.clock-0.2.0.lattice",
          "sha256": "<包的 sha256，hex>",
          "size": 5623,
          "signature": "<ed25519 签名，128 位 hex>",
          "permissions": ["clock"]
        }
      ]
    }
  ]
}
```

几个字段的用处：`versions` 是**降序**排列的候选集（同一个组件可以同时挂着几个版本，`planInstall` 按范围挑最高的那个）；`permissions` 是**这个版本**申请的权限快照，更新时用它算"多要了哪几项"；`icon` 是相对目录文件的路径。`publisher` 可以写在根上（所有条目共用），也可以写在条目里覆盖。**目录本身不用签名** —— 它只是索引，信任锚点在包上。

### 9.3 用户那边会发生什么

装的时候平台按顺序验三件事，任何一件不过就拒绝，错误文案是分开的：

1. 包的 `sha256` 等于目录里写的那个 —— 挡传输损坏和"半路被换掉"
2. 签名能被 `publisher.key` 验过 —— 挡伪造
3. 这把钥匙等于**这个组件第一次安装时钉在本地的那把** —— 挡"另起一把钥匙、连目录一起换掉"

第 3 条有个直接后果：**换钥匙必须由用户点头**。你换了签名密钥再发版本，老用户会看到一张"这把组件的发布者钥匙变了"的提示，上面印着两把钥匙的指纹，点确认之后才会继续装。这不是 bug，是设计 —— 界面上那两串指纹就是给用户对一眼用的。

第一次安装没有可比的东西（TOFU，trust on first use）：卡片上会印出钥匙指纹，用户只能信"这次看到的"。所以**别频繁换钥匙**，换了就等于让每个用户重新做一次信任决定。

### 9.4 更新会保留上一代，回滚是交换

覆盖安装之前，旧版本整份复制到 `widget-backups/<id>`，只留一代。用户点 `Back to 1.0.0` 之后，被换下去的那个版本变成新的备份 —— 也就是说这个按钮可以按两次，两个方向都成立。

对你的组件来说只有一条要注意：**别把"用户数据"放在组件目录里**。目录会被整份替换/换回，放这儿的东西会跟着版本走甚至丢。数据走 `storage` 桥（落在 `widget-data/<id>.json`，跟版本无关）。

### 9.5 新版本多要权限，必须让用户重新确认

新版本在 `permissions` 里加了东西，平台**不会自动授予**，也不会禁用组件：

- 组件照旧能用（只是新权限那些方法返回 `permission_denied`）
- 卡片上出现 `Review` 标记，主窗口底部弹一条不会自己消失的横幅
- 用户点 `Allow` 才逐项授予，点 `×` 就一直拒着

所以**别把"以后可能用到"的权限先写进清单** —— 那会让每次更新都变成一次提权请求，用户很快就学会无视那条横幅。

### 9.6 评分与举报

已安装的组件卡片上可以打星，也可以 `Report`（选原因、写说明、顺手打分）。**这些东西不会上传** —— 平台没有服务端，它写成一份 `reports/<id>-<时间戳>.json`，对话框里会直接告诉你文件在哪。想让作者看到，得你自己把那个文件发过去。

文件里带着版本、目录里那份权限快照、平台与架构 —— 作者拿到的是一份完整现场，不用让你手抄版本号。
