# 未確定領域と実装時に決めるべき事項

拡張 IDD の全体 flow 設計は 2026-08-25 に完了したが、実装時に更に詰めるべき点がいくつか残っている。優先度別に整理。

## 高優先 (実装着手前に必要)

### 1. Web UI ↔ LLM 通信の具体的な protocol 実装 (2026-08-27 解決)

- envelope schema は決定済み (envelope.md 参照)
- 「user prompt 前挿入」は **pi の SDK にそのまま存在した**:
  `AgentSession.prompt(text, { streamingBehavior: "followUp" })` が「現在の turn の完了を待って次の turn の user 位置に入る」。
  session が待機中なら通常の `prompt()` がそのまま新しい turn になる。外側のラッパーは不要。
  (`@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` の `PromptOptions`)
- **`expandPromptTemplates: false` を必ず付ける。** 既定は true で、envelope には agent 生成の文字列が載るため、
  skill command / prompt template として解釈される余地を残せない (IddCore DEC-662)
- 逆方向 (LLM → Web UI) は envelope.md の通り tool call = HTTP。口は 4 つに限り、token で閉じる
  (IddCore DEC-660 / DEC-661)。envelope に `<callback>` として base-url / token / endpoint を同梱する
- pi session の所有者は runtime を持つ 1 プロセスに限る (IddCore DEC-659)。engine は port だけを持つ

### 2. `linear-axi` MCP の branch 名取得機能

- Meltly area で「Copy git branch name」相当を API で取得する必要 (area-config.md 参照)
- `linear-axi` MCP に該当機能があるか要確認
- 無ければ:
  - Linear REST API 直叩きで実装 (Linear の access token 管理が必要)
  - or `linear-axi` に PR を投げて機能追加

### 3. commit rewrite の実装

- schema は area-config.md に定義済み
- 実装:
  - Node.js で git log を読み、各 commit を rewrite
  - rewrite された commit で新しい branch を作り直す (git rebase or filter-branch)
  - 実装複雑度が高いので、既存の git rewrite ライブラリ (git-filter-repo 等) を活用検討

## 中優先 (実装しながら決める)

### 4. 3-verdict framework の抽象化

- Integrator / Verifier / Responder が共通の 3 態度 pattern を持つ (mechanical fix / sub todo spawn / user 判断)
- pi-web-idd 内で共通の抽象化 (base class or utility) を作るべきか、それとも agent 別に実装するか
- 私の推奨: 最初は agent 別に実装、動作確認後に共通化を検討 (premature abstraction 回避)

### 5. sub_todo spawn の implementation detail

- Integrator 態度 2 と Responder 態度 2 で使う
- 新 lane 起票時:
  - backlog record に parent_id 付きで追加
  - **DEC/INV/QA/reference を自動生成** (誰が? Integrator/Responder 自身? それとも新 planner を起動して生成?)
  - executor session を spawn
- 私の推奨: sub_todo の intent 生成は spawn 元の Integrator/Responder が担当 (context が既にあるので、新 planner 起動より効率的)

### 6. 依存関係 (`depends_on`) の管理粒度

- 手動設定 (人間が Web UI で明示的に指定) + 自動設定 (planner が S1 で判断) を両対応する予定
- 自動設定の判定基準を明確化する必要
- 循環依存の検出 (`depends_on` が chain で循環しないか)

### 7. cascading check の invalidation timing

- S3 で「前 lane の状態変化」を trigger に後続 lane を再 check する
- 具体的な detection 方法:
  - poll ベース (定期的に lifecycle event を read して差分検出)
  - event ベース (event 発火を watch)
- 私の推奨: event ベース (実時間性が高い)

### 8. Verifier の「semantic completeness」判定基準

- 「rewrite で重要な情報が失われたか」の判定は主観的
- Verifier に判定基準を prompt で明示する必要
- 私の想定基準例:
  - 数値 (「3 秒以内」「WCAG AA」等) の削除は semantic loss
  - 条件文 (「〜の場合」「〜を除いて」等) の削除は semantic loss
  - 単なる形容詞 / 副詞の削除は許容

## 低優先 (運用しながら調整)

### 9. Polling interval の tuning

- Phase B の event 検出 polling interval (active 1 分 / idle 10 分 が初期値)
- 実運用で latency と rate limit のバランスを見て調整
- 判定に何かしらの metrics (latency 分布、API 消費率) を残しておくと良い

### 10. Verifier の 3 回連続失敗検出

- 同じ failure_type が 3 回連続で発生した場合、態度 3 にエスカレート (S2 の s2_recovery_attempt と同じ思想)
- Verifier についても同様のフィルタが必要か検討
- 実装コスト vs 誤爆リスク の trade-off

### 11. security_scan_failed の default 対応

- CI 失敗 種類の中で security_scan_failed だけは default で態度 3 に振る予定
- 具体的にどの security scanner (Snyk, GitHub CodeQL, etc.) の何を trigger にするかは実運用で決定
- False positive 率が高い scanner だと user 判断負荷が上がるため要調整

### 12. archive されたな intent の活用

- lane_close 時に `_docs/intent-archive/<Area>/<slug>/<merged-date>/` に move
- 将来 planner がこの archive を reference として活用する仕組み
- (例: 過去に類似 lane があった場合、その DEC を planner の初期 context に含める)
- MVP スコープ外だが、実装時に retrieval 用の index 化を検討する余地

## 未検討事項 (発見時追記)

### 13. Verifier 態度 3 の「回答」を記録する event が無い (2026-08-26 / UI プロトタイピング)

S4 Phase A には `s4_verify_user_judgment_requested` (問うた記録) はあるが、**人間が何と答えたか**の記録が無い。S3 には `s3_ok` / `s3_reject` / `s3_defer` があるのと非対称。

UI 側では「このまま出す / 直させる / 切り出す」の 3 択に落ちているので、少なくとも以下が必要:

- このまま出す → `s4_verify_clean` で代用できる (既存)
- 直させる → 該当 event 無し
- 切り出す → `s3_sub_todo_spawned` 相当の S4 版が無し

### 14. executor の turn 途中での停止・介入を許すか (2026-08-26 / UI プロトタイピング)

lane detail に executor の stream を出すと、当然「今すぐ止めたい」が出てくる。envelope は次 turn の user prompt 前挿入なので turn 境界での介入しか設計されていない。

- turn 途中の中断を許すか。許す場合、`s2_result` を出せないまま終わる lane の stage をどう扱うか (`s2_aborted` 等が要る)
- pi 側に abort に相当する API があるか未確認

### 15. agent に伝えた内容を ledger に残すか (2026-08-26 / UI プロトタイピング)

lane detail から executor に直接話しかける導線を置いた (turn 境界で届く)。「QA-4 が壊れるから先に既存 flow の test を通して」のような発言は実質 DEC の補足であり、残さないと後から辿れない。

- `s2_interjection { message }` のような event を足すか
- 既存の質問機構 (`pending-questions` / `pending-answers`) を逆向きに使うか

### 16. DEC / QA の見出しを UI が parse する前提 (2026-08-26 / UI プロトタイピング)

GO 待ちの UI は `dec_count` / `qa_count` のような数ではなく **DEC と QA の見出しそのもの**を出す。実装方針は「event には数だけ残し、`_docs/intent/**` を server 側で parse して返す」に決めた (`executor-progress-*.json` を file で持つ判断と同じ思想)。

そのため planner の出力に書式の制約が要る:

- `decision.md` / `qa.md` の見出しが機械的に拾える形であること (`## DEC-1 <一文>` 等)
- 書式が崩れたときの UI の fallback (数だけ出す?)

### 17. planner が生成する文字列の長さ・数の制約 (2026-08-26 / UI プロトタイピング)

UI は agent 出力の長さを制御できないが、破綻しない上限は存在する。実測:

- 質問の選択肢 label: **40 文字を超えると 2 行に折り返す** (desktop 1112px card 幅)
- 選択肢の説明文は UI に出さない (schema には残し、envelope の echo と agent の判断材料としてのみ使う)。したがって **label 単体で選べる粒度**であることが必須
- 現状 (context) の事実は 4 件を超えたら畳む前提。planner 側の目安も必要

### 18. 質問の `context` を自由文のままにするか、事実の列にするか (2026-08-26 / UI プロトタイピング)

現 schema は `context: string` (自由文)。UI 検討では「事実の列 (`{label, value, ref?}`) に分解して出す」ほうが判断が速いという結論になったが、採否は保留。

- 分解する場合: `pending-questions.jsonl` の schema 変更 + envelope の echo もその形に
- 自由文のまま出す場合: UI 側は畳んで `▸ 現状 n` とし、開いたときだけ全文を出す

現在の wireframe は**畳む形**を採用済み (`02` の質問 card)。分解案は保留のまま。

## 意図的に scope 外にしたもの

以下は「今回の設計で意図的に扱わなかった」領域。将来必要になれば再検討:

- **Web UI の詳細 layout**: UI プロトタイピング phase (次 session) で決める
- **通知の外部送信** (Slack / Discord への lane_ready 通知等): pi-web-idd 内 UI で完結する前提、外部通知は不要
- **team collaboration** (複数人での同 lane 編集): pi-web-idd はぺんね個人用 orchestrator、multi-user は不要
- **Metrics / analytics dashboard**: lane_close event の attrs (duration 等) を持たせているので後で作れるが、MVP スコープ外
- **backup 戦略**: `~/dev/00_meltly/work/` の backup は別 task として spawn 済み (`chat/*/` に相当する内容)
