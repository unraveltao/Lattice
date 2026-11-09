# DSH Delivery Reliability 005 — Host Integration Feasibility Spike

## Final status: PARTIAL

The spike verified RELIABILITY-004, inspected DSH `0.2.2-rc.1` public jobs contracts and implementation, and built a temporary multi-process host-wrapper recovery prototype. The prototype proves durable wrapper-owned recovery and lease fencing, but the current DSH release does not expose a proven external callback/restart path for taking over real Web UI jobs or recreating execution after the DSH process disappears.

Therefore this is **PARTIAL**, not PASS. No production integration is enabled.

## RELIABILITY-004 delivery verification

- Branch: `integrate/reliability-004`
- Base commit: `182052b`
- Current HEAD: `04e52e33a9e7dac1abda61a0efe35878b831e676`
- User-provided commit: `04e52e33a9e7dac1abda61a0efe35878b831e676` — matches HEAD
- Report-recorded commit: `82cd4cc` — superseded by the amended commit above; the amendment changed report text only and preserved the three artifacts
- Worktree at start: clean

The historical 004 report’s embedded `82cd4cc` reference is stale after the amend; it is not a second branch state and was not overwritten or deleted. Current HEAD is the authoritative delivery SHA.

## Task A — host interface findings

The public package `/home/admin/.npm/_npx/72500ffcd8799faa/node_modules/@deepseek-ai/dsh-jobs/lib/types/index.d.ts` declares `JobRegistry.start(spec): JobId`, `list`, `get`, `read`, `readAt`, `kill`, `wait`, `remove`, and `attachController`. Its contract requires a live DSH `Context`/agent composition and says implementations must honor owner/session lifecycle semantics.

`@deepseek-ai/dsh-jobs-local` is explicitly a **process-local** implementation. Read-only source evidence at `/home/admin/.npm/_npx/72500ffcd8799faa/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js:371-501` shows:

- `store = new Map()`;
- generated ID `kind-${randomUUID...}`;
- owner resolution through live agent state;
- `spec.run(handle)` callback invocation;
- completion through `hooks.done`;
- settlement and cancellation in the same process.

Conclusions:

| Question | Result |
|---|---|
| Can an external Host Wrapper legally call a real callback? | **Only if it already runs inside a supported DSH Context/composition and receives the public `JobSpec` seam.** No unrelated external Web/API entry point was found. |
| Stable task ID before DSH job creation? | **Yes, wrapper-owned only.** DSH’s own ID is generated after `start` and is transient. |
| Durable wrapper↔DSH mapping? | A database row can record the transient DSH ID, but it does not provide execution control or restart. |
| Take over an actual user-created Web task? | **Not established.** No public interception/callback registration was found. |
| Stable recovery entry point? | **Not found.** The registry has no durable re-attach/restart API. |

Public API, internal implementation, and unknowns are separated in [DSH-HOST-INTEGRATION-DECISION.md](DSH-HOST-INTEGRATION-DECISION.md).

## Task B — restart lifecycle

The feasible lifecycle is:

```text
Host allocates task_id
  -> durable QUEUED row
  -> worker lease
  -> DSH callback/job
  -> checkpoint + artifact hash
  -> process crash
  -> host scanner finds expired RUNNING lease
  -> replacement DSH callback/job (requires supported host entry point)
  -> skip persisted stages
  -> enqueue/send outbox
```

Ownership is explicit:

- Reliability Host Wrapper owns stable `task_id`, task database, recovery scanner, and delivery worker.
- DSH owns only transient process-local `job_id` and current model/tool execution.
- Outbox delivery is independent from model execution.
- SQLite leases prevent two workers from recovering the same task concurrently.

The current DSH release satisfies only the in-process callback portion. It does not satisfy the replacement-job portion after host process loss.

## Task C/D — temporary multi-process prototype

Added:

- [test/host-wrapper-005.test.mjs](test/host-wrapper-005.test.mjs)
- [test/fixtures/worker-005.mjs](test/fixtures/worker-005.mjs)

Command:

```text
node --test --disable-warning=ExperimentalWarning test/host-wrapper-005.test.mjs
```

Result: **1 passed, 0 failed**.

The test uses two independent Node processes plus a recovery process, not Promise concurrency:

1. `worker-crash` claims the SQLite task and is SIGKILLed.
2. `worker-live` races during the active lease and is rejected.
3. After lease expiry, `worker-recovery` claims the task and commits the remaining stage.
4. The parent verifies `COMPLETED` and stage `recovered` from a fresh connection.

The test proves wrapper-owned lease fencing and crash recovery. It does not claim DSH host integration because the workers use the reliability callback fixture, not the private installed DSH registry.

Reliability-004 targeted test was run once as requested for the new spike:

```text
node --test --disable-warning=ExperimentalWarning test/integration-004.test.mjs
```

Result: **7 passed, 0 failed**.

No real Claude request, production service/database change, installed-package modification, or prior broad-suite rerun was performed.

## Task E — architecture decision

Recommendation: **A. External Host Wrapper**, with production enablement deferred until DSH supplies a documented external callback/correlation/restart contract. Option B (wait for an official Durable Job API) is the required fallback/prerequisite for a full PASS. Option C (DSH fork) is rejected: it has the highest maintenance and upgrade risk and was not approved.

See [DSH-HOST-INTEGRATION-ARCHITECTURE.md](DSH-HOST-INTEGRATION-ARCHITECTURE.md) and [DSH-HOST-INTEGRATION-DECISION.md](DSH-HOST-INTEGRATION-DECISION.md).

## Screenshots and limitations

Real screenshots for this run are **BLOCKED** because the Electron browser provider reported no spawnable Electron binary. Historical previews were not used. Active browser-tab mapping and candidate runtime configuration equality remain UNKNOWN.

## Commit and worktree

Task artifacts were explicitly staged only after verification. Final commit:

The final commit SHA is reported with the delivery message (`git rev-parse HEAD`); it is intentionally not duplicated inside this self-referential report.

Expected explicit paths:

```text
DSH-DELIVERY-RELIABILITY-005-REPORT.md
DSH-HOST-INTEGRATION-ARCHITECTURE.md
DSH-HOST-INTEGRATION-DECISION.md
test/host-wrapper-005.test.mjs
test/fixtures/worker-005.mjs
```
