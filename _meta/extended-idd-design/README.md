# 拡張 IDD 設計 handoff

本ディレクトリは 2026-08-25 に完成した「拡張 IDD (intent-driven development) の全体フロー設計」の引き継ぎ資料。次の作業 phase (UI プロトタイピング → 実装) を別 session で始める際の起点として書き残す。

## この設計が目指すもの

「朝起きたら、判断待ちの作業レーンが N 件並んでいる」を実現する、AI 主導の開発 pipeline。人間の役割は判断のみに絞り、実装は agent が並列で回す。

具体的には:

- 朝 5:30 cron で Linear / GitHub から起票を拾い、重複判定して backlog へ
- backlog の各 lane を並列 planner が下調べ (DEC/INV/QA/reference 生成)
- 人間 (ぺんね) が起きて GO / DEFER を判定
- GO 判定を受けた lane を独立 executor が並列実装
- Integration check で並列 lane 同士の衝突を解決 (AI 主導)
- Ship phase で commit rewrite + verify + push + PR 化
- Reviewer 対応も Responder が担い、人間は方針レベルの判断のみ

## 引き継ぎ資料一覧

| ファイル | 内容 |
| --- | --- |
| `README.md` | この文書 |
| `flowchart.md` | FigJam URL + 6 page 構成 |
| `stages.md` | S0-S4 の各段階の要点 |
| `schema.md` | 全 state file (jsonl / json) の schema |
| `agents.md` | 6 種類の agent session の role/model/存在形態 |
| `events.md` | 全 lifecycle event 一覧 (attrs 含む) |
| `area-config.md` | area 別 config schema と例 (Meltly / 個人 repo) |
| `envelope.md` | Web UI ↔ LLM 通信の envelope schema |
| `open-questions.md` | 未確定領域と実装時に決めるべき事項 |
| `ui-findings.md` | UI の確定した表示規約。前半 = wireframe (2026-08-26)、**後半 = 実装で確定したもの (2026-08-27、こちらが優先)** |

## UI プロトタイピング (2026-08-26 完了)

wireframe は Figma の design file に描いた (FigJam ではなく `/design/`)。結果と表示規約は `ui-findings.md`、そこで出た設計課題は `open-questions.md` の 13-18 に追記済み。

https://www.figma.com/design/lxOCLCMN9xKzDjBm63Y1qh/pi-idd-web

確定したもの: 既存 shell への統合形態 / 判断 card 5 種 / sidebar の section 構成 / lane detail の構成 / mobile / 状態と縁。

## 実装 phase (2026-08-27 進行中)

pi-web-idd 上で React 実装に着手済み。`ui-findings.md` の後半「実装フェーズで確定したもの」が最新の表示規約で、
wireframe と食い違う場合はそちらが優先。

実装済み:

- Inbox (判断キュー) — 札束形式。card 5 種、めくる操作、記録中 / 成功 / 失敗の状態、motion、hover
- sidebar の lane 一覧 — 群ごとの重み付け、判断待ちの印、取り込み
- lane detail — 契約 / 現物 / 経過 の 3 primitive (中身に穴 3 つ、下記)
- state の読み書き — `GET /api/idd/state`、`GET /api/idd/lane/[id]`、`POST /api/idd/decide`
  (押下 → ledger へ append → envelope XML を outbox へ、まで通っている)

既知の穴:

1. lane detail の `work.files` (git diff --stat 未読) / `agents` (planner-sessions.jsonl 未読) / 経過が生 event 名のまま
2. `open-questions.md` 13-18 が未解決 (16 は実装側で先行して方針を決めた。`ui-findings.md` 参照)
3. undo が無い。判断は押した瞬間に確定する。ledger が append-only なので打ち消し event の設計が要る
4. 実 state の lane が 1 本しかなく、10-20 本規模での破綻は未検証 (それまでは fixture 表示で確認している)

**次 session 開始時の推奨 prompt**:

```
拡張 IDD の実装の続きです。
設計は ~/dev/active/pi-web-idd/_meta/extended-idd-design/ が SSOT。
README.md → ui-findings.md の順で読んで (後半の「実装フェーズで確定したもの」が最新)、
components/idd/ と lib/idd-ui/ の現状を確認してから続けて。
```

## 完了した設計内容

- 5 stage (S0-S4) の全 flow (詳細は各 file 参照)
- 6 種類の agent session の役割分担
- 全 27 lifecycle event の定義
- state file の schema
- area 別 config schema (Meltly / 個人 repo)
- Web UI ↔ LLM 通信 envelope の formal 化
- Meltly 慣習への準拠 (Linear API 経由 branch 名、PR body に全 commit AI 要約)

## 補足: 前 session の作業経過

前 session (2026-08-25) で発生した主な出来事:

- 拡張 IDD の 5 stage を段階的に design (`opening → S0 → S1 → S2 → S3 → S4`)
- 途中で FigJam に 6 diagram を generate (Overview + 5 detail)
- FigJam layout の試行錯誤 (section wrap で connector が壊れる問題)
- 最終的に「detail は 5 個の別 page に配置、Overview は元 page に残す」構成に落ち着く
- Meltly 側からの review コメント (山下さん指摘) を受けて S4 の branch 名 / PR body 生成方針を retrofit
- Verifier agent (Phase A 用) を追加

## ライセンス / 秘匿性

本 handoff は pi-web-idd (private repo) 内の `_meta/` 配下にある。overlay 領域なので upstream に push されない前提。
