---
name: context-engineering
description: Compatibility entry for the former context-management Skill; current task context discovery belongs to development-workflow.
whenToUse: Read only when following an existing link. Do not invoke as a separate development workflow.
---

# Context Engineering Compatibility Notice

This Skill formerly provided map-first discovery, targeted file reading, focused tool output, and long-task context recovery. Those methods now belong to Context Discovery and Handoff in [development-workflow](../development-workflow/SKILL.md). `AGENTS.md` and project documentation remain the authorities for permanent rules and technical facts.

For new development tasks, use `development-workflow` as the only entry point. This file is retained for compatibility and no longer defines an independent development process. Unified Review remains in the main workflow; this compatibility entry must not trigger a second full Review.
