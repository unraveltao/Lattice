import { TaskStore, State } from "../../src/task-store.mjs";

const [dbFile, taskId, runId, mode] = process.argv.slice(2);
const store = new TaskStore(dbFile);
store.createTask(taskId, "005 multiprocess recovery");
const claimed = store.claim(taskId, runId, 120);
process.stdout.write(JSON.stringify({ claimed }) + "\n");
if (!claimed) {
  store.close();
  process.exit(2);
}
if (mode === "crash") {
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);
} else {
  store.commitStage(taskId, runId, "recovered", { worker: runId });
  store.transition(taskId, State.COMPLETED);
  store.close();
}
