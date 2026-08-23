---
name: close
description: Use after implementation work — records the QA round (Intent Delta, R2, verdict), reviews the change, and decides task completion.
---

# Close

Run after implementation, before the final response. The norms live in
`_docs/standards/workflow.md` — this skill is the procedure, not the rulebook.

## Procedure

1. **Verify.** Run the planned checks, `./scripts/check-docs.sh`, and the project's own
   build / typecheck / lint / test gates. The wrapper covers documentation contracts and
   the validators' own health only — a green wrapper is not evidence that the project
   still builds, and template-shipped files land inside the project's tree. Report the
   documentation gate and the project gates separately. Compare the diff against the
   request, TODO Goal, and Acceptance Criteria.
2. **R1 review** (workflow.md § R1): switch to a reviewer stance — or hand to a
   different model when available — and check: DEC conformance, pointer placement,
   whether a `None:` Intent Delta is actually justified.
3. **Record the Round** in the task's `qa.md`, or in `_docs/qa/<Area>/maintenance.md` for
   small work (format: workflow.md § QA round). Every change gets a Round.
4. **R2** (workflow.md § R2): if triggered (new DEC / `Size >= M` / `Risk High`),
   write `R2: PENDING` and add an R2 task to TODO.md — or run it synchronously if this
   harness can spawn an isolated fresh-context call (pass only the commit range and QA doc
   path; grade the blind answers before completion).
5. **Decide completion.** `PASS` (or accepted `PARTIAL`) → remove the TODO task, add
   follow-ups and the R2 task. `FAIL` / `BLOCKED` → the task stays.
6. **Archive the Plan** if one exists: `git mv` to `_docs/archives/plan/<Area>/<slug>/`
   and update references. Never archive intent / QA / guide / reference — mark obsolete
   ones `status: superseded` / `obsolete` instead.
7. **Summarize**: validations actually run, verdict.

## Turn-End Conduct

A turn may end with documentation debt; a task may not close with it. If docs are behind at
turn end, state the gap in one line and handle it at the head of the next mainline
instruction — do not start unprompted work, and do not re-ask for permission the loop
already grants.
