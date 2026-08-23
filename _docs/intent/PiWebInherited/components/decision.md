---
title: components/ pi-web 由来コードの設計判断（inherited）
status: active
intent_schema: 3
created_at: 2026-08-23
updated_at: 2026-08-23
references: []
related_issues: []
related_prs: []
---

<!-- Canonical path: _docs/intent/PiWebInherited/components/decision.md -->

## Context

本文書は pi-web v0.8.9 (SHA `2a6e537`, MIT) から本 repo に取り込んだ `components/` 配下ファイルの設計判断を集約する台帳。これらの DEC は元コードのインラインコメントに含まれていた「なぜこう書いたか」を、fork の IDD 化作業（Workspace DEC-002 additive extension 境界、Workspace DEC-001 fully-fixed fork）にあわせて抽出したもの。抽出前は自由文コメントとして各所に散っていた判断を、`validate-comments` の許容形式（`// intent: DEC-XXX — <one-line reason>`）に置き換えるためにここへ集めた。

DEC ID は本ファイル用に **DEC-300..DEC-499** の範囲を予約する。判断内容そのものは pi-web 由来のため、原則として本 repo で「変える」対象ではないが、DEC-002 の additive 境界を越えない範囲では自由に改変してよい（Workspace DEC-001 参照）。

## Decisions


### DEC-300: 書いたファイル一覧は tool call 由来のみ、返答本文の path 抽出はしない

- **What**: `TurnWrittenFiles` に渡す `WrittenFile[]` は、そのターンで成功した `write`/`edit` tool call の結果のみから導出する。assistant の返答テキストから path らしき文字列を拾って追加はしない。
- **Why**: 返答文からのヒューリスティック抽出は誤検知（コード例に含まれるパス、fictional path、archive 引用等）と false negative（相対表記、Windows path、backtick 無し等）の両方を生む。tool call は「実際にファイルを書いた」という machine 記録なので事実と一致する。
- **Change freedom**: ボタン UI、レイアウト、`onOpenFile` の実装は自由。「返答テキストを path 抽出源に使わない」だけが不変。
- **Anchors**: components/TurnWrittenFiles.tsx:1-52

### DEC-301: frontmatter 由来 URL は http/https/mailto scheme のみ許可

- **What**: `FrontmatterCard` で frontmatter 値を anchor として render する際、`isUrl` で `^(https?:\/\/|mailto:)` のみを URL 扱いにする。他 scheme（`javascript:`, `data:`, `file:` 等）は URL とみなさず plain text として表示。
- **Why**: frontmatter はユーザー自身のファイル由来なので基本信頼できるが、React の JSX escape だけでは `href="javascript:..."` の実行を止められない。scheme allowlist で明示的に弾く。
- **Change freedom**: 許可 scheme の追加（例: `tel:` 等）、URL 表示スタイルは自由。「scheme allowlist 方式を保つ」だけが不変。
- **Anchors**: components/FrontmatterCard.tsx:19-27

### DEC-302: MarkdownBody の renderer 安定化と react-markdown 副作用の除去

- **What**: `components` を `useMemo` で安定化する（`cwd`/`isStreaming`/`onOpenFile` 依存）。`a` / `img` handler で react-markdown が付与する `node` prop を明示的に `delete props.node` で剥がす。ローカルパス画像は `next/image` ではなく `<img>` + file API 経由で serve する（`eslint-disable-next-line @next/next/no-img-element` 付き）。
- **What (詳細)**:
  - renderer identity 安定化: message hover 等の頻繁な parent re-render で、内部 state を持つ block（コードブロック、mermaid、画像等）が再マウントされないようにする
  - `node` prop delete: react-markdown の内部 metadata であり DOM 属性ではないため React が warning を出す
  - 画像の file API 経由: local file path (`/home/…`) は Next の image optimizer では扱えないので、file API に read 委譲する
- **Why**: いずれも「ユーザ操作や streaming 中の再 render で挙動が壊れない」ためのガード。renderer identity が変わると mermaid 再描画・画像 flicker・code block の scroll position 消失が起きる。`node` を残すと HTML 属性違反で React が console warning を吐く。画像 API を経由しないと local path が読めない（Next の image loader が拒否する）。
- **Change freedom**: `useMemo` の依存配列の詳細、`node` 除去の書き方、画像 URL の組み立て方法は自由。「stateful block を安定 render する」「`node` 属性を DOM に流さない」「local path は file API で serve する」の 3 つが不変。
- **Anchors**: components/MarkdownBody.tsx:18-89

### DEC-303: CodeBlock は memo 化しつつストリーム中はプレーン表示に落とす

- **What**: `CodeBlock` を `React.memo` でラップし、加えて `isStreaming` フラグが true の間は Prism (`SyntaxHighlighter`) を使わず生の `<pre><code>` を返す。ストリーム完了後だけ syntax highlight を有効化する。
- **Why**: streaming で code block の中身が chunk 単位で伸びるとき、Prism は毎 chunk で全長を再トークン化するため、streamed rendering 全体の中で最も重い処理になる。memo だけでは「他 message の update で親が再 render する場合」の再計算を防げても、自 block が chunk 更新するときは走ってしまう。ストリーム中はプレーンにする方針で両方止める。
- **Change freedom**: memo の比較関数、streaming 中の見た目、highlight テーマの切替方式は自由。「streaming 中は Prism を走らせない」「memo で親 re-render 由来の再計算を止める」の 2 点だけが不変。
- **Why not**（全期間 highlight）: 開発中のストリーム 5-10s の間 UI が固まる。UX 上不許容。
- **Anchors**: components/MermaidBlock.tsx:240-300

### DEC-304: FileExplorer のエラー処理と refresh 挙動

- **What**: FileExplorer 内の以下 4 挙動:
  1. `fetchEntries` の HTTP エラー時、response body が JSON でなければ silently ignore し、`Failed to load files (HTTP N)` の既定文言にフォールバック
  2. TreeNode の子ディレクトリ load 失敗は catch 内で ignore（loading state だけ解除）。UI 上にはエラー表示しない
  3. `refreshToken` の bump 時は、既に open + loaded な TreeNode だけ再 fetch する
  4. `expandedPaths` / `highlightedPaths` / upload feedback のリセットは cwd 切替時にのみ実行、`refreshKey` bump では保つ
- **Why**:
  - 非 JSON body の握りつぶし: `res.json()` は非 JSON で throw する。ここで throw を上位に伝えると、生 HTML の response body を error に混ぜてしまい UX 悪化。既定文言の方がユーザに親切。
  - 子 load 失敗の握りつぶし: 個々の子 dir load はユーザ操作の隙間で頻繁に走る。ここで inline error を出すと tree UI がノイズだらけになる。上位の直接的な dir clicked 時に再 fetch されるので、そちらでエラー露出する。
  - refreshToken の限定再 fetch: 全 TreeNode を再 fetch すると massive request storm になる。ユーザに見えている open dir だけで十分。
  - リセット境界を cwd に限定: `refreshKey` は「同じ cwd でファイル増減があった」ときに bump するが、そのたびに展開状態を失うのは操作性が悪い。cwd が変われば context 自体が変わるので reset して自然。
- **Change freedom**: エラー表示の詳細、loading spinner、reset するフィールド集合は自由。「上記 4 rule を保つ」だけが不変。
- **Anchors**: components/FileExplorer.tsx:80-89, 254-263, 265-271, 673-693

### DEC-320: 未選択セッションの完走を親に伝えるフック

- **What**: `onBackgroundTaskDone?: () => void` を SessionSidebar の Props に持ち、選択中でないセッションが running から抜けたときに親へ発火する。
- **Why**: 別ワークスペース／別プロジェクトで走らせていたエージェントの完了を、サイドバーを開かなくても気付けるようにしたい（親側で通知音や toast を鳴らす想定）。running 判定は SessionSidebar が polling で持っている情報なので、ここで側路的に通知する方が pipeline が短い。
- **Change freedom**: 完了時に親が何をするか（音、通知、SW push）は自由。通知の trigger 条件（未選択かつ running→idle 遷移）は変えない。
- **Anchors**: components/SessionSidebar.tsx:101

### DEC-321: WorktreeState はサーバ計算 identity と取得元 cwd を保持する

- **What**: `WorktreeState` の各フィールドを次の invariant で運用する:
  - `forCwd`: この state が fetch された cwd。以降の応答判定に使う。
  - `projectKey`: server 側で計算した安定 identity。ブラウザ側で path から派生させない。
  - `isTopLevel`: false のとき（repo subdir）は switcher を出さない。
  - `currentWorktreePath`: checkout の正準パス（server 解決）。
- **Why**: (1) 非同期の worktree 情報 fetch が複数飛ぶので、古い応答が新しい selection を上書きしないよう「どの cwd に対して取ったか」を state に持たせて guard する。(2) Windows 大小・区切り差など OS 依存の path 意味論をブラウザに持ち込むと fork ごとに壊れるので server 側の識別に委ねる。(3) repo subdir を開いたときのセッションは独自 identity で扱われる（DEC-327 と一致）ため、そこで switcher を出すと別プロジェクトへ jump してしまう。
- **Change freedom**: 各フィールドの名前や `WorktreeEntry` の詳細は自由。「server-computed identity をブラウザで再解釈しない」「取得元 cwd を必ず一緒に持つ」「subdir では switcher を出さない」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:113, 116, 119, 121

### DEC-322: session tree は parent 鎖を辿って最近祖先へ吊り直す（循環は遮断）

- **What**: `buildSessionTree` は `parentSessionId` の鎖を作り、byId に存在する最近祖先まで再帰的に walk する。訪問済み id を Set で追跡し、循環を検知したら null を返す。
- **Why**: parent chain の途中のセッションが削除される・別プロジェクト由来で filter 済みで見えない、といった状況が普通に起こる。単純に `parentSessionId === s.id` で結ぶと表示から欠落するセッションが出る。祖先を辿って最も近い「見える」ノードにぶら下げる方が UI 上の情報損失が少ない。循環はデータ破損時にしか起きないが、無限ループで tab を固めるより明示 fallback にする。
- **Change freedom**: sort 順（現在は modified desc）は自由。「欠落祖先を鎖で解決する」「循環時は null を返す」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:261, 271

### DEC-323: 空 catch は意図的 no-op として一貫扱う

- **What**: 以下の catch はすべて意図的 no-op として扱い、error を UI へ露出させない。
  - `saveUnreadSessionIds` の localStorage 例外
  - running poll の fetch/AbortError
  - `handleDefaultCwd` の /api/default-cwd 失敗
  - `commitRename` の PATCH 失敗
- **Why**: いずれも「失敗しても次の refetch/poll/操作で回復する」性質の副作用で、error を出しても user がとれる action がない。特に localStorage は privacy mode / quota で頻繁に失敗するので、UI 継続の方を優先する。
- **Change freedom**: 例外を metric に飛ばす等の観測強化は追加してよい。「UI に error を出して blocking にしない」「例外で state を戻さない」だけが不変。
- **Why not**（例外を toast で表示）: 上記どれも user が直せない失敗なので通知は騒音になる。
- **Anchors**: components/SessionSidebar.tsx:159, 509, 759, 1964

### DEC-324: パス表示は home 短縮のみ・切り詰めは RTL PathLabel に一任

- **What**: `displayCwd` は home dir を `~` に置換するだけで truncate しない。`PathLabel` は container を `direction: rtl` / inner を `unicodeBidi: plaintext` で構成し、左端に ellipsis を出しつつ内側の path を LTR 表示にする。
- **Why**: パスは末尾（プロジェクト名や worktree 名）ほど識別に効くので、固定セグメント数で切るより「入る分だけ末尾を見せる」方が有用。ネイティブに左端 ellipsis を出す CSS がないので rtl trick を使う。ただし RTL のまま bidi が動くと `-` や `/` の順序が入れ替わるので plaintext isolation で LTR に閉じ込める。
- **Change freedom**: 表示に使う font/size/pad は自由。「end-preserving で左端 ellipsis」「path の視覚順は LTR」「home は `~` に畳む」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:177, 182

### DEC-325: running セッション状態は軽量 poll を権威にする

- **What**: `/api/sessions` の応答に含まれる `runningSessionIds` は初期 fallback のみに使い、軽量 poll が一度でも snapshot を返した後は `runningPollAuthoritativeRef` を立てて以後上書き禁止にする。加えて session refresh のたびに、存在しなくなった session の unread マーカーを剪定する。
- **Why**: `/api/sessions` はセッション一覧の走査で重く応答が遅れることがある。走行中の脱走・完了に追随したいので軽量 poll (2.5s) を独立に走らせ、遅延した session-list 応答が古い running set で上書きしないようにする。unread は session が消えれば意味を持たないので、同じタイミングで剪定して stale 表示を防ぐ。
- **Change freedom**: poll 間隔 (`RUNNING_SESSIONS_POLL_MS`) や endpoint は自由。「軽量 poll が権威になったら session-list の running を捨てる」「unread は存在確認で剪定する」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:421, 436, 440

### DEC-326: ブラウザ storage は hydration 後に復元し、unread は persist する

- **What**: explorer の open/close preference は SSR 直後の初回描画では反映せず、hydration 後の useEffect で `loadExplorerOpen()` から復元する。unread マーカーは useEffect で常時 saveUnreadSessionIds に流し、reload 後も残るようにする。
- **Why**: (1) SSR 中は localStorage が読めないので、`useState(true)` の初期値と storage 値を一致させる術がなく hydration mismatch を招く。open のまま SSR して、hydration 後の 1 tick で collapsed に戻すのが最小コスト。(2) unread は「完了したのに開いていない」という状態を保つのが目的で、reload で消えると 気付き の目的が壊れる。
- **Change freedom**: storage key、format、encode 方式は自由。「初回描画は open 固定」「unread は毎回 persist」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:467, 472

### DEC-327: projectFor は validated → worktreeState.forCwd → worktree list → session の順で解決する

- **What**: `projectFor(cwd)` は次の優先順で `{root, key}` を返す:
  1. `validatedProject.cwd === cwd`（custom path validate 直後）
  2. `worktreeState.forCwd === cwd`（server が保証する identity）
  3. `worktreeState.worktrees.some(w => w.path === cwd)`（同一 project 内の別 worktree）
  4. `allSessions` 走査
  5. fallback: `{ root: cwd, key: cwd }`
- **Why**: (1) custom path 選択直後、raw path key で 1 フレーム描画されると AppShell がそれを別 workspace への切替と解釈してリセットが走る。validate 応答の identity を最優先することでその狭間を潰す。(2) セッション未持ちの worktree に切り替えても、既存 worktreeState の list に含まれているなら同一プロジェクトとして扱う方が row の unmount / remount が起きず UX が滑らか。
- **Change freedom**: fallback 内訳（session なしのときに何を返すか）は自由。優先順位だけが不変。
- **Anchors**: components/SessionSidebar.tsx:595, 602

### DEC-328: onCwdChange は cwd と key の両方を監視、cwd sync は prop 値変化時のみ

- **What**: cwd 通知は `{cwd, key}` の組み合わせを ref に保存し、どちらかが変わった時だけ発火する。`selectedCwdProp` に基づく `setSelectedCwd` は prop 値が変化した時のみ実行し、同じ値の再着信では触らない。
- **Why**: (1) worktree/session refresh は cwd 不変のまま key が hydrate されるケースがある（DEC-327 の 5.→3. への昇格）。cwd 変化のみで判定すると key 変化が親に伝わらず、workspace 切替と identity hydration が区別できなくなる。(2) sync effect が prop 値の恒等再着信でも発火すると、user が switcher で切った worktree が prop 経由で snap back される。prop 変化 gate で明示的に区別する。
- **Change freedom**: 通知先の shape や lastSyncedCwdPropRef の初期値は自由。「cwd と key の両方監視」「prop 変化 gate」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:614, 628

### DEC-329: 初回ロード時は URL のセッション ID を最優先で復元する

- **What**: `initialSessionId` があり かつ 1 回も復元していない場合、そのセッションを allSessions から探して選択する。見つからなければ `onInitialRestoreDone` を呼んで親に placeholder を表示させる。復元不要／初期セッションが不明なら最新プロジェクトを既定で開く。
- **Why**: URL restore の失敗を静かに握り潰すと、user は「何が起きたのか分からない画面」に取り残される。placeholder を出す責任を親に投げて、初期化 flow を明示的に閉じる。
- **Change freedom**: 既定プロジェクト選択の順序（現在: getRecentProjects[0]）は自由。「セッション ID 復元を最優先、失敗時は placeholder」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:674

### DEC-330: currentWorktree lookup は UI 選択一致を最優先する

- **What**: `currentWorktree` は次の順で解決する:
  1. `selectedCwd` に一致する worktree
  2. `worktreeState.forCwd === selectedCwd` かつ `currentWorktreePath` が指す worktree
  3. `isMain` な worktree
- **Why**: refetch が到着する前は UI で選択された path をそのまま尊重し、応答が来たら server 解決 path (currentWorktreePath) を使う。ブラウザ側で path 正規化を頑張ると Windows の大小・区切り差でずれる。fallback として main を使うのは、少なくとも repo としては正しい表示になるため。
- **Change freedom**: fallback の 3 段目（main）は自由に変えてよい。1→2 の順序と「server 解決を優先」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:695

### DEC-331: worktree 作成は楽観登録、削除は dirty 確認を挟む

- **What**: `handleCreateWorktree` は 201 応答後、refetch を待たずに `worktreeState` へ新 worktree を挿入し、forCwd / currentWorktreePath を新 path に切り替える。`handleRemoveWorktree` はサーバが `{dirty: true}` を返したら force 確認 UI (`wtConfirmRemove`) に切り替え、明示 confirm があってから force=true で再送する。
- **Why**: (1) 楽観登録なしだと、setSelectedCwd → 次の render で projectFor が「知らない cwd」と判定し AppShell が別プロジェクトへ jump したように見える。refetch は数百 ms 後に来るのでその間の flicker を避けたい。(2) dirty worktree の force 削除は未 commit の作業を消す破壊的操作なので silent には流さず、user の意思確認を経る。
- **Change freedom**: confirm UI の見た目、force 確認の文言は自由。「作成は楽観登録」「dirty は confirm 経由」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:783, 811

### DEC-332: session click は click path で cwd を移し、新 session は client 採番で pi 起動を遅延させる

- **What**: `handleSelectSessionFromList` は onSelectSession の前に `setSelectedCwd(s.cwd)` を呼ぶ。`handleNewSession` は crypto.randomUUID で temp ID を採番し、pi worker を起動せずに親に渡す。
- **Why**: (1) selectedCwdProp の sync effect は prop 値変化時のみ発火する（DEC-328）ので、同じセッションを別 worktree 切替後に再クリックした場合には効かない。click path で自発的に cwd を移すことで、prop 変化に依存せずに必ず追随する。(2) 新 session を作った時点で pi を spawn すると、user が結局送信しなかった場合に空の pi 実体が残る。最初のメッセージ送信まで lazy にすることでプロセスの浪費と observed worker 数の水増しを防ぐ。
- **Change freedom**: temp ID の生成方法（fallback path）や click path の副作用の順序は自由。「click 時に cwd 同期」「pi は lazy 起動」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:848, 856

### DEC-333: per-project activity は集計 key と配色を per-session と一致させる

- **What**: `projectActivity` は `getProjectActivity(allSessions, runningSessionIds, unreadSessionIds)` で per-project の `{running, unread}` を求める。selector button 上には「選択中以外の project に activity があるか」の boolean だけをドットで出し、dropdown 内の各 project 行では `showProjectActivity` が running/unread を count 付きで出す。配色は per-session の `RunningSessionIndicator` (accent) / `UnreadSessionIndicator` (#0891b2) と揃える。
- **Why**: (1) filter/list と activity の集計 key が違うと「dropdown を開いたら何も無い」という不整合を招くので、`workspaceKeyOf` と同じ stable key で数える。(2) dropdown を開かないと other-workspace の activity に気付けないと通知の意味が薄いので、collapsed 状態にドットを出す。(3) 配色を per-session と揃えることで「同じ意味の signal」だと一目で分かる。
- **Change freedom**: ドット位置・count formatting・icon 詳細は自由。「集計 key は workspaceKeyOf」「配色は per-session と一致」「collapsed 表示にも activity を出す」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:868, 871, 877, 1862

### DEC-334: SessionItem の rename/表示は skill 展開を畳み、無変更 rename は no-op

- **What**: (1) `displayFirstMessage` は SDK 展開後の `<skill>` block を `skillExpansionToCommand` で `/skill:name args` に畳んで自動タイトルの source にする。(2) rename 入力の select は renaming state 変化を rAF で待ってから `inputRef.current?.select()` する。(3) `commitRename` は `renameValue === title || name === (session.name ?? "")` を検知したら PATCH を投げずに終了する。
- **Why**: (1) 保存された first message が展開後 XML のままだと自動タイトルに raw XML が出て読めない。MessageView と同じ「畳んだ command 表現」で揃える。(2) startRename の同期 setTimeout(0) は input mount 前に発火することがあり select が空振る。renaming の state 変化に rAF を挟むと mount 完了後に確実に走る。(3) 無編集の rename で fallback title (first message / id) を実 name として書き込むと、その session の identity が事故で汚れる。skill 起動セッションの raw XML が name として persist されるのを防ぐ意味もある。
- **Change freedom**: rAF/次 tick の実装詳細、無変更判定の細部は自由。「skill は畳む」「rename 入力の select は mount 後」「無変更 rename は no-op」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:1932, 1940, 1954

### DEC-335: session row は高さ固定で reflow を起こさない

- **What**: `ITEM_HEIGHT = 54` を outer wrapper に固定し、rename 入力・delete 確認 UI・通常表示を同 slot に差し替える。
- **Why**: 行内 UI が伸縮すると virtual scroller のない現状ではリスト全体が reflow して他の行のスクロール位置がずれる。confirm/rename は突発的に発生するので、その揺れが体感に直結する。固定高で差し替える方が視線移動が安定する。
- **Change freedom**: 具体的な高さ値、内側 UI の内訳は自由。「行は高さ固定で差し替える」だけが不変。
- **Anchors**: components/SessionSidebar.tsx:2014

### DEC-336: worktree switcher は git 直下 project でのみ表示し、同一 project 内では refetch 中も表示継続

- **What**: `showWorktreeSwitcher = worktreeState?.isGit && isTopLevel && selectedCwd && selectedProject?.key === worktreeState.projectKey`。`worktreeState.forCwd === selectedCwd` の一致だけを条件にはしない。
- **Why**: (1) subdir セッションは独自 identity で扱う（DEC-321, 327）ので、そこで switcher を出すと別プロジェクトへ jump したように見える。(2) 同一 project 内の別 worktree に切り替えるたびに forCwd 一致条件で unmount が入ると、行ごと消えて再描画される。同一 project なら list を共有できる（DEC-333）ので、switcher を出しっぱなしにする方が flicker が消える。
- **Change freedom**: switcher の見た目・dropdown の中身は自由。表示条件と「非表示時は guide ラベルを出す」inactiveWorktreeSelector の存在だけが不変。
- **Anchors**: components/SessionSidebar.tsx:877

### DEC-350: Audio所有をAppShellに置く

- **What**: `useAudio` の返り値 (`soundEnabled`, `playDoneSound`, `unlockAudio`, etc.) を AppShell が保持し、ChatWindow へ props として渡す。
- **Why**: 完了音は選択中でない workspace の task 完了時も鳴らしたい。ChatWindow は非active workspace で unmount されうるため、その中で `useAudio` を持つと通知音が消える。常設の AppShell に置けば mount lifecycle と独立に鳴らせる。
- **Change freedom**: 追加の音声/通知ソースを AppShell 経由で扱ってよい。ChatWindow 側に別途 audio 状態を持たせない限り破らない。
- **Anchors**: components/AppShell.tsx:74

### DEC-351: fresh composer を一時 draft id で識別する

- **What**: `newSessionDraftId` state と `activeNewSessionDraftKeyRef` で、同一 cwd 内の連続する新規 composer を識別する。
- **Why**: 同一 cwd で「新規セッションを開始」を繰り返した際に ChatWindow が同じ key で再マウントされないと、直前の入力状態や中途 runtime が残ってしまう。ephemeral な id を key に混ぜて明示的に remount させる。
- **Change freedom**: id の生成方式 (`crypto.randomUUID` fallback を含む) は自由に差し替えてよい。「連続する fresh composer が識別可能」であればよい。
- **Anchors**: components/AppShell.tsx:88

### DEC-352: mobile では sidebar / file panel を overlay drawer 扱いにする

- **What**: `useIsMobile` が真のとき、初期 sidebarOpen を false にし、session選択・file open・toolbar操作時に drawer を自動で畳む。
- **Why**: mobile viewport では sidebar と chat と file panel が同時表示できない。overlay drawer にして chat 領域を優先し、ユーザー操作の直後に drawer を閉じることで「選んだのに見えない」体験を避ける。
- **Change freedom**: breakpoint 判定 (`useIsMobile`) の閾値や drawer アニメーション、backdrop の見た目は自由。「mobile では drawer が主 content を隠さない」原則を守ればよい。
- **Anchors**: components/AppShell.tsx:164, 547, 768

### DEC-353: top bar の dropdown は同時に一つだけ開く

- **What**: `activeTopPanel` を単一の union state (`"branches" | "system" | "session" | "language" | null`) にし、同時に複数の dropdown が開かないよう排他制御する。
- **Why**: 各 dropdown が個別 boolean だと重ね表示・focus 争奪・positioning 競合が起きる。単一 state にすれば「別 panel を開く = 現 panel を閉じる」が自明。
- **Change freedom**: panel の種類は追加してよい (union に足す)。単一 state で排他制御する原則を維持する限り自由。
- **Anchors**: components/AppShell.tsx:242

### DEC-354: `@` mention はチャット入力の autocomplete と同一書式で挿入する

- **What**: `handleAtMention` / `handleAtMentions` / `handleFileLineMention` は `buildAtMentionText` / `buildFileAtMentionsText` / `buildFileLineMentionText` を通してテキスト化する。
- **Why**: agent 側の read tool は `@` プレフィックスを剥がして path を resolve する経路をひとつしか持たない。sidebar/file viewer からの挿入が chat の autocomplete と別書式だと、agent が読めない mention を送ってしまう。
- **Change freedom**: `build*Text` 群の内部書式は自由に変えられる。「chat autocomplete と挿入経路が同じ helper を経由する」ことを守ればよい。
- **Anchors**: components/AppShell.tsx:363

### DEC-355: URL からの初期 session 復元は remount と placeholder 表示を抑止する

- **What**: `initialSessionRestored` state と `suppressCwdBumpRef` ref で、`?session=` 経由の初期化フローが完了するまで placeholder を出さず、sidebar からの cwd 通知でも `sessionKey` を bump しない。
- **Why**: URL param 復元中に welcome placeholder を挟むと視覚的に一瞬「空 → 復元後 chat」の点滅が出る。加えて、`useAgentSession` は mount-only effect で content を読み込むため、welcome mount → session mount という遷移だと復元 session のメッセージが読まれない。復元専用フラグと bump 抑止で「session 付きで一発 mount」を保証する。
- **Change freedom**: フラグの命名や初期化タイミングは変えてよい。「復元中は placeholder を出さず、復元完了で一度だけ mount する」不変を守ればよい。
- **Anchors**: components/AppShell.tsx:383, 385, 423, 487, 550, 807

### DEC-356: workspace 復元 async に token guard を掛ける

- **What**: `workspaceRestoreTokenRef` を単調増加させ、`restoreWorkspaceContext` の非同期完了時に古い token のレスポンスを破棄する。
- **Why**: workspace を高速に切り替えたときに前の workspace の `/api/sessions` レスポンスが後着し、ユーザーが既に離れた project の session を蘇らせる (レースコンディション) のを防ぐ。
- **Change freedom**: 非同期 API を追加する場合も同じ token パターンで無効化する。単調増加 counter でなく AbortController でも良い。
- **Anchors**: components/AppShell.tsx:387, 448

### DEC-357: 全ての active-session 遷移を `setLastOpenSession` で記録する

- **What**: `selectedSession` 変化時の effect で `projectKey ?? activeProjectKeyRef ?? workspaceKeyOf(selectedSession)` を求め、常に `setLastOpenSession` を呼ぶ。
- **Why**: sidebar 選択以外 (新規セッション作成・fork 経由) の遷移も lastOpen 記録に含めないと、次回 workspace 切替時に復元される session がずれる。transient session は server 由来 projectKey を持たないため、active project の identity を fallback として使う。
- **Change freedom**: fallback の優先順位は状況に応じて調整可。「あらゆる active-session 遷移が記録される」原則を守ればよい。
- **Anchors**: components/AppShell.tsx:394

### DEC-358: workspace 切替時の last-open session 復元は defensive に失敗する

- **What**: `restoreWorkspaceContext` は `/api/sessions` から live list を取り、`(1)` 削除済み → 記憶を破棄, `(2)` project 移動 → 記憶を破棄, `(3)` 通信失敗 → 記憶を保持, の3分岐で扱う。復元 session は必ず新規 mount で選択する。
- **Why**: 復元対象がユーザー操作で消えたり移動したりしていても壊れないこと、通信一過性エラーで記憶を失わないこと、`useAgentSession` の mount-only effect が動くこと、をひとまとめに満たすため。
- **Why not**: 個別に「削除検出だけ」実装すると通信失敗時に記憶を消してしまい、次回接続復旧時に welcome に戻る。
- **Change freedom**: `/api/sessions` を別 API に置き換えたり、fetch を SWR に変えるのは自由。上記3分岐の意図が保たれること。
- **Anchors**: components/AppShell.tsx:440, 451, 456, 460, 468, 523

### DEC-359: 同一 project 内の cwd 通知は remount を起こさない

- **What**: `handleCwdChange` は (a) cwd null は初期 mount 扱い、(b) 同一 cwd で projectKey だけ変化した hydrate はユーザー操作ではない、(c) 同一 project 内の worktree 切替は既存 session を維持、の3ガードで remount を最小化する。fresh composer は cwd が移動した場合のみ remount する。
- **Why**: 全ての cwd 変化で sessionKey を bump すると、hydrate や worktree 切替のたびに chat が飛んで UX が壊れる。他方 fresh composer の runtime は cwd 移動時に remount しないと、既に起動済み runtime が古い cwd に送信を続けてしまう。
- **Change freedom**: guard の条件は追加してよい。remount と no-remount の判定境界は当該 DEC を参照して更新する。
- **Anchors**: components/AppShell.tsx:480, 492, 494

### DEC-360: 異なる project 切替では現 session と file tabs を破棄する

- **What**: `handleCwdChange` が `currentProject !== newProject` を検出したら、`selectedSession` を null 化し、`fileTabs` を空にし、`rightPanelOpen` を false にし、`restoreWorkspaceContext(newProject)` を呼ぶ。
- **Why**: file tabs は絶対 path キーなので他 project に持ち越すと path が食い違って壊れる。session も外 project のものは無関係。同一 project 内 worktree 切替では tabs を残したい (path はそのまま解決できる) ので分岐する。
- **Change freedom**: 破棄対象を追加してよい (例: 新 UI state)。同一 project 内では tabs 保持、異 project では破棄、の分岐を守る。
- **Anchors**: components/AppShell.tsx:501, 519

### DEC-361: 同一 session の再選択は remount を避ける

- **What**: `handleSelectSession` は `isRestore` でない再クリック時、`selectedSession.id === session.id` かつ `workspaceKeyOf` が一致するときは早期 return する。
- **Why**: 既に開いている session を再クリックしたら chat の scroll 位置や入力中テキストを守りたい。remount するとロード/positioning サイクルが再走してしまう。ただし cwd 移動が pending の場合は re-select flow を通す必要がある。
- **Change freedom**: 一致判定条件を追加してよい (例: version key)。「同一 session 再クリックで作業状態が飛ばない」不変を守る。
- **Anchors**: components/AppShell.tsx:532

### DEC-362: URL 復元時は `router.replace` を呼ばない

- **What**: `handleSelectSession` の末尾で `isRestore` が true なら `router.replace` を skip する。
- **Why**: `?session=` が既に正しい state のときに `router.replace` を呼ぶと、production Next.js で Suspense boundary が remount ループに入る (dev では観測しづらい)。dev/prod parity を確保するため復元時は router を触らない。
- **Change freedom**: `isRestore` の判定方法（現行は復元経路から明示 flag として渡す）や、router を skip する具体条件は自由に変えてよい。「復元経路では `router.replace` を呼ばない」だけが不変。
- **Revisit when**: Next.js の Suspense/router 挙動が変わる、または本アプリの routing が App Router 以外に移行するとき。
- **Anchors**: components/AppShell.tsx:553

### DEC-363: transient SessionInfo を session 一覧から hydrate する

- **What**: 新規セッション or fork 作成直後に `hydrateSelectedSession(sessionId)` を呼び、`/api/sessions` の該当 entry から `projectKey` を含めて上書きする。
- **Why**: client 側で組み立てた transient SessionInfo は server 計算の `projectKey` を持たない。`handleCwdChange` の同一 project 判定 (DEC-359) がこれに依存するため、hydrate しないと直後の worktree 切替で chat が閉じてしまう。
- **Change freedom**: hydrate 経路 (fetch / SWR / WebSocket) は自由。「transient を作ったら server truth で埋め直す」意図を守る。
- **Anchors**: components/AppShell.tsx:581

### DEC-364: 圧縮後の hasMessages 判定は sessionStats と session file の両方を見る

- **What**: auto-name ボタンの enable 判定で、`sessionStats?.userMessages > 0 || selectedSession.messageCount > 0` の OR を採る。
- **Why**: 文脈圧縮 (context compaction) 後は現在ロード中の messages から user 発話が消えていることがある。session file 側の総メッセージカウントも参照しないと「発話があるのに auto-name できない」状態になる。
- **Change freedom**: 判定に別 counter を追加してよい。「圧縮後も発話有無を正しく判定できる」ことを守る。
- **Anchors**: components/AppShell.tsx:1163

### DEC-365: cache hit rate の分母は input系 token 全体

- **What**: `cacheRead / (cacheRead + cacheWrite + input) * 100`。
- **Why**: cache hit rate を「今回 input 相当のうち cache から読めた割合」として意味付けるため、分母は cache read + cache write + 生 input の合計 (すべて input 側の課金対象) にする。output は分母に含めない。
- **Change freedom**: 表示桁数や色分けは自由。分子/分母の定義を変えるなら本 DEC を更新する。
- **Anchors**: components/AppShell.tsx:1902

### DEC-380: 画像添付フォーマットの旧新両対応

- **What**: `UserMessage` から画像を復元するとき、現行のネスト画像形式 (`block.source.type === "base64"`) と、旧 pi-ai のフラット形式 (`block.data` / `block.mimeType`) の両方を受け付ける。
- **Why**: pi-web v0.8.9 系のユーザーが持つ既存メッセージ履歴には旧フラット形式で保存された画像ブロックが混在しており、フォーク後も過去メッセージからの画像復元を壊さないため。
- **Change freedom**: 対応対象の入力形式を追加/削除するのは自由。ただし旧フラット形式を落とす場合は既存履歴のマイグレーションが前提。
- **Anchors**: components/ChatInput.tsx:270

### DEC-381: skill dormancy はパレット open ごとに再取得、未知スキルはアクティブ扱い

- **What**: `/api/skills` を「スラッシュパレットが開かれるたび」に呼び出して `disableModelInvocation` を取り込み、その辞書に載っていないスキルは非休眠 (アクティブ) として扱う。
- **Why**: スキル休眠状態は skills パネルから随時トグルされるので、コンポーネント初期化時のみ取得すると陳腐化する。open のタイミングで再取得すればユーザーが直前に切り替えた結果がすぐパレットに反映される。辞書未掲載のケースは「まだ情報が届いていない/失敗した」状態が主で、そのときにデフォルトを「休眠 (使えない)」にすると全スキルが見えなくなり体験が壊れるため、安全側は「アクティブ」。
- **Change freedom**: フェッチ頻度 (毎回 open か debounce か) や失敗時のフォールバック UI は差し替え可。「未知はアクティブ」の既定を反転する場合は、ロード失敗時にパレットが空になる問題を別で解く必要がある。
- **Anchors**: components/ChatInput.tsx:198, components/ChatInput.tsx:1176

### DEC-382: `enabledModels` の 0 件マッチを警告として可視化

- **What**: 設定側で解決した `enabledModels` に、どのモデルにもマッチしなかったパターンが含まれる場合、そのリストを警告バナーとして常に表示する。
- **Why**: 設定タイポでモデルが 0 件になっても静かに動くと、ユーザーは「なぜ選べないか」に気付けない。警告として上げれば設定の見直しに直結する (元 issue #307)。
- **Change freedom**: 見せ方 (tone/レイアウト/文言) は自由。存在する限り可視化するというルール自体は維持。
- **Anchors**: components/ChatInput.tsx:369

### DEC-383: キュー復元は TUI の順序に合わせる

- **What**: `prependText` でキューされたテキストを差し戻すとき、`queued テキスト → 既存入力` の順で空行 1 行を挟んで連結する。
- **Why**: 同じアクションを TUI 側でも実装しており、Web 側だけ順序が違うとユーザーがワークフローを切り替えるたびに混乱する。TUI の `applyPrepend` 相当と挙動を合わせる。
- **Change freedom**: セパレータの中身 (改行数など) は変えられる。順序を反転する場合は TUI 側も同時に変える。
- **Anchors**: components/ChatInput.tsx:493

### DEC-384: 送信復元と再マウントを跨いだドラフト同期

- **What**: `restoreSubmission` は (1) 先に走っている `clearInput` と衝突しないよう queued 状態と合成し、(2) 再マウントに備えて `setDraft` を同期的に呼び、(3) React の functional update より先に `valueRef` / `attachedImagesRef` の imperative snapshot を更新する。
- **Why**: 送信の楽観 UI は `handleSend` 直後に `clearInput` を打ち、その後で pi 側の reject/promotion が返る。素の React state 経由だと (a) reject が観測するのは既に消えた DOM テキスト、(b) 最初の楽観送信で ChatWindow が empty-state から抜けて本コンポーネントが unmount、(c) セッション昇格で draftKey が rekey されるといった 3 つのタイミングが競合する。同期永続化＋imperative snapshot 先行更新で「復元テキストが取りこぼされる」を潰す。
- **Why not**: functional updater のみに寄せると (b)/(c) のタイミングで捨てられるため、imperative の複線化は不可避。
- **Change freedom**: 3 つの手当ての実装方法は差し替え可。「復元テキストが不揮発に落ちる」インバリアントだけは維持。
- **Anchors**: components/ChatInput.tsx:541, components/ChatInput.tsx:556, components/ChatInput.tsx:568

### DEC-385: cwd 未設定なら @ 補完は完全無効

- **What**: `updateAtQuery` は `cwd` が null/undefined のとき即座に `atQuery` をクリアして戻り、@ トークン抽出も file-index フェッチも走らない。
- **Why**: cwd が無いのはディレクトリ未選択の新規セッション状態で、file-index API に渡すべき基準ディレクトリが存在しない。半端に @ を検知するとエラーバナーや空メニューを出してノイズになる。「機能ごとオフ」が最もシンプル。
- **Change freedom**: cwd が付いた瞬間に有効化される挙動は維持。cwd 未設定でも別ソース (例: プロジェクトインデックス) から補完する拡張は加えられる。
- **Anchors**: components/ChatInput.tsx:790

### DEC-386: 切り詰めインデックスはサーバー検索でフォールバック

- **What**: file-index がクライアント上限で truncated されている場合、@ クエリを (debounce つきで) サーバー側にも投げて全リストからランク付けを取り、ローカル一致は「プロビジョナル表示」として即時レンダリングしつつ、サーバー結果が返ったら差し替える。
- **Why**: 大きなリポジトリではクライアント index に載らない深いパスがあり、ローカルフィルタだけだと見つからない。かといってサーバー往復を待つと入力体感が悪くなるので「即時のローカル → 遅延のサーバー」の 2 段構えにする。stale な応答は `{cwd, query}` タグで無視する。
- **Change freedom**: debounce 幅、UI のヒント文言、プロビジョナル/正式の見せ分けは自由。ローカル即時＋サーバー最終の 2 段構造は維持。
- **Anchors**: components/ChatInput.tsx:807, components/ChatInput.tsx:1740

### DEC-387: file-index / @ サーバー検索の失敗はサイレントに劣化

- **What**: file-index 取得と @ サーバー検索の `.catch` は、UI にエラーを出さず、直前のインデックスやローカル一致の表示をそのまま維持する。次のキーストロークまたは次回 open で自然に再試行される。
- **Why**: これらは補助入力の裏側であり、失敗するたびにトーストや赤字を出すとメイン入力の邪魔になる。ユーザーの主要動作 (テキスト送信) は失敗しても続行できるので、UI ノイズを避けて機会主義的にリトライする方が全体の作業感が良い。
- **Change freedom**: リトライ契機 (open/keystroke/timer) は差し替え可。「メイン入力を止めない」原則だけ守る。
- **Anchors**: components/ChatInput.tsx:821, components/ChatInput.tsx:865

### DEC-388: @ トークンとメニュー開閉の同期

- **What**: `atQuery` の `{start, quoted, query}` を鍵に、@ トークンが出現・変化するたびにメニューを開き `activeIndex` を 0 にリセットする。Escape で閉じても、次のキーストロークで @ トークンが再認識されればまた開く。
- **Why**: スラッシュメニューと挙動を揃えて「Esc で今回だけ消える / 再入力で復活する」体験を作る。トークン一致で `useEffect` を回すことで onChange/onSelect のどちらから来ても同じロジックで再開できる。
- **Change freedom**: 鍵の粒度 (start だけ / quoted 込み) は自由。Esc 一時クローズ＋次入力で再開の 2 段挙動は維持。
- **Anchors**: components/ChatInput.tsx:833

### DEC-389: file-index はメニュー open 契機で取得、サーバー 10 秒キャッシュに乗せる

- **What**: file-index のフェッチは @ メニューが開いた瞬間にのみ発火。サーバー側が cwd 単位で ~10 秒キャッシュしている前提で、close→再 open は基本的にキャッシュヒットで安く済ませる。入力途中では再フェッチしない。
- **Why**: 入力ごとに fetch すると毎キーで往復が発生し、大量のリクエストになる。@ が現れるまで file-index は不要なので、「メニュー open」を唯一の契機に絞れば、サーバー側の短命キャッシュと合わせて「初回だけ実費、再 open はほぼ無料」に落ちる。
- **Change freedom**: TTL 秒数、リフェッチ契機 (フォーカスや unmount 時など) は変えて良い。「入力中は fetch しない」だけは守る。
- **Anchors**: components/ChatInput.tsx:845

### DEC-390: @ 補完の TUI 準拠トークン処理

- **What**: 補完適用時の後処理を TUI `applyCompletion` に合わせる。(1) 引用符付きトークン (`@"..."`) の補完では、挿入テキストが閉じ引用符を持つので既存の閉じ引用符を除去する。(2) 挿入直後は `setValue` が onChange を発火しないので `extractAtQuery` を手動で走らせて `atQuery` を再導出し、ファイル補完なら末尾スペースでトークンを閉じてメニューを閉じ、ディレクトリ補完なら `/` で終わらせてトークンを維持しドリルダウンを続けさせる。
- **Why**: Web と TUI で同じ補完操作の結果が異なると、ユーザーがワークフローを移すたびに手が止まる。引用符ダブりや「補完後にメニューが閉じない/勝手に閉じる」といったズレを潰す。
- **Change freedom**: 判定の実装は自由。TUI との操作結果の一致だけは守る。
- **Anchors**: components/ChatInput.tsx:880, components/ChatInput.tsx:888

### DEC-391: IME 変換中はメニュー系キー入力を傍受しない

- **What**: @ メニュー (および同種のカスタムキーハンドリング) は `isComposing` の間、Arrow/Enter/Tab/Escape を処理しない。
- **Why**: IME 変換中の矢印/Enter/Tab は候補選択・確定のキーで、これらをメニュー側で `preventDefault` すると変換操作が壊れる。日本語入力ユーザーが最も踏むので、composition 中は必ずスルーする。
- **Change freedom**: 判定に使うフラグ (`nativeEvent.isComposing` / `keyCode 229` / `isComposingRef`) は追加/差し替え可。「composition 中はキーを取らない」原則は不可侵。
- **Anchors**: components/ChatInput.tsx:1092

### DEC-392: モデル選択肢の優先度と表示制約

- **What**: (1) `modelList` (provider 情報付き) が来ていればそちらを使い、無いときだけ `modelNames` にフォールバックする。(2) デスクトップの右パディングは 16px の基本値に ChatMinimap の 36px 分を足して 52px にし、視覚的に整列させる。(3) モバイルではモデル選択パネルを左マージン 8px 固定＋幅 `calc(100vw - 16px)` 上限にして、長いモデル名でもパネルが画面外にはみ出さないようにする。
- **Why**: いずれも「モデルまわりの選択・表示が UI として破綻しないための最低ライン」。provider が無いと group ヘッダが崩れる、右パディングが揃わないとミニマップと二重に見える、モバイルで幅制御が無いと horizontal scroll が発生する。
- **Change freedom**: 数値 (52px, 8px) や上限のかけ方は自由。「provider ソース優先」「ミニマップ整列」「モバイルで画面外に出さない」の 3 つの目的は維持。
- **Anchors**: components/ChatInput.tsx:1260, components/ChatInput.tsx:1337, components/ChatInput.tsx:2086

### DEC-410: プロバイダーアイコンのカラー戦略

- **What**: `PROVIDER_ICONS` の各エントリに `hasColor` boolean を持たせ、`ProviderIcon` で分岐して描画する
- **Why**: lobehub のカラーアイコンは自己配色 SVG のため wrapper 不要、モノクロアイコンは `currentColor` を継承させることでライト/ダークテーマに追従できる。宣言時点でどちらのレンダリング契約に従うかを固定することで、呼び出し側は size 以外の style を意識せずに済む
- **Change freedom**: 個別プロバイダーがどちらの Icon コンポーネントを持つか、色トークンの選択、追加/削除
- **Anchors**: components/ModelsConfig.tsx:52, components/ModelsConfig.tsx:1726

### DEC-411: デュアル認証プロバイダーは両ピッカーセクションに出す

- **What**: `OAuthProvider.supportsApiKey` と `ApiKeyProvider.supportsOAuth` の marker prop を用意し、両対応プロバイダーはピッカーの OAuth セクションと API Key セクションの双方に出す
- **Why**: 認証方式は排他ではなく、ユーザーはどちらでも接続できる。片方だけに出すとサブスクを持たない側が「利用不可」と誤認する。marker prop を分離することで、片側の一覧から反対側の存在を隠さずに済む
- **Change freedom**: セクションのラベル、並び順、marker prop 名
- **Anchors**: components/ModelsConfig.tsx:102, components/ModelsConfig.tsx:112

### DEC-412: compat は provider と model にまたがり model 側が勝つ

- **What**: `effectiveCompat()` は provider.compat と model.compat を結合して返し、UI は結合値を表示する。ただしトグル操作の書き込みは常に model.compat のみへ行う
- **Why**: provider-composer は実行時に model 側優先で merge するため、UI が model のみを読むと hand-edited な provider レベル設定が反映されず、逆に merged 値へ書き込むと provider 全体の共通設定を上書きしてしまう。読みは merged、書きは model 側限定という非対称構造でこれを両立させる
- **Change freedom**: merge の実装、UI の表示形式
- **Anchors**: components/ModelsConfig.tsx:714

### DEC-413: HeaderListEditor はドラフト行をローカル state に留める

- **What**: HeaderListEditor は入力行を `useState` のローカル配列で保持し、`serializeHeaderRows` で有効行のみを親へ通知する
- **Why**: 空欄の name/value をそのまま Record<string,string> に保存すると "" キーが HTTP ヘッダ名として渡り不正になる。編集途中の空欄行はローカルで保持し、確定した行のみを親状態に持ち上げることでこの事故を防ぐ
- **Change freedom**: 行追加/削除の UI、シリアライズ条件
- **Anchors**: components/ModelsConfig.tsx:719

### DEC-414: OAuth 成功は SSE 側の success イベントで確定させる

- **What**: `submitCode` は POST に対する HTTP 200 では成功状態に遷移させず、成功状態遷移は EventSource の "success" メッセージ受信時にのみ行う
- **Why**: POST 200 は「サーバがコードを受け付けた」時点で返るが、その後のトークン交換や設定書き込みは非同期に走る。成功を SSE 側でのみ確定させることで、片側だけ成功して片側で失敗する split-brain 状態を避けられる
- **Change freedom**: エラー表示、リトライ挙動
- **Anchors**: components/ModelsConfig.tsx:1405

### DEC-415: dual-auth プロバイダー切替では両プロバイダーリストを同時にリロード

- **What**: `refreshAuthProviders` は `loadOAuthProviders` と `loadApiKeyProviders` を必ずセットで呼ぶ
- **Why**: dual-auth プロバイダーは資格情報の種別が切り替わると OAuth リストと APIKey リストの間で移動する。片方だけリロードするとプロバイダーが両方のリストに残って重複表示され、古い側の row から disconnect すると新規発行したばかりの資格情報を消してしまう (#309)
- **Change freedom**: 呼び出しタイミング、リクエストの並列化方式
- **Anchors**: components/ModelsConfig.tsx:1894

### DEC-416: 管理プロバイダーとカスタムの間にだけ区切り線を出す

- **What**: OAuth / APIKey いずれかの管理プロバイダーが有効で、かつカスタムプロバイダーも存在する場合にのみ区切り線 `<div>` を描画する
- **Why**: 管理プロバイダーが 0 件のときに区切り線を出すとリスト冒頭に浮いた線が残り、視覚的な「隠れセクション」を暗示してしまう。両側が空でない場合のみ divider を出すことで、区切りが「意味のある境界」に対応するよう保証する
- **Change freedom**: divider のスタイル、条件式の順序
- **Anchors**: components/ModelsConfig.tsx:2124

### DEC-417: プロバイダー切替時に detail 内部 state を初期化

- **What**: `OAuthDetail` と `ApiKeyDetail` の両方で、`provider.id` の変化を依存にした `useEffect` で内部の loginState / apiKey / error / EventSource を初期状態にリセットする
- **Why**: detail コンポーネントは選択されたプロバイダーに紐づく認証進行状態を持つ。プロバイダー切替時に state が持ち越されると、新プロバイダー画面に前プロバイダーの認証途中 UI や EventSource が残り、誤ったプロバイダーに向けた副作用（コード送信・disconnect）を許してしまう
- **Change freedom**: 依存配列に含める key、リセット対象の粒度
- **Anchors**: components/ModelsConfig.tsx:1321, components/ModelsConfig.tsx:1572

### DEC-435: 完了音の所有権を AppShell に置き上書き耐性のあるラップにする

- **What**: 完了音の state と操作を AppShell が保有し、ChatWindow は props 経由で受け取って `wrappedOnAgentEnd` として合成する。`playDoneSound` は ref 経由で常に最新参照を保つ。
- **Why**: (1) 完了音の所有権を ChatWindow に置くと、非アクティブなワークスペースでタスクが終わったときにコンポーネントがマウントされていないため鳴らない。AppShell に置けば全ワークスペース横断で鳴らせる。(2) `useAgentSession` は内部で `handleAgentEventRef` を毎レンダで最新コールバックに上書きするため、そこにラッパを差し込んでも初回再レンダで消える。上書きされない `onAgentEnd` 側でラップするのが唯一安定なフック点。
- **Change freedom**: 完了音を鳴らすトリガー種別 (onAgentEnd, extensionDialog 到来など) は追加してよい。所有権を ChatWindow 側に戻すことは不可。
- **Anchors**: components/ChatWindow.tsx:46, components/ChatWindow.tsx:255-269

### DEC-436: 更新チェックはベストエフォートでサイレントに失敗させる

- **What**: `NewSessionUpdateLink` は `/api/app-update` の失敗を `.catch(() => {})` でサイレントに握り潰す。
- **Why**: 新規セッション作成の見出し領域に表示するオプショナルリンクであり、更新確認 API の失敗を UI エラーとして露出させると新規セッション開始体験を阻害する。表示自体が nice-to-have なので沈黙が正解。
- **Change freedom**: エラー時のフォールバック表示や再試行を追加してよい。エラーを throw させたり loading spinner を残したりするのは不可。
- **Anchors**: components/ChatWindow.tsx:81-96

### DEC-437: user メッセージと compaction 要約を等価なグループアンカーとして扱う

- **What**: `isGroupAnchor` は `role === "user"` に加えて `role === "custom" && customType === "compaction"` も true を返す。折り畳みグループ化と live-tail 判定 (`lastAnchorIdx`) の両方で使う。
- **Why**: pi のセッションは通常 user prompt → process → final answer をひとつのターンとして `ProcessDetailsGroup` に畳む。compaction がターン途中で走ると元の user prompt が削除され、代わりに compaction 要約 (role "custom") が挿入される。この要約をアンカー扱いしないと、compaction 後の tool call と最終回答がすべて単独メッセージとして描画され、折り畳みが効かなくなる。また live-tail 判定側で `lastUserIdx` を使うと、compaction 要約がストリーミング中セグメントを支えているケースを見落とす。
- **Change freedom**: 追加のアンカー種別 (system marker 等) を増やしてよい。user だけを特別扱いに戻すのは不可。
- **Anchors**: components/ChatWindow.tsx:187, components/ChatWindow.tsx:708-711

### DEC-438: onEditContent を useCallback で安定化して履歴再レンダを防ぐ

- **What**: `handleEditContent` を `chatInputRef` にだけ依存する `useCallback` で包む。
- **Why**: `MessageView` は React.memo() でメモ化されており、props の参照恒等が変わるたびに再レンダされる。編集ハンドラをインラインで生成すると毎レンダで新規参照になり、履歴に並ぶ全 MessageView が再レンダされる。長い会話ではこれがフレーム落ちの直接原因になる。
- **Change freedom**: 依存追加は必要な場合に限る。インライン関数への差し戻しは不可。
- **Anchors**: components/ChatWindow.tsx:272-275

### DEC-439: 遅延ロードとスクロール位置保全で長い履歴を扱う

- **What**: `visibleCount` を `VISIBLE_PAGE_SIZE` から始め、IntersectionObserver で sentinel が可視になったらページを増やす。ページ挿入直前に `captureScrollDistance` で底からの距離を保存し、挿入後の `useLayoutEffect` で `restoreScrollTop` により位置を戻す。
- **Why**: 数百件規模の履歴を初回で全描画すると初期表示が重い。上部スクロールで段階的に古いページを増やす方式にすればコストを分割できる。ただしメッセージを prepend すると `scrollHeight` が伸び、素朴には表示位置が飛ぶ。捕捉→復元でビューポート位置を保つ。
- **Change freedom**: `VISIBLE_PAGE_SIZE` や増分ロジックの変更は許容。スクロール位置保全を外して素朴 prepend に戻すのは不可。
- **Anchors**: components/ChatWindow.tsx:310-343

### DEC-440: セッション統計とコンテキスト使用量はスカラーキーで AppShell に伝播する

- **What**: `sessionStats` と `contextUsage` はそれぞれスカラーフィールドを `|` 連結したキー (`statsKey`, `ctxKey`) を計算し、`useEffect` の依存に置く。実体は ref 経由で最新参照を渡す。
- **Why**: これらのオブジェクトはレンダごとに新規オブジェクトとして生成される (参照恒等が毎回変わる) ため、そのまま依存配列に置くと毎レンダで通知が走り、AppShell の setState と再レンダを連鎖させて無限ループになる。スカラー結合キーを比較すれば実質的な変更のみで通知が走る。
- **Change freedom**: キーに含めるフィールドの取捨は許容。オブジェクトそのものを依存に戻すのは不可。
- **Anchors**: components/ChatWindow.tsx:347-384

### DEC-441: toolResultsMap を messages 依存 useMemo で安定化する

- **What**: `toolResultsMap` は `messages` を依存とする `useMemo` で構築する。
- **Why**: `MessageView` は `React.memo()` で包まれており、`toolResults` prop の参照恒等が変わると再レンダが走る。ストリーミング更新は `streamState` 側で吸収され `messages` 配列は変わらないので、useMemo で参照を安定化させれば `message_update` イベントごとの全 MessageView 再レンダを避けられる。過去にインライン `new Map()` を使っており memo() が無効化されていた経緯がある。
- **Change freedom**: 内部の Map 構築ロジックは変更してよい。インライン `new Map()` への差し戻しは不可。
- **Anchors**: components/ChatWindow.tsx:390-402

### DEC-442: ストリーミング末尾ではタイムスタンプ表示を抑制する

- **What**: 末尾のアシスタントメッセージについて `showTimestamp` を計算するとき、`streamState.isStreaming` かつ `idx === messages.length - 1` の場合は false に落とす。
- **Why**: ストリーミング中はライブ更新される別バブル (streaming bubble) 側がタイムスタンプを担う。確定済み側にも表示すると、同一位置で同一時刻が二重表示され UI が乱れる。
- **Change freedom**: タイムスタンプ表示ポリシー全体を再設計してよい。ストリーミング中の二重表示を許すのは不可。
- **Anchors**: components/ChatWindow.tsx:747-749

### DEC-443: ターン内 write/edit を再走査して書き込みファイル一覧を復元する

- **What**: 最終アシスタント応答をレンダする直前、`userIdx + 1` から `finalAssistantIdx` までのアシスタントメッセージを走査し、全 content ブロックを集めてから `extractTurnWrittenFiles` に渡す。
- **Why**: pi では tool call が個別のアシスタントエントリとして保存されるため、最終回答メッセージ自体には「このターンで何を書いたか」の記録が残らない。ターン全体の write/edit ブロックを事後的に集約しないと「書き込みファイル一覧」を UI に出せない。
- **Change freedom**: 走査対象範囲や `extractTurnWrittenFiles` の実装は変更してよい。最終メッセージ単体だけを見る方式に戻すのは不可。
- **Anchors**: components/ChatWindow.tsx:855-867

### DEC-455: トークン概算のCJK/サロゲート考慮

- **What**: 主要トークナイザ(GLM/DeepSeek/GPT-o200k)で観測される「CJK 1 char ≒ 1 token / 非CJK 1 char ≒ 1/4 token」という粗い比率で、ストリーミング中のトークン数を近似する。ストリーミング差分を追加する際は、直前のテキストの末尾がハイサロゲートで新しいデルタがローサロゲートから始まる場合に限り、非CJKとして二重に計上した分(1/4 token)を差し戻す。
- **Why**: モデルごとに正確なトークナイザをブラウザに載せると重すぎるため、t/sメーター用途に耐える精度で軽量に置き換える必要がある。サロゲート対の分割は特に絵文字混じりのストリームで発生し、放置すると同じ文字を二回数えるので、差分適用時にだけ補正する。
- **Change freedom**: 係数(1/4)や補正タイミングは調整可、ただし「差分は前回テキスト全体を再スキャンしない」原則は維持する(t/sの更新頻度が落ちるため)。
- **Anchors**: components/MessageView.tsx:29, components/MessageView.tsx:66

### DEC-456: 大きいメッセージのMarkdown回避

- **What**: 100_000文字を超える本文は`SafeMarkdownBody`でクリックして開くプレーンな`<pre>`表示に退避し、通常のMarkdownパイプライン(react-markdown+KaTeX+syntax highlighting)には流さない。
- **Why**: 数百KB級のHARダンプやログ貼り付けをMarkdownとして描画すると、メインスレッドが数秒〜十数秒固まりチャット全体が操作不能になる。閾値越えではまず表示コストを断ち切り、ユーザーが明示的に「見る」と選んだ場合だけプレーンで表示する。
- **Change freedom**: 閾値(100_000)は端末性能に応じて調整可、退避先UIは`<pre>`以外でも可(コピー可能な生テキストであること)。
- **Anchors**: components/MessageView.tsx:82, components/MessageView.tsx:91

### DEC-457: ユーザーバブルの高さ上限

- **What**: ユーザー送信バブルの最大高さを300pxに固定し、超えた分はバブル内スクロールに閉じ込める。
- **Why**: 数千行のペーストを含むメッセージがそのまま伸びると、直近のアシスタント応答が画面外に押し流されて会話の連続性が失われる。バブルに閉じ込めることで「送った内容は残しつつ会話は流れる」を成立させる。
- **Change freedom**: 数値(300px)は調整可、スクロール方向(縦のみ)や overflow の閉じ込め方針は維持する。
- **Anchors**: components/MessageView.tsx:139

### DEC-458: writtenFilesは呼び出し側で計算する

- **What**: `TurnWrittenFiles`に渡すファイル一覧は、`MessageView`ではなく`ChatWindow`側でターン全体のsuccessful write/edit tool callから集計して`writtenFiles` propで渡す。
- **Why**: 保存済みメッセージの経路ではtool callがアシスタント本文とは別entryに切り出されるため、`MessageView`が受け取る1メッセージだけを見ても書き込まれたファイルを網羅できない。ターン全体を握っている`ChatWindow`でしか正しく集計できない。
- **Change freedom**: 集計ロジックの置き場所は`ChatWindow`である必要はなく「ターン全体を持つ呼び出し側」であれば可、prop名や形状は変更可。
- **Anchors**: components/MessageView.tsx:187

### DEC-459: toolResultは単独描画しない

- **What**: `role === "toolResult"`のメッセージは`MessageView`が受け取っても`null`を返し、対応する`toolCall`ブロックの下にインライン描画されるパスに任せる。
- **Why**: toolCallとtoolResultは論理的に対で、時系列的に別entryとして流れてきても表示上はペアで見せた方が読解コストが低い。単独描画も許すと同じ結果が2回出るか、順序が乱れて対応関係が読めなくなる。
- **Change freedom**: ペアリング未成立の孤児toolResultをどう扱うかは別の判断、少なくとも「toolCallと対で表示されるべき正常系」ではこのパスで抑止する。
- **Anchors**: components/MessageView.tsx:245

### DEC-460: 画像コンテンツの二形式を両対応する

- **What**: `ImageContent`の描画では、`lib/types.ts`の`{source:{type,data,media_type,url}}`入れ子形式と、pi-aiオンディスク形式の`{data, mimeType}`フラット形式の両方から`src`を組み立てる。
- **Why**: この画面はライブメッセージ(型定義通り)と保存済みメッセージ(オンディスク形式)の両方をレンダリングする起点で、どちらか一方に寄せるとリロード後に画像が欠ける/生成直後に画像が欠けるという片側だけの破損を招く。上流での正規化が入るまで表示層で両対応する。
- **Change freedom**: どちらの形式を正とするかは上流の正規化が入った時点で決められる、それまでは表示層でのフォールバックを維持する。
- **Anchors**: components/MessageView.tsx:322

### DEC-461: 生成時間はセッションファイルの時刻差から導く

- **What**: thinkingブロックのduration表示と、tool callのdurationは、いずれもセッションファイルに記録された時刻の差から算出する。thinkingは「前メッセージ終端 → 本メッセージ終端」の差を生成時間の近似として採り、tool callは「assistantメッセージ時刻(生成終了)→toolResult時刻(実行終了)」の差を所要時間とみなす。
- **Why**: 保存済みメッセージにはブロック単位の開始/終了時刻がないため、streaming中に計測した`streamingDurations`はリロード後には失われる。ファイル時刻差なら再表示でも同じ値が出る。thinking側は「思考+最初のツール呼び出しまでのテキスト」を含むので厳密な思考時間ではないが、UIで見せる粒度としては十分。
- **Change freedom**: 精度が問題になれば上流(pi-ai)側でブロック単位の時刻を保存する方向に倒せる、UI側の近似計算は捨ててよい。
- **Anchors**: components/MessageView.tsx:617, components/MessageView.tsx:624

### DEC-462: user-run bashをToolCallBlockに寄せる

- **What**: `BashExecutionMessage`(ユーザー実行のbash)を描画する`BashExecutionView`では、等価な`ToolCallContent`と`ToolResultMessage`のペアを合成して既存の`ToolCallBlock`に流す。
- **Why**: ユーザー実行bashとエージェント実行bashの見た目・展開挙動・結果ペイン構造を統一すると、ユーザーは「bashの結果はここに出る」という単一のメンタルモデルで両者を読める。専用UIを別途組むと表示差分の保守が二重になる。
- **Change freedom**: 合成shapeは`ToolCallBlock`のI/Fに従う限り自由、bash特有の`fullOutputPath`などの拡張表示は`BashExecutionView`側でラップする形で足せる。
- **Anchors**: components/MessageView.tsx:1648

### DEC-465: BranchNavigatorのインライン埋め込み契約

- **What**: `BranchNavigator`は独立パネル用途とトップバー等への埋め込み用途を1コンポーネントで賄い、後者向けに`inline`/`containerRef`/`open`/`onToggle`/`compact`/`hideInlineButton`の6つのpropsで外部制御とレンダリング切替を受ける。
- **Why**: ブランチ選択UIを独立コンポーネントとして持ちつつ、上位のツールバーからは「トリガーは自分で描く、開閉状態は自分で持つ、位置合わせのアンカーだけ提供する」という埋め込みも許容したい。両ユースケースを別コンポーネントに分けると、ツリーレンダリング・アクティブパス計算などの実装が二重化する。
- **Change freedom**: 個別props名は変更可、ただし「独立/埋め込みの二モードを1コンポーネントで支える」構造は維持する。
- **Anchors**: components/BranchNavigator.tsx:7

### DEC-466: 線形チェーンの圧縮とラベル解決の二段構え

- **What**: 分岐のない一本道の親子連鎖は`compressChain`で先頭ノードに畳み込み、`skipped`カウントを添える。表示ラベルの解決は、サーバ側で用意された`branchPreview`(先頭メッセージのプレビュー)を優先し、`branchPreview`が無ければ`labelEntry`(圧縮チェーン上の最初のmessage entry)を`getLabel`にかける。
- **Why**: セッションツリーは分岐がなくても中間ノード(tool call等)が長く連なるので、そのまま出すとブランチ切替UIが縦に膨れて実質使えない。畳んで先頭のメッセージ相当だけ見せた方が意思決定に必要な情報密度になる。ラベル側は、サーバ射影が入っていれば安価な要約を使うが、未射影のセッションやテスト固有のshapeでも壊れないよう`labelEntry`のフォールバックを残す。
- **Change freedom**: 圧縮の停止条件(`children.length !== 1`)や`skipped`の集計方法は調整可、ただし「表示ラベルは常に得られる」ことは保つ。
- **Anchors**: components/BranchNavigator.tsx:42

### DEC-467: トップレベルブランチの選択規則

- **What**: パネルのトップレベル行として何を出すかは、ツリーのroot数で分岐する。複数rootなら(=最初のメッセージ地点から分岐している)root群自体をブランチ行として出し、単一rootなら圧縮後の先頭ノードの子を出す。
- **Why**: ブランチはユーザーが「別の道」を選ぶための選択肢なので、共通prefixを見せても意味がない。共通prefixを剥がした後の最初の分岐点の子が「選ぶべき候補」になる。最初のメッセージから既に分岐している場合はrootそのものが候補になるので、対称的に扱う。
- **Change freedom**: 分岐点の探索を`compressChain`経由で行う実装は変更可、規則自体(共通prefixを剥がす)は維持する。
- **Anchors**: components/BranchNavigator.tsx:62

### DEC-480: EventSource watch のライフサイクル分離と同期タイミング

- **What**: watch (EventSource) のライフサイクルはファイル本体のロードと独立させ、`connected` を受けた直後に一度だけ同期を実行する。`change` イベントの JSON ペイロードは `try/catch` で受け、パース失敗時は `size` を更新しないだけで refetch は続行する。
- **Why**: watch を一時停止しても表示中の内容を保持するには読み込みを分離する必要がある。watcher は connected 時点で初めて存在するため、直前スナップショットとライブイベントの間に発生する変更を connected 直後の同期で埋めないと取り逃す。change ペイロードは fs event が壊れ得るので握りつぶし、次の refetch で整合させる方が UI の停止より無害。
- **Change freedom**: 同期のタイミング (connected 以外に error からの回復時にも入れるなど)、パース失敗時の観測方法 (Sentry 送信など) は自由に増やしてよい。ロードと watch を混ぜて 1 effect にする方向は不可。
- **Anchors**: components/FileViewer.tsx:486, components/FileViewer.tsx:660, components/FileViewer.tsx:850, components/FileViewer.tsx:1098, components/FileViewer.tsx:1137

### DEC-481: ソース選択行と mention UI の振る舞い

- **What**: ソース表示の選択範囲取得では、選択端が対象行の実文字を 0 文字しか含まない場合その境界行を範囲から除外する。@ mention ボタンは選択範囲があれば行 mention、なければファイル @mention を呼び出す。
- **Why**: ブラウザの Selection は隣接行の先頭/末尾ゼロ幅位置を選択端に含めるため、そのまま lineNumber を採ると意図しない 1 行分がずれて mention される。同じボタンで選択有無に応じて分岐させることで、UI 要素を増やさず選択ベースの参照挿入と全体参照を両立させる。
- **Change freedom**: 境界判定の実装 (Range API 以外での判定など) や UI の表示テキスト (選択件数の提示など) は自由。ボタンを 2 つに分ける・選択境界を無視して常に含めるのは不可。
- **Anchors**: components/FileViewer.tsx:127, components/FileViewer.tsx:1366

### DEC-482: markdown/html/diff の初期表示モード決定

- **What**: 明示的な `initialDisplayMode` または保存された `initialState` がない場合、markdown/html はロード直後に preview を初期モードにする。`requestedInitialDisplayMode === "diff"` の復元は、git diff の解決が返るまで保留する。
- **Why**: 生成済み HTML やレンダリング前提の markdown は source より preview 表示の方が有用度が高く、source タブへは 1 クリックで戻れる。diff 復元を git 応答前に確定させると、まだ未解決の hasGitDiff=false 状態で fallback effect が source に降格させてしまうため、応答待ちで保留するしかない。
- **Change freedom**: preview 既定にする言語の追加や、保留中の loading UI 表現は自由。明示指定/復元指定を上書きする方向は不可 (ユーザーの選択が常に勝つ)。
- **Anchors**: components/FileViewer.tsx:1160, components/FileViewer.tsx:1177

### DEC-483: 差分表示は変更±3行のみ描画し残りを折り畳む

- **What**: `DiffView` は変更行の前後 3 行のみを render し、残りは "... N unchanged lines ..." に折り畳む。
- **Why**: git 系ツールの慣習に近い context 表示にすることで、長いファイルの diff でもスクロール量を抑え、変更周辺の文脈だけを視線集中させられる。全行 render すると大量ファイルで DOM が肥大化する。
- **Change freedom**: 折り畳みの UI (クリックで展開など) や CONTEXT の値そのものは調整可。全行 render に戻すのは不可。
- **Anchors**: components/FileViewer.tsx:300

### DEC-484: markdown レンダラの pre 素通しとローカル画像の file API 経由配信

- **What**: ReactMarkdown の `pre` component は `<>{children}</>` で素通し、code block の wrap は `CodeBlock` 側に一元化する。markdown 内の相対パス image は resolveLocalFileHref で解決した上で `/api/files` 経由で src を組み立てる。
- **Why**: `pre` を素通しにしないと `pre > CodeBlock > pre` のような二重ラップが発生し、CodeBlock 内で行った padding/scroll 設定が壊れる。ローカルパス画像はブラウザから直接読めないため file API サーバー経由で配信する必要があり、外部 URL はそのまま渡す。
- **Change freedom**: CodeBlock の内部構造や file API のクエリパラメータは自由に変えてよい。pre で追加の wrap を復活させる、外部 URL まで file API を通すのは不可。
- **Anchors**: components/FileViewer.tsx:1459, components/FileViewer.tsx:1488


## Consequences / Impact

- **コメントの pointer 化**: `components/` 配下の全 `.ts/.tsx/.mjs` ファイルで、prose comment が `// intent: DEC-XXX — <reason>` に置換される。IDE の hover/jump-to-definition は現状の validate-comments では追わないが、grep で辿れる。
- **DEC ID の消費**: DEC-300..DEC-499 のうち本ファイルで消費した ID は他所で再利用できない（`validate-comments` の broken pointer 検査は成立するが、意味の衝突を避けるため）。
- **改変自由度**: 元コードの WHAT/HOW を語っていたコメントは削除された。動作を変更したい場合は該当 DEC の Why が阻害されないかを確認する。

## Quality Implications

- **DEC が守る品質**: 元 pi-web コードの「なぜこの書き方をしたか」の情報が消失しない。破ると: 将来コード改変時に、元の判断意図が読み取れず退行を招く。
- **QA での確認観点**: `deno run scripts/validate-comments.ts` が `components/` 配下でエラー 0 であること。`_docs/intent/PiWebInherited/components/decision.md` の全 DEC が実コードから grep で参照されていること（broken pointer は validate-comments が検出）。

## Intent-derived Invariants

None
<!-- 本 DEC 群の不変条件は Workspace/pi-web-idd-workspace/decision.md の INV-001 に集約している (from Workspace DEC-002)。本ファイル固有 INV は None。 -->

## Rollback / Follow-ups

- **Rollback**: 本ファイルを削除し、`components/` 配下の pointer コメントを元の prose に戻す（git revert で 1 commit 単位で戻せる粒度に維持する）。
- **Follow-ups**:
  - pi-web 由来の他ディレクトリ（`app/`, `lib/`, `hooks/`）も同じ方針で IDD 化予定。DEC ID 帯は別途割り当てる。
  - `_docs/intent/PiWebInherited/README.md` に該当ディレクトリ一覧と DEC 帯対応表を残す（未着手）。
