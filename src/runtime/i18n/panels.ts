/**
 * 属性面板 / 组件说明 / 举报对话框的英文 → 中文。
 *
 * key 就是英文原文（见 `runtime/i18n.ts`）。带 `{name}` 的句子两边占位符要一致。
 *
 * 三块各自成组：属性面板（`InspectorPanel`）、"怎么用"的外壳（`HelpContent`）、
 * 举报与评分（`ReportDialog`）。**组件清单里的文案不进这张表** —— 组件名、
 * description、help 正文、changelog 都是作者写的，原样显示。
 *
 * 权限名（"System time" 那十句）也不在这里：它出现在组件库、商店、画布卡片和
 * 属性面板四处，归 `misc.ts`，界面上一律走 `permissionLabel()`。
 *
 * 和别的面板撞车的几句（`Saving…`、`{count} star(s)`、`How to use {name}`、
 * 层级的 `Desktop` / `On top`）在 `common.ts`，这里不重复。
 */
export const PANELS_ZH: Record<string, string> = {
  // —— 属性面板：外壳 ——
  Inspector: "属性面板",
  "Show the inspector": "展开属性面板",
  "Collapse the inspector": "收起属性面板",
  "Select a widget on the canvas to see its layer, size and permissions.":
    "在画布上选中一个组件，就能看到它的层级、尺寸和权限。",
  "No description": "暂无描述",

  // —— 属性面板：怎么用 ——
  "How to use": "怎么用",

  // —— 属性面板：三段折叠的标题 ——
  "Layer & size": "层级与尺寸",
  "Permissions & options": "权限与选项",

  // —— 属性面板：底部的移除区 ——
  "Takes this copy off the canvas and the desktop. The widget itself stays in your library.":
    "把这一份从画布和桌面上拿走。组件本身还在组件库里，再拖出来就又是一份。",

  // —— 属性面板：层级 / 穿透（Desktop / On top 两档的译名在 common） ——
  Layer: "层级",
  "Sits above desktop icons and below normal windows, so switching apps never covers it.":
    "压在桌面图标之上、普通窗口之下，切换应用时永远不会被盖住。",
  "Floats above every window — good for monitors and readouts.": "浮在所有窗口之上 —— 适合监控和读数。",
  "Click-through": "鼠标穿透",
  "Mouse events pass straight through — useful for purely decorative widgets.":
    "鼠标事件直接穿过去 —— 适合纯装饰性的组件。",

  // —— 属性面板：底板 ——
  Backplate: "底板",
  "Reset to theme": "恢复主题",
  "Pick a colour": "选择颜色",
  "Backplate colour": "底板颜色",
  "Follow the light / dark theme": "跟随明暗主题",
  Auto: "自动",
  Fill: "浓度",
  "Backplate fill": "底板浓度",
  Blur: "模糊",
  "Backplate blur": "底板模糊",
  "Backplate red": "底板红色",
  "Backplate green": "底板绿色",
  "Backplate blue": "底板蓝色",
  "{label} value": "{label}数值",
  "Fill is at 100%, so nothing shows through — lower Fill to see the frosted wallpaper.":
    "浓度是 100%，什么都透不出来 —— 调低浓度就能看到磨砂壁纸。",
  "The wallpaper shows through but is still sharp — raise Blur to frost it.":
    "壁纸透出来了，但还是清晰的 —— 调高模糊就能磨砂。",
  "Fill is how much of the colour covers the backplate, not window transparency. At 0 you get only the frosted wallpaper.":
    "浓度是颜色盖住底板的程度，不是窗口的透明度。调到 0 就只剩磨砂壁纸。",

  // —— 属性面板：尺寸 ——
  Size: "尺寸",
  "Reset to {w} × {h}": "恢复为 {w} × {h}",
  W: "宽",
  H: "高",
  "Widget width": "组件宽度",
  "Widget height": "组件高度",
  "Minimum {w} × {h}. Drag the edges on the canvas, or type an exact value here.":
    "最小 {w} × {h}。在画布上拖边缘，或者在这里输入精确数值。",

  // —— 属性面板：每实例配置项 ——
  Options: "选项",
  Reset: "重置",
  "Back to the defaults this widget ships with": "回到这个组件的出厂默认值",
  "Options belong to this copy only — two widgets of the same kind can be set up differently.":
    "选项只属于这一份实例 —— 同一种组件的两份可以各配各的。",

  // —— 属性面板：权限授予 ——
  "This widget needs no platform permissions.": "这个组件不需要任何平台权限。",
  "No bridge method backs this permission yet": "这个权限还没有对应的桥方法",
  soon: "即将支持",
  "Calls without a granted permission are rejected by the bridge; widgets must degrade gracefully.":
    "没授予的权限，调用会被桥直接拒绝；组件必须自己优雅降级。",
  "Permissions marked": "标着",
  "are declared by the widget but the platform has no bridge method behind them yet — granting them would change nothing.":
    "的权限由组件声明，但平台还没有对应的桥方法 —— 授予它不会有任何变化。",

  // —— 属性面板：来源 ——
  Source: "来源",

  // —— 组件说明：变更记录与空态（`How to use {name}` 在 common） ——
  "What changed": "改了什么",
  "This widget does not ship a how-to yet. Its author can add one to the manifest.":
    "这个组件还没有写使用说明。作者可以在清单里补一份。",

  // —— 举报 / 评分 ——
  "Report {name}": "举报 {name}",
  "What went wrong?": "出了什么问题？",
  "It is broken": "它坏了",
  "It asks for more than it needs": "它要的权限超出实际需要",
  "The description is misleading": "描述有误导",
  "It crashes or freezes my desktop": "它会崩溃或卡住我的桌面",
  "Something else": "其它问题",
  "Details (optional)": "详情（可选）",
  "What did you expect, and what happened instead?": "你原本期望什么，实际发生了什么？",
  "Your rating": "你的评分",
  Rating: "评分",
  // 星级按钮和组件库卡片上的评分是同一句话（`{count} star(s)` 在 common）
  "The report is written to a file on this computer. Nothing is sent anywhere.":
    "举报会写成本机上的一个文件，不会发送到任何地方。",
  "Save report": "保存举报",
  "Saved. Lattice has no server, so nothing was uploaded — send this file to the author (or attach it to an issue) to report the problem.":
    "已保存。棂没有服务端，所以什么都没上传 —— 把这个文件发给作者（或者附在 issue 里）来反映问题。",
  Done: "完成",
};
