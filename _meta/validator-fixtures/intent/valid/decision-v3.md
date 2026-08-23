---
title: Intent fixture (schema 3)
status: active
intent_schema: 3
created_at: 2026-08-15
updated_at: 2026-08-15
references: []
related_issues: []
related_prs: []
fixture_path: _docs/intent/Fixture/unified/decision.md
---

## Context
- validator fixture for intent_schema 3.

## Decisions

### DEC-101: Repository-unique IDs anchor code pointers

- **What**: DEC IDs are allocated once per repository.
- **Why**: code-side pointers must resolve from the ID alone, without an area/slug tuple that rots on renames.
- **Change freedom**: the numbering sequence and formatting may change while IDs stay unique and stable.

## Consequences / Impact
- pointers survive slug renames.

## Quality Implications
- duplicate IDs would break pointer resolution.

## Intent-derived Invariants
None

## Rollback / Follow-ups
- none.
