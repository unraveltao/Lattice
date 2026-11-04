---
name: writing-for-agents
description: Maintain Lattice project rules, Skills, and formal documentation with clear ownership and verifiable references.
whenToUse: When creating or substantially revising AGENTS.md, a project Skill, formal docs, or the ownership and relationships between project documents.
---

# Writing for Agents

## Purpose

Help agents put each rule, decision, procedure, and technical fact in its authoritative home and keep references maintainable.

## Trigger

Use for new or substantial edits to `AGENTS.md`, `SKILL.md`, formal project docs, or documentation responsibilities. Do not load it for routine code comments or minor copy changes unless the document's ownership or meaning changes.

## Workflow

1. Read the relevant routing and language guidance in [docs/README.md](../../../docs/README.md), plus applicable `AGENTS.md` rules.
2. Search for the existing fact or rule. Decide its owner before editing: permanent rules in `AGENTS.md` or the relevant standard; decisions in their decision record; reference procedures in the appropriate reference doc; task methods in Skills.
3. Write only the information owned by that file. Link to other authorities instead of copying their technical facts. Distinguish implemented behavior from planned or unverified behavior using repository evidence.
4. For architecture, workflow, or Skill-relationship changes, check which maintained diagrams represent those relationships. Update the editable source and rendered artifact together when the depicted structure changes; keep the diagram's ownership and update rule documented with its source. If updating a diagram is outside the approved scope, report the required follow-up rather than silently leaving it stale.
5. Check relative links and document-specific requirements with the existing `npm run check:docs` script; use other checks only when the changed document requires them.

## Safety

`docs/README.md` and `AGENTS.md` remain authoritative for document placement, language, and project rules. Do not create a second home for an existing fact or claim behavior without source/test evidence. Respect the approved file scope; document authorization does not authorize Git writes, which are handled separately by `git-safety`.
