---
name: prep
description: Use before starting any implementation work — aligns the TODO task, depth artifacts (Plan / qa.md), and existing decisions before code changes begin.
---

# Prep

Run before implementation. The norms live in `_docs/standards/workflow.md`
(the loop, depth rules, comment rules) — this skill is the procedure, not the rulebook.

## Procedure

1. **Clarify the request.** Restate the goal, assumptions, and open questions.
2. **Read before writing.** AGENTS.md, the TODO task, and the standards sections that
   apply. Then grep `_docs/intent/` for DEC entries already governing the area — the main
   failure to avoid is re-inventing an existing decision under a new ID.
3. **Audit the TODO task.** It needs `Size`, `Risk`, AC-001-style Acceptance Criteria, and
   a QA path (never `None`). Check the path-based risk floor
   (see workflow.md § 自動下限) before trusting the declared Risk.
4. **Create the depth artifacts** the task requires
   (see workflow.md § 深さの段階):
   - `Size >= M` → create `_docs/plan/<Area>/<slug>/plan.md`
     (Overview / Scope / Non-Goals / Requirements / Tasks / QA Plan / Rollout).
   - `Risk >= Medium` → create `_docs/qa/<Area>/<slug>/qa.md` from the template with
     `qa_status: planned`; fill Acceptance Criteria and the Checks table now, before
     implementation.
   - Known design decisions → record as DECs now (`intent_schema: 3`, ID = repo max + 1);
     decisions that emerge later are caught by the Intent Delta at close.
5. **Plan the pointers and tests.** Decide where `// intent: DEC-xxx` anchors will go and
   which checks become tests vs pointers (see workflow.md § intent ↔ code
   traceability — one condition, one enforcement).
6. **Report before touching code**: docs read, TODO state, applicable DECs
   (`applied:` candidates), open questions.
