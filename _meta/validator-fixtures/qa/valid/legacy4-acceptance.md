---
title: "QA: legacy schema 4"
status: active
qa_status: verified
risk: Medium
qa_schema: 4
created_at: 2026-08-15
updated_at: 2026-08-15
references: []
related_issues: []
related_prs: []
fixture_path: _docs/qa/Fixture/legacy4/qa.md
---

# QA: legacy schema 4

## Acceptance Criteria

- AC-001: legacy schema 4 unified doc is lazily accepted.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | lazy acceptance | validator | scripts/validate-qa.ts | verified |

## Rounds

### Round 1 (2026-08-15)

- **Commands**:

  ```bash
  ./scripts/check-docs.sh
  ```

- **AC Coverage**: AC-001 covered
- **Intent Delta**: None: fixture only
- **R2**: 非発動
- **Verdict**: PASS
