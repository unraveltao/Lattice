import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = `${process.env.HOME}/tools/chrome-wrap.sh`;
const GUARD = new URL("../bin/chrome-guard.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procsWith = (marker) => {
  let n = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(marker)) n++; } catch {}
  }
  return n;
};
const argsFor = (udd) => ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${udd}`, "--no-first-run"];

test("调用方 spawnSync 超时（SIGTERM）后，整组 Chrome 一起退出 —— 重现事故里 test:browser ETIMEDOUT 的形态", async () => {
  const udd = mkdtempSync(join(tmpdir(), "guard-t1-"));
  const r = spawnSync(process.execPath, [GUARD, CHROME, ...argsFor(udd)], { timeout: 2500 });
  assert.equal(r.error?.code, "ETIMEDOUT");
  for (let i = 0; i < 50 && procsWith(udd) > 0; i++) await sleep(100);
  assert.equal(procsWith(udd), 0);
});

test("对照：旧写法（spawn 后只在正常路径 kill，脚本中途 exit）确实会留下孤儿 —— 证明下面的兜底测试有鉴别力", async () => {
  const udd = mkdtempSync(join(tmpdir(), "guard-t2-"));
  // c3-head.mjs 的旧形态：非 detached spawn，只有走到末尾才 chrome.kill()
  const legacy = spawnSync(process.execPath, ["-e", `const c=require("child_process").spawn(${JSON.stringify(CHROME)},${JSON.stringify(argsFor(udd))},{stdio:"ignore"});setTimeout(()=>{process.exit(1)},2500)`], { timeout: 10000 });
  assert.equal(legacy.status, 1);
  await sleep(500);
  const leaked = procsWith(udd);
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(udd)) process.kill(Number(name), "SIGKILL"); } catch {}
  }
  assert.ok(leaked >= 3, `旧写法应当泄漏整组进程，实际残留 ${leaked}`);
});

test("新写法：fn 里直接 process.exit()、或抛未捕获异常，都不留进程、不留登记与临时目录", async () => {
  for (const how of ["process.exit(3)", "setTimeout(()=>{ throw new Error('uncaught') }, 10); await new Promise(()=>{})"]) {
    const dir = mkdtempSync(join(tmpdir(), "guard-reg-"));
    const marker = `/tmp/dsh-chrome-`;
    const before = procsWith(marker);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { withBrowser } from ${JSON.stringify(new URL("../src/browser-runtime.mjs", import.meta.url).href)};
      await withBrowser({ dir: ${JSON.stringify(dir)}, chrome: ${JSON.stringify(CHROME)}, owner: "exit-test", max: 1 }, async (b) => { await b.debugPort(); ${how}; });
    `], { timeout: 30000 });
    assert.ok(r.status === 3 || r.status === 1, `exit status ${r.status}`);
    await sleep(300);
    assert.equal(procsWith(marker), before, `${how}: 残留进程`);
    assert.equal(readdirSync(join(dir, "registry")).length, 0, `${how}: 登记没清`);
  }
});

test("收到 SIGTERM（例如 systemctl stop / 被取消）时，本进程启动的浏览器随之退出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-reg-"));
  const before = procsWith("/tmp/dsh-chrome-");
  const p = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withBrowser } from ${JSON.stringify(new URL("../src/browser-runtime.mjs", import.meta.url).href)};
    await withBrowser({ dir: ${JSON.stringify(dir)}, chrome: ${JSON.stringify(CHROME)}, owner: "term-test", max: 1 }, async (b) => { await b.debugPort(); console.log("up"); await new Promise(()=>{}); });
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res) => p.stdout.on("data", (d) => String(d).includes("up") && res()));
  assert.ok(procsWith("/tmp/dsh-chrome-") >= before + 3);
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
  await sleep(300);
  assert.equal(procsWith("/tmp/dsh-chrome-"), before);
});

test("调用方被 SIGKILL（来不及发任何信号）后，看门狗在 ~1s 内回收整组", async () => {
  const udd = mkdtempSync(join(tmpdir(), "guard-t3-"));
  // 中间进程 = "调用方"：它拉起 guard，然后被 SIGKILL
  const caller = spawn(process.execPath, ["-e", `require("child_process").spawn(process.execPath,[${JSON.stringify(GUARD)},${JSON.stringify(CHROME)},...${JSON.stringify(argsFor(udd))}],{stdio:"ignore"}); setInterval(()=>{},1000)`], { stdio: "ignore" });
  for (let i = 0; i < 100 && procsWith(udd) < 3; i++) await sleep(100);
  assert.ok(procsWith(udd) >= 3, "Chrome 已起来");
  process.kill(caller.pid, "SIGKILL");
  for (let i = 0; i < 60 && procsWith(udd) > 0; i++) await sleep(100);
  assert.equal(procsWith(udd), 0);
});

test("正常退出：chrome 自己结束（--dump-dom）时 guard 透传退出码且不留进程", async () => {
  const udd = mkdtempSync(join(tmpdir(), "guard-t4-"));
  const r = spawnSync(process.execPath, [GUARD, CHROME, "--headless=new", `--user-data-dir=${udd}`, "--no-first-run", "--dump-dom", "data:text/html,<p id=x>ok</p>"], { timeout: 30000, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /id="x"/);
  await sleep(300);
  assert.equal(procsWith(udd), 0);
});
