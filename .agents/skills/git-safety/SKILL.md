---
name: git-safety
description: Verify repository and Worktree identity, inspect Git state, and keep each Git operation within explicit user authorization.
whenToUse: Use before any Git or Worktree operation that changes refs, the index, files, branches, or integration state. Read-only source review can skip the full procedure unless workspace identity is material.
---

# Git Safety

## Purpose

This Skill provides pre-operation checks for Git and Worktree safety. It does not grant permission, choose product architecture, or make one operation authorize another.

## Trigger

Use before each Git or Worktree operation that changes repository metadata, refs, the index, files, branches, or integration state. For read-only inspection, use only the checks needed to identify the relevant workspace and baseline.

## Workflow

### Identify and inspect the target

From the exact repository path, verify and record:

1. Repository root and target Worktree path.
2. Branch and full HEAD; check upstream when relevant.
3. `git status --short --branch`.
4. Staged and unstaged file lists and diffs, including untracked files.
5. Exact paths, refs, or other state the requested operation will affect.
6. Explicit authorization for this operation and scope.

If a path, branch, HEAD, upstream, status, staged list, or diff differs from the approved conditions, stop and report. Do not repair the mismatch automatically.

### Check the specific operation

Authorization must name the operation. These operations are distinct and must not be inferred from one another:

| Operation | What to verify | Authorization boundary |
|---|---|---|
| `fetch` | Remote and refs to update; record that remote-tracking metadata changes | Requires authorization to fetch; does not update the working branch or authorize `pull` |
| `pull` | Remote, branch, resulting integration, and working-tree effects | Requires separate explicit authorization; never treat fetch approval as pull approval |
| `add` | Exact files and complete diff; check for generated files, secrets, and others' work | Stage only authorized paths; never use broad staging to avoid review |
| `commit` | Complete staged diff, file list, `git diff --cached --check`, message | Requires explicit commit authorization for that staged content |
| `push` | Exact remote, branch/ref, and outgoing commits | Requires separate explicit push authorization |
| `merge` | Source, target, expected result, conflicts, and affected worktree | Requires separate explicit merge authorization |
| `rebase` | Exact base and commits to replay; conflict/recovery implications | Requires separate explicit rebase authorization |
| `reset` | Exact mode, ref, and affected index/files | Potentially destructive; do not run without explicit authorization for the exact reset |
| `clean` | Exact path set and ignored/untracked data at risk | Destructive; do not run without explicit authorization for the exact cleanup |
| Worktree/branch creation or deletion | Target path, branch, base, current occupancy and status | Requires authorization for that exact creation or deletion |
| Restore/revert/checkout of files | Exact files and content to replace | Requires explicit authorization; never overwrite unexplained or other-agent changes |

### Protect parallel work

Use an isolated writable Worktree for each coding owner. Before creating or reusing one, check whether its path or branch is already in use and whether it contains changes. Do not infer authorship from timestamps or style. Do not overwrite, stash, reset, clean, or delete a Worktree containing unexplained or uncommitted work. Do not terminate processes owned by another agent.

### Report the result

For the requested operation, report the repository and Worktree, branch, HEAD, upstream when relevant, status, staged paths, diff scope, authorization basis, operation performed or withheld, and resulting state. If no write was authorized, state that no Git write was performed.

## Safety

Follow `AGENTS.md` as the permanent authority for Git and collaboration rules. This Skill defines the operation-specific checks and cannot grant or broaden authorization. If a check fails or relevant state is uncertain, stop and preserve the current state.
