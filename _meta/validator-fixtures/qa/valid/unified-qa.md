---
title: "QA: Unified fixture"
status: active
qa_status: verified
risk: Medium
qa_schema: 5
created_at: 2026-08-15
updated_at: 2026-08-15
references:
  - "_docs/intent/Fixture/unified/decision.md"
related_issues: []
related_prs: []
fixture_path: _docs/qa/Fixture/unified/qa.md
---

# QA: Unified fixture

## Acceptance Criteria

- AC-001: fixture exercises the unified schema.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | unified schema validates | validator | scripts/validate-qa.ts | verified |

## Rounds

### Round 1 (2026-08-15)

- **Commands**:

  ```bash
  deno run --allow-read scripts/validate-qa.ts
  ```

- **AC Coverage**: AC-001 verified
- **Intent Delta**: applied: DEC-101
- **R2**: 非発動
- **Verdict**: PASS
