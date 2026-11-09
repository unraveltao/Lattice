import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, State, sha256File } from "../src/task-store.mjs";
import { createReliabilityJob } from "../src/dsh-adapter.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "dsh-int4-"));
const make = (dir, now = () => Date.now()) => new TaskStore(join(dir, "job.db"), { now });

function readyForDelivery(store, id, run = "run-1") {
  store.createTask(id, id);
  assert.equal(store.claim(id, run), true);
  assert.equal(store.transition(id, State.COMPLETED).state, State.COMPLETED);
  store.enqueueDelivery(id, "report", "payload", `${id}:report:v1`);
}

test("R1 effect crash before side effect can be retried", async () => {
  const s = make(temp()); s.createTask("r1", "R1");
  let sideEffects = 0;
  await assert.rejects(s.once("effect:r1", "r1", async () => { throw new Error("crash before side effect"); }));
  const second = await s.once("effect:r1", "r1", async () => { sideEffects++; return { ok: true }; });
  assert.deepEqual(second, { ran: true, value: { ok: true } });
  assert.equal(sideEffects, 1);
  s.close();
});

test("R2 side effect before persistence is at-least-once, not exactly-once", async () => {
  const s = make(temp()); s.createTask("r2", "R2");
  let external = 0;
  await assert.rejects(s.once("effect:r2", "r2", async () => { external++; throw new Error("crash after side effect"); }));
  await s.once("effect:r2", "r2", async () => { external++; return { accepted: true }; });
  assert.equal(external, 2, "a crash before the DONE write permits a duplicate external effect");
  s.close();
});

test("R3 persisted effect result suppresses duplicate work", async () => {
  const s = make(temp()); s.createTask("r3", "R3");
  let calls = 0;
  await s.once("effect:r3", "r3", async () => { calls++; return { id: "stable" }; });
  const replay = await s.once("effect:r3", "r3", async () => { calls++; return { id: "wrong" }; });
  assert.deepEqual(replay, { ran: false, value: { id: "stable" } });
  assert.equal(calls, 1);
  s.close();
});

test("R4 outbox crash before send is recovered from an expired claim", async () => {
  let now = 1_000; const s = make(temp(), () => now); readyForDelivery(s, "r4");
  const row = s.db.prepare("SELECT id FROM outbox WHERE task_id=?").get("r4");
  s.db.prepare("UPDATE outbox SET status='SENDING', claim_until=? WHERE id=?").run(now + 10, row.id);
  let sends = 0; now += 11;
  const result = await s.deliver(async () => { sends++; });
  assert.equal(result.sent, 1); assert.equal(sends, 1); assert.equal(s.outbox("r4")[0].status, "SENT");
  assert.equal(s.get("r4").state, State.DELIVERED);
  s.close();
});

test("R5 receiver success before confirmation is retryable and receiver dedupe makes it effectively-once", async () => {
  const s = make(temp()); readyForDelivery(s, "r5");
  const received = new Set(); let attempts = 0;
  const sender = async (message) => {
    attempts++;
    received.add(message.dedupeKey);
    if (attempts === 1) throw new Error("receiver committed; confirmation lost");
  };
  assert.equal((await s.deliver(sender, { baseMs: 0 })).failed, 1);
  // Make the retry due without waiting.
  s.db.prepare("UPDATE outbox SET next_at=0 WHERE task_id=?").run("r5");
  assert.equal((await s.deliver(sender, { baseMs: 0 })).sent, 1);
  assert.equal(attempts, 2); assert.equal(received.size, 1);
  assert.equal(s.get("r5").state, State.DELIVERED);
  s.close();
});

test("R6 concurrent once callers execute one owner", async () => {
  const s = make(temp()); s.createTask("r6", "R6"); let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 25)); return { ok: true }; };
  const [a, b] = await Promise.all([s.once("effect:r6", "r6", fn), s.once("effect:r6", "r6", fn)]);
  assert.equal(calls, 1); assert.deepEqual(a.value, { ok: true }); assert.deepEqual(b.value, { ok: true });
  s.close();
});

test("R7 NO_ACCOUNT E2E calls model once, retains hash/report, queues delivery, then recovery only sends", async () => {
  const dir = temp(); const db = join(dir, "job.db"); const artifact = join(dir, "result.md");
  writeFileSync(artifact, "deterministic result\n");
  const job = createReliabilityJob({ dbFile: db, taskId: "r7", title: "NO_ACCOUNT delivery" });
  assert.equal(job.store.claim("r7", "worker-1"), true);
  await job.store.runStage("r7", "worker-1", "artifact", async () => ({ data: { retained: true }, files: [artifact] }));
  let modelCalls = 0;
  await assert.rejects(job.callModel({ call: async () => { modelCalls++; return { status: 503, body: "no eligible upstream account is currently available" }; } }), (e) => e.reason === "NO_ACCOUNT");
  assert.equal(modelCalls, 1); assert.equal(job.state().state, State.PARTIAL);
  const report = job.deterministicReport();
  assert.match(report, /State: PARTIAL/); assert.match(report, /sha256=/); assert.equal(job.store.verifyArtifacts("r7").length, 0);
  job.store.enqueueDelivery("r7", "report", report, "r7:report:v1");
  let sends = 0; const before = modelCalls;
  await job.store.deliver(async ({ payload }) => { sends++; assert.equal(payload, report); });
  assert.equal(sends, 1); assert.equal(modelCalls, before); assert.equal(job.state().state, State.DELIVERED);
  assert.equal(sha256File(artifact).length, 64); job.close();
});
