---
name: development-workflow
description: Organize Lattice development from task intake through implementation, one unified review, risk-based verification, and handoff.
whenToUse: Use for feature work, bug fixes, refactors, or tasks with multiple implementation steps. Use a short path for simple, obvious, low-risk changes.
---

# Development Workflow

## Purpose

This is the only development workflow entry point. It organizes work; `AGENTS.md`, project docs, source code, tests, and specialist Skills remain the authorities for project rules and technical facts.

## Trigger

Use for implementation work. For a pure knowledge question or a simple local change with an obvious check, use only the relevant parts of this workflow. Call specialist Skills only when their subject applies:

- `git-safety` before relevant Git or Worktree operations.
- `invariants` before code changes.
- `domain-modeling` when introducing or resolving domain terms or contracts.
- `writing-for-agents` when creating or substantially revising formal docs, `AGENTS.md`, or Skills.
- `new-widget` for official Widget creation or maintenance.
- `verify` when selecting or reporting validation.

## Workflow

### 1. Intake

Make the task decidable with:

- **Objective:** the outcome in one sentence.
- **Done When:** observable behavior or checks that determine completion.
- **Non-goals:** areas that must stay untouched.
- **Restrictions:** applicable authorization, workspace, and safety boundaries.
- **Stop Conditions:** baseline mismatch, material ambiguity, scope expansion, or unavailable required evidence.

For a simple task, state these briefly or omit obvious fields. Do not create a long task template for routine work. Create a persistent goal only for work that spans multiple turns and benefits from tracked continuation.

Before asking the user, check the relevant source, docs, history, and task context. Ask only when a material decision cannot be resolved from available evidence; state a reasonable default and why.

### 2. Context Discovery

For a low-risk L1 task with sufficient context and known file locations, skip rereading the project map; still inspect and follow applicable `AGENTS.md` rules. Otherwise, start with the project map in `docs/README.md` and relevant `AGENTS.md` guidance. Read only files that can affect the next decision. Trace the relevant call path and tests before broadening the search. Avoid whole-repository scans and unrelated file reads.

For long-running work, keep a concise record of the objective, baseline, changed files, completed checks, unresolved risks, and the next action in the agreed task record. After a context handoff, reconstruct those items and check `git status` before continuing; do not reread the repository wholesale.

### 3. Classify the Task

Choose the level by risk, impact, reversibility, boundary uncertainty, and verification coverage—not by file count alone.

| Level | Use when | Planning, review, and verification |
|---|---|---|
| **L1 — Simple local** | A contained, low-risk change has an obvious success condition and failure is easy to detect and reverse. | Brief plan; inspect the changed lines; run the focused check. No full review ceremony. |
| **L2 — Standard** | A normal feature or fix follows established architecture and has bounded impact. A change may touch multiple modules and still be L2. | Record scope and dependencies; perform one complete unified review; fix findings and locally re-review; run relevant focused and integration checks. |
| **L3 — High risk** | Architecture or trust boundaries change, or data migration, security, user data, difficult rollback, external integration, or significant uncertainty raises the consequence of failure. | Record impact, dependencies, alternatives, rollback, and acceptance criteria; implement in verifiable slices; perform one complete review of the agreed scope; locally re-review fixes; run the relevant broad validation and identify environment-only checks. |

Old labels map by meaning: `small` is usually L1; `cross-module` is usually L2 but becomes L3 when risk or boundary uncertainty warrants it; `high-risk` is L3. Cross-module alone does not imply L3.

### 4. Plan When the Risk Warrants It

For L2 and L3 work, record scope, affected files and interfaces, dependencies, risks, acceptance criteria, and non-goals before implementation. For L3, include alternatives and a rollback or recovery approach where applicable. Keep a plan brief for L1.

Use these questions selectively when a decision is materially ambiguous or risk is elevated:

- What observable result proves success, and what case must not change?
- Could this lose or corrupt user data, or race with another operation or agent?
- What happens on failure, and how can the change be reversed?
- What evidence will demonstrate the behavior?

Check repository evidence first. Do not ask users to repeat accepted decisions or answer questions that source, docs, or tests can resolve. Never use this method to expand authorization.

### 5. Implement Within Scope

Follow `AGENTS.md` and applicable specialist Skills. Before code changes, use `invariants` to identify relevant INV rules. Make the planned change, avoid unrelated refactors, and preserve other agents' work. If the verified baseline or target files change unexpectedly, stop before dependent writes and report the discrepancy. Use `git-safety` before Git or Worktree operations; this workflow does not grant Git permission.

### 6. Unified Review

Review is a stage of this workflow, not a separate Skill invocation. Perform one complete review of the agreed change scope. Match the review depth to L1/L2/L3 and the acceptance criteria. Check requirements, architecture and invariants, correctness, security and data safety where relevant, compatibility, UI/accessibility where relevant, changed-file boundaries, and actual validation evidence.

Classify findings consistently:

- **P0 — Critical:** severe security, data-loss, or authorization failure; blocks acceptance.
- **P1 — High:** core behavior is wrong or a major regression is likely; blocks acceptance.
- **P2 — Medium:** material functionality or maintainability issue. Before acceptance, fix it or obtain explicit acceptance from the user or designated acceptance owner; record the disposition, rationale, and any follow-up in the review report.
- **P3 — Low:** limited impact; may be recorded as an optimization suggestion without blocking acceptance.
- **Info:** information or residual risk, not a severity level.

Report observed evidence, affected files, impact, and required action. Set the result to `PASS`, `NEEDS FIX`, or `BLOCKED`; mark it blocked when required source, baseline, authorization, or evidence is unavailable. P0/P1 block acceptance. For P2, fix the finding or obtain explicit acceptance from the user or designated acceptance owner, and record who accepted it, the rationale, and any follow-up. P3 may remain as a recorded optimization suggestion. Do not infer a pass from a summary.

After fixes, inspect the changed diff, affected call paths, and related tests. Repeat a full review only when a fix changes architecture or materially expands scope.

### 7. Verify

Select checks by changed behavior and risk. Use the `verify` Skill and the project verification docs for the current commands and environment limits; use existing npm scripts for deterministic checks. Do not reproduce large command inventories here. Report exactly what ran, what passed or failed, what did not run, and what requires Windows/Tauri or another environment.

### 8. Handoff

Use a concise report with these fields:

- **Task**
- **Baseline** — repository/worktree, branch, and HEAD as relevant.
- **Scope**
- **Completed**
- **Changed Files**
- **Review** — status and findings by P0–P3; use Info only for non-severity notes.
- **Verification** — commands and evidence, including unrun checks.
- **Known Issues**
- **Git Status**
- **Authorization** — operations performed and their authorization basis; state if none.
- **Next Action**

Simple tasks may shorten the report, but must not hide changed files, failures, unverified behavior, or remaining risks.

## Safety

Follow `AGENTS.md` for permanent project rules and authorization, and use `git-safety` for Git/Worktree pre-operation checks. This workflow does not grant authorization or override either source. If an applicable boundary is unclear, stop and report.
