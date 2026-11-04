---
name: new-widget
description: Guide creation and maintenance of official Lattice Widgets while keeping the manifest, implementation, tests, and release path aligned.
whenToUse: When adding a Widget under public/widgets, changing an official Widget's manifest or behavior, or preparing an official Widget example.
---

# New Widget

## Purpose

Provide the Widget-specific decision and consistency checks. The component contract is owned by [docs/WIDGET_SPEC.md](../../../docs/WIDGET_SPEC.md); this Skill points to the workflow and cross-file checks without copying the full specification.

## Trigger

Use for official Widget creation or maintenance. Do not use it for platform UI features, general SDK work, or unrelated documentation.

## Workflow

1. Read the relevant Widget recipe in `AGENTS.md` and the applicable sections of `docs/WIDGET_SPEC.md`. Inspect a nearby official Widget when its pattern is relevant.
2. For a new package, prefer the existing `npm run create:widget` scaffold. Use manual creation when modifying an existing Widget or when the scaffold cannot represent the approved task. Inspect generated paths and options before editing; do not overwrite existing files.
3. Check the manifest and implementation as one contract: identity and entry point, version, permissions, configuration, help/changelog, localized text, and any declared capabilities must agree with actual behavior. Use `docs/WIDGET_SPEC.md` for exact field rules.
4. Trace cross-file effects such as runtime parsing, SDK usage, translations, tests, indexes, package contents, signatures, or registry data only when the change touches them. Use `invariants` for applicable project invariants and `verify` to select checks.
5. Before packaging or publication, identify which scripts write generated, tracked, signed, or external artifacts. Inspect the expected outputs and keep validation distinct from release. Report required checks and any unverified result.

## Safety

Do not invent Widget protocol rules or duplicate the specification here. Do not add undeclared capabilities or claim behavior unsupported by the implementation. Creating/editing a Widget does not authorize signing, publishing, registry changes, or other release actions; obtain separate explicit authorization for each such operation and use `git-safety` for Git operations.
