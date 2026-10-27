/**
 * 外壳与面板之外那些地方的英文 → 中文。
 *
 * 一眼就能看出哪块归谁：
 *   - `shell.ts`   平台外壳：顶栏、画布、组件库、属性面板、说明页、举报框、设置菜单
 *   - `panels.ts`  assistant 面板与小窗、调试面板
 *   - `misc.ts`    非组件的模块：商店客户端、桌面投放、开机自启、权限标签、错误话
 *
 * 三条规矩：
 * 1. **key 就是英文原文**，一个字都不能差（见 `runtime/i18n.ts` 的文件头）。
 * 2. **带 `{name}` 的句子两边都要有同一个占位符**，否则那处会露出 `{name}`。
 * 3. 只收"用户看得见的字"。日志、`console.warn`、注释不进这张表。
 */
export const MISC_ZH: Record<string, string> = {
  // —— 权限名（`runtime/manifest.ts` 的 `PERMISSION_LABELS` 是英文原文）——
  "System time": "系统时间",
  "Widget storage": "组件存储",
  "Write clipboard": "写剪贴板",
  "Network access": "网络访问",
  "System metrics": "系统指标",
  "Media control": "媒体控制",
  "Sound level": "声音响度",
  "Open links": "打开链接",
  "Agent activity": "Agent 活动",
  "Use my AI model": "用我的 AI 模型",
  "Agent tool calls": "调用组件声明的工具",
  "Run commands": "在终端里跑命令",
  "Store a secret for me": "替我保管一个密钥",
  "Save files": "保存文件",
  "Rearrange my desktop": "替我调整桌面",

  // —— 商店：这份东西有多旧（`platform/catalogue.ts` 的 describeAge）——
  "just now": "刚刚",
  "{minutes} minutes ago": "{minutes} 分钟前",
  "{hours} hours ago": "{hours} 小时前",
  "{days} days ago": "{days} 天前",

  // —— 商店：读不到、读到的不是最新那份 ——
  "no reason given": "没有给出原因",
  "{url} could not be reached ({reason}). Showing the copy from {age}.":
    "连不上 {url}（{reason}）。显示的是 {age}的那一份。",
  "{url} could not be reached ({reason}). This is the catalogue that ships with the app.":
    "连不上 {url}（{reason}）。这是随应用一起发的那份商店数据。",
  "the catalogue is not valid JSON: {error}": "商店数据不是合法的 JSON：{error}",
  "the catalogue could not be read": "商店数据读不出来",
  "the bundled catalogue is missing (HTTP {status}) — run npm run store:index":
    "内置商店数据缺失（HTTP {status}）—— 跑一下 npm run store:index",
  "a remote catalogue needs the desktop app — run npm run tauri:dev":
    "远端商店需要桌面应用 —— 跑一下 npm run tauri:dev",

  // —— 商店：安装失败 ——
  "{id} has no publisher key — refusing to install an unsigned package":
    "{id} 没有发布者钥匙 —— 拒绝安装未签名的包",
  "could not download {url} (HTTP {status})": "下载不了 {url}（HTTP {status}）",

  // —— 清单校验（组件库的"加载失败"卡片上那几句）——
  "manifest.json is not an object": "manifest.json 不是一个 JSON 对象",
  'id "{id}" is not a reverse-domain id, e.g. lattice.clock':
    'id "{id}" 不是反向域名格式，例如 lattice.clock',
  'version "{version}" is not a valid semver string': '版本号 "{version}" 不是合法的语义化版本',
  'missing required field "{field}"': '缺少必填字段 "{field}"',
  "Unknown author": "未知作者",

  // —— assistant：工具循环走到步数上限 ——
  "I stopped here: a single turn can run at most {steps} tool steps.":
    "我先停在这里：一轮对话最多 {steps} 步操作。",
};
