---
title: hooks/ + app/ + top-level pi-web 由来コードの設計判断（inherited）
status: active
intent_schema: 3
created_at: 2026-08-23
updated_at: 2026-08-23
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/PiWebInherited/hooks-app-other/decision.md -->

# hooks/ + app/ + top-level pi-web-inherited DEC

## Context

本ファイルの DEC 群は agegr/pi-web v0.8.9 (SHA `2a6e537`, MIT) 由来コードの `hooks/**`、`app/**`（`app/idd/**`・`app/api/idd/**` を除く）、`bin/**`、および top-level TS/JS ファイル (`next.config.ts`, `instrumentation.ts`, `proxy.ts`) の設計判断を記録する。本 repo の IDD-化（Workspace/pi-web-idd-workspace/decision.md の DEC-002「additive 拡張境界」および DEC-001「upstream 追従なしの完全固定派生」）に伴い、既存のインライン散文コメントから抽出した。ここでの「Why」は基本的に pi-web 由来の設計者の意図の再構成であり、本 repo で新たに定めた不変ではない。

## Decisions

### DEC-500: 新規セッション作成時は明示 override のみ送信し、models scope はサーバー側で原子的に解決

- **What**: `useAgentSession.ensureNewSession` は browser 側が明示指定した provider/modelId/thinkingLevel だけを `/api/agent/new` に送る。models 一覧の `enabledModels` scope とデフォルト解決は AgentSession construction と同一 tick でサーバーが行う。
- **Why**: browser 側で `newSessionModel ?? newSessionDefaultModel` を送ってしまうと、その値が古い可能性がある（models 一覧の refresh より前に session が始まる race）。server で construction と scope 解決を原子的に行えば race window が消える。
- **Change freedom**: browser 側 override の UI や API 名は自由。「明示 override のみ送る」原則が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`ensureNewSession`）

### DEC-501: System パネル起動時は dormant session を prompt を送らずに初期化

- **What**: `loadSystemPrompt` は `ensureNewSession` で session を起こしたあと `get_state` だけを送り、prompt / message は発行しない。
- **Why**: System パネルは system prompt の確認 UI であり、副作用として model run や user message を作りたくない。事前に確認してから prompt を送りたいユーザー体験を保つ。
- **Change freedom**: どの UI から呼ぶかは自由。「非 prompt command で初期化する」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（`loadSystemPrompt`）

### DEC-502: 他ブラウザで開始された session への SSE 再接続を sidebar polling で通知

- **What**: 別ブラウザで開始された session の SSE stream には、sidebar が持つ軽量な running-state poll の結果（`sessionRunning` prop）を trigger にして再接続する。同期プロトコルを新設しない。
- **Why**: session UI は一箇所からしか開かれない前提を持たない。すでにある sidebar poll を「session が動いているかの安いシグナル」として再利用すれば、chat 側に別の同期経路を追加せずに追随できる。
- **Change freedom**: sidebar が返す情報のスキーマは自由。「専用の同期プロトコルを追加しない」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（session running effect）

### DEC-503: server state が確認できない間は SSE stream を切らない

- **What**: `scheduleEventStreamClose` の `checkServerIdle` は fetch が失敗した場合に stream を close せず、poll を継続する。
- **Why**: network が一時的に切れただけで stream を close すると、復帰時に取りこぼしが発生する。確認できるまでは開けておく方が誤って切ることによる被害が大きい。
- **Change freedom**: poll 間隔・retry 数は自由。「確認不能で close しない」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（`scheduleEventStreamClose`）

### DEC-504: prompt run 境界を越えた stale response / 遅延イベントを guard する

- **What**: `promptRunIdRef` を各 prompt に振り、`finishPromptWithoutStream` / `reconcileAgentState` / `message_start` / `message_update` / `message_end` の handler は run boundary を跨いだイベントを検出したら早期リターンする。
- **Why**: 遅い fetch が完了する前にユーザーが次の turn を始めた場合、古い response で新しい turn の状態を上書きするとゴーストメッセージ／stale finish が発生する。boundary guard がなければ SSE buffer を frozen tab で溜め込んだあとの flush で streaming bubble が復活する。
- **Change freedom**: run id の型・命名は自由。「run boundary で stale event を drop」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（`finishPromptWithoutStream`, `reconcileAgentState`, `handleAgentEvent` case `message_start`/`message_update`/`message_end`）

### DEC-505: SSE を主完了経路にし、poll による reconciliation は recovery net として運用

- **What**: `waitForPromptSettlement` / `waitForBashSettlement` / `reconcileAgentState` の poll は、mount 中に visibility / online / interval で trigger されて `finishPromptWithoutStream` を呼ぶ。SSE の agent_end / prompt_done が届けば通常はここに到達しない。session id は tick 毎に ref から読む（新規 session では ensure_session 完了後まで id が確定しないため）。
- **Why**: SSE は network drop、mobile tab の background、half-open connection で欠落する。欠落した場合でも streaming state を無限に残さないため、poll による reconciliation が必要。ただし SSE を主にしないと event 順序が崩れる。
- **Change freedom**: poll 周期は自由（現行は 15s reconcile / 1s bash / 30s idle grace 等）。「SSE 主・poll 副」の階層と「sid は ref から都度読む」が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`waitForPromptSettlement`, `waitForBashSettlement`, `reconcileAgentState`, reconcile useEffect）

### DEC-506: compaction state は unconditional に mirror して stuck UI を防ぐ

- **What**: `reconcileAgentState` は毎回 `state?.isCompacting ?? false` を `setIsCompacting` に反映する。state が undefined（wrapper 消滅）なら compacting でないとみなす。
- **Why**: compaction_end イベントが欠落すると "Stop compaction" UI が永久に残る。他の isStreaming/isPromptRunning と違い compaction UI は補助的なので、値の欠落＝完了と扱う方が safe。
- **Change freedom**: mirror するタイミングは自由。「欠落 = 完了扱い」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（`reconcileAgentState`）

### DEC-507: 1 論理 prompt が複数 end event を吐くため settlement まで stream を開放しない

- **What**: `agent_end` / `agent_settled` / `prompt_done` の handler は「stream close」を SSE grace + settlement 判定の後まで遅らせる。extension が inject した agent の実行、compact、retry で agent_end が複数回発火し得る。abort 後は queued messages が pi 側に残り、次の turn で delivered される。
- **Why**: 1 turn = 1 agent_end という単純化は extension・compact・retry で崩れる。close を early に決めると、続けて発火する agent_start を取りこぼす。
- **Change freedom**: settlement 判定式は自由。「複数 end を許容し settlement 判定を独立させる」原則が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleAgentEvent` case `agent_end`, `agent_settled`, `prompt_done`）

### DEC-508: streaming 出力の live-follow は tail 近接時のみ + defer で DOM 反映を待つ

- **What**: `message_start`/`message_update` handler は `isNearBottomRef.current` が true のときだけ scrollIntoView を呼び、`requestAnimationFrame` で 1 フレーム遅らせる。
- **Why**: ユーザーが上にスクロールして過去を読んでいるときに live-follow で下に飛ばされないようにする。scroll を即発火すると React の DOM 更新前で stale layout に対して scroll するので、次の frame まで待つ必要がある。
- **Change freedom**: 「tail 近接」の閾値は自由。「近接時のみ + defer」だけが不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleAgentEvent` case `message_start`/`message_update`）

### DEC-509: 楽観追加ユーザーメッセージと delivered queue message の同一化

- **What**: `message_end` で受け取った user message は、直前の楽観 message key と一致すれば追加せず、一致しなければ追加する。楽観 key は 1 回だけ consume する。
- **Why**: delivered steering/follow-up message は user role として届く。初回 prompt は `handleSend` で楽観追加済みなので、そのまま追加すると重複する。ただし後続の same-text queue delivery（別 turn）は render する必要がある。
- **Change freedom**: message key の hash 関数は自由。「1 楽観 = 1 consume、以降の same-text は render」が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleAgentEvent` case `message_end`）

### DEC-510: 送信後の transport failure は不確定なので SSE を切らずに server state で確定させる

- **What**: `handleSend` と `sendStreamingPrompt` は fetch が失敗しても、`isPromptRejectedError` で拒絶と確定できない限り SSE を保持し、`waitForPromptSettlement` / `reconcileAgentState` に判定を委ねる。
- **Why**: proxy timeout などで response を失ったが server は accept 済みというケースを、client が「拒絶」と決めつけて close すると、実際に走っている turn の情報を全て失う。restoreSubmission も duplicate turn を招く。
- **Change freedom**: `isPromptRejectedError` の判定条件は自由。「不確定なら server 側に決めさせる」原則が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleSend`, `sendStreamingPrompt`）

### DEC-511: model_change は Pi 側で同期永続化されるため成功時も失敗時も session を再読込

- **What**: `handleModelChange` は set_model 成功後に `loadSession` を呼ぶ。失敗時も override を戻したうえで `loadSession` を呼ぶ。
- **Why**: pi は model_change を同期的に session file に書く。client の override 表示と、file 由来の canonical model / thinking level / active leaf を再度整合させないと乖離する。fail した response が来ても server 側で書き込みは進んでいる可能性があるため、失敗経路でも再読込が必要。
- **Change freedom**: 再読込のスコープは自由。「成功・失敗いずれでも session file を再読込」が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleModelChange`）

### DEC-512: thinking level "auto" は Pi 側設定を触らず、enabledModels の pin を新規セッションに反映

- **What**: `handleThinkingLevelChange` は "auto" 選択時に pi へ set_thinking_level を送らない。`loadModels` は `enabledModels` に pin (`anthropic/*:high` など) が設定されていれば新規 session の初期 level に反映する。
- **Why**: "auto" は「pi が判断する」なので client 側で強制すべきではない。enabledModels は CLI と同じ pattern を持つので、CLI と同一挙動にしないと動作差が出る。
- **Change freedom**: pin syntax は pi と同期する（pi 由来）。「auto は pass-through、pin は反映」が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleThinkingLevelChange`, `loadModels`）

### DEC-513: streaming 中の追加送信は AgentSession.prompt に atomic 判断させる

- **What**: `sendStreamingPrompt` は steer / followUp を直接叩かず、`prompt` command に `streamingBehavior` を付けて送る。
- **Why**: 直接 steer/followUp を呼ぶと、request 中に turn が settle した場合に idle queue に message が strand する。`prompt` に集約すれば server 側で「queue に載せる／新 turn として実行する」を atomic に判定できる。
- **Change freedom**: streamingBehavior の値集合は pi と同期。「steer/followUp を直接叩かない」が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`sendStreamingPrompt`）

### DEC-514: recall 時は SSE のみで届く queue_update を待たず locally clear

- **What**: `handleRecallQueue` は clear_queue の結果を受けたあと、`setQueuedMessages({ steering: [], followUp: [] })` を local に呼ぶ。
- **Why**: pi の clearQueue は empty queue_update を発火するが、それは SSE 経由でしか届かない。SSE 未接続で recall した場合は UI が古い queue のままになる。local clear で UI と実状を即座に合わせる。
- **Change freedom**: clear 直後の text 表示方式は自由。「local clear を発行する」原則が不変。
- **Anchors**: `hooks/useAgentSession.ts`（`handleRecallQueue`）

### DEC-515: グローバル abort handler は module-level registry 経由で prop-drilling を回避

- **What**: `registerAbortHandler` で ChatWindow が abort handler を module scope に登録する。AppShell の global Esc listener は module から直接 handler を読む。
- **Why**: ChatWindow 内部の agentRunning / handleAbort を AppShell まで prop-drill すると、無関係な component tree に依存が漏れる。module-level registry は「一度に 1 handler」で十分な用途に対して最小コストの共有機構。
- **Change freedom**: registry の実装（Map・ref・context）は自由。「global Esc は ChatWindow から module 経由で呼ぶ」だけが不変。
- **Anchors**: `hooks/useKeyboardShortcuts.ts`（`registerAbortHandler`）

### DEC-516: Esc は textarea/input 内では handler を発火させず ChatInput 側の menu 制御に委譲

- **What**: `useGlobalKeyboardShortcuts` の keydown handler は `event.target` が TEXTAREA/INPUT の場合に Esc を早期リターンする。
- **Why**: ChatInput は slash menu / @ file menu を Esc で閉じるロジックを持ち、その menu state は component-local。global で Esc を消費すると menu が開いたまま agent が停止する挙動になる。
- **Change freedom**: どの tag を除外するかは自由。「component-local な Esc 消費を global が奪わない」原則が不変。
- **Anchors**: `hooks/useKeyboardShortcuts.ts`（`useGlobalKeyboardShortcuts`）

### DEC-517: mobile breakpoint (640px) と SSR-safe hook の設計

- **What**: `useIsMobile` は 640px を境界とし、SSR / hydration 初回は false（desktop）を返してから `useSyncExternalStore` で実 viewport に同期する。
- **Why**: breakpoint 値は `app/globals.css` と共有する定数（片方だけ書き換えると崩れる）。SSR で `window.matchMedia` を触れないので desktop 前提で render しないと hydration mismatch が起きる。
- **Change freedom**: 境界値・default 側は自由。「値は CSS と同じ、SSR 初回は desktop 固定」が不変。
- **Anchors**: `hooks/useIsMobile.ts`

### DEC-518: localStorage / prefers-color-scheme イベント欠落・失敗時の graceful degradation

- **What**: `useTheme` は localStorage の read/write を try/catch でくるみ、`window.focus` と `document.visibilitychange` を追加 listener として登録する。ViewTransition の cancel も catch する。
- **Why**: private mode / storage quota で storage が失敗しても theme 切替は動くべき。一部ブラウザは background 中に prefers-color-scheme の change event を落とすので、frontend に戻ったとき再同期する fallback が要る。
- **Change freedom**: fallback listener の集合は自由。「storage 失敗を握り潰す・event 欠落を復帰時に補償する」原則が不変。
- **Anchors**: `hooks/useTheme.ts`

### DEC-519: AudioContext を単一保持し autoplay policy に対応

- **What**: `useAudio` は `ctxRef` に AudioContext を保存して使い回し、`unlockAudio` で `resume()` を呼ぶ。
- **Why**: user gesture の外で作った AudioContext は "suspended" で始まり音が出ない。context を毎回作ると unlock の機会を失い、user gesture に応じて resume することで初めて音が鳴る。
- **Change freedom**: unlock を呼ぶ trigger は自由。「context を毎回作り直さない・catch は握り潰す」が不変。
- **Anchors**: `hooks/useAudio.ts`

### DEC-520: localStorage 失敗時は locale 切替を継続

- **What**: `useI18n` は localStorage の read/write を try/catch で握り、失敗しても current page 内の locale 切替は続行する。
- **Why**: private mode でも UI を触れる状態を維持したい。永続化は best-effort。
- **Change freedom**: fallback の locale 決定順は自由。「storage 失敗を握り潰して現行 tab の切替は残す」が不変。
- **Anchors**: `hooks/useI18n.tsx`

### DEC-521: resize panel の storage 失敗・pointer capture 失敗は silent

- **What**: `useResizablePanel` は storage 書き込み失敗と `releasePointerCapture` 失敗をどちらも silent に握る。
- **Why**: 書けない storage で resize UI を無効化する理由がない。pointer capture はブラウザが cancel 後に already-released を返すことがあり、その throw は再送不要。
- **Change freedom**: catch の粒度は自由。「resize 動作は storage/capture 失敗で止めない」が不変。
- **Anchors**: `hooks/useResizablePanel.ts`

### DEC-522: visualViewport は WebKit の resize 遅延を rAF で回避

- **What**: `useViewportHeight` は `visualViewport.resize` を受けても `requestAnimationFrame` の中で height を読み、値が settle した状態で `--app-viewport-height` を書く。
- **Why**: WebKit は PWA で keyboard を dismiss した直後に古い viewport.height で resize event を発火することがある。同期読みだと keyboard 分の高さが残る CSS が UI に張り付く。
- **Change freedom**: 遅延方法（rAF, microtask, setTimeout）は自由。「resize を同期で読まない」だけが不変。
- **Anchors**: `hooks/useViewportHeight.ts`

### DEC-523: files route は symlink 経由の upload 迂回を防ぎ、multipart 全体サイズを個別上限より広く取り、client 切断経路は silent

- **What**: `getUploadDirectory` は `fs.realpathSync` で directory と allowedRoots の両方を解決してから比較する。`MAX_UPLOAD_REQUEST_BYTES` は `MAX_UPLOAD_TOTAL_BYTES + 1024*1024` として multipart boundary 分の余白を持つ。file streaming の `enqueue`/`close`/`error` の各 controller 操作は client 切断で throw するので try/catch で silent に握る。
- **Why**: symlink を realpath で解決しないと、allowed root 内の symlink 経由で root 外に書ける。multipart は boundary/header で body 総量が file bytes より必ず大きい。client が abort した後の controller 操作は expected な throw で、log しても意味がない。
- **Change freedom**: 上限値、fallback ルールは自由。「symlink 両側解決、multipart 余白、client 切断 silent」が不変。
- **Anchors**: `app/api/files/[...path]/route.ts`（`getUploadDirectory`, `createFileBodyStream`）

### DEC-524: files route の watch は attribute event を無視、listing は withFileTypes で per-entry stat を削減

- **What**: `watch` handler は `mtime/ctime/ino/size` の 4 値が全て一致する change event を drop する。`connected` event は `fs.watch()` が返ったあとに emit する。`list` handler は `readdirSync({ withFileTypes: true })` で directory / file / symlink を判定し、`resolveDirentIsDirectory` で per-entry stat を回避する（symlink や dtype 非対応 FS のみ stat fallback）。
- **Why**: 一部プラットフォームは file read や attribute 読み取りでも fs.watch event を発火するので、変化なしの通知を filter する。connected を watcher 生成前に emit すると、client が snapshot する前後の変化が空白期間に落ちる。normal file の per-entry stat は大規模 dir で線形コストが痛い。
- **Change freedom**: 判定に使う field 集合は自由。「attribute event filter、connected の順序、stat 省略」が不変。
- **Anchors**: `app/api/files/[...path]/route.ts`（`watch` handler, `list` handler）

### DEC-525: file-index の cap 設計と BFS truncation

- **What**: `MAX_FILES` は client-side index の cap、`GIT_HARD_CAP` / `WALK_HARD_CAP` は in-memory listing の hard cap。`?q=` は full listing を search してから cap を適用する。`listWithWalk` は BFS でキュー展開し、shallow file 優先で cap する。
- **Why**: client-side は fuzzy filter を local で回すので送る量を絞る、`?q=` は「深い path をわざわざ探す」目的なので full listing を対象にしないと deep file を検索できない（TUI の fd 挙動）。cap 到達時に BFS のほうが「関連性の高い浅い path が残る」ため DFS より良い。
- **Change freedom**: cap の値・比率は自由。「client-side は cap 済み、q= は full 対象で post-cap、BFS 優先」が不変。
- **Anchors**: `app/api/file-index/route.ts`（`listWithWalk`, `GET` handler）

### DEC-526: file-index は git 優先 → readdir fallback、globalThis 上の per-cwd cache

- **What**: `listWithGit` を先に呼び、失敗（git 不在 or non-repo）したら `listWithWalk` にフォールバック。skip 一覧は fallback 側のみで使う。cache は `globalThis.__piFileIndexCache` に置き Next.js の hot-reload を跨いで生存し、CACHE_TTL_MS 内は再計算しない。derived な `entries` は `?q=` 初回に lazily 構築する。
- **Why**: git repo は .gitignore が正解なので TUI と同じ挙動をなぞる。@ menu は open ごとにリクエストしキー入力ごとに search するので、短い window での再計算は無駄。cache を globalThis に置かないと hot-reload で消える。entries は search 時のみ必要なので lazy。
- **Change freedom**: cache TTL、entry 数上限は自由。「git 優先・globalThis cache・lazy entries」が不変。
- **Anchors**: `app/api/file-index/route.ts`（`listWithGit`, `getIndexCache`, `GET` handler）

### DEC-527: skills route は DefaultResourceLoader 経由で AgentSession と同じ探索結果を返し、global skills を allow-list、frontmatter 更新は surgical

- **What**: GET は `loadSkillsWithInstallInfo(cwd)` を呼ぶ（AgentSession 起動と同一 loader）。PATCH は `~/.agents/skills`（symlink 先）を allow-list に追加してから access check し、`disable-model-invocation` フラグの追加削除は line 単位の replace で行う（YAML parser round-trip しない）。
- **Why**: settings.json の skill path、package skills、`.agents/skills` の解決は SDK と一致させないと画面と実挙動が乖離する。global skills は symlink されるので `isExistingFilePathAllowed` が realpath で `~/.agents/skills` に着地する、この root も trusted なので allow-list に加える必要がある。frontmatter を parser で書き戻すと他フィールドの整形が変わり diff が肥大化する。
- **Change freedom**: PATCH で扱う key の集合は自由。「SDK loader 共通化、~/.agents/skills allow-list、surgical edit」が不変。
- **Anchors**: `app/api/skills/route.ts`（GET, PATCH）

### DEC-528: worktrees route の access 制御、removed cwd fallback、dirty removal のエラー表面

- **What**: `checkCwdAllowed` は `/api/files` と同じ allow-list を使う。`GET` は cwd が存在しない場合に inferred project root を使って listing を続行し、`allowFileRoot(w.path)` で worktree path を allow-list に追加する。`DELETE` は git の "dirty" エラーを regex で検出し `409` として `dirty: true` を返す。
- **Why**: worktree endpoint も file と同じ security boundary を守るべき。削除済み worktree の session を UI で開いた状態でも switcher 表示を保つ、addWorktree の in-memory allowlist は server restart で消えるので再登録する。UI に "force remove を出すか" を判断させるため server は dirty 状態を明示的に返す。
- **Change freedom**: エラー文字列の regex は git 出力の変化に追随。「files と同じ gate、removed cwd fallback、dirty=409」が不変。
- **Anchors**: `app/api/worktrees/route.ts`（`checkCwdAllowed`, GET, DELETE）

### DEC-529: running-events SSE は subscribe を snapshot より先に、initial frame を同時に流し、heartbeat で proxy timeout を回避

- **What**: `/api/agent/running/events` は `subscribeRunningSessions` を先に呼び、その直後に `getRunningRpcSessionIds()` の snapshot を initial frame として送る。以降 30 秒毎に `":\n\n"` heartbeat を送る。sidebar 表示は基本 SSE 経由で、tab visible の polling snapshot 用に `/api/agent/running` も別途提供。
- **Why**: subscribe → snapshot の順にしないと、その間に発生した状態変化が失われる。initial frame を出さないと接続直後の UI が空になる（duplicate frame は client 側で set が同一化するので害はない）。heartbeat がないと proxy が idle connection を close する。sidebar は idle 時に poll を止めたいので SSE を主体にする。
- **Change freedom**: heartbeat 周期は自由。「subscribe-before-snapshot、initial frame、heartbeat」が不変。
- **Anchors**: `app/api/agent/running/events/route.ts`, `app/api/agent/running/route.ts`

### DEC-530: agent/new の ensure_session semantics、一意 startRpcSession key、files-route allowlist 同期

- **What**: `type: "ensure_session"` は session runtime を作るだけで prompt を送らない。session 起動時の key は `` `__new__${randomUUID()}` `` で毎リクエスト unique。session 作成後に `allowFileRoot(cwd)` を呼び、`invalidateSessionListCache()` する。
- **Why**: client は slash command 取得のためにも session を起こす必要があるが、prompt は送りたくない。`startRpcSession` は同じ key の同時 caller を coalesce するので、Date.now() ベースの key だと同ミリ秒 2 request が同一 session に潰れる。files-route の allowlist cache は最短 TTL 秒生き残るので、新規 cwd が即読めるよう明示的に allow する。
- **Change freedom**: key の生成方式は unique を保てば自由。「ensure_session の副作用なし・一意 key・allowlist 同期」が不変。
- **Anchors**: `app/api/agent/new/route.ts`（POST）

### DEC-531: session 削除時は bounded header だけ読み、子 session を cascade re-parent する

- **What**: `DELETE /api/sessions/[id]` は削除前に `readSessionHeader` で対象の parentSession を読む（bounded read）。同ディレクトリの兄弟 `.jsonl` を scan して、`parentSession` が削除対象を指すものを再帰させず親に付け替える。malformed / 読み取り失敗の子 file は skip する。
- **Why**: 削除対象の session file 全体を読むのは無駄（末尾まで JSONL）。bounded header で必要な parent 情報だけ取れる。子を re-parent しないと tree が破れる。malformed line を無視する tolerance は SDK 側の慣行と合わせる。
- **Change freedom**: scan 対象 dir、skip 判定は自由。「bounded header + cascade re-parent」が不変。
- **Anchors**: `app/api/sessions/[id]/route.ts`（DELETE）

### DEC-532: OAuth login SSE の in-memory registry、provider token 検証、abort 伝播

- **What**: GET は SSE stream。POST は client の code 入力を受け、`loginToken` を key とする promise を resolve する。`globalThis.__piLoginCallbacks` は SSE と POST 間の共有 registry。token は `` `${provider}-${Date.now()}-${random}` `` 形式で、POST は token が provider prefix と一致するかを検証する。client 切断は `req.signal.addEventListener("abort", ...)` で全 pending token を reject する。
- **Why**: OAuth flow は state を streaming 中に維持する必要があるが、Next.js の route は無状態なので globalThis registry で SSE handler と POST handler を橋渡しする。provider 検証がないと別 provider の token を送信すれば任意 provider の flow に介入できる。client abort に応答しないと server 側の login promise が hang する。
- **Change freedom**: token format 内部の random 部分は自由。「globalThis registry、provider prefix 検証、abort 伝播」が不変。
- **Anchors**: `app/api/auth/login/[provider]/route.ts`（GET, POST）

### DEC-533: api-key route は credential を直接 store し unbounded catalog refresh を回避

- **What**: POST は `apiKeyAuth.login` から返る credential を `storeProviderCredential` で直接永続化する（`ModelRuntime.login()` を経由しない）。
- **Why**: `ModelRuntime.login()` は credential 保存の後に model catalog を network から refresh するが、その refresh に時間制限がない。遅い catalog で保存 request 全体が hang するのを避けるため、保存を先に確定させて catalog は後続で cache invalidate する。
- **Change freedom**: cache invalidate の trigger は自由。「保存を catalog refresh に先行させる」が不変。
- **Anchors**: `app/api/auth/api-key/[provider]/route.ts`（POST）

### DEC-534: providers listing は login 方式 (oauth / apikey) の capability で分類し dual-auth も両方に含む

- **What**: `/api/auth/all-providers` は API key を受け付ける provider を返し、`/api/auth/providers` は OAuth を宣言する provider を返す。anthropic のように両方を持つ provider は両方の list に現れる。分類は `lib/provider-listing.ts` の capability check に委任する。
- **Why**: provider を hardcode で分けると、SDK 側で新 provider が追加されたときの反映漏れが出る。capability-based にすれば pi 側の宣言が single source of truth。UI 側も「OAuth もある provider に API key を設定させる」という要求に応えられる。
- **Change freedom**: 分類関数の実装は自由。「capability-based、dual-auth は両 list に含む」が不変。
- **Anchors**: `app/api/auth/all-providers/route.ts`, `app/api/auth/providers/route.ts`

### DEC-535: /api/models は project trust を通してから extension 読込み、enabledModels は CLI と同じ pattern 解決

- **What**: `loadModels` は `projectTrustReloadOptions(cwd, agentDir)` を services 作成に渡し、untrusted な project では extension を実行しない。visible model の絞り込みは `resolveVisibleModels` に `settings.getEnabledModels()` を渡し、CLI と同じ glob / fuzzy pattern を通す。
- **Why**: model 列挙でも `.pi/extensions` factory が動くので、untrusted な project code の実行を許してはならない（`lib/project-trust.ts` #236）。enabledModels の pattern は CLI と同一挙動でないと画面と `pi run` の視野が食い違う（#307）。
- **Change freedom**: services 生成のオプションは自由。「trust ゲート、CLI 同型の pattern 解決」が不変。
- **Anchors**: `app/api/models/route.ts`（`loadModels`）

### DEC-536: agent/[id] endpoints は already-running session の fast path を持ち、bash-output は inline size-limited + download stream

- **What**: `/api/agent/[id]` POST/GET と `/api/agent/[id]/events` は `getRpcSession(id)` で in-memory session を優先し、alive でなければ file から `startRpcSession` する。`/api/agent/[id]/bash-output` は size <= 上限を inline で JSON 返し、`download=1` は buffering せず stream する。
- **Why**: session が生きていれば file を再解釈するコストを払う必要がない。bash-output は 100MB 級の出力もあり得るので、inline / download を明示的に分離しないと OOM や response hang を起こす。
- **Change freedom**: fast path の判定順・inline 上限は自由。「in-memory 優先、size 分岐」が不変。
- **Anchors**: `app/api/agent/[id]/route.ts`, `app/api/agent/[id]/events/route.ts`, `app/api/agent/[id]/bash-output/route.ts`

### DEC-537: git/diff は cwd の存在を要求し、path の repo 帰属確認は getGitFileDiff に委任

- **What**: `getGitFileDiff` を呼ぶ前に cwd を `isExistingFilePathAllowed` で存在チェックする。path 自体は存在チェックしない（deleted file を diff できるように）。
- **Why**: cwd が存在しないと `git -C` が失敗するので事前 400。file は git status によっては削除済みで、getGitFileDiff 内で git に「この repo のこの path か」を判定させたい。
- **Change freedom**: 呼び出し順は自由。「cwd 存在必須、path 存在は git 側任せ」が不変。
- **Anchors**: `app/api/git/diff/route.ts`

### DEC-538: skills/search の parseSearchOutput は npx skills find の line format に依存

- **What**: `parseSearchOutput` は `owner/repo@skill  NNK installs` という 2 行構成（次行に URL）を regex で抽出する。skills.sh API 呼び出しに失敗した場合の fallback として使う。
- **Why**: skills.sh の 一次 API が落ちても検索を止めない。fallback の入力は human-readable な出力しかないので、format 変更に追随する脆さは受容する。
- **Change freedom**: regex は npx skills find の出力に追従。「fallback を持つ二段構成」が不変。
- **Anchors**: `app/api/skills/search/route.ts`（`parseSearchOutput`）

### DEC-539: auto-name の waitUntilReady?. は dev hot-reload で古い wrapper が生存する状況への防御

- **What**: `/api/sessions/[id]/auto-name` は `session.waitUntilReady?.()` を optional chaining で呼ぶ。
- **Why**: `globalThis` 上の session wrapper は dev の hot-reload を跨いで生存する。`waitUntilReady` が実装される前の古い instance が残っていた場合でも、それらは既に startup 完了済みなので undefined 呼び出しをスキップして先に進める。
- **Change freedom**: hot-reload 世代管理の実装は自由。「optional chain で古 wrapper を許容」が不変。
- **Anchors**: `app/api/sessions/[id]/auto-name/route.ts`

### DEC-540: thinking route は SessionManager 経由で SDK の malformed-line 許容を保つ

- **What**: `/api/sessions/[id]/entries/[entryId]/thinking` は `getSessionEntries(filePath)` を通して entry を取得する（`SessionManager` backed）。
- **Why**: SDK の SessionManager は malformed line を skip する tolerance を持つ。生 JSON を自前 parse すると壊れた line で throw して他 entry が読めなくなる。
- **Change freedom**: どの getter を使うかは自由。「SDK 経由で malformed 許容を継承」が不変。
- **Anchors**: `app/api/sessions/[id]/entries/[entryId]/thinking/route.ts`

### DEC-541: cwd/validate は UI 選択前に workspace を allow_root に登録し project を解決

- **What**: `POST /api/cwd/validate` は path 正規化 → stat 検証 → `allowFileRoot(normalizedCwd)` → `resolveProject` → project identity key 返却の順で処理する。
- **Why**: UI がまだ選択していない cwd を先に allow-list するのは、直後の /api/files 呼び出しが 403 にならないように pre-warm する意図。project identity は Meltly IDD の pi worker mapping に必要。
- **Change freedom**: 正規化ルール（~/… 展開など）は自由。「pre-warm allow-list + project 解決」が不変。
- **Anchors**: `app/api/cwd/validate/route.ts`

### DEC-542: session export の patchExportHtml は pi-coding-agent の再帰実装を iterative に書き換え

- **What**: `patchExportHtml` は pi-coding-agent の `template.js` にインラインで書かれた `sortChildren` / `mapNodes` / `markActive` の 3 関数を export 後の HTML 上で iterative 版に replace する。replace 前に line ending を LF に正規化する。
- **Why**: 深い linear session tree（5000 entries+）で再帰版が call stack overflow する。`template.js` を直接直すと `node_modules` 経由で上書きされるので repo-side patch が必要。route.ts (CRLF) と template.js (LF) を混ぜて match するので、比較前に両方 LF 化しないと Windows で失敗する。`import.meta.resolve` は Next.js の production bundle で strip されることがあり、複数の候補 path を試す。
- **Change freedom**: 3 関数の iterative 実装（DFS/BFS の選択、post-order の作り方）は自由。「recursion を iterative に置換」「line ending 統一」が不変。
- **Anchors**: `app/api/sessions/[id]/export/route.ts`（`patchExportHtml`, `getPiCliPath`）

### DEC-543: bin/pi-web.js は next CLI 直接呼び出し + spawn argv 化で .bin symlink / shell 経由問題を回避

- **What**: `nextBin` は `require.resolve("next/dist/bin/next", { paths: [pkgDir] })` を主経路、`next/package.json` からの derive を 2 段目、`node_modules/next/dist/bin/next` を最終 fallback として解決する。次の CLI は `spawn(process.execPath, [nextBin, ...])` で shell を経由しない。ブラウザ opener は Windows で `cmd.exe /c start "" <url>`、mac で `open`、Linux で `xdg-open` を、いずれも `shell: true` を使わず argv で spawn する。
- **Why**: npx install では `.bin` symlink が存在しないことがある。`shell: true` は Node 22+ で DEP0190 警告が出て、引数エスケープを shell に投げる分だけ path with spaces / injection のリスクが上がる。Windows の `start` は cmd 内蔵なので cmd 直接呼び、空 title 引数（`""`）を挟まないと URL が title 扱いされる。
- **Change freedom**: candidate 解決順は自由。「argv 分離、shell:true 不使用、`.bin` に依存しない」が不変。
- **Anchors**: `bin/pi-web.js`

### DEC-544: Service worker は /api/ と /sw.js を cache 対象にしない

- **What**: `public/sw.js` の fetch handler は cross-origin と `/api/*` と `/sw.js` を全て素通しにし、SW cache には載せない。
- **Why**: session 情報や agent の live traffic は必ず local server から最新を取る必要があり、SW cache に載ると stale response を掴んで UI が古い state を表示してしまう。sw.js 自身も更新経路を塞がないため除外。
- **Change freedom**: cache 対象の path 拡張・排除リストの粒度は自由。「/api/ と /sw.js は cache しない」だけが不変。
- **Anchors**: `public/sw.js:44`

### DEC-545: 通知クリック時の window match は race を許容して次候補へ進む

- **What**: `matchAll` で拾った client を `focus()` / `navigate()` する際、失敗（TypeError 等）は catch で握り潰し次の candidate へ進む。全部失敗なら最後に `self.clients.openWindow()` で新規開く。
- **Why**: `matchAll` の結果と実 focus 呼び出しの間に window が閉じる race は日常的に発生し、都度失敗を surface してもユーザ操作としては再現不能。エラー握り潰しは正当な defensive 挙動。
- **Change freedom**: catch 内で log を取るかどうかは自由。「1 candidate 失敗で次に進む、全滅時は新規 window」だけが不変。
- **Anchors**: `public/sw.js:101`

## Consequences / Impact

- **範囲**: 本 DEC 群は hooks / app / bin / top-level TS の pi-web-inherited なコードに閉じている。IDD-native な `app/api/idd/**` / `lib/idd/**` の判断は Workspace decision.md 側で管理する。
- **cherry-pick 経路**: Workspace DEC-001 により upstream pi-web からの取り込みは行わないので、本 DEC 群と upstream の DEC id の衝突を心配しなくてよい。
- **DEC 更新**: 本 DEC が指す挙動が変わる場合、対応する intent pointer コメントも同 DEC を差し続けるか、新 DEC を採番して差し替える。
- **テスト landmark**: `hooks/useAgentSession.test.mjs` と `app/api/files/watch-route.test.mjs` は元々 pi-web のコメント文字列を landmark に使っていた。本 DEC-化に合わせて test 側も intent pointer / 構造キーワードに書き換えた。

## Quality Implications

- 本 DEC 群が守るのは「pi-web の意図的な設計判断が、コメント削除の過程で失われないこと」。破ると: エッジケース（transport failure、SSE 欠落、hot-reload wrapper、Windows shell escaping）で pi-web が積み重ねてきた対策が知らず知らずに剥がれ、同じ問題が再発する。
- コード自体の挙動は本タスクでは変更していない（comment-only 化 + test 側の landmark 更新のみ）。したがって既存の pi-web の QA は影響を受けないはず。

## Intent-derived Invariants

None

## Rollback / Follow-ups

- **Rollback**: intent pointer の書き戻しは可能だが、pi-web の元コメント表記に戻す価値は薄い。DEC id 側で意味を保持する方針を維持する。
- **Follow-ups**:
  - `components/**` と `lib/**` の pi-web-inherited なコードも同様に IDD-化する予定（別 agent スコープ）。DEC id 帯域は本 file の 500–699 と衝突しないよう別帯域を割り当てる。
  - 本 DEC 群のうち、実挙動が本 repo の IDD 拡張と齟齬をきたすものがあれば、Workspace 側 DEC で override する（例: pi-web-inherited な SSE 挙動が Meltly の lifecycle event 送信と競合する場合など）。今のところ想定なし。
