/**
 * 组件库与商店那几块：`LibraryPanel` / `LibSection` / `CatalogueSection`。
 *
 * 卡片上的句子动辄带变量（`v{version}`、`{count} widgets`），中文里语序
 * 常常要倒过来 —— 所以表里存的是**整句**，不要为了复用把一句话拆成几段。
 */

export const LIBRARY_ZH: Record<string, string> = {
  // —— 组件库面板：标题行、搜索、空态 ——
  Widgets: "组件",
  "Show the widget library": "展开组件库",
  /* 顶栏左上那颗三线：它开合的就是这一栏（按钮在 `App.tsx`，措辞归这一档） */
  "Toggle the widget library": "开合组件库",
  "Open the widgets folder in Explorer": "在资源管理器里打开组件文件夹",
  "Open widgets folder": "打开组件文件夹",
  "Dismiss notice": "关闭提示",
  "Search widgets": "搜索组件",
  "Clear search": "清除搜索",
  "Scanning widgets…": "正在扫描组件…",
  "No widgets at all": "一个组件都没有",
  "The platform is empty": "平台还是空的",
  "Nothing below is installed yet. Install one and the desktop has something to show.":
    "下面这些都还没安装。装一个，桌面上就有东西可看了。",
  "Install the official pack ({count})": "安装官方包（{count}）",
  "Nothing matches “{query}”": "没有匹配“{query}”的组件",
  "Search covers names, ids, descriptions, authors and permissions.": "搜索范围包括名称、id、说明、作者和权限。",
  // —— 全局搜索浮层的结果角标：只分"有没有"，不暴露商店 / 随包发 这条内部区别 ——
  "Not installed": "未安装",
  "{count} on the canvas": "画布上 {count} 份",
  "Widgets that failed to load": "加载失败的组件",
  "Drag a widget folder or a": "把一个组件文件夹或",
  "package from Explorer into this window to install it.": "包从资源管理器拖进这个窗口即可安装。",
  "Drop a widget folder or a .lattice package anywhere in this window to install it.":
    "把组件文件夹或 .lattice 包拖到这个窗口的任意位置即可安装。",
  "Install all": "全部安装",
  "Install all {count} bundled widgets at once": "一次安装全部 {count} 个内置组件",

  // —— 组件回收站（`runtime/trash.ts` 的判据，这一段只是画出来） ——
  "Recently removed": "最近删除",
  "Deleting a widget leaves a copy here for seven days. Restore it if you removed the wrong one.":
    "删掉的组件会在这里留七天。删错了可以拿回来。",
  Restore: "恢复",
  "Its widget isn't installed": "这个组件已经卸载了",
  "Delete from the trash": "从回收站里删掉",
  "Empty trash": "清空回收站",
  Empty: "清空",
  "Empty?": "确定清空？",
  Keep: "留着",
  "This cannot be undone.": "清空之后就找不回来了。",

  // —— 组件库卡片（Installed / `{count} star(s)` / `How to use {name}` 在 common） ——
  Review: "待确认",
  Local: "本地",
  "No description yet": "还没有说明",
  "Declared by the widget, but the platform has no bridge method for it yet":
    "组件声明了这项权限，但平台还没有对应的桥方法",
  "Rate {name}": "给 {name} 评分",
  "Click again to clear": "再点一次取消评分",
  "Restore {version} (the version you had before this update)": "回滚到 {version}（更新前的版本）",
  "Back to {version}": "回到 {version}",
  "How to use this widget": "这个组件怎么用",
  Details: "详情",
  "Details for {name}": "{name} 的详情",
  Report: "举报",

  // —— 分区标题行（调用方给英文原文，LibSection 负责翻译） ——
  Available: "可安装",
  "Collapse {title}": "收起{title}",
  "Expand {title}": "展开{title}",

  // —— 商店：标题行与状态 ——
  Catalogue: "商店",
  "Cannot be installed": "无法安装",
  Offline: "离线",
  "Loading…": "加载中…",
  "Reload the catalogue": "重新加载商店",
  "Catalogue updated {date} — click to reload": "商店更新于 {date} —— 点击重新加载",
  "The catalogue could not be read": "读不到商店内容",
  "Showing an older copy": "显示的是旧副本",
  "{count} entries were skipped": "跳过了 {count} 个条目",
  "Nothing in the catalogue matches your search.": "商店里没有匹配的条目。",
  "This catalogue is empty.": "商店里还没有东西。",
  "Can be installed": "可以安装",
  "Needs a decision": "需要你决定",
  "Install all {count} widgets at once": "一次安装全部 {count} 个组件",

  // —— 商店：订阅了不止一个源时的那几行 ——
  "Turned off": "已关掉",
  "{count} widgets": "{count} 个组件",
  "Another source also offers it: {names}. This card uses the one above it in the list.":
    "另外还有来源提供它：{names}。这张卡用的是列表里更靠上的那一份。",

  // —— 商店：已安装条目的静默统计 ——
  "Already installed — {versions}.": "已安装 —— {versions}。",
  "{count} up to date": "{count} 个已是最新",
  "{count} older than your copy": "{count} 个比你装的旧",
  "{count} unsigned": "{count} 个未签名",
  "a changed publisher key": "换了发布者钥匙",
  "a blocked publisher key": "发布者钥匙已被拉黑",
  "1 of them has {notes}.": "其中 1 个：{notes}。",
  "{count} of them have {notes}.": "其中 {count} 个：{notes}。",
  "They are listed under Installed above.": "它们列在上面的“已安装”里。",

  // —— 首次引导（0011）：一张三步卡 + 目录区见底时那一句 ——
  "Three things, then you are set": "三件事，之后就看你的了",
  "Install one from the list below — the official pack is already unpacked.":
    "从下面挑一个装上 —— 官方包已经解好了，点一下就行。",
  "Click a card to put it on the canvas. The arrow sends a copy to your desktop.":
    "点一张卡片它就落在画布上；卡片上那颗箭头会把它复制一份放到真实桌面。",
  "More widgets come from catalogue sources: the official one is here, and anyone can publish another.":
    "更多组件来自目录源：官方那份已经在这儿了，别人的源谁都能发一份。",
  "Add another source": "加一个别的源",
  "Hide this and do not show it again": "收起来，别再问了",
  "Got it": "知道了",
  "That is everything your sources offer right now.": "你现在订的源里就这些了。",
  "Anybody can publish a catalogue. Paste its address and its widgets show up here, side by side with these.":
    "谁都能发一份目录。把地址粘进来，那份里的组件就会和这些并排出现在这儿。",

  // —— 商店卡片 ——
  Blocked: "已拉黑",
  Signed: "已签名",
  Unsigned: "未签名",
  "This version asks for a permission you have not granted": "这个版本要了一项你还没授予的权限",
  "Signed by {name} · {fingerprint}": "签名者 {name} · {fingerprint}",
  "This update asks for {permissions}": "这次更新要了 {permissions}",
  "Update to {version}": "更新到 {version}",
  "Already installed ({version})": "已安装（{version}）",
  "The catalogue only has {version} — you have {installed}. Nothing to do.":
    "商店里只有 {version}，你装的是 {installed}。无需操作。",
  "You blocked this publisher key ({fingerprint}). Nothing signed with it will be installed.":
    "你拉黑了这把发布者钥匙（{fingerprint}）。用它签名的东西都不会被安装。",
  "Unblock this key": "解除拉黑",
  "No publisher signature — this catalogue entry cannot be installed": "没有发布者签名 —— 这个条目无法安装",
  "Publisher key changed: was {old}, now {new}.": "发布者钥匙变了：原来是 {old}，现在是 {new}。",
  "Trust the new key and install": "信任新钥匙并安装",
  "The old key is blocked — it can no longer ship to you.": "旧钥匙已被拉黑 —— 它再也签不进来东西了。",
  "Stop trusting the previous key entirely — use this if it may have leaked":
    "彻底不再信任旧钥匙 —— 怀疑它泄露时用这个",
  "Block the old key instead": "改为拉黑旧钥匙",
  "Adds {permissions} — you will be asked to allow it.": "新增 {permissions} —— 安装后会请你授权。",
};
