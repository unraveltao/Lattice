---
name: domain-modeling
description: Establish consistent names and domain contracts across Lattice interfaces and implementation layers.
whenToUse: When introducing a cross-layer concept, command, field, event, permission, or Widget contract, or when one term is used with conflicting meanings.
---

# Domain Modeling

## Purpose

Define a clear, stable concept and its names across the layers that consume it. `GLOSSARY.md` owns shared terminology; the relevant specification and source own behavior and interface details.

## Trigger

Use for concepts visible across Rust, TypeScript, SDK, Widget manifests, or user-facing language. Do not add local implementation names that are clear from their owning code and are not shared domain terms.

## Workflow

1. State the concept, its users, and the boundary it represents.
2. Search `GLOSSARY.md`, source, and relevant specifications for existing names and meanings.
3. Choose one canonical term. If a term already means two different things, separate the concepts with distinct names rather than adding vague qualifiers.
4. Map the contract across consumers: commands and payloads, persisted keys, TypeScript/Rust/SDK types, events, manifests, UI labels, and docs as applicable. Keep display wording distinct from stored identifiers.
5. If the term is genuinely shared, add or refine its concise definition and pointer in `GLOSSARY.md`. Put behavior constraints in their owning specification; do not duplicate them in the glossary.
6. Recheck the affected interfaces for consistent naming and report any compatibility or migration requirement to `development-workflow`.

## Safety

Do not rename persisted data or public interfaces as a wording-only cleanup; establish compatibility and a migration plan first. Follow `AGENTS.md` for project rules and authorization. This Skill does not authorize scope expansion or Git operations.
