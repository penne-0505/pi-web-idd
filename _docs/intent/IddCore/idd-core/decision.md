---
title: 拡張 IDD engine (@idd/core) の境界と構成
status: active
intent_schema: 3
created_at: 2026-08-27
updated_at: 2026-08-27
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/IddCore/idd-core/decision.md -->

# 拡張 IDD engine (@idd/core) の境界と構成

## Context

本 repo は pi-web v0.8.9 の固定派生（Workspace DEC-001）として始まり、当初は「拡張 IDD の web UI」だけを持っていた。実際に pipeline を回すには取り込み（S0）・下調べ（S1）・実装（S2）・衝突確認（S3）・提出（S4）の実体が要るが、それらは Meltly 側（`~/dev/00_meltly/sync-tools/`）の Python 実装と、その置き場所に依存した構造として存在している。

本 repo をその依存から切り離し、拡張 IDD 本体として成立させる。設計の正本は `_meta/extended-idd-design/`（handoff）で変わらない。

UI 側の判断は `_docs/intent/IddUi/`。

## Decisions

### DEC-650: engine を UI から独立した層として `packages/idd-core` に置く

- **What**: ledger の読み書き・stage 判定・intent の parse・worktree の観測・envelope の生成を `packages/idd-core`（`@idd/core`）に置く。engine は Next.js も React も知らず、外界として知ってよいのは state dir と intent root（`IDD_STATE_DIR` / `IDD_INTENT_DIR`）だけ。import の向きは常に UI → engine の一方向で、engine から UI 側の module を参照しない。
- **Why**: pipeline の実体は UI の付属物ではなく、cron / CLI / 別の front からも使われる。pi-web fork のコードに混ぜると、engine の再利用が fork ごと引きずる形になる。view model（`LaneRow` / `InboxItem` など）は表示の都合で毎日変わるのに対し、ledger の schema は handoff に紐づく。変化の速度が違うものを同じ層に置かない。
- **Change freedom**: package 内の module 分割、公開する関数、package 名は自由。「engine が UI を参照しない」「外界が state dir と intent root に閉じている」の 2 点だけが不変。
- **Why not**（最初から別 repo に切る）: 契約（event の attrs、view に必要な field）がまだ日単位で動いており、この段階で repo を割ると engine と UI の往復が毎回 2 repo・2 PR になる。境界さえ守っていれば `git subtree split -P packages/idd-core` で後から切り出せる。
- **Revisit when**: pi-web fork 以外から engine を使う必要が出た時点、または contract が安定して往復が減った時点で独立 repo へ切り出す。
- **Anchors**: `packages/idd-core/src/index.ts`（公開面）、`lib/idd-ui/server/state.ts`（UI 側の消費点）、`tsconfig.json`（`@idd/core` の path）

### DEC-651: view model への畳み込みは UI 側に残す

- **What**: `buildState` / `buildLaneDetail`（ledger → `LaneRow` / `InboxItem` / `LaneDetailView`）と event の表示名対応表は `lib/idd-ui/server/` に残し、engine には移さない。
- **Why**: これらは「どう見せるか」の判断そのもの（IddUi DEC-608 / DEC-631 など）であって、pipeline の実体ではない。engine に置くと、表示都合の変更が engine の API を揺らす。
- **Change freedom**: 畳み込みの実装と置き場所（UI 内での module 分割）は自由。「表示都合の型が engine の公開面に現れない」だけが不変。
- **Anchors**: `lib/idd-ui/server/state.ts`、`lib/idd-ui/server/events-display.ts`

### DEC-652: 旧 13-event 実装と msync への shell out を削除し、handoff schema に一本化する

- **What**: `lib/idd/`（`ledger-io.ts` / `lifecycle-schema.ts` / `worker-pool.ts` とその test）と `/api/idd/{lanes,lifecycle,workers}` を削除する。lane の状態・event の書き込みは `@idd/core`（handoff の 41 event / `lifecycle-<repo>.jsonl`）だけが持つ。
- **Why**: 旧実装は Meltly 側 Python の部分移植で、13 event / `ledger-<repo>.jsonl` という**非互換の schema** を持っていた。同じ「lane の状態」に正本が 2 つあると、どちらを信じるかが実装ごとに分かれる。設計の SSOT は handoff（`_meta/extended-idd-design/`）と決めており、食い違う実装は統合ではなく破棄する。`/api/idd/lifecycle` の msync CLI shell out も、`POST /api/idd/decide` が同じ役割を handoff schema で果たすため二重になっていた。これを消すことで Meltly のツールチェーンへの最後の直接依存が切れる。
- **Change freedom**: 削除後の再実装の形は自由。「lane の状態の正本を 2 つ持たない」「外部 CLI に状態変更を委譲しない」だけが不変。
- **Why not**（両者を変換層で繋ぐ）: 13 event と 41 event は粒度が違い、変換は情報を捏造するか捨てるかのどちらかになる。どちらも履歴の信頼性を壊す。
- **Anchors**: `packages/idd-core/src/ledger/`（一本化後の正本）、`app/api/idd/decide/route.ts`

### DEC-653: area 別の慣習は config で吸収し、engine に repo 名を焼き付けない

- **What**: `config/areas.json`（`IDD_AREAS_FILE` で差し替え可）に area ごとの source 種別・linked_repo・intake filter・branch 名の型を持たせ、engine はそこから読む。
- **Why**: handoff の `area-config.md` の履行。Meltly と個人 repo で慣習が違い、これを条件分岐でコードに持つと area が増えるたびに engine を触ることになる。
- **Change freedom**: field の追加、置き場所は自由。「area 固有の値が engine のコードに現れない」だけが不変。
- **Anchors**: `config/areas.json`、`packages/idd-core/src/config/areas.ts`

### DEC-654: GitHub の起票は gh CLI 経由で読む

- **What**: issue の取得は `gh issue list --json` を実行して行い、engine 自身は token を持たない。
- **Why**: `gh` は既に認証済みで、credential の保管と更新をそちらに委ねられる。engine に token を持たせると、保管場所・rotation・漏洩範囲を自前で背負う。
- **Change freedom**: 取得の実装は自由。「engine が credential を保持しない」だけが不変。
- **Why not**（GitHub API を直接叩く）: token の管理責務が増えるわりに、得られるのは実行速度だけ。
- **Revisit when**: Linear を足すとき。Linear には gh 相当が無いため、credential の受け渡し方を別途決める必要がある。
- **Anchors**: `packages/idd-core/src/intake/github.ts`

### DEC-655: S0 は「拾って backlog に入れる」までで、判断はしない

- **What**: 取り込みは issue を backlog record にし `lane_open` を append するところまで。GO / 中止 などの判断は一切行わない。取り込み自体は判断ではないので INV-003（1 押下 = 1 append）の対象外で、1 回の実行で複数 event を書く。
- **Why**: 判断は人間の役割（handoff の前提）。取り込みが判断まで踏み込むと、朝起きたときには既に決まっている lane が生まれる。
- **Change freedom**: 実行契機、取り込み単位は自由。「取り込みが判断を発生させない」だけが不変。
- **Anchors**: `packages/idd-core/src/intake/run.ts`、`app/api/idd/intake/route.ts`

### DEC-656: 重複判定は URL 一致だけを engine に持ち、意味判定は差し替え可能な口にする

- **What**: 第 1 段階（URL 完全一致）は engine 内で機械的に行い、第 2 段階（意味類似）は `DuplicateDetector` という差し替え可能な関数として口だけ開ける。detector が無い間は URL 一致だけが働く。
- **Why**: 意味判定には LLM が要り、どの model をどう呼ぶかは未決（handoff は「cron session 内 LLM」とだけ書いている）。判定の質が決まらないまま自前の語彙一致で代用すると、`detection_method: "semantic"` に嘘の値が入る。口だけ開けておけば、決まった時点で engine を触らずに差せる。
- **Change freedom**: detector の実装と呼び出し位置は自由。「判定方法が `detection_method` に正しく現れる」だけが不変。
- **Revisit when**: 意味判定の model が決まった時点で detector を実装する。
- **Anchors**: `packages/idd-core/src/intake/run.ts`

### DEC-657: cron と UI は同じ engine の入口を叩く

- **What**: 取り込みの入口は `runIntake()` 1 つで、cron は `packages/idd-cli`（`idd intake`）から、UI は `POST /api/idd/intake` から呼ぶ。CLI は web app の起動を必要としない。
- **Why**: 「朝の cron」と「今すぐ取り込む」で処理が分岐すると、片方だけ直る事故が起きる。engine が UI から独立している（DEC-650）ことの実際の効用がここに出る。
- **Change freedom**: CLI の command 体系は自由。「入口が 1 つ」だけが不変。
- **Anchors**: `packages/idd-cli/bin/idd.ts`、`app/api/idd/intake/route.ts`

### DEC-658: area は file 名に写すときだけ平坦化する

- **What**: area は `penne-0505/medo` のように `/` を含みうる。`lifecycle-<area>.jsonl` の file 名にするときだけ `[^A-Za-z0-9_.-]` を `-` に潰す。backlog の `area` field は元の値のまま。
- **Why**: 平坦化した値を正本にすると、area と repo の対応が復元できなくなる。file 名の制約は書き出し側の都合でしかない。
- **Change freedom**: 平坦化の規則は自由。「正本の area を書き換えない」だけが不変。
- **Anchors**: `packages/idd-core/src/ledger/write.ts`

### DEC-659: pi session の所有者は runtime を持つ 1 プロセスに限る

- **What**: envelope の配信（`prompt` の実行）は pi runtime を所有するプロセス（Next server）だけが行う。engine は `AgentRunner`（`deliver` / `spawn`）という port しか持たず、実装は `lib/idd-ui/server/agent-runner.ts` に 1 つだけ置く。CLI / cron からの配信は `POST /api/idd/deliver` を叩く。
- **Why**: pi の session は jsonl file に永続化される。CLI が別プロセスで同じ session を開くと、同一 file を 2 プロセスが書いて壊れる。所有者を 1 つに決めれば、配信の順序も idle 判定も 1 箇所で決まる。
- **Change freedom**: port の signature、runner の置き場所は自由。「同じ pi session を 2 プロセスが持たない」だけが不変。
- **Why not**（engine が自分で AgentSession を起こす）: UI と CLI が同時に動く構成で session file が壊れる。壊れ方が静かなので発見も遅れる。
- **Consequence**: S1 以降の cron は「server が起きている前提」になる。localhost の常駐 app なので実害は無い。intake は外部依存が無いので CLI 単独で動く（DEC-657）。
- **Anchors**: `packages/idd-core/src/agent/port.ts`、`packages/idd-core/src/agent/outbox.ts`、`lib/idd-ui/server/agent-runner.ts`、`app/api/idd/deliver/route.ts`

### DEC-660: agent 用の書き込み口は token でだけ開く

- **What**: `/api/idd/agent/*` は `Authorization: Bearer <token>` を要求する。token は `IDD_AGENT_TOKEN`、無ければ `state/agent-token`（0600）に生成して保存する。比較は長さと定数時間で行う。
- **Why**: dev server を `-H 0.0.0.0` で出しているため、無認証の書き込み口は LAN の誰にでも ledger を書かせることになる。ledger は判断の唯一の履歴なので、汚染は復元できない。
- **Change freedom**: token の生成・保管・header 名は自由。「agent の書き込み口が無認証で開かない」だけが不変。
- **Revisit when**: server を localhost 専用に閉じるなら方式を見直してよい。
- **Anchors**: `packages/idd-core/src/agent/token.ts`、`lib/idd-ui/server/agent-auth.ts`

### DEC-661: agent → engine は 4 つの口だけ。envelope は書き戻し先を同梱する

- **What**: agent が engine に書ける経路は `questions` / `ready` / `progress` / `result` の 4 つに限る。いずれも lane の実在を確認し、自分の lane の state しか書けない。envelope には `<callback>`（base-url / token / endpoint 一覧）を同梱する。
- **Why**: 口が増えるほど「agent が勝手に進める」余地が増える。判断（GO / 承認 / 中止）は人間の側にあり、agent 用の口には存在しない。envelope に書き戻し先を同梱するのは handoff の self-containment 原則の履行で、agent 側の設定に依存させないため。
- **Change freedom**: 口の実装、payload の形は自由。「判断を発生させる口を agent に与えない」だけが不変。
- **Anchors**: `packages/idd-core/src/agent/inbound.ts`、`app/api/idd/agent/*/route.ts`、`packages/idd-core/src/ledger/write.ts`（buildEnvelope）

### DEC-662: envelope は followUp で入れ、prompt template の展開を切る

- **What**: 配信は `prompt(xml, { streamingBehavior: "followUp", expandPromptTemplates: false })`。稼働中なら現在の turn の完了後、待機中ならその場で新しい turn になる。
- **Why**: handoff の「user prompt 前挿入方式」は pi の SDK にそのまま存在した（open-questions #1 の答え）。`steer` は実行中の turn を割り込むので、判断の通知には強すぎる。`expandPromptTemplates` の既定は true で、envelope には agent 生成の文字列が載るため、skill command や template として解釈される余地を残せない。
- **Change freedom**: streaming 中の扱いは自由。「割り込まない」「envelope の中身をコマンドとして解釈させない」の 2 点が不変。
- **Anchors**: `lib/idd-ui/server/agent-runner.ts`、`lib/rpc-manager.ts`（expandPromptTemplates の受け渡し）

### DEC-663: envelope に載る問いと選択肢は pending-questions を正本にする

- **What**: 回答時の envelope は UI の payload ではなく `pending-questions.jsonl` の batch から問い・context・選択肢を引く。回答済みの batch も引けるようにする。
- **Why**: UI は選択肢の index しか送らない（送る必要が無い）。payload を正本にすると、envelope の問いが空になるか、UI 側の表示文字列が正本になってしまう。agent に届く envelope は agent 自身が発した問いと一致していなければならない。
- **Change freedom**: 引き方は自由。「envelope の問いが agent の発した問いと一致する」だけが不変。
- **Anchors**: `packages/idd-core/src/ledger/read.ts`（readQuestionBatch）、`packages/idd-core/src/ledger/write.ts`

### DEC-670: lane ごとに git worktree を切る

- **What**: 下調べ / 実装は `<local_path>-lanes/<IDD-ID>` の worktree で行い、branch は area の `branch_name_pattern`（既定 `idd/{idd_id}`）で作る。area に `local_path` が無い場合は prep を skip する。
- **Why**: 並列 lane が同じ working tree を踏むと、片方の編集がもう片方の観測を壊す。worktree なら分離が物理で担保され、S3 の衝突確認も「別 branch 同士の merge」として素直に書ける。
- **Change freedom**: 置き場所、branch 名、既存 branch の扱いは自由。「lane 同士が同じ working tree を共有しない」だけが不変。
- **Anchors**: `packages/idd-core/src/worktree/ensure.ts`、`config/areas.json`

### DEC-671: 下調べに載せる lane の選定は engine、session を起こすのは runtime

- **What**: どの lane を下調べに載せるか（待ち行列・並列上限 `IDD_PLANNER_CONCURRENCY`）は engine が決め、pi session を起こすのは runtime 側の `AgentRunner.spawn` だけ。起動した session は `planner-sessions.jsonl` に記録する。
- **Why**: 並列上限は pipeline の規律（handoff の S1）であって runtime の都合ではない。逆に session の起こし方は runtime の都合であって pipeline の規律ではない。DEC-659（session の所有者は 1 プロセス）と同じ境界をここでも引く。
- **Change freedom**: 選定の順序付け、上限の既定値は自由。「engine が session を直接起こさない」「上限を runtime 側で解釈しない」の 2 点が不変。
- **Revisit when**: handoff の優先度 ranking（11 段階）が確定したら、現在の起票順 FIFO を置き換える。
- **Anchors**: `packages/idd-core/src/plan/prep.ts`、`lib/idd-ui/server/agent-runner.ts`、`app/api/idd/prep/route.ts`

### DEC-672: planner への最初の指示も envelope にする

- **What**: 下調べの開始指示は `<idd-system-message type="s1_prep_start">` として組み立て、lane の題名・source URL・context・成果物の置き場所・書式の制約・質問の作法・callback を 1 通に含める。
- **Why**: agent 側に前提知識を置かないという envelope の self-containment 原則を、最初の 1 通にも適用する。書式の制約（`## DEC-1 — <一文>`、選択肢 label 40 文字以内）は UI がその形で読む以上、指示に含まれていないと守られない。
- **Change freedom**: 文面と含める項目は自由。「agent 側の設定に依存しない」「UI が要求する書式が指示に含まれる」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/prep.ts`（plannerBrief）

### DEC-673: intent の置き場所は題名ではなく lane id から作る

- **What**: `_docs/intent/<Area>/<slug>/` の slug は lane id（`idd-902`）から作る。
- **Why**: 題名は日本語を含むが、docs 規約の canonical path は `[a-z0-9]+(-[a-z0-9]+)*` を要求する。題名由来の slug では planner が作る intent が validator を通らない。lane id なら ASCII で一意、かつ lane と 1:1 に対応する。
- **Change freedom**: slug の形は自由。「ASCII で、lane と 1:1 で、題名の変更で動かない」だけが不変。
- **Anchors**: `packages/idd-core/src/intent/parse.ts`（slugOf）

### DEC-676: 判断を記録したら、その場で配信を試みる

- **What**: `POST /api/idd/decide` は記録に成功したら続けて `deliverPending()` を呼ぶ。配信の失敗は記録の成功を取り消さず、未達は outbox に残る。
- **Why**: 記録と送信を分ける（DEC-606）のは「送れなくても記録は残す」ためであって、「送るのを後回しにする」ためではない。人間が回答したのに planner が動き出さない時間は、そのまま lane の停滞になる。押した時点で試すのが最も短い。
- **Change freedom**: 呼ぶ場所、再送の戦略は自由。「配信の失敗が記録の成功を巻き戻さない」だけが不変。
- **Anchors**: `app/api/idd/decide/route.ts`

### DEC-677: 質問は 1 問ずつ判断し、planner を起こすのは batch が揃ってから

- **What**: batch は **1 枚の card** として出し、その中で未回答の問いを 1 問ずつ順に見せる。主ボタンは残りがある間は「次の質問へ」、最後の 1 問で「回答して再開させる」。回答は 1 問ごとに `pending-answers.jsonl` へ記録し、全問が揃ったときにだけ `question_batch_answered` event と envelope を 1 通生成する。
- **Why**: handoff の S1 は「batch 内最大 5 問」「planner の resume 条件は全問が揃ったとき」。判断の単位（1 問）と再開の単位（1 batch）は別物だが、**1 問 = 1 card にすると同じ lane の札が 5 枚並び**、1 画面 1 判断の趣旨（IddUi DEC-620）に反する上、「4 枚答えたが何も進んでいない」状態がキューに散らばる。card 間に依存関係を持たせる案は、めくる操作の意味まで変えるので採らない。batch という単位が既にあるのだから、その中で完結させる。
- **Change freedom**: card 内の進み方、進捗の見せ方は自由。「1 問ずつ判断できる」「全問揃うまで agent を起こさない」「同じ batch が複数の札に割れない」の 3 点が不変。
- **Anchors**: `lib/idd-ui/server/state.ts`、`packages/idd-core/src/ledger/write.ts`（applyDecision の answer）

### DEC-678: 眠った session は file から起こす。起こし直しで id が変わったら配信しない

- **What**: 配信先の session が registry に生きていない場合、session id から session file を解決して起こす。file が見つからない、または起こした結果 id が変わった場合は配信せず、未達として残す。
- **Why**: `startRpcSession(id, "", cwd)` は file を指定しないと**新しい session を作る**。pi の session は 10 分で idle 破棄されるため、回答が届く頃には眠っているのが普通で、この経路を踏むと「届いた」と記録されたまま、質問を知らない別の session に投げ込まれる。届かなかったことが観測できない配信は、未達より悪い。
- **Change freedom**: 解決の方法は自由。「届け先が意図した session であることを確認してから配信する」だけが不変。
- **Anchors**: `lib/idd-ui/server/agent-runner.ts`

### DEC-679: lane は「消す」のではなく lane_close で終端へ送る

- **What**: UI から lane を畳む操作（中止 / 取り消し）は `lane_close` を append し、attrs に `outcome: "aborted" | "dropped"` と理由を残す。backlog record も event も削除しない。`deriveStage` は `lane_close` を終端として扱うので、lane は sidebar の「終端 (直近)」へ移り、判断キューからは消える。
- **Why**: ledger は append-only で、判断の唯一の履歴（INV-003）。record を消すと「その lane が存在した」ことごと消え、なぜ消したかも残らない。UI に必要なのは視界から外すことであって、履歴から消すことではない。誤って取り込んだ lane（`dropped`）と、やると決めた上で止めた lane（`aborted`）は後で区別できる必要があるので、同じ event の attrs で分ける。
- **Change freedom**: 呼び名、attrs、どこから押せるかは自由。「record を削除しない」「畳んだ理由が残る」の 2 点が不変。
- **Anchors**: `packages/idd-core/src/ledger/write.ts`（lane_abort / lane_drop）、`packages/idd-core/src/ledger/derive.ts`

### DEC-681: 下調べの成果物は lane の worktree にある。読む側もそこを先に見る

- **What**: `parseIntent` は lane の worktree（`planner/executor-sessions.jsonl` の `worktree_path`）配下の `_docs/intent/<Area>/<slug>/` を先に探し、無ければ server の intent root を見る。`<Area>` の path 要素は `areaSegment()`（area の最後の 1 語）で統一し、書く側（planner への指示）・読む側・「成果物が無い」表示の 3 箇所で同じ関数を使う。
- **Why**: planner は lane の worktree で作業するので、成果物は commit されるまでそこにしかない。server の cwd だけを見ていると、`s1_ready` が来ているのに GO card が空になる。area は `penne-0505/pi-web-idd` のように repo 名を含みうるため、書き込み先と読み取り先が食い違っていた（実際に食い違って空表示になった）。同じ規則を 3 箇所で別々に書いたことが原因なので、関数に寄せる。
- **Change freedom**: 探索順、helper の置き場所は自由。「書く側と読む側が同じ規則を共有する」だけが不変。
- **Anchors**: `packages/idd-core/src/intent/parse.ts`（areaSegment / parseIntent）、`lib/idd-ui/server/state.ts`

### DEC-682: 成果物の置き場所と書式は repo の docs 規約に従う

- **What**: planner の成果物は `_docs/intent/<Area>/<slug>/decision.md`（full schema、`### DEC-nnn:` + What/Why/Change freedom、INV は Intent-derived Invariants 節）、`_docs/qa/<Area>/<slug>/qa.md`（`- AC-001:` 形式）、`_docs/reference/<Area>/<slug>/reference.md` に置く。brief はこの形だけを指示し、完了条件を `./scripts/check-docs.sh` が通ることとする。読む側（`parseIntent`）は旧い簡易形式も受け付ける。
- **Why**: handoff は「4 ファイルを intent 配下に置く」と書いているが、この repo の docs validator は intent 配下に `decision.md` 以外を許さず、その decision.md にも full schema を要求する。実際に planner が下調べ中にこの衝突を検出して質問を上げ、CI 優先と決まった（IDD-902 の q6）。書式を守れない指示は、agent が毎回同じ壁にぶつかる。読む側だけ寛容にするのは、移行中の lane を表示できなくしないため。
- **Change freedom**: 書式の詳細、寛容に受ける範囲は自由。「指示された形が CI を通る」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/prep.ts`（plannerBrief）、`packages/idd-core/src/intent/parse.ts`

### DEC-683: 「進んでいるはず」と「実際に動いている」を分けて出す

- **What**: 下調べ中 / 実装中の lane について、対応する session が runtime に生きているかを見て `live` / `stalled`（session はあるが動いていない）/ `unstarted`（session が無い）を返す。sidebar では stage bar を破線にし、「停止」「未起動」を添える。
- **Why**: GO を押した lane は「実装中」になるが、executor が起動していなければ誰も何もしない。動いていないものが動いているものと同じ顔で並ぶと、止まっていることに気づけない。生きている session の集合は runtime しか知らないので、engine には集合として渡す（DEC-659 と同じ境界）。
- **Change freedom**: 判定の粒度、見せ方は自由。「止まっている lane が進行中と同じ見た目にならない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/prep.ts`（laneActivity）、`lib/idd-ui/server/state.ts`、`components/idd/LaneList.tsx`

### DEC-685: S2 は契約を渡して実装させ、結果を ledger に戻す

- **What**: GO の付いた lane に executor session を起こす。lane の worktree（S1 で作ったものを再利用）で動かし、brief には契約（DEC / AC / INV の本文）と完了条件（`check-docs.sh` と `tsc --noEmit` が通る、変更を commit する）と callback（progress / result / questions）を載せる。起動時に `s2_start` を、起点 commit 付きで append する。**契約が空の lane には executor を起こさない。**
- **Why**: executor に渡すべきものは issue ではなく契約。契約が空のまま起こすと、agent は自分で目的を決めることになり、GO が意味を失う（UI 側で GO を止めているのと同じ理由 / IddUi DEC-674）。起点 commit を残すのは、差分の基準がないと「この lane が何を書いたか」を後から復元できないため。
- **Change freedom**: brief の文面、並列上限、model は自由。「契約を渡す」「契約が無ければ起こさない」「起点 commit を残す」の 3 点が不変。
- **Anchors**: `packages/idd-core/src/plan/exec.ts`、`app/api/idd/exec/route.ts`、`packages/idd-core/src/worktree/ensure.ts`（headCommit）

### DEC-686: 中断した agent は session file から起こして続きを頼む

- **What**: `POST /api/idd/resume` で、lane の session を file から起こし、「作業は worktree に残っている。`git status` / `git diff` で自分の進み具合を確認してから続けろ」という envelope を届ける。executor の場合は `s2_recovery_attempt` を append する。
- **Why**: runtime が落ちれば session は全て死ぬが、agent が書いたものは worktree に残る。作業を捨てて最初からやり直させるのは、時間だけでなく判断（既に人間が答えた質問の反映など）も捨てることになる。handoff の agents.md が「server 再起動時に jsonl から resume」と書いているのは、この経路のこと。
- **Change freedom**: 文面、再開の契機（手動 / 自動検出）は自由。「途中の作業を前提に再開する」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/resume.ts`、`app/api/idd/resume/route.ts`

### DEC-687: agent にホストの共有物を触らせない

- **What**: executor の brief に host-rules を置き、pattern による `pkill` / `killall` を禁じ、検証用 server は未使用 port + PID 指定でのみ止めるよう指示する。IDD の runtime が使う port は名指しで「触るな」と書く。
- **Why**: 実際に executor が後片付けのつもりで `pkill -f "next dev"` を実行し、**自分の session を載せている runtime ごと落とした**。lane の分離は worktree（DEC-670）でファイル系だけを分けており、プロセスは共有のまま。範囲の広い停止操作は自分自身に届く。
- **Change freedom**: 文面は自由。「共有のプロセス空間に対する破壊的操作を禁じる」だけが不変。
- **Why not**（bash を取り上げる）: 実装には build と test が要る。
- **Revisit when**: lane ごとに検証 server を管理する script を用意できたら、指示ではなくその script だけを使わせる形にする（構造で守る）。
- **Anchors**: `packages/idd-core/src/plan/exec.ts`（executorBrief の host-rules）

### DEC-688: S3 の機械部分は「upstream と衝突するか」だけを見る

- **What**: `s2_result` が来た lane に対し `git merge-tree --write-tree` を実行して衝突の有無だけを判定し、`s3_ready` → `s3_check_in_progress` → `s3_check_clean` / `s3_check_conflict` を append する。解消はしない。判定後、lane は差分確認の判断待ちになる。
- **Why**: merge-tree は index も working tree も触らずに答えるので、lane の作業を壊さずに問える。解消（Integrator の 3 態度）はまだ実装が無いが、**人間の承認だけは先に通せる** — 機械的判定と人間の判断は独立に足せる。
- **Change freedom**: 判定方法、cascading の扱いは自由。「判定が lane の作業状態を変えない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/review.ts`、`app/api/idd/check/route.ts`

### DEC-689: 差分確認に出す diff は実物から作り、基準は今の分岐点にする

- **What**: 差分確認 card の diff は lane の worktree で `git diff <merge-base(HEAD, main)>` を実行して作る。要約や再構成はしない。
- **Why**: 判断の材料は実物でなければならない。基準に `s2_start` の起点 commit を固定で使うと、**rebase 後には他人の変更まで差分に混ざる**（実際に 15 ファイルのはずが 39 ファイルになった）。分岐点なら rebase を跨いでも lane の変更だけが残る。
- **Change freedom**: 表示する行数、ファイルの選び方は自由。「基準が分岐点」「実物から作る」の 2 点が不変。
- **Anchors**: `packages/idd-core/src/plan/review.ts`（laneBase / laneDiff）、`lib/idd-ui/server/state.ts`

### DEC-690: 提出物は lane の実物から機械的に組み立てる

- **What**: PR の title は先頭 commit の subject、body は「起票の URL + 契約の DEC の一文」、commit 一覧は `git log <merge-base>..HEAD`。AI に要約させない。IDD の語彙（`DEC-` / `AC-` / `IDD-` 等）が残っている行は flag して card 上で見せる。
- **Why**: 提出物は外に出るもので、内部語彙が漏れると読み手に意味が通らない。かといって AI に書き直させると、**実物と提出物がずれる**（何を出したのかが commit と一致しなくなる）。実物から組み立てて、内部語彙が残っている箇所だけを人間に見せるのが、ずれを作らずに読める形にする最短経路。
- **Change freedom**: 本文の組み立て、flag の対象は自由。「提出物が実物と一致する」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/ship.ts`（buildSubmit）

### DEC-691: verifier の検査は実際に走らせられるものだけを並べる

- **What**: 提出前の検査は 5 つ（未 commit の変更が無い / commit がある / 満たすべき条件がすべて確認済み / PR 本文に IDD の語彙が残っていない / commit message が規約に沿う）。すべて実際に判定する。判定できないものは項目に出さない。
- **Why**: 検査項目は「通ったことにできてしまう」もっとも危険な表示。実行できない項目を並べると、緑のチェックが判断の根拠として機能しなくなる。
- **Change freedom**: 項目の増減は自由。「並べた項目はすべて実際に判定される」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/ship.ts`

### DEC-692: push と PR 作成は人間が押したときだけ

- **What**: `git push` と `gh pr create` は `s4_verify_clean`（「このまま出す」）を人間が押したときにのみ実行する。engine 側の自動処理からは呼ばない。
- **Why**: この 2 つがこの pipeline で唯一「外に出る」操作で、取り消せない（IddUi DEC-628 の緩衝材が付いているのもこの押下）。自動化の対象にすると、判断を人間に絞るという前提そのものが崩れる。
- **Change freedom**: 実行の場所、失敗時の扱いは自由。「人間の押下以外で外に出ない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/ship.ts`（runShip）、`app/api/idd/decide/route.ts`

### DEC-693: verifier agent が未実装の間は、提出前の検査を人間が兼ねる

- **What**: `s4_submit_started` の後、`s4_verify_clean` が無い間は提出前確認の判断待ちにする（handoff では verifier agent の態度 3 のときだけ人間に上がる）。承認（`s3_ok`）を押した時点で提出の準備まで進める。
- **Why**: verifier agent は未実装だが、検査項目は機械的に判定できている（DEC-691）。agent を待たずに人間が同じ材料で判断できる。**未実装を「素通し」で埋めない**ための暫定であり、agent が入ったら人間に上がる条件を handoff 通りに戻す。
- **Change freedom**: 暫定の期間、条件は自由。「未実装の段階を素通しにしない」だけが不変。
- **Revisit when**: verifier agent を実装した時点。
- **Anchors**: `packages/idd-core/src/ledger/derive.ts`、`app/api/idd/decide/route.ts`

### DEC-697: merge は観測して記録するだけ

- **What**: `s4_pr_created` のある lane について `gh pr view --json state` で状態を見に行き、MERGED なら `s4_merged` と `lane_close` を append する。merge 操作そのものは行わない。
- **Why**: merge は GitHub 側の権限と設定（review 必須、CI 必須など）が支配する領域で、engine が代行すると、そこに置かれた制約を迂回することになる。pipeline の役目は「起きたことを記録する」ところまで。
- **Change freedom**: 観測の頻度、記録する attrs は自由。「engine が merge しない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/close.ts`

### DEC-698: 閉じた lane の worktree は撤去する。ただし未 commit の変更が残っていれば残す

- **What**: `lane_close` の後に `git worktree remove` する。`git status --porcelain` が空でなければ撤去せず、残したパスを返す。
- **Why**: worktree は lane ごとに増え続けるので、閉じたら片付けたい。ただし未 commit の変更は「まだ拾われていない作業」で、消すと復元できない。閉じたかどうかと、拾い終えたかどうかは別。
- **Change freedom**: 撤去の契機は自由。「未 commit の変更を消さない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/close.ts`（removeLaneWorktree）

### DEC-699: 閉じた lane 宛ての envelope は未達に数えない

- **What**: `pendingEnvelopes()` は `lane_close` / `s1_defer` / `s3_defer` のある lane 宛てを除外する。
- **Why**: 閉じた lane には届け先の session が無く、永久に配信されない。それを「未達」として数え続けると、対処すべきものと対処しようのないものが同じ数字に混ざる。
- **Change freedom**: 除外の判定は自由。「届き得ないものを待ち行列に数えない」だけが不変。
- **Anchors**: `packages/idd-core/src/agent/outbox.ts`

### DEC-700: 段階を繋ぐのは orchestrator の仕事。tick が 1 巡させる

- **What**: `POST /api/idd/tick`（CLI は `idd tick`）が S0 から順に一巡する: 取り込み → merge 観測 → 衝突確認 → 実装起動 → 下調べ起動 → 未達の配信。**判断が要る段階の手前で止まる** — GO / 承認 / 提出は人間の押下でしか進まない。
- **Why**: 各段階を個別の endpoint にしただけでは、取り込んだ lane が下調べに載らない（実際に IDD-903 / 904 が取り込まれたまま止まった）。handoff の Orchestrator は「S0 完了直後に S1 を spawn する」もので、その連結が欠けていた。逆に、判断の段階まで自動で越えさせると、人間の役割が判断だという前提が崩れる。
- **Change freedom**: 順序、tick の契機（cron / 手動）は自由。「判断の手前で止まる」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/tick.ts`、`app/api/idd/tick/route.ts`、`packages/idd-cli/bin/idd.ts`

### DEC-701: 記号の採番は engine が lane ごとに帯で割り当てる

- **What**: prep の時点で lane ごとに DEC の帯（20 個）と INV の開始番号を決め、brief に「この帯を使え。自分で最大値を数えるな」と書く。帯の計算は repo と**切ってある全 lane worktree の両方**を走査した最大値から行い、同じ tick で起こす lane 同士はさらにずらす。
- **Why**: 並列に走った planner がそれぞれ repo の最大値を読むと、**全員が同じ番号から採番する**（実際に IDD-903 と IDD-904 が DEC-701〜705 を二重に取った）。ファイルが別なので git の衝突にはならず、意味の衝突だけが残る — merge 後にコードのポインタ `// intent: DEC-701` がどちらを指すか決められなくなる。未 commit の lane worktree も走査対象に含めないと、同じ穴が残る。
- **Change freedom**: 帯の幅、割り当ての契機は自由。「採番を並列 agent の観測に任せない」だけが不変。
- **Anchors**: `packages/idd-core/src/intent/numbering.ts`、`packages/idd-core/src/plan/prep.ts`

### DEC-702: GO を押したら executor が起きる

- **What**: `s1_go` の記録に続けて `runExec()` を呼ぶ。tick を待たない。
- **Why**: GO は「実装を始めてよい」という判断そのもので、押したのに何も始まらないなら判断が宙に浮く（実際に IDD-903 / 904 が GO 済みのまま停止した）。回答を押した時点で配信する（DEC-676）のと同じ理由。
- **Change freedom**: 起動の場所は自由。「判断と実行の間に手動の一手を挟まない」だけが不変。
- **Anchors**: `app/api/idd/decide/route.ts`

### DEC-704: PR の題名は lane が最初にやったこと

- **What**: `git log --reverse` で古い順に取り、先頭の commit subject を PR の題名にする。
- **Why**: 新しい順のままだと、後から足した修正が題名になる（実際に IDD-903 の PR が「DEC を 741-745 に振り直して…」になった。lane の主題は文章作法の skill 化）。lane が何をした lane かは、最初にやったことが表す。
- **Change freedom**: 題名の作り方は自由。「後付けの修正が主題を隠さない」だけが不変。
- **Anchors**: `packages/idd-core/src/plan/ship.ts`

### DEC-705: lane の worktree は既定ブランチから切る

- **What**: `git worktree add` の起点を明示的に `main`（無ければ `origin/main` / `master`）にする。repo の HEAD には従わない。
- **Why**: HEAD から切ると、そのとき作業中だった branch の未 merge の変更ごと lane に入る（実際に IDD-903 / 904 が私の未 merge commit を抱え、差分確認 card が 29 ファイルを表示した）。lane の差分は lane の変更だけであるべきで、それは切る時点で決まる。
- **Change freedom**: 既定ブランチの決め方は自由。「lane が切った時点の他人の作業を巻き込まない」だけが不変。
- **Anchors**: `packages/idd-core/src/worktree/ensure.ts`

## Consequences / Impact

- `lib/idd-ui/server/` から ledger の読み書きが消え、UI 側は engine の公開面だけを見る。state file の schema 変更は engine に閉じる。
- 下調べは lane ごとに worktree を作る（DEC-670）。`<repo>-lanes/` が増えるので、lane を閉じたときの撤去が要る。
- envelope の配信は server が起きている必要がある（DEC-659）。`POST /api/idd/deliver` が入口で、未達は `outbox.jsonl` の `delivered_at: null` として残る。
- `state/agent-token` が生成される（DEC-660）。state dir を共有する全プロセスが同じ token を見る。
- 取り込みは `gh` CLI に依存する（DEC-654）。CI や別ホストで動かすには `gh` の認証が要る。
- engine の import は `.ts` 拡張子付きにした。`node --experimental-strip-types` で CLI を build 無しに実行するため（tsconfig の `allowImportingTsExtensions`）。
- `packages/*` を npm workspace として追加した。`@idd/core` は TypeScript のまま解決される（build 段階を持たない）ため、Next の bundler がそのまま取り込む。
- engine 側にも本 repo の docs 規約（コメントは DEC ポインタのみ）がそのまま適用される。

## Quality Implications

- **DEC-650 が守る品質**: engine が UI の都合で歪まない。破ると: 表示の変更が pipeline の API を揺らし、切り出しが不可能になる。
- **DEC-652 が守る品質**: lane の状態の正本が 1 つに保たれる。破ると: UI と CLI が別の履歴を見て、同じ lane に矛盾した判断を下す。
- **DEC-651 が守る品質**: engine の公開面が handoff の schema だけに対応する。破ると: view model が engine の契約に混ざり、別 front から使えなくなる。

## Intent-derived Invariants

- INV-005 (from DEC-650): `packages/idd-core` から UI 側（`app/` `components/` `hooks/` `lib/`）の module を import しない。

## Rollback / Follow-ups

- **worker pool の再実装**: DEC-652 で `lib/idd/worker-pool.ts` を消したため、Workspace DEC-004 / DEC-007 が宣言した「pi session = persistent worker」の実体は現在存在しない。S1 / S2 の実装時に handoff の `agents.md` に沿って engine 側へ書き直す。

- **Rollback**: `packages/idd-core` を `lib/idd-ui/server/` へ戻せば、workspace 追加前の構成に復帰する（依存は一方向なので機械的に戻せる）。
- **Follow-ups**:
  - 意味類似の重複判定（DEC-656 の detector）を実装する
  - S2（executor）を同じ形で足す。worker pool（Workspace DEC-007 の実体）は `AgentRunner.spawn` が最小形として担っている
  - lane を閉じたときに worktree を撤去する
  - 優先度 ranking（11 段階）の確定後に FIFO を置き換える（DEC-671）
  - S1（planner）を実装し、取り込んだ lane を下調べに載せる
  - cron を systemd timer などに登録する（現状は手動実行）
