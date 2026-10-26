/**
 * 终端组件（`lattice.term`）的事件形状 —— **宿主页**这一侧的那一份。
 *
 * 真正的产出在 `src-tauri/src/term.rs`（`emit("lattice:term", …)`），消费在组件
 * （`public/widgets/lattice.term/widget.js`）。这里只有类型：宿主页要做的事只有
 * 一件 —— 按 `instanceId` 认领，然后原样转给 iframe。
 *
 * 为什么中间要过一道宿主页：桥（`__lattice`）是 iframe ↔ 宿主的 `postMessage`，
 * Rust 的 `emit` 到不了 iframe。`config-changed` / `store-changed` 都是这么走的，
 * 这条也一样。
 *
 * 字段和设计稿（[0018](../../docs/design/0018-terminal-widget.md) §4）一致，
 * 只多一个 `seq`：窗口藏起来回来时靠它跟 `term.state` 对账。
 */

export type TermEventKind = "chunk" | "done" | "lost";

export interface TermEvent {
  /** 哪个实例的终端。`emit` 是广播，宿主页必须比这一项（不变量 9） */
  instanceId: string;
  /** 这一条命令的编号（`term.write` 的返回值） */
  id: string;
  /** 单调递增的事件序号，从 1 开始 */
  seq: number;
  kind: TermEventKind;
  /** `kind === "chunk"` 才有 */
  stream?: "stdout" | "stderr";
  /** `kind === "chunk"` 才有 */
  text?: string;
  /** `kind === "done"` 才有。`null` = 拿不到（哨兵没带回来） */
  code?: number | null;
  /** `kind === "done"` 才有：这条命令的输出被 64KB 上限截过 */
  truncated?: boolean;
}

export interface TermState {
  running: boolean;
  /** shell 现在的目录（来自上一条命令的哨兵；没跑过就是起始目录） */
  cwd: string;
  /** `powershell` / `pwsh`（`cmd` 是留着的位置，这一版不起它） */
  shell: string;
  /** 已经发到第几号事件。`term.state { since }` 用它补齐中间那段 */
  seq: number;
}
