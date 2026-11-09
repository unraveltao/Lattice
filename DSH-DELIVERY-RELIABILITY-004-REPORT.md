# DSH Delivery Reliability 004 report

## Executive summary

Reliability-004 adds targeted fault-injection evidence and documents the safe DSH host boundary. The isolated adapter and SQLite reliability layer pass the new seven-case test set. The DSH host review remains **PARTIAL / NOT PRODUCTION-ENABLED**: DSH `0.2.2-rc.1` exposes process-local jobs, but no supported durable TaskStore/Effect/Outbox integration seam was found. Production wiring, active browser-tab mapping, and runtime-config equality remain UNKNOWN/BLOCKED.

No installed package, production database, systemd service, main branch, running DSH process, real Claude account, or real user data was modified.

## Changes

- Added `test/integration-004.test.mjs` with seven targeted tests:
  - effect crash before side effect and retry;
  - side effect before persistence and duplicate (at-least-once warning);
  - persisted effect result suppressing duplicate work;
  - outbox crash before send and expired-claim recovery;
  - receiver success before confirmation with receiver dedupe;
  - concurrent `once` callers with one owner;
  - complete mock `NO_ACCOUNT` flow with one model request, retained artifact hash, deterministic report, queued delivery, and delivery-only recovery.
- Added `DSH-RELIABILITY-HOST-INTEGRATION-REVIEW.md` with DSH call-chain evidence, instance map, state/hash/outbox model, proposed adapter boundary, semantic limits, and blockers.

## Verification

Command:

```text
node --test --disable-warning=ExperimentalWarning test/integration-004.test.mjs
```

Result: **7 tests passed, 0 failed, 0 skipped**.

Previously accepted targeted baseline (not rerun in this task):

- `test/integration-003.test.mjs`: 3/3 pass.
- `test/task-store.test.mjs`: 7/7 pass.

The prior broad test attempt was invalid because a filtered npm command expanded all test files and left Chrome resources; owned process groups were cleaned after verification. No broad prior suite was rerun for this task.

## Mock NO_ACCOUNT evidence

The R7 test uses a temporary SQLite database and a local artifact. It claims the task, commits an `artifact` stage, and calls a mock model once. The mock returns HTTP 503 with `no eligible upstream account is currently available`; the guard classifies `NO_ACCOUNT`, raises `Blocked`, and the adapter transitions the task to `PARTIAL`. The test asserts:

- model calls = 1;
- state = `PARTIAL`;
- report is deterministic and contains the artifact SHA-256;
- `verifyArtifacts` returns no problems;
- report is queued with a stable dedupe key;
- recovery sends the report once without increasing model calls;
- state becomes `DELIVERED`.

The model was never called against a real provider.

## Semantics and crash windows

| Window | Observed guarantee | Limit |
|---|---|---|
| Before effect side effect | failed RUNNING row is removed; next worker can retry | retry is expected |
| After effect side effect, before DONE persistence | retry can repeat external effect | at-least-once; not exactly-once |
| After DONE persistence | stored result is returned; callback is skipped | applies to the local effect ledger |
| Before outbox send | expired `SENDING` lease is reclaimable | delivery is retried |
| Receiver success before confirmation | outbox remains retryable | receiver must dedupe |
| Concurrent effect workers | claim-before-work permits one owner | crashed owner is recoverable after lease expiry |

Terminology used in this report:

- local persisted effect replay: at-most-once after a durable DONE record;
- external delivery: at-least-once;
- receiver with dedupe key: effectively-once in the tested protocol;
- exactly-once: **not claimed**, because crashes can occur between an external side effect and local persistence/acknowledgement.

## DSH host mapping and integration result

Observed read-only process mapping:

- `127.0.0.1:3080`: PID 745604, `/home/admin/.npm/_npx/72500ffcd8799faa/node_modules/.bin/dsh web --host 127.0.0.1 --no-open --trusted-host 47.100.50.72`, DSH `0.2.2-rc.1`.
- `127.0.0.1:13081`: PID 549781, `/opt/dsh-candidate-0.2.2-rc.1/node24 /opt/dsh-candidate-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 13081`, DSH `0.2.2-rc.1`.
- Both unauthenticated probes returned HTTP 401.
- `@deepseek-ai/dsh-jobs-local` uses a process-local `Map` and random in-memory job IDs; its `start(spec)` calls the supplied callback and settles through `hooks.done`.
- No native host hook was found for this toolkit’s SQLite task/effect/outbox tables.

Safe outcome: keep `src/dsh-adapter.mjs` as an external Host Adapter around a real job callback. Do not patch installed DSH internals or claim automatic production integration. A future production integration requires a supported durable job identity, lifecycle contract, per-job database path/retention policy, independent delivery recovery, receiver idempotency, and verified instance/config mapping.

## Evidence limitations

Screenshots and active browser-tab-to-process mapping are **BLOCKED**. The browser provider reported `no spawnable Electron binary`; no DOM/session mapping was available. Existing preview images were unrelated to this task and were not presented as evidence. Runtime configuration equality also remains UNKNOWN because candidate `/proc/549781/environ` was inaccessible.

## Branch and commit

Work was performed on independent branch `integrate/reliability-004`, based on reliability-003 commit `182052b`. The explicit reliability artifacts were reviewed, staged, and committed as `82cd4cc`; no other paths were staged:

```text
DSH-RELIABILITY-HOST-INTEGRATION-REVIEW.md
DSH-DELIVERY-RELIABILITY-004-REPORT.md
test/integration-004.test.mjs
```
