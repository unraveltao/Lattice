/**
 * 到处都用到的那几个词。
 *
 * 分成这么一个文件是为了**同一句话只有一个译法**：`Save` 在属性面板、
 * 举报框、设置页里都出现，各写一份的话早晚会变成"保存 / 储存 / 存一下"。
 * 一个词只在这里出现一次，别处见到它就直接 `t("Save")`，不要再投票。
 *
 * 只收**已经被多个文件用到**的词。只在一个文件里出现的一句，写在那个文件
 * 自己的分片里 —— 否则这个文件会慢慢长成一张总表，失去"改哪块碰哪块"的意义。
 */

export const COMMON_ZH: Record<string, string> = {
  // —— 对话框 / 表单的三个动作 ——
  Save: "保存",
  Cancel: "取消",
  Close: "关闭",
  Back: "返回",
  Delete: "删除",
  Edit: "编辑",
  Remove: "移除",
  Retry: "重试",
  "Try again": "再试一次",
  // —— 安装与更新 ——
  Install: "安装",
  Installing: "正在安装…",
  Update: "更新",
  Updating: "正在更新…",
  Uninstall: "卸载",
  // —— 主题 / 语言这两行共用的三档 ——
  Light: "浅色",
  Dark: "深色",
  System: "跟随系统",
  // —— 商店的三种来源 ——
  Official: "官方",
  Bundled: "内置",
  "Custom URL": "自定义地址",
  // —— 通用小标题 ——
  Permissions: "权限",
  Settings: "设置",
  Search: "搜索",
  Version: "版本",
  Details: "详情",
  // —— 状态与结果（安装 / 保存 / 更新都可能落在这三句上） ——
  "Saving…": "保存中…",
  Installed: "已安装",
  "Up to date": "已是最新",
  // —— 星数的量词：数字由界面自己拼，这里只接量词 ——
  "{count} star": "{count} 颗星",
  "{count} stars": "{count} 颗星",
  // —— "怎么用"的入口：卡片上的 `?`、属性面板的说明节、举报框都会用到 ——
  "How to use {name}": "{name} 怎么用",
  // —— 层级：桌面（沉到壁纸上）与置顶 ——
  Desktop: "桌面",
  "On top": "置顶",
  // —— 全局搜索：顶栏那颗按钮和浮层的输入框共用同一句，别各译一遍 ——
  "Search widgets and the catalogue": "搜索组件与商店",
  /*
   * `All` 从 `assistant.ts` 搬过来的：调试面板用它当"全部记录"，
   * 画布总览的筛选按钮也用它。**两个以上文件用到的 key 归 common**，
   * 留在 assistant 里的话，总览一改就得去读调试面板那份文案。
   */
  All: "全部",
  // —— 画布总览（只读）：退后一步看全 ——
  Overview: "总览",
  "Filter by layer": "按层级筛选",
  "Nothing on the canvas yet": "画布上还没有东西",
  "Install a widget from the library, then it shows up here at its real size and place.":
    "从组件库装一个，它就会按真实的尺寸和位置出现在这里。",
  "Show the whole canvas at once (Ctrl+Shift+O)": "一眼看全整个画布（Ctrl+Shift+O）",
};
