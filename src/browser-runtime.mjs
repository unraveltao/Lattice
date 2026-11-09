// 浏览器生命周期：每个 Chrome 都有"主人"，都能被证明是自己启动的，才会被回收。
//
// 事故原因（DSH-INCIDENT-001）：旧脚本 `spawn(chrome)` 后只在正常路径 `chrome.kill()`——
//   1. 只 SIGTERM 主进程，zygote/renderer/gpu 子进程以 PPID=1 留下；
//   2. 脚本崩溃、超时被杀时根本走不到 kill；
//   3. 没有任何登记，事后无法区分"我的"和"别人的"，所以只能手工按命令行猜。
// 这里的做法：
//   - detached 启动 → Chrome 自成进程组，回收时对 -pgid 整组发信号；
//   - 每次启动写一条登记（pid、pgid、/proc 启动时刻、owner、user-data-dir）；
//   - 回收前必须校验身份：pid 的 /proc 启动时刻与登记一致、cmdline 含登记的 user-data-dir、属于当前用户。
//     pid 被系统复用、或根本不是登记过的进程，一律拒绝，绝不"按名字杀"；
//   - 并发上限用槽位目录（mkdir 原子）实现，跨进程有效，槽位主人死了会被回收；
//   - reapOrphans() 只处理登记簿里的条目：主人进程已死或已超期才回收。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── /proc 小工具（Linux） ─────────────

/** /proc/<pid>/stat 的第 22 字段：进程启动时刻（jiffies）。pid 复用后这个数一定不同。 */
export function procStartTicks(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" "); // 从第 3 字段起
    return rest[19]; // 第 22 字段
  } catch {
    return null;
  }
}
export function procCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}
export function procUid(pid) {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
/** 僵尸（Z）算已经死了：它只等父进程收尸，不占内存也不会再做任何事。 */
export function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}
/** 进程组里还活着的成员 pid（含主进程）。 */
export function groupMembers(pgid) {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const s = readFileSync(`/proc/${name}/stat`, "utf8");
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      if (Number(f[2]) === pgid && f[0] !== "Z") out.push(Number(name)); // f[0]=state f[2]=pgrp
    } catch {
      /* 刚好退出 */
    }
  }
  return out;
}
export function groupRssMB(pgid) {
  let kb = 0;
  for (const pid of groupMembers(pgid)) {
    try {
      const m = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) kb += Number(m[1]);
    } catch {
      /* ignore */
    }
  }
  return Math.round(kb / 1024);
}
export function memAvailableMB() {
  const m = /^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Math.round(Number(m[1]) / 1024) : 0;
}

// ───────────── 登记簿 ─────────────

const regFile = (dir, id) => join(dir, "registry", `${id}.json`);

function writeEntry(dir, entry) {
  mkdirSync(join(dir, "registry"), { recursive: true });
  writeFileSync(regFile(dir, entry.id), JSON.stringify(entry));
}
export function listEntries(dir) {
  const d = join(dir, "registry");
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    try {
      out.push(JSON.parse(readFileSync(join(d, f), "utf8")));
    } catch {
      /* 半写的条目：下一轮再看 */
    }
  }
  return out;
}

/** 只有"确实是登记过的那个进程"才返回 true。 */
export function verifyIdentity(entry) {
  if (!alive(entry.pid)) return false;
  if (procStartTicks(entry.pid) !== entry.startTicks) return false; // pid 被复用
  if (procUid(entry.pid) !== process.getuid()) return false;
  const cmd = procCmdline(entry.pid);
  return cmd !== null && cmd.includes(entry.userDataDir);
}

/** 对整组发信号并等它走干净；先 TERM，超时再 KILL。返回 true 表示组里已无存活成员。 */
export async function killGroup(pgid, { graceMs = 2000 } = {}) {
  const send = (sig) => {
    try {
      process.kill(-pgid, sig);
    } catch {
      /* 组已空 */
    }
  };
  send("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (groupMembers(pgid).length === 0) return true;
    await sleep(50);
  }
  send("SIGKILL");
  const d2 = Date.now() + 3000;
  while (Date.now() < d2) {
    if (groupMembers(pgid).length === 0) return true;
    await sleep(50);
  }
  return groupMembers(pgid).length === 0;
}

async function release(dir, entry) {
  let clean = true;
  if (verifyIdentity(entry)) clean = await killGroup(entry.pgid);
  else if (groupMembers(entry.pgid).length > 0 && entry.leaderGone !== true) {
    // 主进程已不是登记的那个（或已死）但组里还有成员：这些成员是主进程的后代。
    // 进程组是我们自己 detached 创建的，pgid 一定等于当初的 pid；只要组长身份校验过期，
    // 就用"组内每个成员的 cmdline 都含 user-data-dir"来证明它们是我们的。
    const members = groupMembers(entry.pgid);
    const ours = members.every((p) => (procCmdline(p) ?? "").includes(entry.userDataDir));
    if (ours) clean = await killGroup(entry.pgid);
    else clean = false; // 证明不了就不动
  }
  if (clean) {
    live.delete(entry.id);
    try {
      rmSync(entry.userDataDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响进程回收 */
    }
    rmSync(regFile(dir, entry.id), { force: true });
    if (entry.slot) rmSync(join(dir, "slots", entry.slot), { recursive: true, force: true });
  }
  return clean;
}

// ───────────── 并发槽位 ─────────────

async function acquireSlot(dir, { max, owner, waitMs, signal }) {
  const slots = join(dir, "slots");
  mkdirSync(slots, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted while waiting for a browser slot");
    for (let i = 0; i < max; i++) {
      const p = join(slots, `s${i}`);
      try {
        mkdirSync(p); // 原子：谁先建成谁拿到
        writeFileSync(join(p, "owner.json"), JSON.stringify({ pid: process.pid, startTicks: procStartTicks(process.pid), owner, at: Date.now() }));
        return `s${i}`;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // 槽位主人已死 → 回收
        try {
          const o = JSON.parse(readFileSync(join(p, "owner.json"), "utf8"));
          if (!alive(o.pid) || procStartTicks(o.pid) !== o.startTicks) rmSync(p, { recursive: true, force: true });
        } catch {
          /* 刚建好还没写 owner：等一轮 */
        }
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a browser slot (limit ${max})`);
    await sleep(50);
  }
}

/**
 * 按实测内存算并发上限：留出 reserveMB 给系统和 DSH 本体，其余按单个浏览器的实测占用分。
 * 事故机器是 5.6GB：126 个残留进程吃掉约 3.9GB；一个 headless Chrome（带页面）实测（RSS 合计，含共享页，偏保守）约 440–490MB。
 */
export function suggestConcurrency({ perBrowserMB = 480, reserveMB = 1500, hardMax = 4 } = {}) {
  const n = Math.floor((memAvailableMB() - reserveMB) / perBrowserMB);
  return Math.max(1, Math.min(hardMax, n));
}

// ───────────── 本进程的兜底：即使走不到 finally 也不留孤儿 ─────────────
// `process.exit()`、未捕获异常、收到 TERM/INT/HUP：finally 都可能走不到（事故里的 CDP 脚本就是这样留下 126 个进程的）。
// 这里同步地对本进程启动、还没 close 的浏览器整组发 SIGKILL。process.kill 是同步系统调用，'exit' 钩子里能用。

const live = new Map(); // entry.id -> entry
let hooked = false;
function killAllLiveSync() {
  for (const e of live.values()) {
    try {
      process.kill(-e.pgid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
    try {
      rmSync(e.userDataDir, { recursive: true, force: true });
      rmSync(regFile(e.dir, e.id), { force: true });
      if (e.slot) rmSync(join(e.dir, "slots", e.slot), { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
  live.clear();
}
function hookProcess() {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAllLiveSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    // 调用方自己已经处理该信号就不抢；没有人处理时，清理完按默认行为退出
    if (process.listenerCount(sig) === 0) {
      process.on(sig, () => {
        killAllLiveSync();
        process.exit(128);
      });
    }
  }
}

// ───────────── 启动 / 使用 / 回收 ─────────────

/**
 * @param {object} o
 * @param {string} o.dir          登记簿与槽位目录（同一台机器上所有任务共用同一个，才能全局限流）
 * @param {string} o.chrome       Chrome 可执行文件（可以是包装脚本，只要它 exec 到 chrome）
 * @param {string} o.owner        任务 id；写进登记簿，事后能查是谁的
 * @param {number} [o.max]        并发上限，默认按内存估
 * @param {number} [o.waitMs]     排队等槽位的最长时间
 * @param {number} [o.ttlMs]      这个浏览器最长活多久；超过它的会被 reapOrphans 回收
 * @param {AbortSignal} [o.signal] 用户取消
 */
export async function launchBrowser(o) {
  const max = o.max ?? suggestConcurrency();
  const slot = await acquireSlot(o.dir, { max, owner: o.owner, waitMs: o.waitMs ?? 60_000, signal: o.signal });
  const userDataDir = mkdtempSync(join(tmpdir(), "dsh-chrome-"));
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  let child;
  try {
    child = spawn(
      o.chrome,
      [
        "--headless=new",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(o.args ?? []),
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    await new Promise((res, rej) => {
      child.once("spawn", res);
      child.once("error", rej);
    });
  } catch (e) {
    rmSync(join(o.dir, "slots", slot), { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
    throw e;
  }
  const entry = {
    id,
    pid: child.pid,
    pgid: child.pid, // detached ⇒ setsid ⇒ 组 id = pid
    startTicks: procStartTicks(child.pid),
    owner: o.owner,
    ownerPid: process.pid,
    ownerStartTicks: procStartTicks(process.pid),
    userDataDir,
    slot,
    startedAt: Date.now(),
    expiresAt: Date.now() + (o.ttlMs ?? 15 * 60_000),
  };
  entry.dir = o.dir;
  live.set(entry.id, entry);
  hookProcess();
  writeEntry(o.dir, entry);
  // 主进程是 wrapper 时 exec 之后 cmdline 才变；等到 cmdline 里出现 user-data-dir 再放行，
  // 这样 verifyIdentity 在 launch 返回时就必然成立
  for (let i = 0; i < 100 && !(procCmdline(entry.pid) ?? "").includes(userDataDir); i++) await sleep(20);
  entry.startTicks = procStartTicks(child.pid);
  writeEntry(o.dir, entry);

  const handle = {
    entry,
    pid: entry.pid,
    userDataDir,
    /** 等 DevToolsActivePort 出现，返回调试端口 */
    async debugPort(timeoutMs = 15_000) {
      const f = join(userDataDir, "DevToolsActivePort");
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        try {
          const port = Number(readFileSync(f, "utf8").split("\n")[0]);
          if (port > 0) return port;
        } catch {
          /* 还没写 */
        }
        if (!alive(entry.pid)) throw new Error("browser exited before it opened a debugging port");
        await sleep(50);
      }
      throw new Error("browser did not open a debugging port in time");
    },
    rssMB: () => groupRssMB(entry.pgid),
    members: () => groupMembers(entry.pgid).length,
    close: () => release(o.dir, entry),
  };
  return handle;
}

/**
 * 在一个浏览器里干活；无论成功、抛错、超时还是被取消，finally 里一定回收整组进程。
 * `fn(browser, signal)` 里应当尊重 signal；即使不尊重，超时到了也会强制回收（fn 会因此失败）。
 */
export async function withBrowser(o, fn) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(o.signal.reason ?? new Error("cancelled"));
  if (o.signal) {
    if (o.signal.aborted) throw new Error("cancelled before the browser started");
    o.signal.addEventListener("abort", onAbort, { once: true });
  }
  const browser = await launchBrowser({ ...o, signal: ac.signal });
  let timer;
  let killedByGuard = null;
  const guard = new Promise((_, rej) => {
    const stop = (why) => {
      killedByGuard = why;
      void browser.close().finally(() => rej(new Error(why)));
    };
    if (o.timeoutMs) timer = setTimeout(() => stop(`browser task timed out after ${o.timeoutMs}ms`), o.timeoutMs);
    ac.signal.addEventListener("abort", () => stop("browser task cancelled"), { once: true });
  });
  guard.catch(() => {});
  try {
    return await Promise.race([fn(browser, ac.signal), guard]);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    if (killedByGuard === null) await browser.close();
    else await browser.close(); // 幂等：组已空时直接清登记
  }
}

/**
 * 回收"主人已经不在"或"超期"的登记项。**只看登记簿**，对不在簿上的 Chrome 一概不碰。
 * 返回 { reaped, skipped:[{id,reason}] }。
 */
export async function reapOrphans(dir, { now = Date.now() } = {}) {
  const reaped = [];
  const skipped = [];
  for (const e of listEntries(dir)) {
    const ownerGone = !alive(e.ownerPid) || procStartTicks(e.ownerPid) !== e.ownerStartTicks;
    const expired = now > e.expiresAt;
    if (!ownerGone && !expired) {
      skipped.push({ id: e.id, reason: "owner still running" });
      continue;
    }
    const ok = await release(dir, e);
    if (ok) reaped.push(e.id);
    else skipped.push({ id: e.id, reason: "identity not provable — left alone" });
  }
  // 已无主人的槽位（崩溃的任务没来得及放）
  const slots = join(dir, "slots");
  if (existsSync(slots)) {
    for (const s of readdirSync(slots)) {
      try {
        const o = JSON.parse(readFileSync(join(slots, s, "owner.json"), "utf8"));
        if (!alive(o.pid) || procStartTicks(o.pid) !== o.startTicks) rmSync(join(slots, s), { recursive: true, force: true });
      } catch {
        /* 空槽位目录（刚建好）：不动 */
      }
    }
  }
  return { reaped, skipped };
}
