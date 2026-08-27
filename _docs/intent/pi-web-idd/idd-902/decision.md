---
title: outbox の未達を UI に出す — 設計判断
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references:
  - "_docs/qa/pi-web-idd/idd-902/qa.md"
  - "_docs/reference/pi-web-idd/idd-902/reference.md"
related_issues:
  - 4
related_prs: []
---

<!-- Canonical path: _docs/intent/pi-web-idd/idd-902/decision.md -->

# outbox の未達を UI に出す — 設計判断

## Context

配送できなかった envelope は `state/outbox.jsonl` に `delivered_at: null` で残るが、UI のどこからも見えない (実データで IDD-901 の 2 件が滞留中)。`GET /api/idd/deliver` は既に `{pending}` を返すが UI から叩かれていない。表示先の先例は Inbox 見出し行右端の CronStatus (DEC-635: 判断でないものは見出し行の端へ逃がす)。

下調べ中の質問回答: q1 = 両方に出す、q2 = 全件出すが error 有無を見分ける、q3 = おまかせ (planner 判断)、q5 = 件数表示のみ、q6 = CI (docs validator) 優先の配置。

## Decisions

### DEC-664: 未達は Inbox 見出し行に総数、lane detail 見出しに lane 分を出す

- **What**: Inbox の「判断キュー」見出し行 (CronStatus の隣) に全 lane 合計の「未達 n 件」、lane detail の見出しにその lane の件数を出す (質問 q1 の回答: 両方)。
- **Why**: 配送失敗の主因は lane 単位 (`no session for lane` / runner 不在) で、全体の滞留と個別 lane の滞留は別の情報。Inbox だけでは「どの lane が詰まっているか」に辿り着けず、lane detail だけではそもそも滞留があることに気づけない。
- **Change freedom**: 右端の並び順、チップか素文字か等の表現は自由。「判断ではない情報は見出し行の端へ逃がす」(DEC-635) だけは守る。

### DEC-665: 件数は delivered_at null 全件で数え、error 付きは表示上区別する

- **What**: `pendingEnvelopes()` (= `delivered_at: null` の最新レコード) を全件数える。`error` フィールドを持つ分は「配送失敗」として表示上見分けられるようにする (質問 q2 の回答: 全件出すが error 有無を見分ける)。
- **Why**: queued 直後の正常滞留まで隠すと「積まれたがまだ試されていない」詰まりを検知できない。かといって失敗と滞留を同じ見た目にすると、人間が介入すべきもの (失敗) と cron が捌くもの (滞留) の urgency が読めない。
- **Change freedom**: 区別の表現 (内訳数「未達 3 (失敗 2)」、色、アイコン) は自由。全件を母数にすることと、失敗が読み取れることだけが不変。

### DEC-666: 件数は buildState / buildLaneDetail のレスポンスに載せる

- **What**: `/api/idd/state` (`buildState()`) と `/api/idd/lane/[id]` (`buildLaneDetail()`) の JSON に未達件数を含め、UI は新しい fetch を増やさない (質問 q3 は「おまかせ」のため planner 判断)。
- **Why**: Inbox は 15 秒ポーリング、lane detail は mount 時取得という既存経路がある。`GET /api/idd/deliver` を UI から別途叩くと取得タイミングが画面ごとにばらつき、mock/fixture 経路 (DEC-603 / DEC-639) も二重に必要になる。
- **Change freedom**: フィールド名・形状は自由。既存レスポンスに載せ、UI の fetch 本数を増やさないことだけが不変。

### DEC-667: 第一弾は押せない件数表示のみ

- **What**: 「未達 n 件」はクリックを受けない静的な表示とする (質問 q5 の回答: 件数表示のみ)。
- **Why**: 内訳展開 (CronStatus パターン) は envelope 詳細 (type / queued_at / error) の view model と再実行導線を伴い、scope が膨らむ。まず「未達が見える」ことの価値を最小構成で出す。
- **Change freedom**: 後続 lane で展開 UI や手動再配送を足すことは自由。
- **Revisit when**: 運用中に「内訳をその場で見たい」が観測されたとき。

### DEC-668: 成果物の配置は docs validator の canonical path に従う

- **What**: decision.md は `_docs/intent/pi-web-idd/idd-902/`、qa.md は `_docs/qa/pi-web-idd/idd-902/`、reference.md は `_docs/reference/pi-web-idd/idd-902/` に置く (質問 q6 の回答: CI 優先)。
- **Why**: `check-docs.sh` (CI) を赤のままにすると以降の全 lane の文書検証が止まる。`parseIntent` の実解決パス (area フル名 `penne-0505/pi-web-idd` + title-slug) は validator の Area 規約 (1 segment) と両立せず、現状の engine は validator 適合な配置を一切読めない。これは engine 側の問題として分離し、文書配置を engine に引きずられない。
- **Change freedom**: engine 側の解決規約の直し方 (area 正規化、slug 規約) は follow-up lane に委ねる。

## Consequences / Impact

- 表示は読み取り専用の追加であり、`outbox.jsonl` の書き込み経路と `deliverPending()` の配送ロジックには触れない
- lane detail は mount 時 1 回のみの fetch なので、表示中に配送が完了しても件数は次回表示まで更新されない (DEC-666 の帰結。許容する)
- engine (`parseIntent`) がこの配置を読めるようになるまでは、GO 画面の DEC/QA 表示には出ない (DEC-668 の follow-up で解消)

## Quality Implications

- 未達が UI に見えること (QA-1..4)。見えないままだと本 lane の目的を達していない
- queued の正常滞留と配送失敗が区別できること (QA-6)。混同すると cron 正常運用を疑わせる
- `pendingEnvelopes()` の merge 動作 (`envelope_id` 単位の最新化) を壊さないこと (QA-5)。壊れると delivered 済みが未達に復活する
- 確認観点は `_docs/qa/pi-web-idd/idd-902/qa.md` の Checks に対応

## Intent-derived Invariants

- INV-008 (from DEC-666): 未達表示は `outbox.jsonl` と `state/outbox/` を読むだけで、outbox への書き込み (`queueEnvelope` / `patch`) と配送 (`deliverPending`) の振る舞いを変えない
- INV-009 (from DEC-665): 未達件数は `pendingEnvelopes()` の単一実装から導き、UI / route 層で `outbox.jsonl` を再解釈しない

## Rollback / Follow-ups

- 未達の内訳展開 (envelope の type / queued_at / error)、再配送の手動 trigger は別 lane (DEC-667)
- `parseIntent` の解決規約と lane 配置規約の整合 (engine 修正) は別 lane (DEC-668)
- ロールバックは件数フィールドと表示の除去のみ。データ経路の追加は読み取り専用で既存動作に影響しない
