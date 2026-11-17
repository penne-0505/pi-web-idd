---
name: propter-close
description: Use after implementation work in a repository that uses intent-driven development (it has `docs-template.lock.json` and a `TODO.md`) — records the intent of every change (a Choice, or a Waive), checks the records, and decides task completion. In a repository that does not, do nothing.
---

# Close

Run after implementation, before the final response. The norms live in
`idd rules show workflow` — this skill is the procedure, not the rulebook.

First confirm this is an intent-driven repository: it has `docs-template.lock.json`
and a `TODO.md`. When it does not, stop — do not create Choice records, `_docs/qa` files,
or TODO tasks there.

## Procedure

1. **Verify.** Run the planned checks, `idd rules check`, and the project's own
   build / typecheck / lint / test gates. The wrapper covers documentation contracts and
   the validators' own health only — a green wrapper is not evidence that the project
   still builds, and template-shipped files land inside the project's tree. Report the
   documentation gate and the project gates separately. Compare the diff against the
   request, TODO Goal, and Acceptance Criteria.
2. **Check the intent records.** Every change was recorded when it was made, or declared
   with `idd intent waive --session <id>` (applied or no-choice). Run
   `idd intent check` and make it pass. A Choice with no rejected form carries a
   `no_why_not` reason; an unconfirmed Choice left on a file you touched is confirmed,
   dropped, or superseded. Do not gather the records up at the end — write or declare
   them inside the change that made them. Never number an INV: what must hold goes into
   the Choice's `anchored` as prose.
3. **Record the QA round** when the change ran outside a lane (a lane writes none — the
   harness keeps its verification log). Append it to `_docs/qa/<Area>/maintenance.md`, or to
   the slug's qa.md for `Risk >= Medium`, with Commands, AC Coverage, Risk (the round's own),
   Choice and/or Waive, and Verdict (document_contracts.md § qa). No Intent Delta or R2 field.
   A `Risk High / Critical` change made outside a lane is reviewed independently by another
   role, given only the diff and the rules, before it closes; its findings and what was done
   with them go into AC Coverage (workflow.md § lane の外の手の変更).
4. **Decide completion.** With the records in place (a Choice, a Waive, or the record's own
   note) and the checks passing, the task is complete. Remove the TODO task and add
   follow-ups. Otherwise the task stays.
5. **Archive the Plan** if one exists: `git mv` to `_docs/archives/plan/<Area>/<slug>/`
   and update references. Never archive intent / QA / guide / reference — mark obsolete
   ones `status: superseded` / `obsolete` instead.
6. **Summarize**: validations actually run, the records made, verdict.

## Turn-End Conduct

A turn may end with documentation debt; a task may not close with it. If docs are behind at
turn end, state the gap in one line and handle it at the head of the next mainline
instruction — do not start unprompted work, and do not re-ask for permission the loop
already grants.
