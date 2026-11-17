---
name: propter-prep
description: Use before implementation work in a repository that uses intent-driven development (it has `docs-template.lock.json` and a `TODO.md`) — aligns the TODO task, depth artifacts (Plan / qa.md), and the Choices standing on the places the work will touch before code changes begin. In a repository that does not, do nothing.
---

# Prep

Run before implementation. The norms live in `idd rules show workflow`
(the loop, depth rules, comment rules) — this skill is the procedure, not the rulebook.

First confirm this is an intent-driven repository: it has `docs-template.lock.json`
and a `TODO.md`. When it does not, stop — this skill is for intent-driven development,
and it must not create `_docs/plan` / `_docs/qa` files, Choice records, or TODO tasks there.

## Procedure

1. **Clarify the request.** Restate the goal, assumptions, and open questions.
2. **Read the Choices on the places you will touch.** AGENTS.md, the TODO task, and the
   standards sections that apply. Then run
   `idd intent lookup <path>...` for the files the work will change. Every active or
   unconfirmed Choice it pulls on a file or dir place gets a disposal before you write the
   plan: an unconfirmed one is confirmed, dropped (`--grounds`), or superseded; an active
   one is kept, changed within its free, re-anchored, or superseded. `root` Choices are not
   yours to move from a lane. The main failure to avoid is re-inventing an existing
   decision under a new ID.
3. **Audit the TODO task.** It needs `Size`, `Risk`, AC-001-style Acceptance Criteria, and
   a QA path (never `None`). Check the repo's declared dangerous paths (`risk_paths` in
   `config/repos.yaml`; there is no built-in list — see workflow.md § Risk 分類 / § repo の risk の宣言 /
   § 自動下限) before trusting the declared Risk: a change touching one is High. High is the six kinds of harm that cannot be undone — authentication,
   authorization, billing, permission, data loss, and secrets — not difficulty.
4. **Create the depth artifacts** the task requires
   (see workflow.md § lane の外の手の変更; a lane's depth is the planner's, § 深さ):
   - `Size >= M` → create `_docs/plan/<Area>/<slug>/plan.md` as a request
     (依頼 / 意図 / 重要なコンテクスト / 裁量 / 完了の形 / 戻す条件). The fields and their
     entry conditions are `_docs/standards/brief.md`; write the original's place and how to
     read it, never a summary of it.
   - `Risk >= Medium` → create `_docs/qa/<Area>/<slug>/qa.md` from the template with
     `qa_status: planned`; fill Acceptance Criteria and the Checks table now, before
     implementation. Do not write a Rounds section.
   - A decision made now → raise it as a Choice with
     `idd intent raise choice --session <id> --file F.json` (purpose / forms / place /
     why / anchored, plus free / revisit / question / no_why_not as they apply). A Choice
     with no rejected form needs `no_why_not`. A Choice joins an active Purpose; when none
     fits, propose one with `idd intent raise purpose --file`. A root Choice is proposed
     with `idd intent propose` and confirmed by a person. Write what must hold in `anchored`
     as prose: never number an INV (records.md § INV を立てない).
5. **Plan the places and tests.** Decide which paths / symbols go into each Choice's
   `place` and which conditions become tests (Checks in qa.md). No pointers in code
   (records.md § コードとの結び付き).
6. **Report before touching code**: docs read, TODO state, the Choices you disposed of,
   open questions.
