---
title: Fixture intent with a removed candidate mark
intent_schema: 3
status: active
created_at: 2026-08-18
updated_at: 2026-08-18
references: []
related_issues: []
related_prs: []
fixture_path: "_docs/intent/Workflow/candidate-mark/decision.md"
---

# Fixture intent with a removed candidate mark

## Context

The candidate mechanism was removed (issue #17). A `(candidate)` heading must
now be rejected with a migration error.

## Decisions

### DEC-001 (candidate): A cross-cutting rule

- **What**: A rule that would previously have been a candidate.
- **Why**: The fixture verifies the removal error.
- **Change freedom**: The fixture may change as long as the mark is rejected.

## Consequences / Impact

None

## Quality Implications

None

## Intent-derived Invariants

None

## Rollback / Follow-ups

None
