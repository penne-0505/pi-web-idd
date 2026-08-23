---
title: "QA: R2 suppressed despite DEC creation"
status: active
qa_status: verified
risk: Medium
qa_schema: 5
created_at: 2026-08-15
updated_at: 2026-08-15
references: []
related_issues: []
related_prs: []
fixture_path: _docs/qa/Fixture/r2-mismatch/qa.md
---

# QA: R2 suppressed despite DEC creation

## Acceptance Criteria

- AC-001: R2 must fire when a DEC is created.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | R2 trigger consistency | validator | scripts/validate-qa.ts | planned |

## Rounds

### Round 1 (2026-08-15)

- **Commands**:

  ```bash
  ./scripts/check-docs.sh
  ```

- **AC Coverage**: AC-001 covered
- **Intent Delta**: DEC-900 新設
- **R2**: 非発動
- **Verdict**: PASS
