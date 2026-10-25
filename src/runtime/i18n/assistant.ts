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

  // —— 设置态：档列表 + 表单 ——
  "no model yet": "还没有模型",
  "In use": "正在用",
  Use: "用它",
  "Make this the profile the assistant uses": "让助手改用这一档",
  "No model profile yet.": "还没有任何模型档。",
  "Add a model profile": "添加一档模型",
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
};
