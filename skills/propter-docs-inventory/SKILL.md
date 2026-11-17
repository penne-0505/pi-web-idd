---
name: propter-docs-inventory
description: Use in a repository that uses intent-driven development, for its project inventory, stale documentation audit, current-state triage, handoff discovery, or when the user worries docs are drifting, becoming ceremonial, or not being operationally used.
---

# Documentation Inventory

Use this only in an intent-driven repository: it has `docs-template.lock.json` and a `TODO.md`.
When it does not, stop.

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
   `idd rules show workflow`. Completion criterion: you can name the loop,
   the validation command, and the current depth rules.
2. **Map active work.** Classify each TODO task as ready, blocked, underspecified, or stale.
   Surface old-form R2 tasks still open and their age. R2 itself was removed (migration.md § R2 を外した):
   recommend closing each or rewriting it as an ordinary task.
3. **Map durable records.** Inspect `_docs/intent/**` (the drawn projections) and `_docs/qa/**`:
   - legacy schema documents (no marker / old numbers, old-form rounds) — the visible-incomplete backlog
   - unconfirmed Choices on the areas in active use (`idd intent records`)
   - durable docs describing behavior that code or QA rounds no longer support
4. **Check the code edge.** Sample the Choices on busy files (`idd intent lookup <path>`): does
   their why still explain the code they govern? A Choice whose why no longer fits is a drift
   signal validators cannot judge.
5. **Run validators when available.** Prefer `idd rules check`; report exact commands.
6. **Separate diagnosis from execution.** Recommend actions; change nothing.

## Report Shape

- Overall verdict: `Healthy`, `Needs attention`, or `Drifting`.
- Findings ordered by operational impact.
- Counts: unconfirmed Choices on active areas, open old-form R2 tasks, legacy schema docs.
- Recommended next actions: one to three only.
- Owner decisions needed.

## Boundaries

- Do not archive intent, QA, guide, or reference docs.
- Do not remove TODO items.
- Do not treat validator PASS as sufficient health. Validators prove structure, not
  operational use.
