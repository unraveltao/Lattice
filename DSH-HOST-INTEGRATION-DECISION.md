# DSH Host Integration Decision — RELIABILITY-005

## Final result: PARTIAL, recommend A with a hard boundary

**Recommendation: A — External Host Wrapper**, but only as an explicit reliability-owned execution layer around a supported DSH callback when such a callback is made available to the integration. Do not represent the current DSH Web UI as integrated.

For the current `0.2.2-rc.1` release, the operational decision is **PARTIAL / deferred production enablement**. The wrapper can own durable task identity, recovery, and delivery, while DSH remains the model/tool execution host. The inspected DSH public jobs contract is process-local and does not provide durable restart or re-attach.

## Evidence classification

### Public, versioned interfaces

`@deepseek-ai/dsh-jobs` publicly declares `JobRegistry.start(spec): JobId`, `list`, `get`, `read`, `readAt`, `kill`, `wait`, `remove`, and `attachController`. `JobSpec` supplies a synchronous callback starter and `JobHooks` supplies cancellation/completion hooks. The type contract explicitly says the registry implementation lives in `@deepseek-ai/dsh-jobs-local`.

These interfaces are suitable for a host that already owns a live DSH `Context`/agent composition. They do not provide a web/API call that an unrelated external process can invoke to create a job.

### Internal implementation

`@deepseek-ai/dsh-jobs-local` keeps jobs in a process-local `Map`, generates `kind-<short-uuid>` IDs, resolves owners through live agent state, and disposes jobs with the owning agent/service. This is useful lifecycle behavior inside one process, but it cannot survive process loss and has no durable re-attach operation.

### Not established / do not infer

- Stable task ID before a DSH job is created: possible in the wrapper’s own database, but no public DSH correlation field was established.
- Mapping wrapper task ID to DSH job ID: possible as an external row containing the transient DSH ID, but the mapping is not durable execution control.
- Taking over a real user-created Web task: **not established**; no supported external interception or callback registration was found.
- Recovery execution after DSH process loss: **not provided**; the wrapper must create a replacement DSH job through an approved host API, which was not found.
- Screenshot of this task’s actual host UI: **BLOCKED** because no Electron browser provider was available.

## Lifecycle ownership model

| Question | Decision |
|---|---|
| Who owns stable Job ID? | External Reliability Host Wrapper (`task_id`) |
| Who owns DSH Job ID? | DSH process-local registry; transient correlation only |
| Who owns task DB? | Reliability Host Wrapper, isolated from DSH production DB |
| Who recovers unfinished work? | Host recovery scanner/worker after lease expiry |
| Who sends Outbox? | Independent Host Delivery Worker |
| How does a new DSH process execute recovery? | Host creates a replacement callback/job through a future supported API; current release has no proven route |
| How are duplicate workers prevented? | SQLite atomic task lease with expiry; receiver dedupe for external delivery |

The H1 prototype uses two independent Node processes and proves lease competition, crash, and later recovery of the durable stage. It does not prove replacement DSH execution because no safe public restart entry point was found.

## Architecture comparison

| Option | Maintenance cost | Stability | Upgrade risk | Recovery ability | Workload | Decision |
|---|---:|---|---|---|---:|---|
| A. External Host Wrapper | Medium; separate durable layer | Good if callback/API is versioned | Low-to-medium; adapter tracks public DSH API | Strong for host-owned state; DSH replacement still needs API | Medium | **Recommended** |
| B. Wait for official Durable Job API | Low now; potentially low later | Highest once released | Lowest | Strong if API includes re-attach/restart | Low now, blocked delivery | Required fallback / prerequisite for full PASS |
| C. Maintain DSH fork | Very high | Controlled but fork-specific | Very high; merges/security/upstream drift | Can be made strong by modifying registry persistence | Very high | **Do not choose without approval** |

A is preferable to C because it avoids modifying private DSH internals and preserves upgradeability. B is the correct production posture if DSH does not expose the callback/restart contract. C is not justified by this spike and is expressly not selected.

## Acceptance gates for PASS

Upgrade the result from PARTIAL to PASS only when all are demonstrated against the actual supported host:

1. external wrapper creates a stable task ID before DSH execution;
2. a documented DSH API accepts a callback or correlation ID;
3. a real callback runs through the host without private package patching;
4. DSH process termination is followed by a new supported execution entry point;
5. recovery resumes from a persisted checkpoint and does not repeat the completed model call;
6. delivery recovery is independent and idempotent;
7. actual host screenshots and runtime mapping are captured for this version.

Until then, production status remains PARTIAL and the wrapper prototype must stay isolated.
