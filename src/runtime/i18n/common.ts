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
};
