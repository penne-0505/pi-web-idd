---
name: docs-inventory
description: Use for intent-driven project inventory, stale documentation audit, current-state triage, handoff discovery, or when the user worries docs are drifting, becoming ceremonial, or not being operationally used.
---

# Documentation Inventory

This skill audits whether the intent-driven workflow is still operational. It is diagnostic
and read-only by default: produce an inventory report and recommended next actions, but do not
archive, delete, or rewrite docs unless the user explicitly asks for follow-up implementation.

## When to Use

- Current-state triage after time away from a project.
- Handoff or onboarding discovery when the authoritative doc is unclear.
- A documentation health check, stale documentation audit, or workflow inventory.
- Concern that TODO, intent, or QA docs are valid but no longer operational.

## Inventory Flow

1. **Find the operating surface.** Read `AGENTS.md`, `TODO.md`, and
   `_docs/standards/workflow.md`. Completion criterion: you can name the loop,
   the validation command, and the current depth rules.
2. **Map active work.** Classify each TODO task as ready, blocked, underspecified, or stale.
   Surface pending R2 tasks and their age.
3. **Map durable records.** Inspect `_docs/intent/**` and `_docs/qa/**`:
   - legacy schema documents (no marker / old numbers) — the visible-incomplete backlog
   - durable docs describing behavior that code or QA rounds no longer support
4. **Check the code edge.** Sample intent pointers: do the referenced DECs still explain the
   code next to them? Broken or stale pointers are drift signals validators cannot judge.
5. **Run validators when available.** Prefer `./scripts/check-docs.sh`; report exact commands.
6. **Separate diagnosis from execution.** Recommend actions; change nothing.

## Report Shape

- Overall verdict: `Healthy`, `Needs attention`, or `Drifting`.
- Findings ordered by operational impact.
- Counts: pending R2 tasks, legacy schema docs.
- Recommended next actions: one to three only.
- Owner decisions needed.

## Boundaries

- Do not archive intent, QA, guide, or reference docs.
- Do not remove TODO items.
- Do not treat validator PASS as sufficient health. Validators prove structure, not
  operational use.
