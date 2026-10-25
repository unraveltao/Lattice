/**
 * assistant 的三块：面板（`AssistantPanel`）、桌面小窗的壳
 * （`AssistantWindow`）、调试抽屉（`DebugPanel`）。
 *
 * 这一份是唯一一处"平台自己也在跟模型说话"的界面文案 —— 注意区别：
 * 组件的清单文案（组件名、说明）**不**进任何一张表，那是作者写的。
 */

export const ASSISTANT_ZH: Record<string, string> = {
  // —— 面板的壳：标题、齿轮、关闭 ——
  // 中文一律叫"助手"（GLOSSARY 的 assistant 条），别写成 "Assistant 设置" 这种半中半英
  Assistant: "助手",
  "Assistant · Not configured": "助手 · 未配置",
  "Assistant · {model}": "助手 · {model}",
  "Back to chat": "回到对话",
  "Model settings": "模型设置",
  "Assistant settings": "助手设置",

  // —— 会话（0003 §4）：一份对话一个文件，列表按最近改过的排 ——
  Chats: "对话",
  "New chat": "新建对话",
  "Delete this chat": "删除这个对话",
  "Damaged chat": "损坏的对话",
  "That chat could not be opened.": "这个对话打不开。",
  "This chat was too long, so its oldest {count} messages were dropped.":
    "这个对话太长了，最旧的 {count} 条已经被丢掉。",
  "Chats are saved on this machine as plain text — anything you paste in lands on disk. “Delete this chat” removes it.":
    "对话是明文存在这台机器上的——你粘进去的东西会落到盘上。「删除这个对话」会把它删掉。",

  // —— 设置态：档列表 + 表单 ——
  "no model yet": "还没有模型",
  "In use": "正在用",
  Use: "用它",
  "Make this the profile the assistant uses": "让助手改用这一档",
  "No model profile yet.": "还没有任何模型档。",
  "Add a model profile": "添加一档模型",
  "Add model provider": "添加一个模型服务",
  "Enter your API keys to use models from the following providers.":
    "填上 API key，就能用下面这些服务里的模型。",
  Ready: "可用",
  "No key": "缺 key",
  "Read the file again": "重新读取",
  "Read the file again.": "已经从文件里重读了一遍。",
  Name: "名字",
  "Leave empty to use the host name": "留空就用主机名",
  "API base URL": "接口地址",
  "Any OpenAI-compatible endpoint works. Plain http is only allowed for localhost.":
    "任何 OpenAI 兼容的地址都行；明文 http 只放回环地址。",
  "How does this endpoint want the key?": "这个地址要怎么带 key？",
  "Bearer token": "Bearer 令牌",
  "api-key header": "api-key 头",
  "No key (local model)": "不要 key（本机模型）",
  Model: "模型",
  "API key": "API key",
  "API key (currently {hint})": "API key（现在是 {hint}）",
  "Leave empty to keep the current key": "留空 = 不改",
  "This model cannot call tools — it can talk, but it cannot change the desktop.":
    "这个模型不能调用工具 —— 它能说话，但改不了桌面。",
  "Temperature {value} (lower is steadier; 0.4–0.8 works well for changing the desktop)":
    "温度 {value}（越低越稳，改桌面建议 0.4–0.8）",
  "Test connection": "测试连接",
  "Forget key": "删掉 key",
  "Delete profile": "删掉这一档",
  "Delete it and its key?": "连 key 一起删？",
  "Profile deleted, along with its key.": "这一档和它的 key 都删了。",
  "Saved. This profile is ready to use.": "已保存，这一档可以用了。",
  "Saved. A local model needs no key.": "已保存。本机模型不需要 key。",
  "Saved, but there is no key yet — paste one and save again.": "存下了，但还没有 key —— 粘一把再保存。",
  "Connected. {count} models are available — pick one below.": "连上了，有 {count} 个模型可用 —— 在下面挑一个。",
  "Connected, but this endpoint listed no models. Type the model name by hand.":
    "连上了，但这个地址没列出模型 —— 手写模型名。",
  "Key removed from this machine.": "key 已从本机删掉。",
  "This key comes from the environment, not from this machine's settings.":
    "这把 key 来自环境变量，不是这台机器的设置。",

  // —— 预设（只是填表的按钮，产品名不翻） ——
  "DeepSeek's own endpoint, OpenAI-compatible": "DeepSeek 官方接口，OpenAI 兼容",
  "OpenAI's own endpoint": "OpenAI 官方接口",
  "One key for many providers — pick a model after testing the connection":
    "一把 key 走很多供应商 —— 先测试连接再挑模型",
  "Moonshot's endpoint. Paste the key and list the models": "Moonshot 的接口。粘上 key 再列模型",
  "DashScope's OpenAI-compatible mode": "DashScope 的 OpenAI 兼容模式",
  "A model on this machine. No key needed": "本机上的模型，不用 key",
  "LM Studio's local server. No key needed": "LM Studio 的本地服务，不用 key",

  // —— 对话态：空态、过程、输入框 ——
  "Say something and it changes the desktop: “move the clock to the top right”, “switch to dark”, “the pet is too big, make it smaller”. Every step can be undone.":
    "说一句它就能改桌面：「把时钟挪到右上角」「换成深色」「桌宠太大了，调小一点」。每一步都能撤销。",
  "Thinking…": "正在想…",
  Stop: "停下",
  Send: "发送",
  "key from the environment": "key 来自环境变量",
  "Ask it to do something on the desktop (Enter to send, Shift+Enter for a new line)":
    "让桌面上发生点什么事（Enter 发送，Shift+Enter 换行）",

  // —— 对话里那一行工具结果（`describeToolCall` 拼的） ——
  // 参数是组件名 / 实例 id / 主题名，原样插进去，不要翻
  "a widget": "某个组件",
  "Add {widget}": "添加 {widget}",
  "Move {instance}": "移动 {instance}",
  "Resize {instance}": "调整 {instance} 大小",
  "Remove {instance}": "移除 {instance}",
  "Pin {instance}": "钉住 {instance}",
  "Unpin {instance}": "取消钉住 {instance}",
  "Bring {instance} to front": "把 {instance} 提到最前",
  "Switch theme to {theme}": "把主题换成 {theme}",
  "Pause every widget": "暂停全部组件",
  "Resume every widget": "恢复全部组件",

  // —— 桌面小窗的壳 ——
  "Hide (Ctrl+K brings it back)": "收起（Ctrl+K 再叫回来）",
  "Hide assistant": "收起助手",

  // —— 调试抽屉：标题、统计、过滤 ——
  "Widget debug panel": "组件调试面板",
  Debug: "调试",
  // 统计行里数字（`<b>`）在句子前面，所以这两条是接在数字后面的量词
  "bridge calls": "次桥调用",
  "console lines": "条 console 输出",
  failed: "条失败",
  "Record type": "记录类型",
  All: "全部",
  Bridge: "桥调用",
  Console: "console",
  "Failures only": "只看失败",
  "Filter by method, widget or text": "按方法、组件或文字过滤",
  "Resume — catch up with what arrived meanwhile": "继续 —— 把期间收到的补回来",
  "Freeze the view so you can read a row": "冻住画面，好把一行看清",
  Resume: "继续",
  Pause: "暂停",
  Clear: "清空",
  "Close (Ctrl+Shift+D)": "关闭（Ctrl+Shift+D）",
  "Close debug panel": "关闭调试面板",
  "Nothing yet. Bridge calls and console output from widgets show up here as they happen.":
    "还没有。组件发出的桥调用和 console 输出会实时出现在这里。",
  "No record matches the current filter.": "没有记录匹配当前的过滤条件。",
  // 行首那个 kind 标签（`KIND_LABEL` 的值，渲染时才 t()）
  bridge: "桥调用",
  console: "console",

  // —— 手：设置面板里的六组开关（0004）——
  "What it may do": "它能做什么",
  "Turn all off": "全部关掉",
  "Nothing is on by default. A group has to be turned on before its tools exist at all.":
    "默认全关。得先把一组打开，那一组工具才会存在。",

  // —— 审批档：三选一（0003 §3）——
  Approval: "审批档",
  Ask: "每次确认",
  Automatic: "自动",
  "Read-only": "只读",
  "Writes, commands and clicks wait for you. Reads run straight away.":
    "写文件、跑命令、点键鼠都会等你点头；读的那几只直接用。",
  "Nothing asks except removing a widget — the one step that cannot be undone.":
    "除了删除组件（那一步撤不回来），别的都不问。",
  "Writing tools are not even offered. It can look and talk, nothing else.":
    "会改东西的工具根本不给它。它只能看和说。",
  "Read-only mode is on, so {name} is not available. Tell the user where to change it.":
    "现在是只读档，{name} 用不了。告诉用户去哪儿改。",
  "Remove the widget {instanceId}": "删掉组件 {instanceId}",
  Files: "文件",
  "Read, list and search files anywhere; writing needs your approval.":
    "随便读、列、搜；要写就得你点头。",
  Commands: "命令",
  "Run PowerShell as you. No sandbox — every command asks first.":
    "用你的身份跑 PowerShell，没有沙箱 —— 每条命令都先问。",
  "Web pages": "网页",
  "Fetch a URL and read its text. No search engine.": "给个网址抓正文；没有搜索引擎。",
  Screen: "屏幕",
  "List windows and save screenshots. Text models cannot see the picture.":
    "列窗口、存截图；纯文本模型看不到图。",
  "Mouse and keyboard": "鼠标键盘",
  "Real clicks and keystrokes into whatever window has focus. Always asks.":
    "真的点、真的打字，落到当前焦点窗口；每次都问。",
  "External services (MCP)": "外部服务（MCP）",
  "Tools declared by MCP servers you add. Every call asks.":
    "你自己加的 MCP 服务器声明的工具；每次调用都问。",
  "Workspace folder": "工作目录",
  "Relative paths and commands start here. In the Ask mode, writing inside this folder does not ask again — writing outside it still does, and reading was never limited to it (change it and what asks changes).":
    "相对路径和命令从这里起算。「每次确认」档下，写进这个目录**不再问**，写到外面照旧问；读本来就不限于它（改这里会改变什么要问）。",
  "Coming in a later update": "后续版本",

  // —— 技能包（0005）——
  Skills: "技能",
  "{on} of {max} on": "已启用 {on} / {max}",
  "A skill is a written procedure: when to use it, then the steps. Turning one on only adds those words to the prompt — it never adds a tool, and every step it asks for still asks you first.":
    "技能是一份写下来的做法：什么时候用，然后是一步步怎么做。勾上它只是把这段字放进提示词 —— 不会多给任何工具，里面要做的事仍然先问你。",
  "No skills yet. Import one: a folder with a SKILL.md in it, or a single .md file.":
    "还没有技能。导入一个：一个里面有 SKILL.md 的目录，或者一个 .md 文件。",
  "Cannot read it": "读不成",
  "Its front matter has no description — write one so this line says what it is for.":
    "它的 front matter 里没有 description —— 补一句，这一行才能说明它是干什么的。",
  "{chars} characters": "{chars} 字",
  "needs {groups}": "需要 {groups}",
  "Delete its folder?": "删掉它的目录？",
  "Skill folder or .md file": "技能目录或 .md 文件",
  Import: "导入",
  "Added. Turn it on when you want it used.": "已导入。想让它生效再勾上。",
  "At most {limit} skills can be on at once — turn one off first.":
    "最多同时开 {limit} 份技能 —— 先关掉一份。",
  "A skill's text is capped at {limit} characters — “{name}” has {total}.":
    "一份技能的正文最多 {limit} 字 ——「{name}」有 {total} 字。",
  "The skills you turn on share {limit} characters — these would be {total}.":
    "开着的技能共用 {limit} 字额度 —— 这样会是 {total} 字。",

  // —— 审批确认条 ——
  "Approve this action": "批准这个动作",
  Allow: "允许",
  "Always this turn": "本轮都允许",
  Deny: "拒绝",
  "Write {bytes} characters to {path}": "写 {bytes} 个字符到 {path}",
  "Run: {command}": "执行：{command}",
  "Click at {x}, {y}": "点击 {x}, {y}",
  "Double-click at {x}, {y}": "双击 {x}, {y}",
  "Type: {text}": "打字：{text}",
  "Press {key}": "按键 {key}",
  "Call {tool}": "调用 {tool}",

  // —— 对话里那一行小标签 ——
  "List {folder}": "列出 {folder}",
  "Read {file}": "读 {file}",
  "Search for “{query}”": "搜索“{query}”",
  "Write {file}": "写 {file}",
  "Run {command}": "跑 {command}",
  "Fetch {url}": "抓取 {url}",
  "List windows": "列出窗口",
  "Take a screenshot": "截图",
  "Type {count} characters": "输入 {count} 个字符",

  // —— 预算触顶与"这一组关着" ——
  "The {group} capability is switched off in Assistant settings.":
    "「{group}」这组能力在助手设置里是关的。",
  "I stopped here: this turn has been running for {minutes} minutes.":
    "我停在这里了：这一轮已经跑了 {minutes} 分钟。",
  "I stopped here: this turn has used {tokens} tokens.": "我停在这里了：这一轮已经用了 {tokens} token。",

  // —— 外部服务（MCP）——
  "External services": "外部服务",
  "Refresh tools": "重新发现工具",
  "Asking…": "正在问…",
  "An MCP server brings its own tools. Every call still asks you first, and a server runs with your own permissions — there is no sandbox.":
    "MCP 服务器自带工具。每次调用仍然先问你；服务器用的是你自己的权限，没有沙箱。",
  "{count} tools": "{count} 个工具",
  "Remove": "移除",
  "Name (optional)": "名字（可不填）",
  "Server URL": "服务器地址",
  "Command and arguments": "命令与参数",
  "Use a command instead": "换成命令启动",
  "Use a URL instead": "换成网址连接",
  "Add server": "添加服务器",
  "Found {count} tools.": "找到 {count} 个工具。",
  "Saved. Refresh to see its tools.": "已保存。点重新发现看看它有哪些工具。",

  // —— 两个模式（0009）：内部 / 完全访问 ——
  // 界面上的名字「完全访问」（Full access）：`mode` 存的值仍是 `internal` / `everything`
  // （存值的字面量是历史，别为了改名去动 `assistant.json`）。不写"全权"（那是 0006 的名字）
  "Full access": "完全访问",
  Internal: "内部",
  "Files, commands, the web, the screen, input and MCP servers. Approvals are not asked.":
    "文件、命令、网页、屏幕、键鼠和 MCP 服务。一律不问。",
  "Held back by read-only mode — nothing can be changed.": "被只读档压住 —— 什么都不能改。",
  // 内部模式不是"一只都不给"：它照的是那六组开关（0009）。这句曾经写成
  // "六只手一只都不开"，和代码对不上，用户于是以为内部模式不能用工具
  "Manages Lattice, plus whichever hands you switch on. Approvals follow the mode you picked.":
    "管棂自己，加上你拨开的那几组手。要不要问由审批档决定。",
  "Internal mode gives the agent exactly the groups you switch on here. Full access switches them all on and stops asking.":
    "内部模式给它的正是你在这里拨开的那几组；完全访问六组全开，并且一律不问。",
  // 启用完全访问那一道确认（DSH 那一套形状：标题 + 风险段 + 硬线 + 必须勾的框 + 两颗按钮）
  "Enable Full access": "启用完全访问",
  "Turn off": "关掉",
  "Enable Full access?": "启用完全访问？",
  "Confirmation prompts go away: it reads and writes files anywhere, runs commands, fetches pages, screenshots, moves the mouse and types, and calls the MCP servers you added — without asking. The six groups below all switch on, so you can see what it got.":
    "确认条不再出现：它会读写任何地方的文件、跑命令、取网页、截屏、动鼠标、敲键盘、调你加的 MCP 服务 —— 都不再问一句。下面那六组会一起拨开，你能看见它到底拿到了什么。",
  "It reads and writes files anywhere, runs commands, fetches pages, screenshots, moves the mouse and calls MCP servers — without asking.":
    "它能读写任何地方的文件、跑命令、取网页、截屏、动鼠标、调 MCP 服务 —— 都不问。",
  "It still cannot install, uninstall or grant widgets.":
    "装 / 卸 / 授权组件仍然不在它的能力表里。",
  "Editing Lattice's own settings always asks.": "改棂自己的设置永远要问。",
  "Widgets cannot borrow it, and agent calls are unaffected.":
    "组件借不到它，agent 的 HTTP 端点也不受影响。",
  "The budget does not change: 24 steps, 5 minutes, 200k tokens.":
    "预算不变：24 步 / 5 分钟 / 20 万 token。",
  "Turning it off again takes one click, and turning it off never asks.":
    "想收回去点一下就关；关掉它从来不问。",
  "Read-only mode is on and wins — switch approvals to Ask or Automatic first.":
    "只读档开着，而且它优先 —— 先把审批档换成 Ask 或 Automatic。",
  "I understand the risks and want to continue": "我明白风险，继续",
  "This was already on when Lattice started.": "棂启动的时候它就已经是「完全访问」了。",
  "Got it": "知道了",
};
