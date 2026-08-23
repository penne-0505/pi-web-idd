---
title: Fixture QA verification v3 with transferable principle candidate
qa_schema: 3
status: active
draft_status: n/a
qa_status: verified
risk: Medium
created_at: 2026-08-04
updated_at: 2026-08-04
references:
  - "_docs/qa/Workflow/transferable-principles/test-plan.md"
  - "_docs/intent/Workflow/transferable-principles/decision.md"
related_issues: []
related_prs: []
fixture_path: "_docs/qa/Workflow/transferable-principles/verification.md"
---

# Fixture QA verification v3 with transferable principle candidate

## Summary

The fixture represents a passing qa_schema 3 verification that records a
transferable principle candidate from session-end reflection.

## Verification Verdict

Verdict: PASS

## Commands Run

| Command / Test | Result | Notes |
| --- | --- | --- |
| `deno run --allow-read scripts/validate-qa.ts --fixture _meta/validator-fixtures/qa/valid` | PASS | Valid fixture directory exits 0. |

## Automated Test Results

- AC-001: Validator accepted the valid fixture.

## Manual QA Results

- Reflection section review is represented by this fixture.

## Acceptance Criteria Coverage

- AC-001: Covered by validator fixture execution.

## Decision Conformance

- DEC-001: The accepted fixture preserves the why-first QA structure.

## Invariant Coverage

None

## Deferred / Not Covered

- None

## Residual Risks

None

## Follow-up TODOs

- None

## Transferable Principles

- TP: 同一 file 内で同じ役割を担う処理は、同じ座標系・同じ表現手段で書く。表現の混在は
  単一 context の QA では検出できず、別 context で初めて症状化する。
  (契機: portrait 限定バグの根因が同役割 noise の座標系不一致だった /
  昇格先候補: _docs/intent/Workflow/conventions/decision.md)
