---
title: "QA: Unified fixture with bare None"
status: active
qa_status: verified
risk: Medium
qa_schema: 5
created_at: 2026-08-15
updated_at: 2026-08-15
references: []
related_issues: []
related_prs: []
fixture_path: _docs/qa/Fixture/bare-none/qa.md
---

# QA: Unified fixture with bare None

## Acceptance Criteria

- AC-001: bare None must be rejected.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | bare None fails | validator | scripts/validate-qa.ts | planned |

## Rounds

### Round 1 (2026-08-15)

- **Commands**:

  ```bash
  ./scripts/check-docs.sh
  ```

- **AC Coverage**: AC-001 covered
- **Intent Delta**: None
- **Verdict**: PASS
