import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, State, sha256 } from "../src/task-store.mjs";
import { Budget, Blocked, guardedCall } from "../src/llm-guard.mjs";

const STORE = new URL("../src/task-store.mjs", import.meta.url).href;
const work = () => mkdtempSync(join(tmpdir(), "dsh-task-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("D1. 恢复时已完成阶段直接跳过：阶段函数不会再执行（不重做、不再花钱）", async () => {
  const d = work();
  const s = new TaskStore(join(d, "t.db"));
  s.createTask("T", "demo");
  assert.ok(s.claim("T", "run-1"));
  const calls = [];
  const stage = (name) => async () => (calls.push(name), { data: { name }, files: [] });
  await s.runStage("T", "run-1", "audit", stage("audit"));
  await s.runStage("T", "run-1", "port", stage("port"));
  // 模拟中断后第二次运行：同样的流程重放一遍
  s.release("T", "run-1");
  assert.ok(s.claim("T", "run-2"));
  const r1 = await s.runStage("T", "run-2", "audit", stage("audit"));
  const r2 = await s.runStage("T", "run-2", "port", stage("port"));
  const r3 = await s.runStage("T", "run-2", "test", stage("test"));
  assert.deepEqual(calls, ["audit", "port", "test"], "audit/port 只执行过一次");
  assert.deepEqual([r1.skipped, r2.skipped, r3.skipped], [true, true, false]);
  assert.deepEqual(s.stages("T"), ["audit", "port", "test"]);
});

test("D2. 产物记录 SHA-256；文件被改动或丢失能被发现", async () => {
  const d = work();
  const s = new TaskStore(join(d, "t.db"));
  s.createTask("T", "demo");
  s.claim("T", "r");
  const f1 = join(d, "a.patch"), f2 = join(d, "b.md");
  writeFileSync(f1, "diff --git a b\n");
  writeFileSync(f2, "# notes\n");
  const cp = s.commitStage("T", "r", "port", { ok: 1 }, [f1, f2]);
  assert.equal(cp.artifacts.length, 2);
  assert.equal(cp.artifacts.find((a) => a.path === f1).sha256, sha256("diff --git a b\n"));
  assert.deepEqual(s.verifyArtifacts("T"), []);
  appendFileSync(f1, "tampered\n");
  writeFileSync(f2, "# notes\n");
  const bad = s.verifyArtifacts("T");
  assert.deepEqual(bad.map((b) => b.problem), ["modified"]);
  // 提交一个不存在的产物应当整体失败，不留下半个检查点
  assert.throws(() => s.commitStage("T", "r", "ghost", {}, [join(d, "nope.txt")]));
  assert.equal(s.checkpoint("T", "ghost"), null);
});

test("D3. 运行者被 SIGKILL 后：租约过期，另一个运行者接手并从检查点继续（跨进程）", async () => {
  const d = work();
  const db = join(d, "t.db");
  const s = new TaskStore(db);
  s.createTask("T", "crashy");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
    import { TaskStore } from ${JSON.stringify(STORE)};
    const s = new TaskStore(${JSON.stringify(db)});
    s.claim("T", "doomed", 1500);
    await s.runStage("T", "doomed", "audit", async () => ({ data: { done: true } }));
    console.log("audited");
    await new Promise(() => {}); // 在第二阶段中间被杀
  `], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => child.stdout.on("data", (x) => String(x).includes("audited") && r()));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.equal(s.claim("T", "rescuer", 5000), false, "租约未过期时不能抢");
  await sleep(1700);
  assert.equal(s.claim("T", "rescuer", 5000), true, "租约过期后可以接手");
  let reran = false;
  const a = await s.runStage("T", "rescuer", "audit", async () => ((reran = true), { data: {} }));
  assert.equal(a.skipped, true);
  assert.equal(reran, false, "已完成的 audit 不重做");
  await s.runStage("T", "rescuer", "port", async () => ({ data: { by: "rescuer" } }));
  assert.deepEqual(s.stages("T"), ["audit", "port"]);
  assert.throws(() => s.commitStage("T", "doomed", "late", {}), /does not hold the lease/, "被顶掉的旧运行者不能再写");
});

test("D4. 4 个进程同时抢同一个任务：恰好 1 个成功", async () => {
  const d = work();
  const db = join(d, "t.db");
  new TaskStore(db).createTask("T", "race");
  const script = `
    import { TaskStore } from ${JSON.stringify(STORE)};
    const s = new TaskStore(${JSON.stringify(db)});
    const t0 = Date.now() + 400; while (Date.now() < t0) {}   // 对齐起跑线
    console.log("RESULT " + s.claim("T", "p" + process.pid, 60000));
  `;
  const run = () => new Promise((res) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (x) => (out += x));
    c.on("exit", () => res(/RESULT (\w+)/.exec(out)?.[1]));
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(results.filter((x) => x === "true").length, 1, `结果 ${results}`);
  assert.equal(results.filter((x) => x === "false").length, 3);
});

test("D5. 被上游挡住 → 保留成果（PARTIAL）并在本地确定性生成报告，无需模型", async () => {
  const d = work();
  const s = new TaskStore(join(d, "t.db"), { now: () => 1_000 });
  s.createTask("T", "Lattice UI Shell A");
  s.claim("T", "r");
  const f = join(d, "ui.patch");
  writeFileSync(f, "patch-bytes");
  await s.runStage("T", "r", "port", async () => ({ data: { files: 12, tests: "navigation 41 PASS" }, files: [f] }));
  // 模型调用被账号池耗尽挡住
  const noAcct = async () => ({ status: 503, body: "no eligible upstream account is currently available" });
  const err = await guardedCall({ call: noAcct, budget: new Budget(), sleep: async () => {} }).catch((e) => e);
  assert.ok(err instanceof Blocked);
  const t = s.block("T", "r", err.reason, { summary: err.detail.summary });
  assert.equal(t.state, State.PARTIAL, "有成果 → PARTIAL，不是失败");
  assert.equal(t.blocked_reason, "NO_ACCOUNT");
  const r1 = s.buildReport("T");
  const r2 = s.buildReport("T");
  assert.equal(sha256(r1), sha256(r2), "同一份库内容，报告逐字节相同");
  assert.match(r1, /State: PARTIAL/);
  assert.match(r1, /Blocked: NO_ACCOUNT/);
  assert.match(r1, /1\. port/);
  assert.match(r1, new RegExp(sha256("patch-bytes")), "报告里有产物哈希");
  // 没有任何成果就被挡住 → BLOCKED
  s.createTask("U", "nothing done");
  s.claim("U", "r");
  assert.equal(s.block("U", "r", "AUTH").state, State.BLOCKED);
});

test("D6. 发件箱：发送失败只重试发送、任务不重跑；去重只发一次；超过次数进 DEAD 但不丢", async () => {
  let now = 10_000;
  const d = work();
  const s = new TaskStore(join(d, "t.db"), { now: () => now });
  s.createTask("T", "deliver me");
  s.claim("T", "r");
  let stageRuns = 0;
  await s.runStage("T", "r", "build", async () => (stageRuns++, { data: {} }));
  s.transition("T", State.COMPLETED);
  const q1 = s.enqueueDelivery("T", "report", "FINAL REPORT");
  const q2 = s.enqueueDelivery("T", "report", "FINAL REPORT");
  assert.equal(q1.queued, true);
  assert.equal(q2.queued, false, "同内容重复入队被去重");
  assert.equal(s.get("T").state, State.DELIVERY_PENDING);

  const sent = [];
  let failuresLeft = 2;
  const sender = async (m) => {
    if (failuresLeft-- > 0) throw new Error("smtp 451 try later");
    sent.push(m.payload);
  };
  assert.deepEqual(await s.deliver(sender, { baseMs: 1000 }), { sent: 0, failed: 1, dead: 0 });
  assert.deepEqual(await s.deliver(sender), { sent: 0, failed: 0, dead: 0 }, "退避期内不重发");
  now += 1000;
  assert.equal((await s.deliver(sender)).failed, 1);
  now += 2000;
  assert.equal((await s.deliver(sender)).sent, 1);
  assert.deepEqual(sent, ["FINAL REPORT"], "最终只发出一次");
  assert.equal(s.get("T").state, State.DELIVERED);
  assert.equal(stageRuns, 1, "整个投递过程没有重跑任务");
  await s.deliver(sender);
  assert.equal(sent.length, 1, "已 SENT 的不会再发");

  // DEAD：一直失败
  s.createTask("V", "never delivers");
  s.claim("V", "r");
  s.transition("V", State.COMPLETED);
  s.enqueueDelivery("V", "report", "X");
  for (let i = 0; i < 6; i++) {
    now += 100_000;
    await s.deliver(async () => { throw new Error("down"); }, { maxAttempts: 3 });
  }
  const ob = s.outbox("V");
  assert.equal(ob[0].status, "DEAD");
  assert.equal(ob[0].attempts, 3, "到上限就停，不无限重试");
  assert.equal(s.get("V").state, State.DELIVERY_PENDING, "没送出去就不能算 DELIVERED");
});

test("D7. 非法状态跳转被拒；幂等副作用只执行一次；预算暂停可持久、调高后可继续", async () => {
  const d = work();
  const db = join(d, "t.db");
  const s = new TaskStore(db);
  s.createTask("T", "x");
  assert.throws(() => s.transition("T", State.DELIVERED), /illegal transition QUEUED -> DELIVERED/);
  s.claim("T", "r");
  assert.throws(() => s.transition("T", State.DELIVERED), /illegal transition RUNNING -> DELIVERED/);

  let sends = 0;
  const a = await s.once("push:T:v1", "T", async () => (sends++, "sent"));
  const b = await s.once("push:T:v1", "T", async () => (sends++, "sent"));
  assert.equal(sends, 1);
  assert.deepEqual([a.ran, b.ran], [true, false]);

  // 预算：用完 → Blocked(BUDGET) → 落库为 PARTIAL/BLOCKED；重开进程后仍在；调高预算后继续
  const budget = new Budget({ maxCalls: 1 });
  const ok = async () => ({ status: 200, body: "ok" });
  await guardedCall({ call: ok, budget, sleep: async () => {} });
  const e = await guardedCall({ call: ok, budget, sleep: async () => {} }).catch((x) => x);
  assert.equal(e.reason, "BUDGET");
  s.commitStage("T", "r", "s1", { n: 1 });
  s.block("T", "r", "BUDGET", { summary: e.detail.summary });
  s.close();
  const s2 = new TaskStore(db); // "重启"
  assert.equal(s2.get("T").state, State.PARTIAL);
  assert.equal(s2.get("T").blocked_reason, "BUDGET");
  assert.ok(s2.claim("T", "r2"), "暂停的任务可以被重新认领继续");
  assert.equal(s2.get("T").state, State.RUNNING);
  assert.equal(s2.checkpoint("T", "s1").data.n, 1, "之前的成果还在");
  await guardedCall({ call: ok, budget: new Budget({ maxCalls: 5 }), sleep: async () => {} });
});
