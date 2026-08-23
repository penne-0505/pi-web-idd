---
title: lib/ pi-web 由来コードの設計判断（inherited）
status: active
intent_schema: 3
created_at: 2026-08-23
updated_at: 2026-08-23
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/PiWebInherited/lib/decision.md -->

# lib/ pi-web 由来コードの設計判断（inherited）

## Context

本文書は agegr/pi-web v0.8.9 (SHA `2a6e537`, MIT) 由来の `lib/` 配下コードに埋まっていた散文コメントを、fork の IDD 化過程で decision として抽出したものである（Workspace DEC-002 の additive 拡張境界と、DEC-001 の完全固定派生方針に従う）。ここに列挙する DEC は「pi-web 上流で採用され、fork でもそのまま維持している設計判断」の目録であり、fork 側で新規に加えた判断ではない。fork 独自の判断は他の `_docs/intent/*/decision.md` に置く。

lib/idd/ 配下は既に IDD-native なので本文書の対象外。

## Decisions


### DEC-100: 拡張向けに no-op な PlainTextTheme を提供する

- **What**: pi の Extension は完全な `Theme` インスタンスを要求するため、装飾を全て素通しにする `PlainTextTheme` を用意し、Extension バインドや custom UI に渡す。
- **Why**: Pi Web の UI は独自の HTML/CSS でスタイリングしており、SDK 経由の ANSI 装飾を再解釈する必要がない。しかし SDK / Extension は Theme の存在自体を前提として構成されており、渡さないと Extension 側で null 参照や色計算のエラーになる。
- **Change freedom**: no-op メソッド群の返し方（getFgAnsi 等の空文字列返し）は自由。Theme を型として満たし、装飾を一切適用しないことだけが不変。
- **Anchors**: `lib/rpc-manager.ts:115-140`（PlainTextTheme 定義）

### DEC-101: prompt admission を直列化し preflight 承認まで ack しない

- **What**: `prompt` case は `acquirePromptAdmission` で 1 件ずつ通し、内部の `preflight` Promise が SDK 側 `preflightResult` callback で resolve されるまで await する。RPC 応答は preflight 承認までブロックし、承認前の失敗は POST 応答で throw、承認後の失敗のみ `prompt_error` event として非同期に流す。callback を呼ばない SDK 版のために、`prompt` Promise 解決時にも fallback で `acceptPreflight()` を叩く。
- **Why**: pi の RPC contract は「preflight（同期 validation + Extension 承認）を通ってから ack、以後の失敗は非同期 event」で成り立っている。ここが崩れると、上流側で「この prompt が run 開始したか queue に入ったか」の判別が付かなくなる。直列化を admission に限定することで、以降の run/queue 判定は SDK に atomic に委ねられる。
- **Change freedom**: `finishPrompt` の管理、`prompt_done` を steering/followUp で emit するかの分岐、event 名（`prompt_error` / `prompt_done`）は自由。「admission の直列化」「preflight 承認までは ack しない」「承認後の失敗のみ非同期 event」の 3 点だけが不変。
- **Why not**: prompt 全体を単一 promise で直列化 — 後続 prompt の queue 追加まで塞ぎ、SDK 側 streaming queue の意味が失われる。
- **Anchors**: `lib/rpc-manager.ts:336-344`（acquirePromptAdmission）、`lib/rpc-manager.ts:400-486`（prompt case 全体）

### DEC-102: bash-only session は生成直後に自力で JSONL を flush する

- **What**: `bash` case 完了後に `persistBashOnlySession` を呼び、session file が未存在なら header + 現在の entries を wx flag で書き出し、SessionManager 内部の `flushed` フラグを true に立てる。
- **Why**: pi の SessionManager は「最初の assistant message が入るまで JSONL への flush を遅延する」設計。bash-only の session は assistant message を持たないため、この遅延ロジックの下では session file が永遠に作られない。web UI 側の session listing は persisted 判定を file 存在で行っているため、bash 実行結果が history に載らなくなる。
- **Change freedom**: 書き出しの詳細（wx flag、cache 更新、内部 flag の書き方）は自由。「bash-only の session が session listing に載る状態を作る」という結果だけが不変。
- **Anchors**: `lib/rpc-manager.ts:359-377`（persistBashOnlySession）

### DEC-103: DeepSeek thinking compat では xhigh を state に強制的に戻す

- **What**: `set_thinking_level` case で `level === "xhigh"` かつ現在 model が DeepSeek thinking compat（`compat.thinkingFormat === "deepseek"`）の場合、`inner.setThinkingLevel` の後に `agent.state.thinkingLevel = "xhigh"` を上書きする。
- **Why**: pi の `setThinkingLevel` は `supportsXhigh() === false` の model に対して xhigh を high に clamp する。しかし DeepSeek 互換層の `reasoningEffortMap` は xhigh → max のマッピングを持っており、xhigh のまま state に残っていないと最上位 reasoning effort に到達できない。
- **Change freedom**: 判定条件の書き方は自由。「DeepSeek 互換モデルで xhigh を要求されたら state を xhigh に固定する」だけが不変。
- **Revisit when**: pi の `setThinkingLevel` が compat 層と協調して clamping を回避するようになった場合、この上書きは不要になる。
- **Anchors**: `lib/rpc-manager.ts:574-585`（set_thinking_level case）

### DEC-104: clearQueue は全消しのみ、単一 dequeue は提供しない

- **What**: `clear_queue` command は `inner.clearQueue()` にそのまま委譲する。個別 message の dequeue API は提供しない。
- **Why**: pi 側に単一 dequeue の公開 API がない。UI 側で「clear + 選択した分だけ再 enqueue」する迂回は、agent loop が message を pull し始めているタイミングと race する。
- **Change freedom**: 追加の log / 統計は自由。「単一 dequeue を提供しない」だけが不変。
- **Revisit when**: pi が単一 dequeue API を露出した場合、UI 側の queue 操作を段階的に置き換え可能になる。
- **Anchors**: `lib/rpc-manager.ts:619-624`（clear_queue case）

### DEC-105: reload 時は factory widget を破棄、array widget snapshot はクリアする

- **What**: `resetExtensionWidgetsForReload` は `activeExtensionWidgets`（factory 由来）を個別に clear し、`extensionWidgets`（array snapshot）は一括で clear する。以後、次回 Extension の `session_start` で snapshot が再取得される。
- **Why**: reload の意味論を pi 側の既存挙動と揃えるため。factory widget は component 生成ライフサイクルを持ち dispose まで含めた個別 clear が必要。array widget は snapshot なので破棄だけで済み、Extension 側の `session_start` が repopulate を担う。
- **Change freedom**: 内部 flag（`extensionWidgetsResetting`）の使い方や順序は自由。「factory は個別 dispose、array snapshot はまとめて破棄、以後 session_start に任せる」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:860-871`（resetExtensionWidgetsForReload）

### DEC-106: ensure_session 由来の transient session は history に露出させない

- **What**: `getRpcSessionInfos` で `!persisted && (!session.isRunning() || !firstUserMessage)` を満たす session を skip する。
- **Why**: `ensure_session` は composer が slash command 一覧をロードする間に空の runtime を確保するための呼び出しで、prompt 承認までは「idle かつ空」の session が存在する。これを session 一覧に出すと、ユーザが送信していない session が history に並び、混乱を招く（結局送信されず terminate される）。
- **Change freedom**: skip 判定に加える他条件は自由。「prompt 承認前かつ persisted でない session を history に出さない」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1429`（getRpcSessionInfos の skip 判定）

### DEC-107: session 一覧は persisted に限らず in-memory SessionManager からも構成する

- **What**: `getRpcSessionInfos` は registry を走査し、persisted session は SessionManager の header と entries から、まだ file に落ちていない session は in-memory の SessionManager から情報を構築して返す。
- **Why**: pi は最初の JSONL flush を assistant message 到達まで遅延させる。prompt を出したがまだ assistant message が返っていない時点では file が存在しないため、file 走査だけでは「今 accept された prompt を持つ session」が一覧に現れない。UI 側の一覧は「今動いている session」を即時に見せる必要があるため、in-memory から補う。
- **Change freedom**: `firstMessage` の抽出方式、`lastActivityMs` の集計、`transient` フラグの用途は自由。「in-memory session を一覧に出す」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1413-1455`（getRpcSessionInfos）

### DEC-108: running-status は globalThis の listener に SSE push で伝える

- **What**: running session id の集合を `globalThis.__piRunningListeners` に保持し、`notifyRunningChange` から listener を叩く。sidebar 等は SSE 経由でこれを購読する。
- **Why**: sidebar が定期 poll せずに済み、pi session の状態変化が即時に反映される。listener を `globalThis` に置くのは Next.js の hot-reload で module が再評価されても購読関係を保つため（module scope の Set だと reload 毎に空になる）。
- **Change freedom**: SSE の実装詳細、snapshot のシリアライズ方法（`JSON.stringify(sorted)`）は自由。「globalThis に listener を持ち push で通知する」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1482-1519`（getRunningListeners / subscribeRunningSessions / notifyRunningChange）

### DEC-109: subscriber が消えたら snapshot を空にリセットする

- **What**: `notifyRunningChange` は `listeners.size === 0` のとき `lastRunningSnapshot = ""` にリセットして早期 return する。
- **Why**: `lastRunningSnapshot` は「前回 push した状態」であり、subscriber が居ない間の状態変化は届いていない。次に subscriber が来たとき、その subscriber は初回 snapshot を別経路で受け取る想定なので、次回 `notifyRunningChange` の diff 判定が旧 subscriber 時代の stale snapshot と一致してしまうと初回以降の状態変化を落とすリスクがある。空リセットにより、次回は必ず push が発生する。
- **Change freedom**: 空文字列以外の sentinel は自由。「listener 消失時に diff 判定用の snapshot をリセットする」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1497-1508`（notifyRunningChange 内の early return）

### DEC-110: startRpcSession は新規 session の model 解決を construction 前に一度だけ行う

- **What**: 新規 session（`hasExistingMessages` が false）では、`resolveVisibleModels` → `selectInitialModelScope` を Agent session 構築前に呼び、initial model / thinking level / scopedModels を同じ settings snapshot から決める。既存 session はその scopedModels をそのまま渡す。
- **Why**: initial model, thinking pin, SDK の scopedModels が別々の settings スナップショットで決まると、直後に 3 者が矛盾する状態を作りうる（例: enabled models 変更中に model は revert 前、scopedModels は revert 後）。1 回の snapshot 読みで 3 点を一括決定することで race を排除する。
- **Change freedom**: `persistExplicitStartupPreferences` の呼び分け、cache invalidation の粒度は自由。「1 settings snapshot から initial state 3 点を決める」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1513-1600`（startRpcSession の起動シーケンス）

### DEC-111: session 起動時に SDK の global theme を初期化する

- **What**: `startRpcSession` の冒頭で `initTheme()` を呼ぶ。
- **Why**: 一部の Extension は terminal UI 外の code path でも SDK の global theme（module scope の singleton）を参照する。初期化を skip すると Extension 側で theme が undefined のまま cache されるコードに触れて落ちる。
- **Change freedom**: 呼び出し位置（agentDir 取得の前後）は自由。「session 起動シーケンスの中で initTheme を通す」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1540`（initTheme 呼び出し）

### DEC-112: tool の allow-list は空か未指定のみ、builtin だけの allow-list は禁止

- **What**: `toolNames === []` なら空 allow-list で全 tool を disable。それ以外は allow-list を渡さず（SDK に全 tool を register させ）、active tool のみを `withExtensionTools` で「builtin + extension tool」に narrow する。
- **Why**: 過去に allow-list へ builtin（`CODING_TOOL_NAMES`）だけを渡していた時期があり、その場合 SDK の `allowedToolNames` が builtin のみに絞られ、Extension/package 由来の tool（subagents、web access 等）が registry から消えて Pi Web だけで使えないという回帰が起きた。`pi` CLI との tool の対称性を保つには「allow-list を builtin だけの部分集合にしない」ことが必須。
- **Change freedom**: active tool の narrow ロジック（`withExtensionTools` の実装）は自由。「allow-list は空か未指定のみ」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1544-1548`（toolsOption 決定）、`lib/rpc-manager.ts:1609-1611`（active tool の narrow）

### DEC-113: services 構築を model 復元より前に、untrusted project の extension を gate する

- **What**: `createAgentSessionServices` を Agent session 構築より前に呼ぶ。その際 `projectTrustReloadOptions` を渡し、untrusted project の `.pi/extensions` を automatic load から外す。
- **Why**: Extension が provider を register してから SDK の model 復元が走らないと、session file に保存された provider/model が unresolved のまま initial state に入る。加えて untrusted repository を開いただけで `.pi/extensions` の JavaScript が走るのは重大なセキュリティ問題（`lib/project-trust.ts`、upstream issue #236 参照）で、trust 取得までは load を gate する必要がある。
- **Change freedom**: `resourceLoaderOptions` の追加 factory、cache 戦略は自由。「provider 登録が model 復元より前に済んでいる」「untrusted project の extension は自動 load されない」の 2 点だけが不変。
- **Anchors**: `lib/rpc-manager.ts:1550-1570`（services 構築）

### DEC-114: 全 tool 無効の session は system prompt を強制的に空にする

- **What**: `toolNames?.length === 0` の session に対して `wrapper.setForceEmptySystemPrompt(true)` を立て、以後 `applyForcedEmptySystemPrompt` が `state.systemPrompt` を空文字列に上書きする。reload / extension discovery 後にも維持する。
- **Why**: pi の `buildSystemPrompt` は tool が 0 個でも非空の system prompt を生成する。Pi Web は「tool 全 off の完全な chat モード」を提供したいため、この prompt をそのまま渡すと chat 用途に対して情報過多かつ矛盾したメッセージが混入する。reload や extension 再読み込みで prompt が復活しないよう force を維持する必要がある。
- **Change freedom**: 空にする timing、force フラグの持ち方は自由。「tool 0 の session では system prompt が空である」だけが不変。
- **Anchors**: `lib/rpc-manager.ts:317-321`（applyForcedEmptySystemPrompt）、`lib/rpc-manager.ts:1613-1617`（force フラグの初期化）

### DEC-125: worktree の project identity 解決（common-dir 親 + top-level 限定 collapse）

- **What**: `resolveProject(cwd)` は `git rev-parse --path-format=absolute --git-common-dir --git-dir --show-toplevel --abbrev-ref HEAD` を叩き、`--git-dir != --git-common-dir` かつ cwd が toplevel と一致するとき（isWorktreeTopLevel）だけ `dirname(commonDir)` を projectRoot として採用する。それ以外の worktree top-level は toplevel をそのまま projectRoot、subdirectory は cwd 自身を projectRoot として保持する。結果は `globalThis.__piProjectCache` に短 TTL でキャッシュし、`addWorktree` / `removeWorktree` で eager に invalidate する。`isTopLevel` フラグは worktree switcher を top-level 限定で出すために使う。
- **Why**: worktree の `--git-common-dir` は main repo の `.git` を指すため、その親を取れば全 worktree が同一 projectRoot を共有し、session をどの worktree で開いてもプロジェクト identity が保たれる。ただし collapse を worktree top-level に限る理由は、subdirectory を repo root にまとめると既存 user の session が別 project 扱いになり「session を作った場所」が UI 上で変わってしまうため。worktree switcher が top-level でのみ意味を持つのも同じ理由で、subdir から repo 全体の worktree を切り替える操作は既存 session の cwd を壊す。cache を globalThis に置くのは Next.js の hot-reload で cache が消えないようにするため。
- **Change freedom**: TTL 値、cache 実装（Map 以外可）、eager invalidate のトリガー追加。「common-dir 親を projectRoot にする」「collapse は worktree top-level のみ」「isTopLevel の意味は switcher の可否」だけが不変。
- **Anchors**: `lib/worktree.ts:10, 22, 41-46, 85-121`

### DEC-126: 本 repo が呼ぶ git は LC_ALL=C で locale を固定する

- **What**: `git()` helper で `execFileAsync` に `env: { ...process.env, LC_ALL: "C" }` を必ず渡し、本 repo から subprocess として起動する git はすべて英語 locale で動かす。
- **Why**: DELETE route などで stderr の文字列を pattern-match して「dirty worktree」などの状態を検出する経路があり、system 言語が変わると git のエラーメッセージが翻訳されて matching が破綻する。「本 repo が call するすべての git 呼び出しで、エラー文字列は英語で返る」ことを invariant として固定すれば、message 比較のロジックが system locale に依存しなくなる。
- **Change freedom**: 呼び出し方式（execFile → spawn 等）、他の env 変数追加。「LC_ALL=C 相当の英語 locale 固定」だけが不変。
- **Anchors**: `lib/worktree.ts:52-61`

### DEC-127: 消失した worktree の session は main repo に集約する

- **What**: cwd が存在しない session について、cwd が `<repoRoot>-worktrees/<dir>` パターン（`addWorktree()` の配置規約）に一致し `repoRoot/.git` が実在する場合、projectRoot を realpath 化した `repoRoot`、branch を `basename(cwd)`（sanitized branch 名）、`isWorktree=true, isTopLevel=true` として ProjectInfo を推論する。推論不能なら `{ projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false }` を返す。
- **Why**: worktree を removeしたあと、その worktree に紐付いていた session をどの project にも属さない phantom として残すと UI 上で dangling 表示が増える。main repo 側に付け替えれば継続閲覧可能で、branch 表示も sanitized branch 名から近似できる（display 用途としては十分）。
- **Change freedom**: 推論できないケースの fallback 内容、branch 表示の正確さ（sanitize による情報損失は許容）、パターン検出の実装。「消失 worktree の session を main repo に集約する」だけが不変。
- **Anchors**: `lib/worktree.ts:71-77`

### DEC-128: git 出力の path 行のみ toNativePath、branch 名など非 path は保つ／cwd も realpath で比較を揃える

- **What**: `git rev-parse` の複数行出力を扱うとき、path である行（`--git-common-dir` `--git-dir` `--show-toplevel`）だけ `toNativePath` で native separator に揃え、branch 名の行（`--abbrev-ref HEAD` の `ref`）は変換せず forward slash を保つ。あわせて cwd 側は `realpathSync` で symlink 解決してから git 出力（既に resolved）と比較する。`toNativePath` の適用対象は「path であること」を呼び出し側が判断し、branch 名など非 path 文字列には渡さない。test でも Windows 上での POSIX → native 変換を regression として押さえる。
- **Why**: git は Windows でも POSIX 形式（`D:/repo`）で path を出すため、fs/path API や Node の cwd と比較するには native separator に揃える必要がある。しかし branch 名にも `/`（`feature/foo`）が含まれるため同じ変換をかけると `feature\foo` に化けて別 branch を指してしまう。cwd 側の realpath 正規化は、git が既に symlink を解決した path を返すため、比較の左右で resolve 状態を揃えないと真に同じ path が false になるから。
- **Change freedom**: 変換関数の内部実装、対象 flag の増減、cwd 正規化の別実装。「path のみ toNativePath」「branch 名など非 path 文字列に toNativePath を適用しない」「cwd を realpath 経由で比較」の 3 点だけが不変。
- **Anchors**: `lib/worktree.ts:97-110`, `lib/paths.ts:24-31`, `lib/paths.test.mjs:11-16`

### DEC-129: listWorktrees は prunable と消失 path を UI 候補から除外する

- **What**: `git worktree list --porcelain` の結果から、`prunable` フラグ付きの entry と、path が `existsSync` で false になる entry を除外して返す。除外された worktree は `WorktreeInfo[]` に載らないので、UI のリストや switcher の候補にも上がらない。
- **Why**: prunable な worktree は gitdir が壊れている状態で、UI 上で選択しても意味のある操作（browse / switch / remove）ができない。ディスク上から消えた path も、git が pruning 前で `prunable` を出していないタイミングがあるため二重にチェックする。UI 側で選択できる worktree だけを見せる方が誤操作を避けられる。
- **Change freedom**: 除外基準の追加（例: 権限なし path）、`existsSync` の非同期化。「prunable と消失 path は listing から除外」だけが不変。
- **Anchors**: `lib/worktree.ts:148-160`

### DEC-130: path の canonical form は native / slash の 2 系統を明示的に使い分ける

- **What**: `lib/paths.ts` は `toNativePath()`（native separator, `D:\repo`）と `toSlashPath()`（forward slash, `D:/repo`）の 2 form を提供する。fs/path API に渡す path・session cwd との比較・user 表示は native、`allowed-roots` の内部 key と separator-insensitive な text matching は slash を使う。path の同一性判定は `samePath()` / `isPathWithinRoots()` に集約し、生の `===` は使わない。`samePath` は separator style を吸収し、Windows では drive letter を含めて case-fold する。
- **Why**: git は Windows でも POSIX 形式で path を出すため native と slash が混在する。両 form を独立に扱わず単一 form に統一すると、片側で失敗する（native only なら git 出力と比較不能、slash only なら fs API に渡せない）。「表示・fs 系は native、内部 key は slash」を明示すれば、どちらのミスも起きない。Windows の case-insensitive は生の `===` で比較すると同一 path が別扱いされる隠れバグの源になるため、比較ロジック側で吸収する。
- **Change freedom**: 内部 helper の実装、追加 form の導入（既存 2 form を残す限り）、case-fold 判定の実装。「native/slash の 2 form を明示的に区別」「比較は samePath 系に集約」「Windows は separator + case を吸収」だけが不変。
- **Anchors**: `lib/paths.ts:1-55`, `lib/paths.test.mjs:24-44`

### DEC-131: isPathWithinRoots は両側の canonical form を許容し、消失 root は無視する

- **What**: `isPathWithinRoots(target, roots)` は target と root の canonical form（native / slash）を問わず受け付け、内部で `path.win32` / `path.posix` を選び直して `resolve` してから比較する。Windows path が絡む場合は case-fold する。`isExistingPathWithinRoots` はさらに `realpathSync` を通し、`roots` の中で realpath 解決に失敗した entry は例外を握りつぶして containment 判定から除外する。
- **Why**: allowed-roots 集合は session / worktree など複数箇所からの書き込みで form が揃わないことがあり、片側 form 前提だと真に含まれる path も false になり得る。Windows での case-fold も同様に含まれる path を誤って除外する経路になる。消失 root については、session や worktree の削除で残された stale entry を毎回例外で潰されるより「無視して残りの root で判定を続ける」方が UX を壊さない。
- **Change freedom**: `path.win32/posix` の分岐条件、case-fold の対象、`realpathSync` の代替実装。「両 form を許容」「stale root は無視」だけが不変。
- **Anchors**: `lib/path-security.ts:5-42`

### DEC-132: allowed-roots は globalThis に slash-normalized で保持する

- **What**: `__piAdditionalAllowedRoots`（追加 root の in-memory 集合）と `__piAllowedRootsCache`（persisted session 由来の root cache）は `globalThis` に置き、`Set<string>` に格納する root はすべて `toSlashPath` で slash-normalized 形に揃える。`allowFileRoot()` も slash 形で追加する。
- **Why**: Next.js の dev 環境で hot-reload が走ると module scope の変数が消えるため、`addWorktree` 直後に追加した root が失われて worker が browse 不能になる経路が生まれる。`globalThis` に固定すれば hot-reload をまたいで生き残る。Set membership は「同一 path を同一 key で引く」ことが要件で、native/slash が混在すると同じ path が別 key として二重登録される。correctness そのものは `isPathWithinRoots` の再正規化に依存する（DEC-131）ため、slash 形は key の一貫性のためだけの選択で、containment の正しさとは独立。
- **Change freedom**: cache TTL、追加 map の分割、slash 以外の canonical 選定（key として一意なら可）。「globalThis 保持」「Set key は単一 canonical form に揃える」だけが不変。
- **Anchors**: `lib/allowed-roots.ts:1-31`

### DEC-150: セッション一覧の結果キャッシュ

- **What**: `listAllSessions()` は `SESSION_LIST_CACHE_TTL_MS` (30 秒) 以内であれば `globalThis.__piSessionListCache` に格納された結果を返し、`loadAllSessions()` を再走行させない。
- **Why**: ページ遷移や再描画のたびに JSONL 全走査と worktree 解決のための子プロセス起動が走ると、体感応答が悪化し upstream の pi 側にも負荷が波及する。TTL 内はキャッシュヒットに落とすことで通常操作の連続には静的な応答時間で応える。
- **Change freedom**: TTL の値、キャッシュ実装 (Map / WeakRef 等) は自由。「TTL 内はスキャンを再実行しない」だけが不変。
- **Anchors**: `lib/session-reader.ts:71-107` (`listAllSessions` の冒頭 TTL ガード)

### DEC-151: セッション一覧走査の coalescing と世代管理

- **What**: `listAllSessions()` は in-flight promise を `globalThis.__piSessionListPromise` に保持し、同じ generation (`__piSessionListGeneration`) のあいだは並行呼び出しをその promise に相乗りさせる。走査完了時に generation が進んでいた場合、その結果を返さずに `listAllSessions()` を再帰的に呼んで現世代の走査へ合流する。
- **Why**: (1) 連続する並行呼び出しごとに全走査を起動しない、(2) 走査中に `invalidateSessionListCache()` が呼ばれたケースを "successful refresh" と区別する。stale 結果を返してしまうと、UI 上は refresh 済みに見えて実データが古いままの race が起きる。
- **Change freedom**: 世代番号の実装、promise の管理場所は自由。「無効化後の caller に stale を返さない」だけが不変。
- **Anchors**: `lib/session-reader.ts:71-107` (coalescing + generation guard)

### DEC-152: `mergeSessionLists` は disk 側を authoritative とする

- **What**: `mergeSessionLists()` は最初に supplemental (in-memory registry) から Map を作り、その上に persisted (disk 走査結果) を上書きする。同じ id が両方に存在すれば disk 側の SessionInfo が最終値になる。
- **Why**: transient なメモリ registry snapshot と disk 上の JSONL が両方に hit している間、素朴に concat すると同一セッションが 2 行描画される瞬間が生まれる。JSONL が生成された時点で disk 側が正で、registry snapshot は無効になる。
- **Change freedom**: 収集順、Map の使い方は自由。「両方 hit したら disk 側が勝つ」だけが不変。
- **Anchors**: `lib/session-reader.ts:37-46`

### DEC-153: セッション周辺キャッシュを `globalThis` に置く

- **What**: `__piSessionPathCache`, `__piPathToSessionIdCache`, `__piSessionListCache`, `__piSessionListPromise` などのモジュール横断キャッシュは module scope の `const` ではなく `globalThis` にぶら下げる。
- **Why**: Next.js の dev サーバは HMR / hot-reload でモジュールを再評価するため、module scope の Map はリロードのたびに空になる。globalThis に置けば evaluated module インスタンスが差し替わっても値が生き残り、開発体験と一貫性が保たれる。
- **Change freedom**: キー命名やライフサイクル管理は自由。「HMR をまたいで残る単一インスタンスにする」だけが不変。
- **Anchors**: `lib/session-reader.ts:105-135`

### DEC-154: `buildSessionContext` は messages と entryIds を並列生成する

- **What**: `buildSessionContext()` は `piBuildContextEntries` が返す SDK 選択済み entry 列を単一 loop で走査し、UI message (`AgentMessage`) と対応する session entry id を同じ添字順に `messages[]` / `entryIds[]` へ追加する。
- **Why**: UI から fork / navigation で「この message の元 entry」に戻る必要があり、context 変換と id 収集を別 loop で行うと pi 側の compaction 順序変更に追従できず添字がずれる。並列生成なら pi の compaction ordering をそのまま持ち回れる。
- **Change freedom**: entry の filter / transform 実装は自由。「messages と entryIds を同一 loop で成長させ index 対応を維持する」だけが不変。
- **Anchors**: `lib/session-reader.ts:229-265` (`buildSessionContext` 内の変換ループ)

### DEC-155: `entryToUiMessage` の deferThinking ガードは assistant 限定

- **What**: `entryToUiMessage()` は `deferThinking` オプションが立っていても `message.role === "assistant"` の場合のみ `thinking` ブロックを空文字＋`deferred:true` に置き換える。user / toolResult / bashExecution / custom は素通し。
- **Why**: `bashExecution` は `case "message"` ブランチで assistant と同じ経路に入るが、user 発行の bash 出力は defer 対象ではない。「assistant 以外は defer しない」を早期 return で明示し、加えて `normalizeToolCalls` が非 assistant を no-op として二重ガードにする。
- **Change freedom**: defer 対象ブロックの種類は自由。「非 assistant を不用意に defer しない」だけが不変。
- **Anchors**: `lib/session-reader.ts:315-340` (`entryToUiMessage` 内 switch 冒頭)

### DEC-156: セッションタイトル生成用 Agent は shadow tools を持つ

- **What**: `buildSessionTitleAgentOptions()` は source Agent の tool 一覧を `createShadowTools()` に通し、名前・説明・schema を保ったまま `execute` を「Tools cannot be executed while generating a session title」を投げるだけの関数に差し替える。
- **Why**: タイトル生成 run は provider prompt cache prefix を source と揃えるために tool 定義を提示するが、命名 run が誤って FS / shell / network に副作用を起こすと元セッションの状態を壊しかねない。tool 名を消すと provider 側の cache key が変わり cache miss が広がるため、名前は保って execute だけ塞ぐ。
- **Change freedom**: 例外文言、tool の hide/expose 方針は自由。「命名 run で副作用を起こさせない」だけが不変。
- **Anchors**: `lib/session-title.ts:32-70`

### DEC-157: タイトル要求は末尾 user message に畳み込む

- **What**: `appendTitleRequestToTrailingUser()` は sanitize 済み messages の末尾が user である場合、その user message の末尾に `TITLE_PROMPT` を連結した新しい message で置き換える。末尾が user でなければ何もしない。
- **Why**: source session が「今答えようとしている user message」で終わっているケースがあり、そこに新たに user message として TITLE_PROMPT を積むと provider に user が 2 連続で並ぶ (許容しない provider がある / 動作が壊れる)。畳み込むことで会話履歴の並びを保ったまま指示を追加できる。
- **Change freedom**: 連結の書式、TITLE_PROMPT の内容は自由。「user 2 連続を作らない」だけが不変。
- **Anchors**: `lib/session-title.ts:75-88`

### DEC-158: `computeSessionTotalActiveMs` は user/bashExecution を境界扱いにする

- **What**: `computeSessionTotalActiveMs()` は timing 対象 entry (`message`, `compaction`, `branch_summary`, `custom_message`) の隣接タイムスタンプ差分を累積するが、user message と bashExecution role の message に到達したら差分を加算せず、`previousTimestamp` を現時刻に置き直す。
- **Why**: user message の直前ギャップは人間の入力待ち時間で active work ではない。bashExecution は完了時刻しかログに載らないため、直前ギャップに任意の人間 idle が混入しうる。この 2 種を境界としないと "active time" の意味が壊れる。
- **Change freedom**: 対象 entry type 集合、差分の丸め方は自由。「user と bashExecution の直前ギャップを加算しない」だけが不変。
- **Anchors**: `lib/session-timing.ts:15-38`

### DEC-159: `lib/types.ts` は pi-mono session-manager 型のミラー、UI 拡張は additive

- **What**: `lib/types.ts` は upstream `@earendil-works/pi-coding-agent` (pi-mono) の session-manager 型を手動でミラーし、UI 側で必要な拡張フィールドは既存 interface に「optional なフィールドを足す」形だけに留める。既存フィールドの型変更や必須化はしない。
- **Why**: pi-web は upstream 追従なし fork (workspace DEC-001) だが、pi-mono 側は独立に更新される可能性があり、UI 側のミラー型が upstream 意味論から乖離しないように加算のみに制限する。additive なら pi-mono 側の型微修正に対しても UI 追加分を独立に維持できる。
- **Change freedom**: 追加フィールドの命名は自由。「既存 pi-mono 由来 field の型を変えない / 削らない」だけが不変。
- **Anchors**: `lib/types.ts:1-329`, `lib/pi-types.ts`

### DEC-160: `ThinkingContent.deferred` — 初回ペイロード省略フラグ

- **What**: `ThinkingContent` に UI 独自の optional flag `deferred?: boolean` を持ち、初回 UI 応答から `thinking` 本文を落とした場合に `true` を立てる。
- **Why**: SSR / 初回応答で長大な thinking を全て流すとペイロードが跳ねる。空文字化した blob に marker を残しておけば、client 側は "後で fetch すべき" と "元から空" を区別でき、on-demand 再取得の対象を確定できる。
- **Change freedom**: 遅延取得 API の形状は自由。「初回省略と本当に空とを区別できる marker を持つ」だけが不変。
- **Anchors**: `lib/types.ts:34-39`

### DEC-161: `ToolCallContent.rawInput` — client-only streaming バッファ

- **What**: `ToolCallContent` に `rawInput?: string` を追加し、streaming で断片的に届く tool 引数を組み立てる client 側バッファとして使う。session JSONL には書き出さない。
- **Why**: pi-mono 側の JSONL には確定した `input` オブジェクトのみが記録される。streaming 中に partial JSON を UI に見せるためのバッファを同じ interface に相乗りさせつつ、永続化経路に漏れないよう「client-only」の契約で扱う。
- **Change freedom**: バッファ形式や flush タイミングは自由。「JSONL には永続化しない」だけが不変。
- **Anchors**: `lib/types.ts:41-48`

### DEC-162: `SessionInfo` の project 系フィールド

- **What**: `SessionInfo` は `projectRoot?: string` (worktree 共通の repo root、非 git dir は cwd 自身) と `projectKey?: string` (Windows 大文字小文字/セパレータ非依存の internal 識別子) を持つ。両方 optional だが `projectRoot` は server 応答では常時セットされる。表示・FS 操作には `projectRoot` / `cwd` を使い、`projectKey` は grouping/比較専用の internal 値。
- **Why**: 複数の worktree を同じ project としてまとめたい (`projectRoot`) 目的と、Windows で path 表記ゆらぎを吸収して確実に一致比較したい (`projectKey`) 目的は別軸。両方を optional にしているのは、client が最初の server refresh より前に transient な SessionInfo を組み立てるため。client は `projectRoot ?? cwd` に fallback する。
- **Change freedom**: 識別子の正規化アルゴリズムは自由。「表示は projectRoot/cwd、比較は projectKey」を混同しない不変。
- **Anchors**: `lib/types.ts:298-317`

### DEC-163: `SessionInfo.transient` — memory-only runtime session の marker

- **What**: `SessionInfo.transient?: boolean` が true の間は「runtime session はメモリに存在するが、対応する JSONL がまだディスクに無い」状態を示す。false / undefined になったら disk-backed 操作 (rename, delete, replay 等) が安全に実行できる。
- **Why**: UI 側で「作ったばかりのセッション」でも即座に一覧表示したいが、その時点で disk 前提の操作を叩くと ENOENT で失敗する。marker で「ディスク待ち」を明示すれば、UI は表示だけ許可し破壊的操作を抑止できる。
- **Change freedom**: transient から persistent への遷移を通知する方式は自由。「transient=true の間は disk 依存操作を待つ」だけが不変。
- **Anchors**: `lib/types.ts:318-321`

### DEC-164: `SessionContext.entryIds` は `messages` と並列添字

- **What**: `SessionContext` は `messages: AgentMessage[]` と同じ長さ・同じ添字順で `entryIds: string[]` を持つ。`messages[i]` の由来 session entry は必ず `entryIds[i]` で取れる。
- **Why**: UI から fork / navigation / label を張るには「その message の元 entry id」が必要。並列配列にしておけば message 数の差分検知・仮想化と両立でき、id 探索のために message 側に埋め込む必要もない (session JSONL に流出させたくない client-only 情報を混ぜずに済む)。
- **Change freedom**: 実装コンテナは自由。「messages と entryIds を index-parallel に維持する」だけが不変。
- **Anchors**: `lib/types.ts:322-328` (`SessionContext`)

### DEC-175: provider 一覧は auth 宣言から派生させる

- **What**: Models パネルに出す provider 一覧は、hardcode した id list ではなく `provider.auth.apiKey` / `provider.auth.oauth` の宣言から動的に決める。API-key list と OAuth list の両方に登場しうる provider（Anthropic, GitHub Copilot, kimi-coding, openrouter, radius, xai 等の dual-auth 系）はそれぞれの list に併記する。
- **Why**: 過去に「Anthropic を OAuth-only と id で決め打ち」した結果、API-key で構成された Anthropic が API-key 側からも OAuth 側からも表示されない不具合（#309）が発生した。dual-auth かどうかは pi-ai SDK の provider 定義の性質であり release ごとに変わるため、id では追随できない。auth 宣言を source of truth にする。
- **Change freedom**: 表示順、display name の付け方、list 分割方針は自由。「id 直書きで dual-auth 判定しない」だけが不変。
- **Anchors**: `lib/provider-listing.ts:1`

### DEC-176: API-key list は models.json 由来と OAuth 認証中 provider を外す

- **What**: `buildApiKeyProviderList` は `status.source` が `models_json_key` / `models_json_command` の provider を list から除外し、`credentialType === "oauth"` の provider は `configured = false` として扱う。
- **Why**: (a) `models.json` 由来の custom provider は Models パネルが `models.json` 自身から別レンダリングするため、API-key list に出すと重複表示になる。(b) 現在 OAuth で認証されている provider を API-key list でも「configured」と表示すると、OAuth list とあわせて 2 度 configured 扱いになり cross-list で重複する。1 provider = 1 configured entry を守るため、API-key 側では OAuth 認証中を non-configured に落として OAuth list 側だけで configured 表示する。
- **Change freedom**: 除外の実装位置、custom source の集合、per-list の rendering 詳細は自由。「1 provider が両 list で configured 扱いにならない」「custom `models.json` provider を API-key list に出さない」の 2 点だけが不変。
- **Anchors**: `lib/provider-listing.ts:51`

### DEC-177: auth.json 破損時でも provider list を空にしない

- **What**: `collectProviderListingInputs` は `modelRuntime.listCredentials()` が throw した場合に catch して credential 情報だけ空 map にフォールバックし、provider 自体の列挙は継続する。
- **Why**: `auth.json` が壊れていたり lock 競合で読めなかったりしたとき、credential type がわからないことは許容できる（per-provider の `getProviderAuthStatus` から状態は取れる）が、provider list そのものが空になると UI 側は「provider が 1 つも存在しない」と誤解する。credential 取得の失敗を全体失敗に伝播させない。
- **Change freedom**: エラー時の warning 出力方法、リトライ有無、部分復旧の粒度は自由。「listCredentials の失敗を provider 列挙の失敗に昇格させない」だけが不変。
- **Anchors**: `lib/provider-listing-runtime.ts:17`

### DEC-178: auth.json の並行更新は proper-lockfile で pi と直列化する

- **What**: `updateStoredCredentials` は pi の `AuthStorage` と同じ proper-lockfile lock を `auth.json` に対して取る。`removeStoredCredentialIfType` は「読む → 型比較 → 削除」を同じ lock 内で完結させる。lock が compromised された場合、その error は release 失敗より優先して throw する（release 側の catch は握り潰す）。
- **Why**: pi 側の login と web UI 側の削除が別プロセスで走ると、type 比較後に別の login が上書きし、UI の stale な削除リクエストが新しい credential を消してしまう TOCTOU レースが起こる。同一 lock で直列化することでこれを封じる。compromised-lock error のほうが原因診断に直結するので、後段の release error に取って代わられないよう優先する。
- **Change freedom**: retry 設定、stale timeout、compromised 時の再取得ポリシーは自由。「同一 lock で type 比較と write を包む」「compromised error を release error より優先」の 2 点だけが不変。
- **Anchors**: `lib/provider-credential-store.ts:70`, `lib/provider-credential-store.ts:86`

### DEC-179: enabledModels の解決は pi 側 resolver に委譲する

- **What**: `enabledModels` の pattern 解決（minimatch glob、fuzzy match、`:thinkingLevel` サフィックス）は自前実装せず、`resolveModelScopeWithDiagnostics` に丸投げする。web 側は結果の scope を UI 表示用に整形するだけ。
- **Why**: 独自実装で exact-string 比較にした結果、`my-gateway/*` のような glob が silently にすべての model を落とす不具合（#307）が発生した。pi 本体側の `--models` フラグと同じ syntax を保証する唯一の方法は pi 側 resolver に委譲することであり、web 側で pattern semantics を持たない。
- **Change freedom**: pi 側 resolver の呼び出し方（snapshot 化、cache 前処理）、diagnostics の受け渡し方、UI の warning 表示は自由。「pattern semantics を web 側で再実装しない」だけが不変。
- **Anchors**: `lib/model-scope.ts:19`

### DEC-180: enabledModels が空 / 未マッチなら available 全体にフォールバック

- **What**: `resolveVisibleModels` は (a) pattern 未設定、(b) 解決結果が 0 件、のどちらでも `modelRuntime.getAvailable()` の全体を返す。fallback 経路でも `warnings` は保持する。
- **Why**: 設定が typo だったり stale だったりしたとき、UI から選択肢が消えると「そもそも model を選ぶ手段がない」状態になり、self-recovery できない。全 model にフォールバックすれば警告を出しつつユーザは選択して復旧できる。
- **Change freedom**: fallback を UI 側で目立たせる警告表現、fallback 発生時の追加テレメトリは自由。「empty scope で UI を model なしにしない」だけが不変。
- **Anchors**: `lib/model-scope.ts:88`

### DEC-181: `:level` サフィックスの thinking pin は matched 全 model について報告する

- **What**: `anthropic/*:high` のような glob + `:level` pattern がマッチしたとき、`thinkingLevelPins` は glob が拾った全 model の `provider/id` に対して pin を書き込む。session が実際にどの model で始まっても、client が pre-select した model の pin を引ける状態を作る。
- **Why**: pi 本体は session 開始時に選ばれた 1 model の pin だけを適用するが、web UI は起動前の pre-select 段階で pin を知りたい（表示・確認のため）。scope 側で glob が展開された時点で全部の pin を保持しておかないと、pre-select 時点で lookup が失敗する。
- **Change freedom**: pin の保持形式（flat map, per-provider map 等）は自由。「glob が matched した全 model の pin が引ける」だけが不変。
- **Anchors**: `lib/model-scope.ts:119`

### DEC-182: AgentSession の初期 model 選択順は pi の起動則に一致させる

- **What**: `selectInitialModelScope` は (1) 明示 `requestedModel` を最優先、(2) なければ scope 内の保存 `defaultModel`、(3) それでもなければ resolver 順の先頭、の順で model を確定する。呼び出し側が明示 thinking level を渡さなければ scoped-model の pin を適用する。
- **Why**: pi の CLI 起動則と web 側で選択順が食い違うと、同じ設定でも起動 model が変わり得て挙動が非一貫になる。pi 側の rule と一致させることで「pi CLI で起動したときと web で起動したときで同じ session になる」を保証する。
- **Change freedom**: 実装のヘルパー分割、`matchesModel` の判定粒度は自由。「requested → 保存 default → resolver 先頭」の優先順と、「明示 thinking level が pin より優先」の 2 点だけが不変。
- **Anchors**: `lib/model-scope.ts:134`

### DEC-183: model load 失敗の UI 文言は path / provider を含めない

- **What**: `withSafeModelLoadFailure` が返す `modelError` は固定文言（"Model list is temporarily unavailable. Check your configuration and try again."）。catch した SDK error を interpolate しない。
- **Why**: SDK の error message には `~/.pi/...` 等の絶対 path や provider の内部識別子が入りうる。UI にそのまま出すと環境情報が漏れる。ユーザに見せる文言と、log に残す debug 情報を分離する境界がこの関数。
- **Change freedom**: 文言の言い回し、i18n 化、追加 CTA は自由。「catch した error を message に interpolate しない」だけが不変。
- **Anchors**: `lib/models-cache.ts:24`

### DEC-184: models.json の cost group は部分入力を 0 埋め、空なら削除

- **What**: `normalizeModelsConfigCosts` は `input`/`output`/`cacheRead`/`cacheWrite` のどれか 1 つでも定義されている cost group について、未定義キーを 0 で埋めて完成させる。1 つも定義されていない cost group は entry ごと削除する。
- **Why**: 下流の cost 計算 (`ModelCatalogPreset` 系) は「値が undefined」と「値が 0」で挙動が分岐する。store 境界で 0 埋めを済ませてしまえば下流に条件分岐を持ち込まずに済む。空 group は削除することで「意味のない `cost: {}` を JSON に残さない」を保つ。
- **Change freedom**: 埋め値（現状 0）、対象キーの拡張、削除条件の粒度は自由。「store 境界で cost group の shape を正規化する（未定義キーが残らない or group ごと消える）」だけが不変。
- **Anchors**: `lib/models-config-store.ts:27`

### DEC-200: allowed-roots 集合を短TTL キャッシュで共有する

- **What**: `getAllowedFileRoots()` は 5 秒 TTL のプロセス内キャッシュ (`globalThis.__piAllowedRootsCache`) を通して allowed-roots 集合を返す。ミス時のみ session の再スキャンを走らせる。
- **Why**: 各 file list / file read リクエストで allowed-roots を組み直すと、pi の全 session を毎回 disk から scan することになりコストが線形に膨らむ。5 秒 TTL であれば新規 cwd の反映は十分速く、Next.js の HMR で module が再読み込みされてもキャッシュを跨げるように `globalThis` に置く。
- **Change freedom**: TTL の値、キャッシュ格納先の名称、無効化トリガの追加は自由。「file access 経路で allowed-roots が rebuild せず共有される」だけが不変。
- **Anchors**: `lib/file-access.ts:10, 15-20`

### DEC-201: allowed roots は session cwd に加え projectRoot と pi-cwd-* を含める

- **What**: allowed-roots 集合には session の `cwd` だけでなく `projectRoot` と `~/pi-cwd-\d{8}` パターンのディレクトリを追加し、`getAdditionalAllowedRoots()` の返り値もマージする。home 読み取り失敗は握り潰す。
- **Why**: 同一 project の worktree だけに session が集中している場合でも、project dropdown から root を辿れる状態を保つ必要がある。`pi-cwd-<date>` は default-cwd endpoint が実行時に生成するため、session に紐付かなくても browse できる必要がある。home が読めない環境で allowed-roots 全体の構築を落とすと、file access UI がまるごと機能を失う。
- **Change freedom**: root 追加の順序、pi-cwd- パターン、`getAdditionalAllowedRoots` の実装は自由。「session cwd 単独に閉じず、projectRoot と pi-cwd-* を含める」ことと「home 読み取り失敗で全体を落とさない」の 2 点だけが不変。
- **Anchors**: `lib/file-access.ts:26, 30, 38`

### DEC-202: 許可判定は lexical と existing の 2 経路を並置する

- **What**: `isFilePathAllowed` は filesystem に触れない lexical 判定、`isExistingFilePathAllowed` は symbolic link 解決後の実在 path 判定として、それぞれ export する。呼び手が用途に応じて使い分ける。
- **Why**: lexical 判定は fast path として path 文字列だけで済ませたい場面 (list 中の候補フィルタ等) に必要で、existing 判定は 実際に開こうとしている path が symlink 経由で allowed root を抜け出す攻撃を弾く必要がある。1 関数に統合すると呼び手が「fs stat が走るのか走らないのか」を判別できない。
- **Change freedom**: 内部実装、underlying util の場所は自由。「2 経路が独立に export されていて呼び手が選べる」だけが不変。
- **Anchors**: `lib/file-access.ts:47, 52`

### DEC-203: file-access test は jiti を通して被試験モジュールをロードする

- **What**: `lib/file-access.test.mjs` は被試験モジュールを直接 dynamic import せず、`jiti` の runtime resolver を経由して読み込む。
- **Why**: アプリ本体は `tsconfig` の `moduleResolution: "bundler"` に基づき extensionless import (`import x from "./foo"`) を解決する。素の Node.js は同じ解決ルールを持たないため、被試験モジュールが `import`ed する他ファイルを見つけられずテストが実行できない。jiti を挟むことで本番と同じ解決経路を再現する。
- **Change freedom**: jiti の起動方法、キャッシュ設定は自由。「テストとアプリの module 解決ルールを一致させる」だけが不変。
- **Anchors**: `lib/file-access.test.mjs:7`

### DEC-204: chat input の @ file autocomplete は pi TUI の挙動を鏡写しにする

- **What**: `lib/file-fuzzy.ts` の helper 群は pi TUI 側の @ file autocomplete を仕様の SSOT として扱い、trigger 条件・scoreEntry ladder・completion 挿入形をすべて TUI と一致させる。
- **Why**: 同じ pi を web と TUI 両方から触るユーザーが、@ で参照するファイルの選び方が UI ごとにズレると学習コストが二重になる。挙動を TUI 側に合わせておくことで、pi TUI 使用中の筋肉記憶がそのまま web 側でも通用する。
- **Change freedom**: 個別の内部関数分割は自由。「TUI の挙動と乖離しない」ことだけが不変。
- **Anchors**: `lib/file-fuzzy.ts:1`

### DEC-205: @ token 検出は行頭 or whitespace 直後に限定し、quoted form を許容する

- **What**: `extractAtQuery` は @ が「テキスト先頭」または「whitespace の直後」にある場合のみ token として認識し、加えて `@"..."` の quoted form を許容する。
- **Why**: この制限がないと `foo@bar` のようなメールアドレスが誤って autocomplete trigger になり、キー入力の度に候補が浮上して邪魔になる。quoted form を残すのは、space を含むディレクトリ名を drill-down する経路 (`@"my dir/fi` のような未完成入力) を成立させるため。
- **Change freedom**: 正規表現の書き方は自由。「行頭 or whitespace 直後の制約」と「quoted form の drill-down 対応」が不変。
- **Anchors**: `lib/file-fuzzy.ts:14`

### DEC-206: file list から directory entry を派生し shallow-first を既定順にする

- **What**: `buildEntriesFromFiles` は server の flat file list からディレクトリを派生させ、`{ pathDepth, alphabetical }` の順で sort した配列を返す。この順が empty `@` query の初期表示順になる。
- **Why**: index API は file のみ返す設計のため、directory を明示的に derive しないと候補に現れない。empty query の初期表示は「浅い階層から見せる」のが最も直感的で、pi TUI とも一致する。
- **Change freedom**: sort key の細部、directory 集合の作り方は自由。「file list から dir を導き、shallow-first で既定順にする」だけが不変。
- **Anchors**: `lib/file-fuzzy.ts:44`

### DEC-207: scoreEntry は TUI ladder + subsequence fallback + "/" 入り query の drill-down 対応

- **What**: `scoreEntry` は TUI 側の scoreEntry ladder (exact 100 / prefix 80 / substring 50 / path-substring 30、directory は +10) を踏襲し、加えて subsequence fallback (score 10) を持つ。query に `/` が含まれる場合は basename ではなく relative path 全体を判定対象にする。
- **Why**: 単純な substring では `chinp` から `components/ChatInput.tsx` を辿れない。低スコアの subsequence を末尾に置くことで、typo 気味の入力でも hit を残す。`/` を含む query に対する full path 判定は drill-down フローの核で、`@src/` 挿入後に query が `src/` になった時、`src` 単独を除外しつつ `src/*` を残す挙動を成立させる。
- **Change freedom**: 追加のスコア軸、tie-breaker、ladder の点数は自由。「exact/prefix/substring の順序性」「subsequence を最下位に置く」「/ 入り query は relative path を対象にする」の 3 点が不変。
- **Anchors**: `lib/file-fuzzy.ts:71`

### DEC-208: @ 候補の挿入形は file / directory / one-shot で切り替える

- **What**: 候補確定時の text 挿入は用途で 3 系統に分ける。`buildAtInsertText` は file を `@path ` で closed、directory を `@dir/` で open (menu 継続) にし、quoted directory は `@"my dir/"` で closed 挿入・caret を quote の直前に置く。`buildAtMentionText` は one-shot 用として directory も trailing `/` 付きで closed 挿入する。
- **Why**: chat input での drill-down (dir を選ぶ → その中身が候補になる) を維持するには directory 選択で menu を閉じてはいけない一方、file explorer の @ ボタンのような one-shot 挿入では drill-down が発生しないため directory も閉じる必要がある。quoted directory を closed で挿入するのは、user が追記しても manual completion しても token が well-formed に保たれるため。
- **Change freedom**: caret 位置の細かい調整、quote 判定の閾値は自由。「file/directory/one-shot の 3 系統に分けて drill-down を成立させる」だけが不変。
- **Anchors**: `lib/file-fuzzy.ts:118, 130`

### DEC-209: file-links の regex 内 "/" は `[/]` 形で書く

- **What**: `lib/file-links.ts` の正規表現リテラルに現れる literal slash は `\/` ではなく `[/]` (character class) を使う。既存の `\//` は `[/]/` に統一する。
- **Why**: `scripts/validate-comments.ts` の comment 抽出器は string / template のみ tracking し、regex literal を tracking しない。結果として `\/` 直後の regex 終端 `/` が連続 `//` として解釈され、その先が誤って「行末までコメント」と判定されて偽陽性エラーが出る。character class 表記なら連続 `//` が発生せず、regex の意味 (literal `/` に match) は同一のまま validator を通過できる。
- **Change freedom**: 別の workaround (validator 側の regex tracking を実装する、pragma で個別 suppress するなど) を採る場合はこの DEC を revisit する。「連続 `//` を regex source に出さない」だけが不変。
- **Why not**: pragma で個別 suppress する案は、regex を含む新規行を追加するたびに毎回 pragma を追記する必要があり保守コストが高い。
- **Revisit when**: `scripts/validate-comments.ts` が regex literal を tracking するようになった時、あるいは pi-web 側で回帰させたい理由が発生した時。
- **Anchors**: `lib/file-links.ts:1, 24, 51, 72, 100, 106, 135`

### DEC-210: resolveLocalFilePath は URL / source-location 構文を適用しない

- **What**: `resolveLocalFilePath` は生の filesystem path 専用として、URL scheme・fragment・query・`file:` prefix・`path:line:col` 形式のいずれも解釈しない。それらを扱うのは `resolveLocalFileHref` の役割。
- **Why**: 2 種類の解決経路を 1 関数に混ぜると、呼び手が「入力が URL でも path でも動く」ことに依存し、意図しない入力が URL として解釈されて別 root に着地する事故が起きやすい。役割分離により、呼び手は入力の由来 (href 相当か path 相当か) に応じて明示的に選ぶ必要が生まれる。
- **Change freedom**: 内部の path 正規化ロジック、Windows drive letter の扱いは自由。「URL / source-location 構文を適用しない」だけが不変。
- **Anchors**: `lib/file-links.ts:123`

### DEC-211: explorer 開閉状態の永続化は best-effort に留める

- **What**: file explorer の開閉状態は localStorage に保存するが、書き込み例外はすべて握り潰す。読み取り失敗時は「開いている」を既定値とする。
- **Why**: privacy mode / storage quota の環境で永続化が失敗しても explorer 自体が使えなくなるのは過剰。開閉状態は quality of life 目的の付随機能なので、失敗を silent に許容する方が UI 全体の可用性が高い。既定を「開」にするのは初回体験で explorer の存在を認知させるため。
- **Change freedom**: storage key 名、既定値の選択は自由。「保存失敗で explorer を壊さない」だけが不変。
- **Anchors**: `lib/file-explorer-state.ts:34`

### DEC-212: agent API 呼出は sendAgentCommand helper に集約する

- **What**: `POST /api/agent/[id]` を叩く経路はすべて `sendAgentCommand` を経由する。response の `{ success, data }` / `{ error, code, accepted }` shape の解釈と `AgentCommandError` への正規化はこの helper だけが担う。
- **Why**: 過去の `hooks/useAgentSession.ts` では同じ 5 行 fetch block が 13 箇所に重複しており、response shape が微妙に variant を含むたびに漏れが発生していた。1 helper に集約すれば shape 変更が single-point で反映され、`prompt_rejected` のような特殊 error code の判定 (`isPromptRejectedError`) も helper と同じレイヤに置ける。
- **Change freedom**: helper の内部実装、追加の response field は自由。「agent API 呼出は helper 経由でしか行わない」だけが不変。
- **Anchors**: `lib/agent-client.ts:1`

### DEC-213: SSE handshake は open → publishSession → signal 監視 → connected event の順で組む

- **What**: `createAgentEventStream` は (1) response header を先に流し (`:\n\n`)、(2) `publishSession` を先に kick してから (3) request signal 監視を装着し、(4) agent が ready になった時点で `connected` data event を発火して初めて client 側が「開通」と判断する構造を取る。
- **Why**: SSE の response header を先に流さないと途中 proxy が buffer し続け client の EventSource が open にならない。ready 判定を content-type レベルではなく `connected` data event に載せることで、client 側の状態管理を「SSE 開通 vs agent 実効性」の 2 軸に分けられる。`publishSession` を signal 監視より先に起動するのは、route 側が既に共有 cold-start promise を持っている場合でも rejection を内部 try に落として stream を壊さないため。
- **Change freedom**: heartbeat interval、event 名の details、buffer 実装は自由。「4 段階の順序」と「header 先出し + connected event 分離」が不変。
- **Anchors**: `lib/agent-event-stream.ts:19, 108, 120`

### DEC-214: AgentEventConnection は EventSource / readiness / passive reconnect を 1 オブジェクトで所有する

- **What**: `AgentEventConnection` は EventSource 生成・readiness handshake (最初の `connected` event 到達までの待機)・passive reconnect (readiness timeout や error 時の再接続) を 1 クラスの内部で完結させる。呼び手は `maintain(sessionId)` / `ensureConnected(sessionId)` / `close()` の 3 つだけを触る。
- **Why**: これらを呼び手側 (React hook 等) に露出させると readiness state、retry timer、generation counter を毎回作り直す必要があり、hook lifecycle と混ざって race condition が入りやすい。1 オブジェクトが state を所有すれば、hook 側は「今この session を維持したい/やめたい」の意思表明だけに集中できる。
- **Change freedom**: reconnect の backoff 戦略、readiness timeout の値、内部 attempt struct は自由。「呼び手に readiness/retry state を露出させない」だけが不変。
- **Anchors**: `lib/agent-event-connection.ts:47`

### DEC-215: 一度 ready になった後 CONNECTING に張り付いた EventSource は discard して張り直す

- **What**: `ensureConnected` は attempt promise が settled した後でも `source.readyState !== EVENT_SOURCE_OPEN` を検知した場合、そのまま待たずに `discard` して新しい connection を張る。
- **Why**: EventSource は onerror の後に readyState = 0 (CONNECTING) に落ちて、ブラウザの内部 retry に任せると復帰しないまま無限に CONNECTING で張り付くケースがある (backend が閉じたが socket 層の close が未通知など)。ここで自前に discard してしまえば、外側の maintain loop が新しい EventSource を生成し直せる。
- **Change freedom**: 検知タイミング、discard の理由コードは自由。「once-ready 後の CONNECTING 継続を許容せず discard する」だけが不変。
- **Anchors**: `lib/agent-event-connection.ts:93`

### DEC-216: agent event の client 送出は pi-web filter + Pi 0.84 projection を単一関数に集約する

- **What**: server から client に流す agent event は `toClientAgentEvent` を必ず通す。omitted event の除外、tool call metadata (`id` / `toolName`) の hoist、message_update の projection (`partial` を落とす)、`tool_execution_update` / `agent_end` の shape 固定はすべてこの関数の中で行う。
- **Why**: pi-web が要求する event filter (turn_start/turn_end の抑制) と、Pi 0.84 で入った message_update の projection ルールを、複数の送出経路 (SSE 本流 / snapshot 差分など) それぞれで書くと差分が生じ、client の state machine が壊れる。1 関数に集約すれば「client が受け取る event 集合」の SSOT がここに固定される。
- **Change freedom**: filter に追加する event 種、projection の field 名は自由。「client 送出前に必ずここを通す」だけが不変。
- **Anchors**: `lib/agent-event-wire.ts:57`

### DEC-217: workspace ごとに「最後に開いた session」を localStorage で覚える

- **What**: workspace (project root や cwd) を切り替えた際、その workspace で最後に開いていた session id を localStorage の `pi-web:last-open-by-workspace` map に記録する。読み書き失敗はすべて握り潰し、best-effort 動作とする。
- **Why**: workspace 切替のたびに blank new-session ページに戻されると、複数 workspace を往復するユーザーは毎回 session picker を辿ることになる。「最後の場所に戻す」既定は typical workflow (同じ workspace を継続的に触る) に対して摩擦を最小化する。privacy mode / quota で storage が使えない環境でも core 機能は動く必要があるため、記憶は best-effort に留める。
- **Change freedom**: storage key 名、map の schema (現状は flat key→session id) は自由。「workspace 単位に最後の session を覚える」ことと「失敗を握り潰す」ことが不変。
- **Anchors**: `lib/workspace-memory.ts:1, 57, 74`

### DEC-218: workspace identity は projectKey → projectRoot → cwd の順で解決する

- **What**: `workspaceKeyOf` は session の `projectKey` (server 側で解決される project identity)、`projectRoot`、`cwd` の順で最初に定義されているものを workspace の identity key として採用する。
- **Why**: `projectKey` は同一 project の Windows path variant や worktree 群を単一 identity にまとめる server 側の resolver が返す値なので、これが available な session ではこれを使うのが最も正確。旧形式 (transient session / legacy session) では `projectKey` が無いため `projectRoot` にフォールバックし、いずれも無い場合の最終手段として `cwd` を使う。この順で解決すれば worktree 間で「最後の session」を共有できる。
- **Change freedom**: 追加の identity source を後段に足すことは可。「projectKey を最優先で採用する」ことが不変。
- **Anchors**: `lib/workspace-memory.ts:78`

### DEC-219: workspace memory の localStorage は空 map なら key ごと消す

- **What**: `clearLastOpen` は workspace の記憶を削除した結果 map が空になった場合、`pi-web:last-open-by-workspace` key を setItem で `"{}"` として残さず removeItem で丸ごと消す。
- **Why**: 空 map の JSON 文字列 (`"{}"`) を残すと、devtools で localStorage を眺めた時に「何かしら状態が残っている」ように見えて誤解を生む。key を消してしまえば「記憶ゼロ」がストレージ上でも自明になる。加えて、後で `workspace-memory` の schema を変えた場合の migration 時に古い empty entry を意識せずに済む。
- **Change freedom**: cleanup をどの操作で行うかは自由 (現状は clear 側だけで、set 側では行わない)。「空 map を storage に残さない」だけが不変。
- **Anchors**: `lib/workspace-memory.ts:70`

### DEC-235: i18n の重複登録拒否と英語フォールバック

- **What**: `registerLocale` は id 衝突で throw する。`resolveBrowserLocale` はマッチしない場合 `"en"` を返す。`translateMessage` は現行 locale → `en` → key 生値の順に fallback する。
- **Why**: 同 id の locale が黙って上書きされると翻訳のリグレッションが観測できない。未対応言語や未翻訳 key が空文字で UI に出るのは崩れの原因、英語の完備を fallback レール化することで最悪でも読める状態を保証する。
- **Change freedom**: 特定 key の翻訳を追加/差し替えする自由、locale 追加時の label / id 命名は自由。「i18n missing key を UI に漏らさない」「同 id の再登録を silent に許さない」の 2 点だけが不変。
- **Anchors**: `lib/i18n/registry.ts:7-30`, `lib/i18n/format.ts:12-27`

### DEC-236: 書き込み系ツールの真実源はツール呼び出しの成功結果に限る

- **What**: `extractTurnWrittenFiles` は assistant turn 内の write/edit 系 tool call のうち、tool result が到着し `isError` でないものだけを抽出し、first-seen 順にデデュープする。text block に現れたパスは無視する。ツール引数の path は href では無く FS path として扱い、`#` `?` `:digits` を保存したまま `resolveLocalFilePath` に渡す。
- **Why**: reply text は幻覚のパスを含みうる。ファイル書き込みの唯一の証拠は「tool call の結果が成功して返った」こと。tool 引数は URL 表現ではないため href 用のエスケープを掛けると実ファイルを誤解決する。
- **Change freedom**: 抽出後の UI 表現、追加でどの meta を返すかは自由。「reply text からファイル情報を汲まない」「結果未着 or error のツール呼び出しを書き込み扱いしない」だけが不変。
- **Anchors**: `lib/turn-written-files.ts:19-49`, `lib/turn-written-files.test.mjs:113-119`

### DEC-237: unified patch のヘッダ検出はハンク外に限定する

- **What**: `parseUnifiedPatch` は `@@` header の残り行数 (`hunkOldRemaining`/`hunkNewRemaining`) を追跡し、hunk 本体の内部では `--- ` / `+++ ` で始まる行を content として処理する。ヘッダとしての解釈はハンク間だけを走査する。
- **Why**: ハンク内の追加行 content が `++ x` で始まると raw 行は `+++ x` となり、削除行 content が `-- x` で始まると `--- x` となる。これを file header として拾うと 1 ファイル分の diff が偽の複数ファイルに分裂する。
- **Change freedom**: 内部ステートの表現、行ごとの走査方式は自由。「hunk 内での `---`/`+++` 判定はしない」だけが不変。
- **Anchors**: `lib/patch.ts:24-77`, `lib/patch.test.mjs:59-85`

### DEC-238: npx 呼び出しはシェルを経由せず Node.js 同梱の npx-cli.js を直接起動する

- **What**: `runNpx` は `findNpxCli` で Node 同梱位置 (Windows MSI と Unix レイアウト) から `npx-cli.js` を探し、見つかれば `execFile(execPath, [cli, ...args])` として実行する。見つからない場合のみ `npx` 名に fallback する。`shell: true` は使用しない。
- **Why**: Node 20.12+ は CVE-2024-27980 対応で Windows の `.cmd` を shell なしで spawn するのを拒否する。`shell: true` を有効化すると shell メタ文字への escaping バグが復活し、ユーザ提供の args がシェル構文として解釈されうる。Node が確実に同梱する `npx-cli.js` を直接呼べば shell を挟まず全プラットフォームで同じ経路になる。
- **Change freedom**: 探索候補の追加、fallback 分岐の追加は自由。「shell を経由しない」だけが不変。
- **Anchors**: `lib/npx.ts:9-50`

### DEC-239: HTTP dispatcher は undici の内部 error emit を握り、既存 fetch override を保存する

- **What**: `withUndiciErrorListener` が生成した全 dispatcher に no-op error listener を付与する。`configureHttpDispatcher` は `globalThis.fetch` がこのモジュール読み込み時点の値と等しい場合にのみ `undici.install()` を呼び、既に差し替えられていれば何もしない。
- **Why**: Undici は response body 終了時に内部 Client error を emit することがあり、これを listener 未登録のまま放置すると EventEmitter 経路で Next.js プロセスが落ちる (body の Promise は既に reject しているので機能面は問題ない)。fetch の後付け override を上書きすると意図された fetch モックや観測レイヤが黙って剥がれるため、install は初期状態限定にする。
- **Change freedom**: dispatcher factory の分岐、timeout 値の変更は自由。「dispatcher に error listener を付ける」「事後差し替え fetch を上書きしない」だけが不変。
- **Anchors**: `lib/http-dispatcher.ts:28-36, 78-84`

### DEC-240: RecentProject は stable key と表示 root を分離する

- **What**: `RecentProject` は `key` (equality / Map key) と `root` (表示 / FS 操作) を並列で持ち、`getRecentProjects` は stable key で dedupe した上で「最新 modified の root」を各 key に紐付けて返す。
- **Why**: 同一プロジェクトが worktree / alias / 大小文字違いで複数の root として現れうる。表示 root で dedupe すると同じプロジェクトが二重に並び、key で dedupe すると特定表示が失われる。両者を分離すればどちらも同時に成立する。
- **Change freedom**: `workspaceKeyOf` の実装 (何を key に使うか) は自由。「key と root の二重表現」だけが不変。
- **Anchors**: `lib/project-groups.ts:4-25`

### DEC-241: メッセージ正規化は assistant role にのみ適用する

- **What**: `normalizeAssistantToolCalls` は `msg.role !== "assistant"` の場合入力をそのまま返し、user / toolResult / bashExecution / custom などの他 role は正規化パスを通さない。
- **Why**: tool-call field の shape 補正は assistant からの出力にのみ意味がある。他 role にも適用すると存在しない field を作ってしまい、下流の型判定が壊れる。
- **Change freedom**: assistant の content 変換ロジックは自由。「非 assistant を素通しする」だけが不変。
- **Anchors**: `lib/normalize.ts:41-56`

### DEC-242: slash 表示縮約は SDK envelope の完全一致のみを対象とする

- **What**: `skillExpansionToCommand` は「開頭 `<skill name=… location=…>`」+「`References are relative to <base>.`」+「本体」+「末尾 `</skill>`」+「optional `\n\n<args>`」の全一致マッチのみを受理する。body 内に例示的な `</skill>` があっても最終閉じタグを優先する greedy キャプチャで一意に切り出す。マッチしない場合は `null` を返す。
- **Why**: 表示上の縮約は pi 側 `_expandSkillCommand` が emit した完全 envelope の逆写像。ゆるいマッチにすると偶発的に `<skill` を含むユーザ入力を縮約してしまい、session 自動命名の sidebar 表示が XML 断片になる。
- **Change freedom**: 縮約後の command 表現 (先頭 `/skill:` 以外の表現) は自由。「envelope の完全一致でのみ縮約」「不一致は null」だけが不変。
- **Anchors**: `lib/slash-display.ts:1-11`

### DEC-243: API リクエストの Host / Origin は loopback・IP・明示許可のみ、cross-site fetch は拒否する

- **What**: `isApiRequestHostAllowed` は `localhost`/`*.localhost`、IP literal、操作者が env で明示指定した hostname のみ受理する。`isApiRequestOriginAllowed` は `sec-fetch-site: cross-site` を拒否し、Origin ヘッダが request URL の origin と一致すれば通す。Origin 未送信は非ブラウザ client として素通しする。
- **Why**: DNS rebinding は DNS 名前解決を経路にする攻撃であり、IP literal を Host に置く限りリバインドできない。cross-site fetch はブラウザ内でしか起こらない drive-by の攻撃面。非ブラウザ client (curl / SDK / MCP) は `sec-fetch-*` を送らないので、Origin 欠落での通過は誤検知ではなく必要な穴。
- **Change freedom**: allow list の追加、user-initiated navigation の例外拡張は自由。「Host / Origin での境界そのもの」を無くさない。
- **Anchors**: `lib/request-security.ts:71-99`

### DEC-244: project tree の response は shallow に保ち、単一子連鎖は圧縮して次残存ノードに ID を積む

- **What**: `projectTreeForResponse` は roots・branch points・leaves のみを残し、単一子連鎖 (`compressedEntryIds`) を圧縮した ID を次に残るノードに載せる。深さは `MAX_PROJECTED_TREE_DEPTH = 200` を超えた時点で `appendFlattenedKeptDescendants` の非再帰経路に切り替える。
- **Why**: client 側 `BranchNavigator` はレスポンス tree を再帰走査する。深い連鎖をそのまま返すとスタック / render の複雑度が跳ね上がる。圧縮しても `compressedEntryIds` を経路に残せば UI は連鎖内 active leaf を識別できる。
- **Change freedom**: 圧縮の内部アルゴリズム、depth 上限値は自由。「response tree を shallow に保つ」「圧縮 ID を UI が辿れる形で残す」だけが不変。
- **Anchors**: `lib/project-tree.ts:1-176`

### DEC-245: ブラウザ通知は Service Worker 経由を優先し、失敗時のみ Notification 直接生成に落とす

- **What**: `showBrowserNotification` はまず `getServiceWorkerRegistration()` を試み、`registration.showNotification` が成功すれば `"service-worker"` を返す。SW 側が例外を投げた場合は Notification コンストラクタでの page notification に fallback する。コンストラクタも throw した場合は `null` を返す。
- **Why**: モバイルブラウザは Notification API を公開しつつ構築時に throw する傾向があり、SW 経由でしか実際に通知を出せない。逆に SW 未登録環境では Notification 直呼びの方が届く。両経路の優先順を固定することで挙動を再現可能にする。
- **Change freedom**: `NotificationOptions` の内容、失敗時の観測 (metrics) の追加は自由。「SW を先に試す」「二重失敗で null を返す」だけが不変。
- **Anchors**: `lib/browser-notifications.ts:69-104`

### DEC-246: tool preset の localStorage 永続化は best-effort

- **What**: `setPreferredToolPreset` は `storage.setItem` を try/catch で包み、例外を swallow してユーザ操作を止めない。
- **Why**: private mode / quota exceeded / SSR で localStorage は throw しうる。preset 保存は UI の quality-of-life であり、これで request path を止めるのは対価が合わない。
- **Change freedom**: storage backend の差し替え、通知 UI の追加は自由。「保存失敗で throw しない」だけが不変。
- **Anchors**: `lib/tool-preset-preference.ts:31-41`

### DEC-247: 書き込み系ツール名判定は MCP の prefix / namespace ラップも受理する

- **What**: `isWriteToolName` / `isEditToolName` は bare `write`/`edit` に加え、`write_*` / `*.write` / `*_write` / `edit_*` / `*.edit` / `*_edit` / `str_replace*` / `replace_editor*` を write/edit として扱う。
- **Why**: MCP server は同じ意味のツールを prefix / namespace で包んで露出する慣行がある (`fs.edit`, `str_replace_editor`, ...)。bare 名のみを見ると外部 MCP 経由の書き込みが検出漏れになり、DEC-236 (書き込み確定源) の網から漏れる。
- **Change freedom**: 追加パターンの拡張は自由。「MCP ラップ名も write/edit として認識する」だけが不変。
- **Anchors**: `lib/tool-names.ts:1-19`

### DEC-248: 起動時の preference 永続化は effective 値と一致した explicit 選択のみ setter で反映する

- **What**: `persistExplicitStartupPreferences` は explicit と effective が一致した場合にのみ `settingsManager.setDefaultModelAndProvider` / `setDefaultThinkingLevel` を呼び、`AgentSession.setModel` / `setThinkingLevel` は再呼び出ししない。
- **Why**: `AgentSession` のコンストラクタは既に effective 値を session に記録済み。setter を再度呼ぶと session ledger に重複 entry が積まれ、拡張向けの変更 event が二重に emit される (UI や extension 側が「変更があった」と誤認する)。
- **Change freedom**: どの設定をどう永続化するかの分岐は自由。「session setter を再呼び出ししない」だけが不変。
- **Anchors**: `lib/startup-preferences.ts:15-53`

### DEC-249: 未信頼プロジェクトのリソースは trust store 経由で dormant にする

- **What**: `projectTrustReloadOptions` は `.pi/extensions`、project `.pi/settings.json` の extension entry、`.agents/skills` を trust 要件付きリソースとして扱い、`ProjectTrustStore` を参照する `resolveProjectTrust` を返す。trust 要件がないプロジェクトでは `undefined` を返し既存 load path を維持する。
- **Why**: pi-web は session service 構築時に project extension を **実行** する (factory は import 時に走り、`session_start` handler は起動時に走る)。trust gate 無しで untrusted repo を開くと repo が持つコードがローカルで実行される (issue #236)。SDK の resource loader は `resolveProjectTrust` が true を返すまで project extension を import しないため、trust を保留すれば dormant に留められる。`pi` CLI と共有 store のため、どちらで trust しても両方に効く。
- **Change freedom**: trust 判定 UI・確認フロー・記憶粒度は自由。「未信頼で extension を import しない」「pi CLI と store を共有する」だけが不変。
- **Anchors**: `lib/project-trust.ts:23-48`

### DEC-250: project identity key は Windows で case-fold、platform 引数は差し込み可能にする

- **What**: `projectIdentityKey` はパスを normalize し末尾セパレータを除去、`platform === "win32"` の場合のみ全体を lower-case する。`platform` は default `process.platform` だが引数で override 可能。
- **Why**: Windows の default FS は case-insensitive のため、大文字違いの同一プロジェクトを別扱いにすると session グルーピングが二重化する。非 Windows CI で Windows semantics をテストするには platform 引数の注入が必要。
- **Change freedom**: normalize アルゴリズム、Windows 判定の付加条件は自由。「Windows で case-fold」「platform 引数で override 可能」だけが不変。
- **Anchors**: `lib/project-identity.ts:1-26`

### DEC-252: frontmatter パース失敗は throw せず data:null で返す

- **What**: `parseFrontmatter` は YAML parse が例外を投げた場合 `{ data: null, rest: block.rest }` を返し、caller には正常系と同じ shape で伝える。
- **Why**: fence された malformed block は下流の remark plugin が既に render から隠す。ここで例外を出すと「frontmatter があるか無いか」だけを見たい上位が下位パースエラーを丸ごと受けることになり、責任境界が崩れる。
- **Change freedom**: エラー時のログ出力の有無は自由。「parse 失敗で throw しない」「shape を維持する」だけが不変。
- **Anchors**: `lib/frontmatter.ts:34-48`

### DEC-253: directory listing は壊れた/非 directory symlink を静かに除外する

- **What**: `listDirectories` は directory エントリをそのまま返し、symlink は realpath + stat が directory を指す場合のみ含める。壊れた symlink・権限拒否・非 directory 参照は `null` にマップされ最終的な配列から除かれる。
- **Why**: FS には壊れた/権限のない symlink が存在しうる。1 件の bad entry で listing 全体が例外化するとナビゲーションが即詰まる。表示不能を silent skip にすることで、正常な兄弟エントリで通常操作を継続できる。
- **Change freedom**: sort 順、追加メタの返却は自由。「壊れ symlink を throw に格上げしない」だけが不変。
- **Anchors**: `lib/directory-browser.ts:60-83`

### DEC-254: multipart 上限はワイヤ実バイトで判定し、Content-Length を信用しない

- **What**: `parseFormDataWithinLimit` は Content-Length を上限判定の一次フィルタとして使うが、実際には `request.body.getReader()` から chunk を読みながら累計バイトを実測し、超過時点で `RequestBodyTooLargeError` を throw する。
- **Why**: chunked encoding では Content-Length が付かず、付いていても client が過少申告しうる。上限を信頼するとヘッダを詐称するだけで境界を越えられる。stream 読みながら実測すれば宣言値に依存しない。
- **Change freedom**: chunk バッファリング戦略、error の型は自由。「実バイトで境界判定する」「Content-Length を単独根拠にしない」だけが不変。
- **Anchors**: `lib/bounded-form-data.ts:15-49`

### DEC-255: 秘匿ファイルは 0o600 で temp に書いて rename する

- **What**: `writePrivateFileAtomicSync` は `.<basename>-<uuid>.tmp` に `mode: 0o600 flag: "wx" flush: true` で書き、`renameSync` で対象パスに置換する。失敗時は `finally` で temp を best-effort 削除する。
- **Why**: default file mode は umask 依存で world-readable になりうる (credential 露出)。非 atomic write は途中状態のファイルを並行 reader に晒す。rename は同一 FS 上で atomic ゆえ、部分書き込みの露出も防ぐ。
- **Change freedom**: temp path 命名、追加の fsync 呼び出し等は自由。「0o600 で書く」「rename で置換する」だけが不変。
- **Anchors**: `lib/atomic-file.ts:5-34`


## Consequences / Impact

- 本文書の DEC は「fork 前から成立している pi-web の設計判断」であり、fork 側から見ると **不変条件の参照点** として機能する。fork の追加コードが lib/ の内部構造に依存する場合、まず該当 DEC を確認し、依存する invariant を明示すること。
- DEC-XXX の "Anchors" 欄はコメント抽出元の site を示す。将来 lib/ 側のコードを触るときは Anchors を辿って該当 DEC の Why を確認する。
- upstream (agegr/pi-web) 側では対応する DEC は存在しないため、pi-web を独立にウォッチして進化差を吸収する必要は Workspace DEC-001 (完全固定派生) により発生しない。

## Quality Implications

- **DEC が守る品質**: pi-web の実装細部に埋め込まれた設計意図が、fork 側の rewrite/refactor で意図せず失われないこと。
- **破ると起きる回帰**: pi-web の runtime が想定していた invariant（例: session flush の遅延、prompt admission の逐次化、path の native/slash 二重表現）が崩れ、pi 側の SDK 契約と噛み合わなくなる。
- **QA 観点**: lib/ を改変する PR では、触った site が Anchor に含まれる DEC を洗い、Why を破っていないか確認する。

## Intent-derived Invariants

None

## Rollback / Follow-ups

- **Rollback**: 本文書は「観察された設計判断の記録」であり、ロールバック対象となる判断そのものは含まない。個別 DEC の Why が誤って抽出された場合は、その DEC を supersede し、正確な Why を新 DEC に書き直す。
- **Follow-ups**:
  - lib/ 内で追加のコメント削除・DEC 抽出が必要になった場合、この文書に追記（新規 DEC-XXX の採番は既存最大値 + 1、ただし本文書の範囲は DEC-100..DEC-299 に留める）。
  - fork 側の新規判断（pi-web 上流に存在しないもの）は本文書ではなく他の `_docs/intent/<Area>/<slug>/decision.md` に書く。
