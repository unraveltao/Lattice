#!/usr/bin/env node
// 给"不是我们写的启动方"（例如 Lattice 的 scripts/test-browser.mjs 用 spawnSync + timeout）兜底的 Chrome 包装器。
//
// 旧包装 `exec chrome` 的问题：调用方超时后只 SIGTERM 到主进程，子进程组留在 PPID=1。
// 这里：Chrome 自成进程组（detached），本进程收到 TERM/INT/HUP、正常退出、或发现父进程没了，
// 都对整组发信号。用法与 chrome 完全一致：chrome-guard.mjs <chrome 路径> [chrome 参数...]
import { spawn } from "node:child_process";
import { killGroup, groupMembers } from "../src/browser-runtime.mjs";

const [chrome, ...args] = process.argv.slice(2);
if (!chrome) {
  console.error("usage: chrome-guard.mjs <chrome> [args...]");
  process.exit(2);
}
const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "inherit", "inherit"] });
const pgid = child.pid;
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  await killGroup(pgid, { graceMs: 1500 });
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => void shutdown(128));
child.on("exit", (code, signal) => {
  // 主进程退了，但 --headless=new 的 helper 可能还在：整组清掉再退出
  void shutdown(code ?? (signal ? 128 : 0));
});
child.on("error", (e) => {
  console.error(String(e));
  process.exit(127);
});
// 父进程（调用方）被 SIGKILL 时我们收不到信号：每秒看一眼 ppid
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent || process.ppid === 1) void shutdown(129);
}, 1000).unref();
// 主进程退出而组里还有人：保险
process.on("exit", () => {
  if (groupMembers(pgid).length) try { process.kill(-pgid, "SIGKILL"); } catch {}
});
