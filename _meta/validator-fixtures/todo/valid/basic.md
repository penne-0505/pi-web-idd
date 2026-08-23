# TODO fixture: valid basic

## 0. System Metadata

- **Current Max ID**: `Next ID No: 4`

## Inbox

-

## Backlog

### Docs-Chore-1: [Chore] Update project display name

- **Title**: [Chore] Update project display name
- **ID**: Docs-Chore-1
- **Priority**: P2
- **Size**: S
- **Risk**: Low
- **Area**: Docs
- **Dependencies**: []
- **Goal**: README and Quickstart use the project display name.
- **Acceptance Criteria**:
  - AC-001: README uses the project display name.
  - AC-002: Quickstart uses the project display name.
- **Steps**:
  1. [ ] Update README.
  2. [ ] Update Quickstart.
- **Description**:
  - Context: Low-risk template customization.
  - Notes: Rounds go to maintenance.md.
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Docs/maintenance.md

### Template-Enhance-2: [Enhance] Add validator fixture self-test

- **Title**: [Enhance] Add validator fixture self-test
- **ID**: Template-Enhance-2
- **Priority**: P1
- **Size**: M
- **Risk**: Medium
- **Area**: Template
- **Dependencies**: []
- **Goal**: Validator fixtures can prove valid and invalid schema examples.
- **Acceptance Criteria**:
  - AC-001: Valid fixtures pass validation.
  - AC-002: Invalid fixtures fail validation.
- **Steps**:
  1. [ ] Add fixtures.
  2. [ ] Run self-test.
- **Description**:
  - Context: Validator behavior is part of the intent-driven workflow contract.
  - Notes: Medium risk requires Plan / Intent / QA.
- **Plan**: _docs/plan/Template/validator-fixture-self-test/plan.md
- **Intent**: _docs/intent/Template/validator-fixture-self-test/decision.md
- **QA**: _docs/qa/Template/validator-fixture-self-test/qa.md

### Template-R2-3: [R2] Reconstruct the why of the fixture self-test change

- **Title**: [R2] Reconstruct the why of the fixture self-test change
- **ID**: Template-R2-3
- **Priority**: P2
- **Size**: XS
- **Risk**: Low
- **Area**: Template
- **Dependencies**: []
- **Goal**: The reconstruction test for Template-Enhance-2 is answered and its gaps are recorded.
- **Acceptance Criteria**:
  - AC-001: The four fixed questions are answered from the diff and in-repo docs only.
  - AC-002: Results and gaps are appended to the QA round.
- **Steps**:
  1. [ ] Answer the fixed questions.
  2. [ ] Append results and gaps.
- **Description**:
  - Context: The `R2` category carries a digit; this fixture keeps the Title parser accepting it.
  - Notes: A reconstruction task is created whenever R2 fires.
- **Plan**: None
- **Intent**: None
- **QA**: _docs/qa/Template/validator-fixture-self-test/qa.md

## Ready

## In Progress
