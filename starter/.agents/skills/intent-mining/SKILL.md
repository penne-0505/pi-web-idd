---
name: intent-mining
description: Reconstruct design intent (DEC records) from an existing project's comments, git history, documents, and tests when retrofitting the intent-driven template onto a codebase that predates it. Use during or after first-time adoption of an existing project. Do not use for greenfield repositories or day-to-day work.
---

# Intent Mining

Run when the intent-driven template is adopted by a project whose design
decisions predate the intent ledger. `docs-template-migration` integrates the
template's *structure*; this skill recovers the missing *content* — the whys
that already govern the code but were never recorded as DECs.

The norms live in `_docs/standards/workflow.md` (DEC format, the knowledge
4-way split, the comment allowlist) and `_docs/standards/document_contracts.md`
(paths, schema markers). This skill is the excavation procedure, not the
rulebook.

## Ground rules

- **Evidence over invention.** A mined DEC reconstructs a why that some
  artifact attests to. Every mined DEC cites its evidence in the `Why`
  (commit SHA, PR / issue number, document path, or the comment it replaces).
- **A guess is a question, not a record.** When the why can only be inferred
  from code structure, or sources conflict, stop and ask the owner. The
  owner's answer becomes the evidence; do not write speculative DECs.
- **Incremental by default.** Mine the areas you are about to touch, plus any
  seed areas the owner explicitly selects. Do not bulk-mine the whole
  repository in one pass — mass-produced low-confidence DECs poison the
  ledger the same way prose comments did.
- **Unmined is visible, not silent.** Areas left unmined are reported as
  such (見える未完了, workflow.md § schema 移行 and the same stance applies
  here). Never present partial mining as complete coverage.

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
is active (`_docs/standards/template_operations.md`). Create the TODO task —
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

Apply the knowledge 4-way split and the decomposition rule
(workflow.md § 何を intent に書き、何を書かないか): why → DEC; decision
history → the DEC's history / `Revisit when`; pure how → discard; durable
mechanism explanation → `_docs/reference/`. Cross-cutting whys are recorded
as ordinary DECs in the most relevant slug's decision.md, with the
cross-cutting nature stated inside the DEC body. Anything that amounts to a
norm proposal (belongs in AGENTS.md / standards) is presented to the owner
as a proposal — never written as a DEC by the agent.

Completion criterion: every candidate has exactly one destination or is
explicitly discarded as how.

### 5. Confirm and record

Write evidence-backed candidates as DECs at the canonical paths
(`intent_schema: 3`, IDs repo-unique, evidence cited in `Why`). Take
inference-only candidates to the owner as questions first. Place
`// intent: DEC-xxx` pointers where each decision is embodied, and remove the
prose comments a DEC replaces in the same edit — the comment's why now lives
in the ledger, and the pointer marks the spot.

Completion criterion: no mined why exists only in a comment or only in this
session's context; each recorded DEC is reachable from the code it governs.

### 6. Close

Run `./scripts/check-docs.sh`, record the QA round (Intent Delta will be
`DEC-xxx 新設` for mined decisions), and let the workflow's R2 trigger fire
normally — a reconstruction test by the next session is exactly the right
check for freshly mined intent.

Completion criterion: the loop artifacts exist and the report below is
delivered.

## Reporting boundary

Report four buckets separately, never merged: evidence-backed DECs recorded,
owner-confirmed DECs recorded (inference ratified by the owner), hypotheses
deferred as open questions, and areas left unmined. State the evidence tier
used for each recorded DEC.
