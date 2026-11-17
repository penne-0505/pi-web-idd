---
name: propter-intent-mining
description: Use only in a repository that uses intent-driven development (it has `docs-template.lock.json` and a `TODO.md`). Reconstruct design intent (Choice records) from an existing project's comments, git history, documents, and tests when retrofitting the intent-driven template onto a codebase that predates it. Use during or after first-time adoption of an existing project. Do not use for greenfield repositories or day-to-day work.
---

# Intent Mining

Run this only in an intent-driven repository: it has `docs-template.lock.json` and a `TODO.md`.
When it does not, stop.

Run when the intent-driven template is adopted by a project whose design
decisions predate the intent ledger. `propter-docs-template-migration` integrates the
template's *structure*; this skill recovers the missing *content* — the whys
that already govern the code but were never recorded as Choices.

The norms live in `idd rules show records` (the Choice's fields, the
knowledge split, Place, the code edge) and `idd rules show workflow` (the loop).
This skill is the excavation procedure, not the rulebook.

## Ground rules

- **Evidence over invention.** A mined Choice reconstructs a why that some
  artifact attests to. Every mined Choice states the cause in its `why` and
  names the evidence (commit SHA, PR / issue number, document path, or the
  comment it replaces) beside it — the evidence alone is never the why.
- **A guess is a question, not a record.** When the why can only be inferred
  from code structure, or sources conflict, stop and ask the owner. The
  owner's answer becomes the evidence; do not raise speculative Choices.
- **Incremental by default.** Mine the areas you are about to touch, plus any
  seed areas the owner explicitly selects. Do not bulk-mine the whole
  repository in one pass — mass-produced low-confidence Choices poison the
  records the same way prose comments did.
- **Unmined is visible, not silent.** Areas left unmined are reported as
  such (見える未完了, migration.md § 旧い形の記録の扱い, and the same stance
  applies here). Never present partial mining as complete coverage.

## Sources, strongest first

1. Explicit design records: ADRs, design docs, RFCs, PR descriptions, issues.
2. Commit messages (`git log --follow`, `git blame` on the surprising lines).
3. Existing prose comments — under the comment allowlist these must be triaged
   anyway; mining decides whether each one carries a why worth keeping.
4. Tests — especially assertions that look arbitrary; they often encode a
   forgotten contract.
5. Code structure alone — the weakest source. Anything derived only from
   structure is a hypothesis and follows the guess rule above.

## Procedure

### 1. Fix the scope

Have the owner name the seed areas (or confirm demand-driven-only mining).
Record the scope and its relation to `DD_SCOPE_BASE` if incremental adoption
is active (`idd rules show template_operations`). Create the TODO task —
mining is a change and runs the normal loop.

Completion criterion: the mined / deferred boundary is written down before
any excavation starts.

### 2. Inventory the evidence

Survey which sources exist and how reliable they are for this project:
doc directories, ADR conventions, PR / issue history accessibility, comment
density, test suite shape. Note areas where history was squashed or imported
(evidence there is weaker).

Completion criterion: for each in-scope area, the available source tiers are
listed.

### 3. Excavate candidate whys

Per area, collect candidates with their evidence: triage every prose comment,
read the history of surprising code (`git log` / `blame`), read the docs and
the odd-looking tests. A candidate is a (claim, evidence) pair — never a
claim alone.

Completion criterion: every in-scope prose comment and every
surprising-but-stable structure has either a candidate entry or an explicit
"no recoverable why" note.

### 4. Classify

Apply the knowledge split and the decomposition rule
(records.md § 書かないもの、立てる判定): why → a Choice; decision history →
the Choice's `revisit` (the harness keeps its history); pure how → discard;
durable mechanism explanation → `_docs/reference/`. A why with no rejected
form a changer would reach for is not a Choice. A why that holds for the
whole repo is a root Choice and is proposed to the owner
(`idd intent propose root-supersede|root-reanchor` when one already stands).
Anything that amounts to a norm proposal (belongs in AGENTS.md / standards)
is presented to the owner as a proposal — never raised as a Choice by the
agent.

Completion criterion: every candidate has exactly one destination or is
explicitly discarded as how.

### 5. Confirm and record

Raise evidence-backed candidates as Choices through the door
(`idd intent raise choice --session <id> --file F.json`: purpose, forms with
the rejected forms or `no_why_not`, place, why, anchored). A Choice joins an
active Purpose (`idd intent purposes`); when none fits, propose one with
`idd intent raise purpose --file` and let the owner confirm it. Take
inference-only candidates to the owner as questions first. The place is the
module the decision governs (a file mark and symbols are optional); what must
hold goes into `anchored` as prose, never as a numbered INV. Code comments
stay under the project's own conventions, and no pointer comment is left in
code.

Completion criterion: no mined why exists only in a comment or only in this
session's context; each recorded Choice is reachable from the code it governs
through its place (`idd intent lookup <path>`).

### 6. Close

Run `idd rules check` and `idd intent check`, and record the QA round with
the Choice field naming the raised Choices (document_contracts.md § qa). When
the owner wants the freshly mined whys checked, have a session that did not
mine them review the diff and the records alone, and write its findings in the
round's AC Coverage.

Completion criterion: the loop artifacts exist and the report below is
delivered.

## Reporting boundary

Report four buckets separately, never merged: evidence-backed Choices
recorded, owner-confirmed Choices recorded (inference ratified by the owner),
hypotheses deferred as open questions, and areas left unmined. State the
evidence tier used for each recorded Choice.
