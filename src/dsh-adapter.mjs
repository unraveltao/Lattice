// DSH 0.2.2-rc.1 integration boundary.
// The installed DSH release has no Task/Effect/Outbox SQLite tables, so this adapter
// owns exactly one reliability database per orchestrated job. It does not modify the
// DSH package, its production database, or systemd service.
import { TaskStore, State } from "./task-store.mjs";
import { Budget, CircuitBreaker, Blocked, guardedCall } from "./llm-guard.mjs";

export function createReliabilityJob({ dbFile, taskId, title, now, budget, breaker } = {}) {
  if (!dbFile || !taskId) throw new TypeError("dbFile and taskId are required");
  const store = new TaskStore(dbFile, { now });
  store.createTask(taskId, title ?? taskId);
  const guard = {
    budget: budget ?? new Budget(),
    breaker: breaker ?? new CircuitBreaker(),
  };
  return {
    store,
    taskId,
    state: () => store.get(taskId),
    async callModel({ stage = "model", call, retry, fallbacks, onEvent }) {
      try {
        return await guardedCall({ call, budget: guard.budget, breaker: guard.breaker, stage, retry, fallbacks, onEvent });
      } catch (error) {
        if (error instanceof Blocked) {
          const runId = store.get(taskId)?.run_id;
          store.block(taskId, runId, error.reason, { summary: error.detail?.summary ?? error.message });
        }
        throw error;
      }
    },
    deterministicReport() {
      return store.buildReport(taskId);
    },
    close() {
      store.close();
    },
  };
}

export { State };
