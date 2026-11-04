---
name: verify
description: Select proportionate validation for Lattice changes and report evidence, failures, and environment limits accurately.
whenToUse: After implementation when deciding which checks support the changed behavior, before reporting completion, or when a validation result needs interpretation.
---

# Verification

## Purpose

Choose validation based on changed behavior and risk, then report what the evidence establishes. Current commands and test limitations are owned by `AGENTS.md`, [docs/reference/verify.md](../../../docs/reference/verify.md), and the existing npm scripts.

## Trigger

Use when planning or running checks for a code, documentation, Widget, SDK, or packaging change. Do not run unrelated suites merely because this Skill was triggered.

## Workflow

1. Identify the behavior, affected boundaries, and acceptance criteria. Start from `docs/reference/verify.md` and inspect `npm run` for available project scripts rather than maintaining a second command inventory here.
2. Run the narrowest relevant deterministic check first. Add focused browser or unit checks for changed behavior; add integration or broader checks when interactions, risk, or acceptance criteria require them.
3. Identify behavior that cannot be established in the current environment. Use the project docs to decide whether Windows/Tauri validation is required; do not substitute a browser check for native window, tray, process, or OS integration behavior.
4. Record evidence with one of these outcomes:
   - **PASS:** the named check ran and passed for its stated scope.
   - **FAIL:** the check ran and failed; include the failing case and concise error evidence.
   - **BLOCKED:** a required check could not run because an external prerequisite or environment was unavailable; state the blocker.
   - **NOT RUN:** the check was not attempted; state why and whether it remains required.
5. Save enough evidence to support handoff: exact command, exit/result summary, affected page or case count when available, and the relevant failure output or environment limitation. Never claim more coverage than the check provides.

## Safety

Follow `AGENTS.md` and the verification reference for project requirements. Do not change behavior to silence a failing check, fake a result, or run unrelated tests. Avoid interfering with other agents' processes, user data, or workspaces. Git state and Git writes are governed by `git-safety`, not this Skill.
