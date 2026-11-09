import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { TaskStore, State } from "../src/task-store.mjs";

const fixture = join(process.cwd(), "test/fixtures/worker-005.mjs");
const temp = () => mkdtempSync(join(tmpdir(), "dsh-host5-"));
function worker(db, id, mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture, db, "job-005", id, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", (x) => { out += x; });
    child.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

test("H1 separate host-wrapper workers race, crash, and recover the same durable job", async () => {
  const db = join(temp(), "job.db");
  const first = worker(db, "worker-crash", "crash");
  // Let the first worker establish its SQLite lease before the second starts.
  await new Promise((r) => setTimeout(r, 45));
  const second = worker(db, "worker-live", "complete");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.signal, "SIGKILL");
  assert.equal(b.code, 2, "live worker must not steal an unexpired lease");

  // Time is intentionally bounded by the worker lease; then an independent
  // process can resume the unfinished callback. This is not Promise concurrency.
  await new Promise((r) => setTimeout(r, 160));
  const recovery = await worker(db, "worker-recovery", "complete");
  assert.equal(recovery.code, 0);
  const store = new TaskStore(db);
  assert.equal(store.get("job-005").state, State.COMPLETED);
  assert.deepEqual(store.stages("job-005"), ["recovered"]);
  store.close();
});
