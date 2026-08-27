---
title: "QA: outbox の未達を UI に出す"
status: active
qa_status: verified
risk: Low
qa_schema: 5
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/intent/pi-web-idd/idd-902/decision.md"
  - "_docs/reference/pi-web-idd/idd-902/reference.md"
related_issues:
  - 4
related_prs: []
---

# QA: `outbox の未達を UI に出す`

<!-- Canonical path: _docs/qa/pi-web-idd/idd-902/qa.md -->

## Acceptance Criteria

- AC-001 (QA-1): `outbox.jsonl` に `delivered_at: null` の envelope が n 件あるとき、`GET /api/idd/state` のレスポンスに総数 n が含まれる
- AC-002 (QA-2): ある lane に紐づく未達が m 件あるとき、`GET /api/idd/lane/[id]` のレスポンスに m が含まれる (他 lane の未達は含まない)
- AC-003 (QA-3): Inbox の「判断キュー」見出し行に「未達 n 件」が出る。0 件のときは出ない (または chrome として読ませない水準に留まる)
- AC-004 (QA-4): lane detail の見出しに「未達 m 件」がその lane 分だけ出る
- AC-005 (QA-5): `delivered_at` 設定済みの envelope は件数に含まれない (同一 `envelope_id` の後続レコードで merge される `pendingEnvelopes()` の既存動作を壊さない)
- AC-006 (QA-6): 未達のうち error 付き (配送失敗) があるとき、総数とは別に失敗分であることが表示から読み取れる (DEC-665)

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | decision.md | state レスポンスに総数 | unit | `lib/idd-ui/server/state.undelivered.test.mjs` (fixture の outbox.jsonl) | verified |
| AC-002 | decision.md | lane detail レスポンスに lane 分 | unit | `lib/idd-ui/server/state.undelivered.test.mjs` (複数 lane の未達を混ぜる) | verified |
| AC-003 | DEC-664 | Inbox 見出し行の表示 | manual | `next dev` + fixture で Inbox を目視 (0 件時の非表示も確認) | verified |
| AC-004 | DEC-664 | lane detail 見出しの表示 | manual | lane detail を目視 (IDD-901 = 2 件 / IDD-902 = 1 件) | verified |
| AC-005 | INV-009 | merge 動作の非回帰 | unit | `lib/idd-ui/server/outbox-undelivered.test.mjs` (pendingEnvelopes / countUndelivered) | verified |
| AC-006 | DEC-665 | error 付きの区別表示 | manual | error 付き envelope を含む fixture で目視 (「(失敗 1)」を確認) | verified |
| INV-008 | decision.md | 書き込み / 配送の非変更 | diff-review | `git diff` で `queueEnvelope` / `patch` / `deliverPending` に変更が無いこと | verified |

## Rounds

<!-- 追記専用。実装後に Round を追記する。 -->

### Round 1 (2026-08-27)

- **Intent Delta**: None: DEC-664〜668 の範囲内で実装。契約の追加・変更なし
- **R2**: 非発動 (契約変更なし、risk Low)
- **Verdict**: PASS

実施内容:

- `packages/idd-core/src/agent/outbox.ts` に `countUndelivered(iddId?)` を追加 (pendingEnvelopes() から導く。total = delivered_at null 全件、failed = そのうち error 付き)
- `buildState()` / `buildLaneDetail()` のレスポンスに `undelivered: { total, failed }` を追加 (DEC-666)
- Inbox「判断キュー」見出し行に「未達 n 件 (失敗 m)」、lane detail 見出し右端に lane 分を静的表示 (0 件時は非表示、DEC-667 どおり押せない)
- unit: `lib/idd-ui/server/state.undelivered.test.mjs` (AC-001/002)、`lib/idd-ui/server/outbox-undelivered.test.mjs` (AC-005)。`@idd/core` は tsconfig paths のみの alias のため `idd-core-alias.loader.mjs` の resolve hook で node --test から解決
- manual: `IDD_STATE_DIR=/tmp/idd-902-fixture next dev -p 30241` で実機確認。Inbox に「未達 3 件 (失敗 1)」、IDD-901 detail に「未達 2 件 (失敗 1)」、IDD-902 detail に「未達 1 件」、outbox 空では非表示を目視
- diff-review: `git diff packages/idd-core/src/agent/outbox.ts` は `countUndelivered` の追加のみ。`queueEnvelope` (ledger/write.ts) / `patch` / `deliverPending` 無変更 (INV-008)
