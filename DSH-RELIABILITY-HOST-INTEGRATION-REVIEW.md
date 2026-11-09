# DSH host integration review — reliability-004

## Scope and verdict

Review target: DSH `0.2.2-rc.1` runtime instances on `127.0.0.1:3080` and candidate `127.0.0.1:13081`, plus the isolated reliability toolkit on branch `integrate/reliability-004`.

**Verdict: host integration is not safe to claim or enable in this release.** The supported boundary is an external Host Adapter that wraps the real job callback. The reliability database must remain a separate SQLite database per orchestrated job until DSH exposes a durable task/effect/outbox seam.

No installed package, production database, systemd service, main branch, or running process was modified.

## Runtime mapping

| Instance | Evidence | Mapping result |
|---|---|---|
| `127.0.0.1:3080` | PID 745604 command: `/home/admin/.npm/_npx/72500ffcd8799faa/node_modules/.bin/dsh web --host 127.0.0.1 --no-open --trusted-host 47.100.50.72` | Main DSH web instance, package `0.2.2-rc.1` |
| `127.0.0.1:13081` | PID 549781 command: `/opt/dsh-candidate-0.2.2-rc.1/node24 /opt/dsh-candidate-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 13081` | Candidate DSH instance, package `0.2.2-rc.1` |
| Active browser tab → process | Electron provider reported `no spawnable Electron binary`; no browser DOM/session mapping was available | **UNKNOWN / BLOCKED** |
| Runtime config equality | `/proc/549781/environ` was inaccessible during review | **UNKNOWN**; do not assume profiles/configs are equal |

Both unauthenticated HTTP probes returned 401. No screenshot evidence is claimed: the browser provider was unavailable, and existing preview images were unrelated to this review.

## Host call-chain evidence

The installed host’s relevant process-local path is:

```text
web CLI/profile boot
  -> @deepseek-ai/dsh-jobs-local LocalJobRegistry
     -> start(spec)
        -> validate owner/kind/label/concurrency
        -> generate in-memory kind-<randomUUID> id
        -> call spec.run(handle)
        -> pump output and record session events
        -> settle from hooks.done
```

Read-only source evidence is `/home/admin/.npm/_npx/72500ffcd8799faa/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js:356-501` and settlement logic at `:769-790`. The registry stores live records in a process-local `Map`; `list/get/read/readAt/kill/wait/remove` operate on those records. The abstract `@deepseek-ai/dsh-jobs` package is only a seam. The `@deepseek-ai/dsh-jobs-local` package describes itself as a “Process-local implementation of the DeepSeek Harness background job registry seam”.

The review found no native callback for this toolkit’s SQLite TaskStore, effect ledger, artifact hash ledger, or outbox. Therefore the adapter must be called at the Host/worker callback boundary, not by patching DSH internals.

## Proposed safe boundary

`src/dsh-adapter.mjs` exports:

```js
createReliabilityJob({ dbFile, taskId, title, now, budget, breaker } = {})
```

The adapter owns one `TaskStore` database per job, composes `Budget`, `CircuitBreaker`, and `guardedCall`, and exposes `state`, `callModel`, `deterministicReport`, and `close`. A Host integration would conceptually be:

1. DSH `start(spec)` creates the process-local job.
2. The callback creates/reopens the adapter with a host-selected temporary/persistent job DB.
3. Each completed stage calls `runStage`, which atomically stores checkpoint data and artifact SHA-256 values.
4. Model calls go only through `callModel`; a classified `NO_ACCOUNT` becomes `PARTIAL`/`BLOCKED` without dense retry.
5. The callback enqueues the deterministic report in the outbox.
6. A separate recovery/delivery worker invokes `deliver`; it never reruns model stages.

This is a design boundary, not a claim that the installed DSH currently wires these steps automatically.

## State, hash, and delivery chain

```text
QUEUED -> RUNNING -> COMPLETED
                    \-> PARTIAL/BLOCKED on host/upstream block
COMPLETED/PARTIAL/BLOCKED -> DELIVERY_PENDING -> DELIVERED

RUNNING stage -> checkpoints + artifacts(path, SHA-256, size)
report        -> deterministic text from SQLite contents
report        -> outbox(dedupe_key, channel, payload)
outbox        -> PENDING -> SENDING(lease) -> SENT
                         \-> PENDING(backoff) or DEAD
```

`TaskStore.commitStage` hashes files before its transaction and stores checkpoint/artifact rows together. `verifyArtifacts` recomputes hashes. `enqueueDelivery` uses `INSERT OR IGNORE` on a unique `dedupe_key`. `deliver` claims pending or expired sending rows, and updates only delivery state; it does not invoke stage/model code.

## Reliability semantics

- **Effect ledger:** at-most-once *successful local execution after a durable DONE record*; a crash after an external side effect but before DONE can execute the external effect again. This is **not exactly-once**.
- **External effects:** at-least-once unless the receiver honors the supplied dedupe key/idempotency key.
- **Outbox:** at-least-once delivery attempt. Receiver-side dedupe makes the tested path **effectively-once**; leases alone never establish exactly-once.
- **Concurrent local workers:** SQLite claim-before-work and leases select one owner; expired leases permit recovery after a crash.
- **Model stages:** completed checkpoints are skipped on restart, preventing duplicate model work for already-persisted stages.

## Integration blockers and required host contract

Before production wiring, DSH should expose or the integration layer must explicitly provide:

1. durable job identity and recovery ownership, not only a process-local random job ID;
2. callback lifecycle guarantees for start, cancellation, producer settlement, and host teardown;
3. a stable per-job database path and cleanup/retention policy;
4. receiver idempotency keyed by `dedupe_key`;
5. a supported way to run delivery recovery independently of model execution;
6. configuration and browser-tab mapping evidence for each target instance.

Until then, use the adapter only in an explicitly isolated host wrapper and keep its database outside DSH’s production store.
