/**
 * assistant 的模型面 —— 唯一的门。
 *
 * 这一层不做任何事，只把三个文件重新导出一遍：传输（`./devLlm`：同一个命令在
 * 桌面走 IPC、在浏览器走 dev server 的 `/api/llm`）、IPC 面（`./assistant`：模型
 * 档、key、列模型、跑一轮对话、会话的读存删）、手（`./hands`：`assistant_tool`、
 * 六组开关、MCP 服务表与工具发现）。
 * 谁要用 assistant，import 这一个模块名就够，不必知道底下分成几个文件、更不必
 * 知道现在跑在窗口里还是浏览器里 —— `callCommand` 自己认。
 *
 * 浏览器预览里也是同一个模块：dev server 会把 `.ts` 直译，所以控制台里
 * `const llm = await import("/src/platform/llm.ts")` 之后 `llm.readLlmProfiles()`
 * 就能用，和面板走的是同一条路（key 仍然只在 Node 里）。
 *
 * 五条规矩：
 *   1. **这里只有 re-export，一行逻辑都不许加。** 一旦在这儿算点什么，它就从
 *      "门"变成"第二个家"，下次改行为的人会改错地方。
 *   2. **不另起名字。** 导出的就是源文件里的名字，不改前缀、不做别名 —— 一个
 *      东西两个叫法，读的人每次都得多猜一次（不变量 19）。
 *   3. **三个源文件不许反过来 import 这个门。** 它们之间是三条直线：`assistant`
 *      → `devLlm` / `hands`，`hands` → `devLlm`。回头指一下就是环，环在这套东西
 *      里不会报错，只会在某个加载顺序下变成 `undefined`。
 *   4. **面板不在门里。** `AssistantPanel.tsx` 是 React 组件，从这儿再导出会把
 *      JSX 和样式拖进"只想发一个命令"的调用方（`assistantMain.tsx` 那种不加载
 *      store 的入口最先遭殃）。要用面板就直接 import 那个组件。
 *   5. **加新东西的顺序：先加在源文件里，再回这儿补一行。** 不是反过来。
 *
 * 与 Rust 的分界：`llm.rs` 是这条面在桌面上真正的实现，`scripts/dev-llm-proxy.mjs`
 * 是它在 dev server 上的对照实现（两边都有测试钉着）。这个文件两样都不是。
 */

export { callCommand, devCommand, hasRust } from "./devLlm";

export {
  activateLlmProfile,
  cancelActiveTurn,
  deleteSession,
  describeDesktop,
  listModels,
  listSessions,
  loadSession,
  localSurface,
  readLlmProfiles,
  remoteSurface,
  removeLlmProfile,
  runAssistantTurn,
  runWidgetTurn,
  saveLlmKey,
  saveLlmProfile,
  saveSession,
} from "./assistant";
export type {
  ApprovalRequest,
  Approver,
  AssistantSession,
  AssistantSurface,
  ProfileView,
  ProfilesView,
  SavedProfile,
  SessionMessage,
  SessionSaved,
  SessionSummary,
  SessionUsage,
  TurnEvent,
  TurnOptions,
  WidgetTurnOutcome,
} from "./assistant";

export {
  callHand,
  cancelHand,
  discoverMcpTools,
  readHands,
  readMcpServers,
  saveHands,
  saveMcpServers,
} from "./hands";
export type { HandsReply } from "./hands";
