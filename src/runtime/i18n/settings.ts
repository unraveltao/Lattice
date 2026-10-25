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
  Version: "版本",
  "Update Channel": "更新通道",
  Stable: "稳定版",
  "Only one channel today — the update feed skips pre-releases, so a beta never arrives on its own.":
    "目前只有一条通道：更新源会跳过预发布版，beta 不会自动送达。",
  "Open source": "开源",
  "Star on GitHub": "去 GitHub 点星",
  "Open source and local-first: no account, no server of ours.":
    "开源、本地优先：没有账号，也没有我们的服务端。",
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

  // —— 设置面板的分区 ——
  Account: "账户",
  Models: "模型",
  Desktop: "桌面",
  About: "关于",
  Theme: "主题",
  "Settings sections": "设置分区",
  "Close settings": "关闭设置",
  "Open configuration file": "打开配置文件",
  "Applies to this window and every widget on your desktop.": "主窗口和桌面上的每个组件都会跟着变。",
  "The whole platform switches immediately. Widgets pick it up on their next frame.":
    "整个平台立即切换；组件在下一帧跟上。",
  "Widgets install from the library; this only decides where packages come from.":
    "组件从组件库安装；这里只决定包从哪里来。",
  "The built-in assistant uses your own OpenAI-compatible endpoint. Its key never reaches a widget.":
    "内置助手用你自己的 OpenAI 兼容地址；key 不会交给任何组件。",

  // —— 帮助页 ——
  "Get help": "获取帮助",
  "These pages are the repository's own Markdown, bundled with the app.":
    "这些页面就是仓库里那份 Markdown，跟着应用一起打包。",
  "They are written in Chinese.": "它们用中文撰写。",
  "Could not read this page": "这一页读不出来",
  "All documentation": "全部文档",
  "Open on GitHub": "在 GitHub 打开",
  "Report a problem": "报告问题",
  "Open an issue": "开一个 issue",

  // —— 帮助页的目录（标题即文档名，一句话说它回答什么）——
  "Start here": "从这里开始",
  Building: "做组件",
  "The project": "项目",
  "Documentation map": "文档地图",
  "Which page answers which question": "哪份文档回答哪类问题",
  Glossary: "术语表",
  "Directory, manifest, placement — the words this project reuses":
    "目录、清单、实例 —— 这个项目反复用的词",
  "Widget spec": "组件规范",
  "Manifest, bridge, permissions, region art": "清单、桥、权限、异形贴图",
  Architecture: "架构",
  "Three layers, sandbox, windows, data": "三层、沙箱、窗口、数据",
  Pitfalls: "踩过的坑",
  "Look up a symptom, not a version": "按症状查，不按版本",
  "Platform rules": "平台规矩",
  "What platform code must not break": "改平台代码不许碰什么",
  "Build and release": "构建与发版",
  "Toolchain, packaging, the release checklist": "工具链、打包、发版清单",
  Roadmap: "路线图",
  "Where it is, what was overturned, what comes next": "走到哪、被推翻的决定、接下来做什么",
  "Version archive": "版本档案",
  "The long-form log of every version": "每个版本的逐条流水",

  // —— 档案页 ——
  "No profile yet": "还没有本机档案",
  "Give this computer a name. Nothing leaves it.": "给这台电脑起个名字。它不会离开这台电脑。",
  "Create local profile": "创建本机档案",
  "Member since {date}": "自 {date} 起",
  "Active days": "活跃天数",
  "Day streak": "连续天数",
  "Total time": "累计时长",
  Activity: "使用记录",
  "Last 12 months": "过去 12 个月",
  "Daily activity over the last year": "过去一年的每日活跃",
  Less: "少",
  More: "多",
  "No activity yet — the heatmap starts recording from today.": "还没有记录。热力图从今天开始记。",
  Mon: "一",
  Wed: "三",
  Fri: "五",
  "Clear usage history": "清除使用记录",
  "Clear the local activity record? Your profile stays.": "清除本机使用记录？档案会保留。",
};
