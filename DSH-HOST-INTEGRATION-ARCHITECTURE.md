# DSH Host Integration Architecture — RELIABILITY-005

## Decision boundary

This architecture treats DSH as a model/tool execution host and an external Reliability Host Wrapper as the durable owner of task identity, recovery, checkpoints, and delivery. This is a feasibility architecture, not a claim that DSH `0.2.2-rc.1` already implements it.

```text
User/API request
      |
      v
Reliability Host Wrapper (durable owner)
  1. allocate stable task_id
  2. persist QUEUED + host metadata
  3. claim worker lease
      |
      v
DSH JobRegistry.start(spec)  ---- process-local job_id
      |
      v
DSH callback: model/tools
      |
      +--> Reliability TaskStore: RUNNING, checkpoints, artifact SHA-256
      +--> guarded model call: NO_ACCOUNT -> PARTIAL/BLOCKED
      +--> deterministic report
      +--> Outbox: DELIVERY_PENDING
                              |
                              v
                    independent Delivery Worker
                      claim lease + receiver dedupe key
                              |
                              v
                          DELIVERED
```

## Ownership

| Resource | Owner | Durable? | Recovery responsibility |
|---|---|---:|---|
| Stable `task_id` | Reliability Host Wrapper | Yes | Host recovery scanner |
| DSH `job_id` | DSH local registry | No; random process-local ID | Observational only; never the recovery key |
| Task/checkpoint/artifact database | Reliability Host Wrapper | Yes, isolated SQLite per job or host DB | Host worker |
| Model/tool execution | DSH callback | No across DSH restart | Host re-creates callback/job |
| Outbox | Reliability Host Wrapper | Yes | Separate delivery worker |
| Receiver deduplication | Delivery receiver | Receiver-dependent | Receiver/idempotency protocol |

## Lifecycle

1. Host allocates a stable task ID before creating the DSH job and inserts `QUEUED`.
2. A worker atomically claims the task lease and transitions it to `RUNNING`.
3. Host invokes a DSH job callback, passing only task-scoped context; DSH may return a random in-memory job ID.
4. Each completed stage writes a checkpoint and artifact hash in one transaction.
5. A model `NO_ACCOUNT` response is classified as non-retryable; existing artifacts remain and the task becomes `PARTIAL`.
6. Host builds a deterministic report from SQLite and enqueues it with a unique dedupe key.
7. DSH can settle or disappear. The task remains durable independently of that process.
8. On service restart, the host scans `RUNNING` tasks whose leases expired, claims one, and creates a new DSH callback/job. Completed checkpoints are skipped.
9. Delivery worker claims outbox rows independently; receiver dedupe handles confirmation-loss duplicates.

## What this architecture proves and does not prove

The temporary H1 prototype proves the SQLite lease/recovery mechanics using **two independent Node processes**: one worker is SIGKILLed while holding the lease, a competing worker is rejected during the lease, and a later worker reclaims after expiry and completes the stage.

It does **not** prove that the current DSH Web UI routes a real user task through an externally supplied callback. The installed DSH registry is process-local and its `start(spec)` contract requires a live internal owner/context. No public Web Job creation API or durable restart API was found in the inspected packages.

## Required supported DSH contract for production

- external creation hook before model execution;
- stable correlation metadata accepted by the job host;
- callback lifecycle and cancellation contract;
- restart/re-attach API or a documented way to create a replacement job;
- host-owned delivery/recovery worker;
- no reliance on the random in-memory DSH job ID for durability.

Until those are public and versioned, the external wrapper remains a design boundary rather than a production integration.
