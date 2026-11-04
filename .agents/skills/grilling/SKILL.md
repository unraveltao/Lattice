---
name: grilling
description: Compatibility entry for the former requirements-challenge and review Skill; current development work belongs to development-workflow.
whenToUse: Read only when following an existing link. Do not invoke as a separate workflow or Review entry.
---

# Grilling Compatibility Notice

This Skill formerly provided requirements challenge questions and delivery review. Its useful methods have moved to [development-workflow](../development-workflow/SKILL.md): check repository evidence before asking, avoid repeating settled decisions, and use risk-focused questions about success, counterexamples, user data, concurrency, failure, rollback, and evidence when ambiguity or risk warrants them. Unified Review dimensions, P0–P3 findings, evidence, and fix re-review are handled in that same workflow.

For new development tasks, use `development-workflow` as the only entry point. This file is retained for compatibility and no longer defines an independent development process. During the compatibility period, do not trigger a second full Review from this Skill.
