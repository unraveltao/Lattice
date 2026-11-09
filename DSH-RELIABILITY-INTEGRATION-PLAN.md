# DSH Reliability Integration Plan

Status: draft integration boundary for `integrate/reliability-003`.

## Scope and ownership

The installed `@deepseek-ai/dsh` `0.2.2-rc.1` runtime has no production Task/Effect/Outbox SQLite schema. Therefore this toolkit owns one SQLite database per orchestrated job, at an explicitly supplied `dbFile`. It must never point at the DSH service database, overwrite production state, or modify the installed package/systemd unit.

`src/dsh-adapter.mjs` is the only proposed boundary: `createReliabilityJob({ dbFile, taskId, title, now, budget, breaker })`. The host runner supplies the task id and a per-job path, and calls the adapter from the job lifecycle. DSH 0.2.2-rc.1 remains responsible for model/provider configuration and UI; the adapter does not import private DSH internals.

## Job lifecycle

`QUEUED → RUNNING → PARTIAL/BLOCKED/COMPLETED → DELIVERY_PENDING → DELIVERED` is persisted by `TaskStore`. A runner claims a task with a lease, heartbeats it, commits each stage and artifact hash transactionally, and releases it. A crashed runner is recoverable after lease expiry; a new runner resumes from the latest completed checkpoint instead of rerunning that stage.

A `NO_ACCOUNT` model result is classified by `llm-guard` and immediately becomes `PARTIAL` when prior stages exist (otherwise `BLOCKED`). The deterministic report is generated locally and does not require an LLM. No real Claude request is part of this plan.

## Data rules

- **Task Store:** SQLite file supplied by the orchestrator; WAL and busy timeout enabled.
- **Checkpoints/artifacts:** stage completion and SHA-256/size records are committed together. Missing or changed files invalidate recovery.
- **Effects:** `once(key, taskId, fn)` claims a lease row before invoking `fn`; concurrent callers wait, completed rows return the stored result, and an expired claim is recoverable. This prevents duplicate external effects under concurrency (the pre-integration implementation did not).
- **Outbox:** delivery records are deduplicated by `dedupe_key`. A sender claims `SENDING` with an expiry; a crashed claim is eligible for recovery. Only sending is retried with bounded backoff; business stages are never rerun. `DEAD` preserves the payload and error.
- **Reports:** `buildReport` is deterministic from SQLite contents; it is the local fallback when upstream is unavailable.
- **Budgets:** `Budget` charges before a request and blocks when call/stage/cost limits are reached. `CircuitBreaker` and `guardedCall` bound transient retries. Exact account-pool 503 is `NO_ACCOUNT`, no dense retry.

## Compatibility with DSH 0.2.2-rc.1

The adapter accepts a generic `call` function and returns/throws normal JavaScript values; it does not assume an Anthropic/OpenAI private API. The host can map the existing DSH model invocation to `call`, pass provider retry metadata to `retry`, and map `onEvent` to its own logs. Since the installed DSH has no matching durable job tables, production wiring is **not claimed** by this standalone branch.

## Verification boundary

New adapter/recovery tests are in `test/integration-003.test.mjs`. Existing toolkit tests are retained. No production service restart, no database migration outside temporary test databases, no Claude request, and no browser-provider rerun are allowed by this plan.
