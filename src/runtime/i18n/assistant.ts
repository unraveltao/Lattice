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

  // —— 设置态：地址 / 模型 / key / 温度 ——
  "API base URL": "接口地址",
  // 提示段落被 `<code>` 切成四段，这里只能逐段译（见 AssistantPanel 的那段 JSX）
  "OpenAI-compatible": "OpenAI 兼容的",
  ". DeepSeek, OpenAI, Kimi and Qwen each use their own": "。DeepSeek、OpenAI、Kimi、Qwen 各填自己的",
  "; a local model on this machine uses": "；本机模型填",
  "(plain http is only allowed for localhost).": "（明文 http 只放回环地址）。",
  Model: "模型",
  "API key (currently {hint})": "API key（现在是 {hint}）",
  "Leave empty to keep the current key": "留空 = 不改",
  "Temperature {value} (lower is steadier; 0.4–0.8 works well for changing the desktop)":
    "温度 {value}（越低越稳，改桌面建议 0.4–0.8）",
  "Test connection": "测试连接",
  "Forget key": "删掉 key",
  "Saved. Model {model}, key {hint} ({source}).": "已保存。模型 {model}，key {hint}（{source}）。",
  "from the environment": "来自环境变量",
  "stored on this machine": "存在本机",
  "Base URL and model saved, but there is no key yet — paste one and save again.":
    "地址和模型存下了，但还没有 key —— 粘贴一把再保存。",
  "Connected. This key can use {count} models: {list}": "连上了，这把 key 能用 {count} 个模型：{list}",
  "Key removed from this machine.": "key 已从本机删掉。",

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
