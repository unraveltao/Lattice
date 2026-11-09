import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBrowser, launchBrowser, reapOrphans, listEntries, groupMembers, alive, procStartTicks, memAvailableMB, suggestConcurrency } from "../src/browser-runtime.mjs";

const CHROME = process.env.DSH_CHROME ?? `${process.env.HOME}/tools/chrome-wrap.sh`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newDir = () => mkdtempSync(join(tmpdir(), "dsh-reg-"));

/** 机器上所有"带 dsh-chrome- 用户目录"的进程数 —— 只数我们自己的标记，不数别人的 Chrome */
function ownedProcs() {
  let n = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes("--user-data-dir=/tmp/dsh-chrome-")) n++;
    } catch {}
  }
  return n;
}
const dirsLeft = () => readdirSync(tmpdir()).filter((n) => n.startsWith("dsh-chrome-")).length;

async function settle() {
  for (let i = 0; i < 60 && ownedProcs() > 0; i++) await sleep(100);
}

test("0. 开始前没有我们自己的残留（基线）", async () => {
  await settle();
  assert.equal(ownedProcs(), 0);
});

test("1. 正常执行结束后 Chrome 整组进程退出，登记与临时目录清掉", async () => {
  const dir = newDir();
  let pid, udd, rss, members;
  await withBrowser({ dir, chrome: CHROME, owner: "t1", max: 2 }, async (b) => {
    await b.debugPort();
    pid = b.pid;
    udd = b.userDataDir;
    rss = b.rssMB();
    members = b.members();
    assert.ok(alive(pid));
  });
  console.log(`  # 单个 headless Chrome：${members} 个进程，RSS ≈ ${rss} MB`);
  assert.ok(members >= 3, "Chrome 应该有多个子进程，这正是只 kill 主进程会泄漏的原因");
  await settle();
  assert.equal(ownedProcs(), 0);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(udd), false);
  assert.equal(listEntries(dir).length, 0);
});

test("2. 执行抛异常也会回收", async () => {
  const dir = newDir();
  let pid;
  await assert.rejects(
    withBrowser({ dir, chrome: CHROME, owner: "t2", max: 1 }, async (b) => {
      await b.debugPort();
      pid = b.pid;
      throw new Error("boom");
    }),
    /boom/,
  );
  await settle();
  assert.equal(ownedProcs(), 0);
  assert.equal(alive(pid), false);
  assert.equal(listEntries(dir).length, 0);
});

test("3. 用户取消（AbortSignal）会回收，且 fn 立刻失败", async () => {
  const dir = newDir();
  const ac = new AbortController();
  let pid;
  const p = withBrowser({ dir, chrome: CHROME, owner: "t3", max: 1, signal: ac.signal }, async (b) => {
    await b.debugPort();
    pid = b.pid;
    setTimeout(() => ac.abort(new Error("user cancelled")), 100);
    await sleep(30_000); // 故意不理会 signal：不能因此赖着不走
  });
  await assert.rejects(p, /cancelled/);
  await settle();
  assert.equal(ownedProcs(), 0);
  assert.equal(alive(pid), false);
});

test("4. 超时会回收", async () => {
  const dir = newDir();
  let pid;
  const t0 = Date.now();
  await assert.rejects(
    withBrowser({ dir, chrome: CHROME, owner: "t4", max: 1, timeoutMs: 1500 }, async (b) => {
      await b.debugPort();
      pid = b.pid;
      await sleep(30_000);
    }),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 10_000);
  await settle();
  assert.equal(ownedProcs(), 0);
  assert.equal(alive(pid), false);
});

test("5. 连续跑 6 个任务，进程数与临时目录不累积", async () => {
  const dir = newDir();
  const before = dirsLeft();
  for (let i = 0; i < 6; i++) {
    await withBrowser({ dir, chrome: CHROME, owner: `seq${i}`, max: 1 }, async (b) => {
      await b.debugPort();
      if (i % 2 === 1) throw new Error("odd run fails"); // 一半失败，一半成功
    }).catch(() => {});
    await settle();
    assert.equal(ownedProcs(), 0, `第 ${i} 轮结束后还有残留`);
  }
  assert.equal(dirsLeft(), before, "临时 profile 目录没有累积");
  assert.equal(listEntries(dir).length, 0);
});

test("6. 并发达到上限时排队：同一时刻最多 2 个，4 个任务全部完成", async () => {
  const dir = newDir();
  let running = 0;
  let peak = 0;
  let peakProcs = 0;
  const order = [];
  const job = (i) =>
    withBrowser({ dir, chrome: CHROME, owner: `c${i}`, max: 2 }, async (b) => {
      running++;
      peak = Math.max(peak, running);
      order.push(`start${i}`);
      await b.debugPort();
      peakProcs = Math.max(peakProcs, groupMembers(b.entry.pgid).length);
      await sleep(600);
      running--;
      order.push(`end${i}`);
    });
  await Promise.all([0, 1, 2, 3].map(job));
  assert.equal(peak, 2, "上限 2：不多也不少（少于 2 说明没并行，多于 2 说明限流失效）");
  assert.equal(order.filter((x) => x.startsWith("end")).length, 4);
  await settle();
  assert.equal(ownedProcs(), 0);
});

test("7. 排队超过 waitMs 会明确报错，不无限等", async () => {
  const dir = newDir();
  const holder = await launchBrowser({ dir, chrome: CHROME, owner: "holder", max: 1 });
  try {
    await assert.rejects(launchBrowser({ dir, chrome: CHROME, owner: "waiter", max: 1, waitMs: 400 }), /timed out waiting for a browser slot/);
  } finally {
    await holder.close();
  }
  await settle();
  assert.equal(ownedProcs(), 0);
});

test("8. 不会误杀别人的浏览器：登记簿之外的 Chrome 在整个生命周期与回收之后都还活着", async () => {
  // 诱饵：另一个"用户"的 Chrome —— 同一个可执行文件，但不在我们的登记簿上
  const decoyDir = mkdtempSync(join(tmpdir(), "someone-elses-chrome-"));
  const decoy = spawn(CHROME, ["--headless=new", `--user-data-dir=${decoyDir}`, "--remote-debugging-port=0", "--no-first-run"], { detached: true, stdio: "ignore" });
  decoy.unref();
  await sleep(1500);
  assert.ok(groupMembers(decoy.pid).length >= 2);
  try {
    const dir = newDir();
    await withBrowser({ dir, chrome: CHROME, owner: "t8", max: 1 }, async (b) => {
      await b.debugPort();
    });
    // 再造一个"主人已死"的孤儿，让 reapOrphans 真的有活干
    const orphanOwner = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { launchBrowser } from ${JSON.stringify(new URL("../src/browser-runtime.mjs", import.meta.url).href)};
      const b = await launchBrowser({ dir: ${JSON.stringify(dir)}, chrome: ${JSON.stringify(CHROME)}, owner: "crashy", max: 1 });
      await b.debugPort();
      process.kill(process.pid, "SIGKILL"); // 主人暴毙，没机会 close
    `]);
    assert.equal(orphanOwner.signal, "SIGKILL");
    assert.equal(listEntries(dir).length, 1, "孤儿留在登记簿上");
    assert.ok(ownedProcs() >= 3, "孤儿 Chrome 确实还活着（这就是事故的形态）");
    const r = await reapOrphans(dir);
    assert.equal(r.reaped.length, 1);
    await settle();
    assert.equal(ownedProcs(), 0, "孤儿已被回收");
    assert.ok(alive(decoy.pid), "别人的 Chrome 主进程还活着");
    assert.ok(groupMembers(decoy.pid).length >= 2, "别人的 Chrome 子进程也都还在");
  } finally {
    try {
      process.kill(-decoy.pid, "SIGKILL");
    } catch {}
    rmSync(decoyDir, { recursive: true, force: true });
  }
});

test("9. pid 被复用 / 登记与进程对不上时拒绝动手", async () => {
  const dir = newDir();
  // 一个与我们毫无关系的进程，被"伪造的登记"指向
  const innocent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  innocent.unref();
  mkdirSync(join(dir, "registry"), { recursive: true });
  const fake = {
    id: "fake",
    pid: innocent.pid,
    pgid: innocent.pid,
    startTicks: "1", // 与真实启动时刻不符 = pid 复用
    owner: "ghost",
    ownerPid: 2147483000, // 不存在的主人
    ownerStartTicks: "1",
    userDataDir: "/tmp/dsh-chrome-does-not-exist",
    slot: "s0",
    startedAt: 0,
    expiresAt: 0,
  };
  writeFileSync(join(dir, "registry", "fake.json"), JSON.stringify(fake));
  try {
    const r = await reapOrphans(dir);
    assert.equal(r.reaped.length, 0);
    assert.match(r.skipped[0].reason, /not provable/);
    assert.ok(alive(innocent.pid), "无关进程毫发无损");
  } finally {
    try {
      process.kill(-innocent.pid, "SIGKILL");
    } catch {}
  }
});

test("10. 并发上限随内存给出，且有硬上限", () => {
  const n = suggestConcurrency();
  console.log(`  # MemAvailable=${memAvailableMB()}MB → 建议并发 ${n}`);
  assert.ok(n >= 1 && n <= 4);
  assert.equal(suggestConcurrency({ perBrowserMB: 1_000_000 }), 1, "内存不够也至少允许 1 个（否则任务永远跑不起来）");
});
