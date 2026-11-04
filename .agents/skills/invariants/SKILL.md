---
name: invariants
description: Map a planned Lattice code change to the applicable project invariants and connected implementation surfaces.
whenToUse: Before changing code in Lattice, especially when touching bridges, permissions, events, persistence, windows, widgets, security boundaries, or cross-layer contracts.
---

# Invariants

## Purpose

Identify which project invariants apply to a code change and which connected files, callers, tests, or documents need inspection. The rules themselves are owned by [AGENTS.md](../../../AGENTS.md) and [docs/INVARIANTS.md](../../../docs/INVARIANTS.md).

## Trigger

Use before code changes when an invariant may constrain the behavior or when the change crosses a platform, widget, host, persistence, security, or API boundary. Do not load this Skill for unrelated questions or purely editorial changes.

## Workflow

1. Describe the intended behavior and the implementation area that will change.
2. Use the starting map below, then search the relevant code and docs. These are entry points, not a complete impact analysis.
3. Read the full text of each applicable `INV-n` in `docs/INVARIANTS.md`; take the union when several areas match.
4. Trace connected implementations, shared state, hosts, callers, tests, and owned documentation. Check both sides of any duplicated contract.
5. Before implementation, record the applicable INV IDs and the surfaces that must remain consistent. Report uncertainty or an uncovered boundary to `development-workflow`.

| Change area | Start with |
|---|---|
| Bridge, host, permissions, or network capability | INV-2, INV-3, INV-4, INV-7, INV-8, INV-14 |
| Event routing or per-window behavior | INV-9, INV-11 |
| Persisted platform state, placement, or per-instance configuration | INV-5, INV-13 |
| Rendering, scheduling, or widget appearance | INV-6, INV-10, INV-18 |
| Component CSP, platform CSP, or navigation boundaries | INV-12, INV-14, INV-24 |
| Diagnostics and injected error reporting | INV-7 |
| Manifest help, changelog, or cross-layer terminology | INV-17, INV-19 |
| Package trust, signatures, or update paths | INV-15, INV-16 |

## Safety

Do not copy invariant definitions into this Skill or treat this mapping as the complete rule. Follow `AGENTS.md` for permanent constraints and stop if an applicable rule or connected boundary cannot be established. This Skill identifies risks; it does not authorize scope changes or Git operations.
