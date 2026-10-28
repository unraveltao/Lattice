/**
 * 平台外壳：`App.tsx`（顶栏 / 提示条 / 横幅）、`Canvas.tsx`、`WidgetFrame.tsx`。
 *
 * key 就是英文原文（见 `runtime/i18n.ts`）。带 `{name}` 的句子两边占位符要一致。
 */
export const SHELL_ZH: Record<string, string> = {
  // —— 顶栏：一句"要不要送到桌面" ——
  "Turn canvas widgets into real desktop windows; the main window will step aside":
    "把画布上的组件变成真正的桌面窗口；主窗口会让到一边",
  "Not available in browser preview — run npm run tauri:dev":
    "浏览器预览里不可用 —— 请跑 npm run tauri:dev",
  "Bring back": "收回来",
  "Running on the desktop — open it there, or send it back to edit.":
    "正在桌面上跑 —— 去桌面上看它，或者先收回来再调。",
  "Send to desktop": "投放到桌面",
  "Search widgets and the catalogue (Ctrl+Shift+F)": "搜索组件与商店（Ctrl+Shift+F）",
  "Assistant — tell it what to change on your desktop (Ctrl+K, separate window)":
    "助手 —— 说一句就能改桌面（Ctrl+K，独立小窗）",
  "Toggle assistant": "开关助手",
  "Theme: {current} — click for {next}": "主题：{current} —— 点击切换到 {next}",
  "Theme: {current}": "主题：{current}",

  // —— 设置菜单里原来长在顶栏的两项 ——
  "Debug panel": "调试面板",
  "Bridge calls and widget console, live (Ctrl+Shift+D)":
    "桥调用与组件控制台，实时（Ctrl+Shift+D）",
  "Toggle debug panel": "开关调试面板",
  "Rescan widgets": "重新扫描组件",
  "Rescan the widgets folder": "重新扫描组件文件夹",
  "Refresh widgets": "刷新组件",

  // —— 安装 / 回滚 / 拖放的提示条 ——
  "Could not reload the widget: {error}": "无法重新加载组件：{error}",
  "Installing from the catalogue needs the desktop app.": "从商店安装需要桌面应用。",
  "{name} is signed with a key you blocked ({key}) — unblock it first.":
    "{name} 的签名用了一把已被你拉黑的钥匙（{key}）—— 先解除拉黑。",
  "{name} is signed with a different key now — confirm it on the card first.":
    "{name} 的签名换了一把新钥匙 —— 先在卡片上确认。",
  "Updated {name} to {version}": "已把 {name} 更新到 {version}",
  "Installed {name} {version}": "已安装 {name} {version}",
  "Rolled {name} back to {version}": "已把 {name} 回滚到 {version}",
  "the previous version": "上一版",
  "Could not roll back: {error}": "回滚失败：{error}",
  '"{id}" collides with a bundled widget id — rename it and try again':
    "「{id}」和内置组件的 id 撞了 —— 改个名字再试",
  "Installed {names} — click a card to place it on the canvas":
    "已安装 {names} —— 点一张卡片把它放到画布上",
  "Could not open the widgets folder: {error}": "打不开组件文件夹：{error}",
  "Blocked publisher key {key}": "已拉黑发布者钥匙 {key}",
  "Unblocked publisher key {key}": "已解除拉黑发布者钥匙 {key}",

  // —— 底部：新权限横幅、崩溃提示、撤销条 ——
  "{version} asks for {permissions}. It stays denied until you allow it.":
    "{version} 新增了权限：{permissions}。在你允许之前，它一直处于未授权状态。",
  Allow: "允许",
  "Keep it denied": "保持拒绝",
  "keeps crashing — its window stopped reloading.": "反复崩溃 —— 它的窗口已经停止重新加载。",
  Dismiss: "关闭",
  Removed: "已移除",
  Undo: "撤销",

  // —— 画布：空态与缺失组件的占位卡 ——
  "The desktop is still empty": "桌面还是空的",
  "Drag one from the library, or just click a widget card":
    "从组件库拖一个过来，或者直接点一张卡片",
  "Empty — exactly as intended": "空的 —— 这正是设计",
  "The platform ships with no widgets. Install a pack on the left, or drop your own into the widgets/ folder.":
    "平台不带任何组件。在左边装一个包，或者把你自己的丢进 widgets/ 文件夹。",
  "Widget not installed": "组件未安装",
  "Widget missing": "组件不见了",

  // —— 画布上的实例卡（WidgetFrame） ——
  "Drag to move": "拖动以移动",
  "Entry URL is empty": "入口地址是空的",
  "The manifest entry could not be resolved — check manifest.json.":
    "清单里的入口解析不出来 —— 检查 manifest.json。",
  "Script error": "脚本错误",
  "Unhandled rejection": "未处理的 Promise 拒绝",
  "Missing file": "文件缺失",
  "Reload widget": "重新加载组件",
  Reload: "重新加载",
  "Needs {permission}": "需要「{permission}」",
  "+{count} more": "+{count} 项",
  "Grant all": "全部授权",
  Grant: "授权",
  "Drag to resize": "拖动以调整大小",

  // —— 桌面窗口的窗饰与超时（`widgetHost.ts`、`App.tsx` 的 withTimeout） ——
  "Toggle layer": "切换层级",
  "Pin position": "锁定位置",
  "Lock position": "锁定位置",
  "Unlock position": "解锁位置",
  "Lock position and size": "锁定位置和大小",
  "Unlock": "解锁",
  "Unlock to move": "解锁后可拖动",
  "On the desktop": "贴在桌面",
  "Floating window": "浮窗",
  // —— assistant 小窗的底板面板（`AssistantWindow.tsx`） ——
  "Backdrop": "底板",
  "Tint": "底色",
  "Dim": "浓度",
  "Blur": "模糊",
  "Dark": "深色",
  "Light": "浅色",
  "Position locked — click to unlock": "位置已锁定 —— 点击解锁",
  // 三档层级的提示语：先说现在在哪，再说点一下去哪儿
  "On top — click to go back to the desktop layer": "置顶中 —— 点击回到桌面层",
  "Normal window — click to keep on top": "普通窗口 —— 点击置顶",
  "Desktop layer — click for a normal window": "已贴桌面 —— 点击换成普通窗口",
  "On top layer": "置顶层",
  "Normal window layer": "普通窗口层",
  "Desktop layer": "桌面层",
  // assistant 小窗那两颗药丸用的，和组件的三档层级不是一套词
  "Send to desktop layer": "送到桌面层",
  "Keep on top": "保持置顶",
  "Close widget": "关闭组件",
  "Dismiss error": "关闭这条错误提示",
  "Stack trace": "调用栈",
  "Restoring desktop widgets": "恢复桌面组件",
  "Bringing widgets back": "收回桌面组件",
  "Sending widgets to the desktop": "把组件投放到桌面",
  "{label} did not answer within {seconds}s": "{label} 在 {seconds} 秒内没有响应",
};
