/**
 * 设置浮层（`SettingsMenu.tsx`）的文案。
 *
 * 单独一片，是因为这里句子最长：开机自启、目录来源、拉黑名单那几段都是
 * 三四行的解释。它们几乎不会和别处重复，混进大表里只会让"改设置页"变成
 * 一次全表搜索。
 */

export const SETTINGS_ZH: Record<string, string> = {
  // —— 浮层本身 ——
  "Settings (Ctrl+,)": "设置（Ctrl+,）",

  // —— 账号卡 ——
  "Not signed in": "未登录",
  "Local profile": "本机档案",
  "Sign in to keep your preferences": "登录后，偏好就记在这台电脑上",
  "On canvas": "画布上",
  "Edit profile": "编辑资料",
  "Sign in": "登录",

  // —— 外观 / 语言 ——
  Appearance: "外观",
  Language: "语言",
  "Follow Windows": "跟随 Windows",

  // —— 画布与桌面行为 ——
  "Snap to grid": "吸附网格",
  "Align to an 8px grid while dragging": "拖动时按 8px 网格对齐",
  "Restore on launch": "启动时恢复",
  "Put your desktop widgets back when Lattice starts": "棂启动时把桌面上的组件放回原位",
  "Restore widgets on launch": "启动时恢复组件",
  "Start with Windows": "开机自启",
  "Launch Lattice when you sign in, so your widgets are already there":
    "登录 Windows 时自动启动棂，组件直接就在桌面上",
  "Start Lattice with Windows": "随 Windows 启动棂",
  "Pause widgets": "暂停组件",
  "Hide the widgets on your desktop and stop their timers, without closing Lattice":
    "把桌面上的组件藏起来、停掉它们的计时器，不用退出棂",
  "Pause desktop widgets": "暂停桌面组件",

  // —— Agent 接入 / assistant ——
  "Agent access": "Agent 接入",
  "Token lives in %APPDATA%\\com.iron-tom.lattice\\agent\\endpoint.json":
    "令牌在这个文件里：%APPDATA%\\com.iron-tom.lattice\\agent\\endpoint.json",
  "Let a local agent read and arrange the desktop over 127.0.0.1":
    "允许本机 agent 经 127.0.0.1 读取并摆放桌面",
  "Allow agent access": "允许 agent 接入",
  "AI assistant": "AI 助手",
  "Talk to your own model with your own API key, and it arranges the desktop for you (Ctrl+K)":
    "用自己的模型和 API key 说话，它替你把桌面摆好（Ctrl+K）",
  "Model · key · Ctrl+K": "模型 · key · Ctrl+K",
  "Registered for a different build — flip this off and on to point it at this one.":
    "自启项还指着另一份安装 —— 关一下再打开，就指到这一份了。",

  // —— 商店 / 关于 / 退出 ——
  "Widget catalogue": "组件商店",
  Profile: "个人资料",
  "About Lattice": "关于棂",
  "local-first": "本地优先",
  "Check for updates": "检查更新",
  "Sign out": "退出登录",
  "Quit Lattice": "退出棂",

  // —— 登录与个人信息表单 ——
  "Your name": "你的名字",
  "No email yet": "还没填邮箱",
  "Display name": "显示名称",
  "What should we call you?": "怎么称呼你？",
  "Email (optional)": "邮箱（可选）",
  "Stored on this computer only. Nothing is uploaded, no password needed, and it is removed with the rest of the platform data.":
    "只存在这台电脑上：不上传、不需要密码，清掉平台数据时它一起消失。",

  // —— 商店来源表单 ——
  "Catalogue address": "商店地址",
  "The catalogue that ships with the app — a demo for when the network is down. Its packages are signed with a public key, so switching back to a real catalogue later will ask you to confirm a different publisher.":
    "跟着应用一起发的那份商店数据，断网时用它兜底演示。里面的包是用一把公开钥匙签的，所以以后换回真商店，会让你先确认另一个发布者。",
  "A plain JSON file — any static host works, no server needed. Packages are verified against the publisher key in that file before they are installed.":
    "一个普通 JSON 文件，放在哪个静态主机上都行，不需要服务端。装包之前，会按这个文件里的发布者钥匙验一遍。",
  "Blocked publishers": "拉黑的发布者",
  "Nothing blocked. Blocking a publisher key means nothing signed with it will be installed — pinned keys do not help if the key itself leaks.":
    "还没有拉黑任何发布者。拉黑一把发布者钥匙，意味着它签的包一个都装不上 —— 钥匙本身泄露了，钉住它也挡不住。",
  Unblock: "取消拉黑",

  // —— 更新那一条 ——
  "Checking…": "检查中…",
  "Install v{version}": "安装 v{version}",
  "Update to v{version}, then Lattice restarts": "更新到 v{version}，然后棂会重启",
  Failed: "失败",
  Check: "检查",
  "Ask the release page whether a newer version exists": "去发布页看看有没有更新的版本",
};
