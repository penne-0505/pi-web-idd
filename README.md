# 拡張 IDD — Intent-Driven Development pipeline

> この README は日本語と英語の 2 部構成です。English speakers, please scroll down.

## このリポジトリは何か

このリポジトリは、[pi coding agent](https://github.com/earendil-works/pi) のブラウザ UI である [pi-web](https://github.com/agegr/pi-web) v0.8.9 の固定派生に、**拡張 IDD (intent-driven development) の pipeline と判断 UI** を組み込んだものです。

拡張 IDD は「朝起きたら、判断待ちの作業レーンが N 件並んでいる」を実現する、AI 主導の開発 pipeline です。起票 (GitHub issue) を lane に取り込み、planner が下調べして契約 (Choice の草案 / AC / reference / 依頼) を生成し、**人間は意図と提出内容を確認**し、executor が独立した git worktree で並列実装します。

- **S0 取り込み**: GitHub issue (label `idd-ready`) を backlog に追加
- **S1 下調べ**: planner が lane ごとに Choice の草案 / AC (qa.md) / reference / 依頼 (plan.md) を生成
- **GO 判断**: 人間が Web UI で GO / DEFER を判定
- **S2 実装**: executor が独立 worktree で実装
- **S3 衝突確認**: 作業本流との衝突を機械判定
- **S4 提出**: 公開差分・文章・検査の確認 → カードで commit message（新しい PR は題名と本文も）を承認 → overlay export → 既存の PR へ push、または PR を作成

構成:

| 場所 | 内容 |
| --- | --- |
| `packages/idd-core` | state の読み書き、各段階と overlay の提出・受け入れ |
| `packages/idd-engine` | engine（常駐する別 process の API）。state・tick・supervisor を持ち、`bin/idd-engine` で起こす |
| `packages/idd-cli` | CLI（取り込み・提出・受け入れ・記録回収） |
| `packages/idd-gui` | 画面（Inbox / Work / 会話）。engine の API だけを読み、engine が `/gui/` で配る |
| `lib/idd-ui` | engine と画面が共有する型と card の文面 |

## 動かし方

### 開発サーバー

```bash
npm install
npm run build:gui    # packages/idd-gui/dist/ に画面の bundle を作る（Bun）
bin/idd-engine       # engine (別 process) — 既定 http://127.0.0.1:30144
```

engine が API と画面を同じ port で配ります。画面は `http://127.0.0.1:30144/gui/` で開きます。engine は起動のときに state の下へ `idd` の wrapper を置き、それが起こす agent の bash に `idd` を見せます。

`packages/idd-gui/` は engine の HTTP の API だけを読む画面です。build は Bun で行い、依存は増やしません。bundle は `build.json` に build の commit を持ち、engine は **自分と同じ commit の bundle だけ**を配ります。別の commit の bundle と、作り直しに失敗した後の bundle は配らず、`/gui/` が理由と作り方（`npm run build:gui`）を 503 で答えます。engine は `dist/` を要求のたびに読むので、作り直しに再起動は要りません。

署名の要る承認は、`localhost` で開いた画面でだけ通ります（鍵は登録した host に結び付くので、IP アドレスで開くと署名できません）。端末からは `idd approve CARD` で 1 枚ずつ通せます。署名する中身を全文出してから、PIN を制御端末で聞きます（引数・環境変数・ファイル・パイプからは読みません。証明を decide に送るだけで、外へ書くのは engine です）。

### 配布版を入れる（install）

配布は、公開 repo の release tag（`v<semver>`）を clone して行います。npm registry には公開しません。

```bash
git clone --branch v0.9.0 https://github.com/penne-0505/pi-web-idd.git ~/propter
cd ~/propter
npm ci          # 依存を入れる（clone 直後は node_modules が無い）
bin/idd install --state-dir <state の絶対 path> --pi-bin <pi の絶対 path> # この機械に置く
```

tag の clone では `--state-dir` と `--pi-bin` の両方が要ります。値は自分の機械のものを控えて渡します。state は、既にこの機械で idd を動かしているなら今使っている state の絶対 path をそのまま渡し（新しい場所を指すと、走っている lane と台帳が見えなくなります）、初めてなら置きたい場所の絶対 path を渡します。pi は `command -v pi` が答える絶対 path です。ここで渡した値は `install.json` に記録され、unit と `~/.local/bin/idd` に書かれ、`idd upgrade` で tag を替えても変わりません。

`idd install` は次のものを作ります。

- `~/.config/idd/`（mode 700）: 設定の置き場。`roles.yaml`・`repos.yaml`・`modes.yaml` が無ければ例を写します（既にあれば触りません）。
- `~/.agents/skills` と `~/.claude/skills`: `propter-*` の skill。
- `~/.config/systemd/user/`: `idd-engine.service`・`idd-tick.service`・`idd-tick.timer`（画面は engine が配るので、画面の unit はありません）。`WorkingDirectory` と `ExecStart` は clone した checkout を指し、`PATH` は install を回した shell のものを写します。`--state-dir`・`--pi-bin` を渡すと、その絶対 path も unit に書きます（下の「稼働を tag の clone へ切り替える」）。
- `~/.local/bin/idd`: checkout の `bin/idd` を起こす wrapper（symlink ではありません）。
- `~/.config/idd/install.json`: 入れた checkout と版の記録。

既にある鍵（`gateway.env` など）・設定・手書きの unit・目印の無い `~/.local/bin/idd` は上書きしません。置かなかったものは結果に出ます。unit の enable と start は行わないので、結果に出る `systemctl --user enable --now ...` を実行します。

版を上げるときは `idd upgrade`（`--to <tag>` で tag を指定、`--here` で tag を替えずに後の段だけ）、機械の側の移行は `idd migrate`、固定した template から移るときは `idd repo migrate` を使います。

### 稼働を tag の clone へ切り替える（run clone）

本流の作業ツリーから unit を動かすと、本流への編集や衝突した merge がそのまま稼働に効きます。稼働は、tag から作った専用の clone（run clone）で動かします。state と pi の指し先は install のときに 1 か所で決め、unit と `~/.local/bin/idd` に絶対 path で書かれます。起動した process は file から読み直して決め直さず、`gateway.env` も環境に既にある値を上書きしません。

- 値の順は、渡された環境 → install の記録 → 既定です。`idd install` は渡された `--state-dir`・`--pi-bin` を `install.json` に記録し、渡されなければ記録を保ちます。
- run clone の `bin/idd`・`bin/idd-engine` を直接呼んでも同じ順です。環境に値が無ければ `~/.config/idd/install.json` の `state_dir`・`pi_bin` を使います（記録の `checkout` がその clone のときだけ。別の clone の記録は借りません）。`gateway.env` の同名の行より記録が先で、記録も `gateway.env` も無いときだけ `<clone>/state` になります。unit・`~/.local/bin/idd`・直接呼びは同じ state を指します。
- tag の上の checkout では、`--state-dir` と `--pi-bin` の両方が要ります（片側だけだと、unit と入口を書かずに止まります）。tag でない checkout（開発）では両方とも省略できます。
- tag の上の engine は、自動の入れ替え（`IDD_RELOAD`）を切って起動します。run clone は `idd upgrade` でしか動かないためです。tag でない checkout の engine は、今までどおり入れ替えを頼めます。
- 設定（`roles.yaml`・`repos.yaml`・`modes.yaml`）の読み先は変わりません（環境変数 → checkout の `config/` → `~/.config/idd`）。unit は `IDD_*_FILE` を設定も削除もしません。
- state は動かしません。走っている lane の記録・`agent-token`・台帳がその中にあるので、切り替える前に実際に使っていた state（手順 5 の実効値）の絶対 path をそのまま渡します。起こした後に lane が見えなければ、控えた値が実効値でなかった印です。

切り替えは人が次の順で行います。**走っている lane は止まりません**: lane の agent は unit とは別の scope で動くので、unit を止めても最後まで走ります。engine が戻るまでの間に届かなかった報告は CLI がやり直します。

1. 開いている会話を確認して閉じる。engine を止めると、開いている会話の process が切れます。
2. tick の timer を止める: `systemctl --user stop idd-tick.timer`
3. 走っている `idd-tick.service` の終わりを待つ（tick は最大 20 分動きます）: `systemctl --user is-active idd-tick.service` が `inactive` を返すまで。timer を止めても、走り始めた tick は残ります。
4. engine を止める: `systemctl --user stop idd-engine.service`。以前 `idd-web.service`（古い画面）を動かしていたなら、これも止めて無効にする: `systemctl --user disable --now idd-web.service`
5. 今、実際に効いている `IDD_STATE_DIR` と `IDD_PI_BIN` を控える。実効値は、次の順で最初に決まるものです。①今の unit の `ExecStart=` が `env IDD_STATE_DIR=… IDD_PI_BIN=…` で渡す値（install が描いた unit。`systemctl --user cat idd-engine.service` で読む。systemd は `EnvironmentFile` の値を `Environment=` より強く扱うが、`ExecStart` の引数はそれらより後に効く）。②`~/.config/idd/gateway.env` にその行があればその値（手書きの unit の `EnvironmentFile=-%h/.config/idd/gateway.env` は unit の `Environment=` より強く効く）。③unit の `Environment=` の値。④どれも無ければ、state は unit の `WorkingDirectory`（今の checkout）の `state`。`gateway.env` は読むだけで、編集も削除もしない。手順 4 より前なら、`/proc/$(systemctl --user show -p MainPID --value idd-engine.service)/environ` が起動中の engine の実際の値を持つので、控えた値と見比べる（`tr '\0' '\n' < /proc/<PID>/environ | grep -E '^IDD_(STATE_DIR|PI_BIN)='`）。どこにも `IDD_PI_BIN` が無いときは、今使っている pi は `<今の checkout>/node_modules/.bin/pi`（あればそれ）、無ければ `command -v pi` が答える絶対 path なので、それを控える。控えたら、`~/.config/systemd/user/idd-{engine,tick}.service`（あれば `idd-web.service` も）と `idd-tick.timer` を `~/.config/idd/units-hand-written/` へ退避する。目印（`# idd-install: managed`）の無い unit は `idd install` が書き換えず、現物と案だけを結果に出します。
6. run clone を作る。`--depth` は付けません（`idd upgrade --to` が tag の祖先を git で判定するため）: `git clone --branch v<tag> https://github.com/penne-0505/pi-web-idd.git ~/propter-run && cd ~/propter-run && npm ci`
7. install する: `bin/idd install --state-dir <控えた state の絶対 path> --pi-bin <控えた pi の絶対 path>`（手順 5 で決めた実効値を渡す）。`install.json` に指し先と、指し先を最初に載せた commit を記録します。記録された `state_dir` が控えた値と一致することを見る。新しい unit は `env IDD_STATE_DIR=…` を ExecStart で渡して `gateway.env` に勝ち、直接呼びも記録が `gateway.env` に先立つので、`gateway.env` の行は消さず残してよい。
8. 起こす: 結果に出る `systemctl --user enable --now idd-engine.service`・`idd-tick.timer` を順に実行する。

起こした後、画面の lane 一覧の上に、engine が起動した commit（古いかどうかに関わらず）が出ます。同じ lane が見えていれば、同じ state を読んでいます。

#### 前の版へ戻す（巻き戻し）

`idd upgrade --to <前の tag>` の 1 回で戻ります。動いている unit があると upgrade は何も替えずに止まり、止める命令を出すので、それを実行してから回し、終わったら結果に出る再起動の命令を実行します。戻れるのは、指し先の仕組み（`bin/gateway-env.sh`）が最初に入った commit（`install.json` の `pointers_commit`。install した時の HEAD ではありません）を含む tag までです。含まない tag を指すと、checkout を替えずに断ります。記録に指し先が無いときは、tag の上の checkout か、今の unit がその値を持っている場合に限り、unit を描き直さずに `idd install` を促して止まります。指し先を持たない開発の checkout は、そのまま後段（依存・build・skills・unit・migration）を回せます。shallow clone では下限を決められないので `--to` は断られ、`git fetch --unshallow` の後に `idd install` を回し直します。

### 環境変数

| 変数 | 意味 | 既定値 |
| --- | --- | --- |
| `IDD_STATE_DIR` | state ファイル (backlog.jsonl / lifecycle / cron-run など) の置き場。環境に無ければ install の記録の値 | `<checkout>/state` |
| `IDD_INTENT_DIR` | intent (DEC) の root | `<cwd>/_docs/intent` |
| `IDD_ENGINE_PORT` | engine が待ち受ける port。CLI と agent の報告の宛先の既定にも使う | `30144` |
| `IDD_AGENT_BASE_URL` | agent の書き戻し先 (envelope の配信先) と CLI の API の宛先。明示すれば `IDD_ENGINE_PORT` より優先 | `http://127.0.0.1:$IDD_ENGINE_PORT` |
| `IDD_INBOX_BASE_URL` | CLI が返す受信箱の URL の origin（engine を別の名前で開くとき。末尾に `/gui/` が付く） | `http://127.0.0.1:$IDD_ENGINE_PORT` |
| `IDD_PI_BIN` | agent が使う pi。unit と `~/.local/bin/idd` には install の記録の値が入り、環境に無ければ直接呼びも記録の値を使う | `<checkout>/node_modules/.bin/pi`、無ければ PATH の `pi` |
| `IDD_AGENT_TOKEN` | agent 用書き込み口の token | `<state>/agent-token` に自動生成 |
| `IDD_GATEWAY_ENV` | 各窓口の鍵（`AI_GATEWAY_API_KEY` など）を置くファイル。`bin/idd` と `bin/idd-engine` がこのパスを読むが、環境に既にある値は上書きしない。`idd-engine.service` はこの変数を見ず、unit の `EnvironmentFile` に書いたパス（既定と同じ）を読む | `~/.config/idd/gateway.env` |

### CLI

```bash
bun run packages/idd-cli/bin/idd.ts intake   # S0 取り込み (engine 不要、state へ直接)
bun run packages/idd-cli/bin/idd.ts tick     # S0 → S3 を一巡 (engine 必須、POST /api/idd/tick)
```

## 即席レーン (idd lane / wt / probe / gate / pr / report)

Issue lane とは別に、オーケストレータ（Claude Code など）が他人の PR のレビュー・増分の再レビュー・逆当てプローブ・小さな実装を role プリセットで起動する入口です。状態は `state/lanes/` に閉じ、Issue lane の ledger には書きません。

```bash
bin/idd lane roles                                   # role と model の設定状況、est 別プロファイル（profiles:）
bin/idd wt add --repo daysai-flutter --pr 5530       # detached の複製を review_root に作る
bin/idd lane run lane.yaml [--no-wait] [--model provider/id]
bin/idd lane status [ID] / tail ID / send ID "text" / stop ID
bin/idd probe --wt PATH --run "cmd" --to REV -- files...   # 戻す → 走らせる → 必ず復元
bin/idd gate --wt PATH [--only format,analyze]       # cwd を固定して checks を走らせる
bin/idd pr ctx --repo owner/name N --out DIR          # 本文・コメント・スレッドを files へ
bin/idd pr post --repo owner/name N --comment --body-file F --expect-head SHA   # レビューの下書きを送出カードに作る（投稿は受信箱のカードで penne が承認したときだけ）
bin/idd report merge --findings a.json --findings b.json --comments DIR/comments.json --out draft.md   # 同一 path + 文字 2-gram Dice ≥ 0.45 で畳む
```

- role（thinking / tools / policy / report 書式）と model の定義（呼び先そのもの・窓口の指定）は `config/roles.yaml`。model は `models` 節の定義を名前で名指しし、定義の `model` がそのまま pi に渡る呼び先（読み替えはしない）。`provider: { order: [...] }` は OpenRouter の `provider` フィールドにそのまま渡る（レーン専用の `PI_CODING_AGENT_DIR` に生成した models.json 経由。ユーザーの `~/.pi/agent/models.json` は触らない）。段は `pipeline` 節で role と、その段が使う model を宣言する、対象 repo（clone / review_root / setup / checks）は `config/lane-repos.yaml`
- lane.yaml は `role` / `worktree` / `diff` / `inputs` / `rules` / `focus` / `task` / `commands` / `report` を持つ。固定の禁止事項と成果物の書式はツールが brief に足す
- role に `harness: claude` を書くと pi ではなく Claude Code の headless（`claude -p --setting-sources "" --strict-mcp-config`、サブスク枠）で走る。`model` は claude の alias（opus 等）、`thinking` は `--effort` に写る。escalation 用
- レーンの bash では `gh` / `git` が PATH シムに置き換わり、投稿・push・`--no-verify`・`--amend` は exit 86 で拒否される

## 全体の流れ (S0-S4)

### S0: 取り込み (Intake)

GitHub issue (area config の `intake_filter.github_labels`、既定 `idd-ready`) と、Linear の鍵の持ち主にアサインされた Issue (`intake_filter.linear_teams` でチームを repo に振り分け、状態は `linear_statuses`、既定 `Todo`、`linear_labels` はすべて付いていることが要る) を拾い、`backlog.jsonl` に追加します。`intake_filter.linear_exclude_labels` に書いたラベルが 1 つでも付いた Issue は、名指しするまで取り込みません。`intake_filter.linear_include_unassigned: true` を書いた repo は、そのチームの未アサインの Issue も同じ条件で取り込みます（書かない repo は今までどおりアサインされた Issue だけを読み、未アサインを読む query も送りません）。Linear へは読み取りの query だけを送ります。`idd intake --list` は取り込まずに、lane になる Issue と飛ばす Issue を表示します。Linear の行には見積りと優先度が出て、値が無ければ「なし」と出ます。`idd intake --list --unassigned` は、未アサインの Issue を取り込まない repo の未アサインの行も `[未アサイン]` の印で分けて出します（その行は lane になりません）。`idd intake APP-1234` や `idd intake 12` / `idd intake owner/name#12` のように明示した Issue は、その Issue だけを直接読み、ラベル・状態・アサインの条件を見ずに取り込みます（Linear はチームを取り込む repo があること、GitHub は取り込む repo の open な Issue であることは要ります）。重複判定は URL 完全一致 (機械) のみ稼働しています。取り込みの結果は 1 実行 1 file の `cron-run-<timestamp>.json` に記録されます。

「今はやらない」起票は、state の無視リスト（`intake-ignores.jsonl`）に載せて取り込みから外します（`idd ignore APP-1234` / `idd unignore APP-1234` / `idd ignores`、または lanes の一覧の下の「取り込まない起票」）。lane を外すボタンは、GO カード・止まった lane のカード・lane の詳細の見出しでは「無視する」、取り込み直しのカードでは「今回も無視する」です。押すと、その lane の起票が無視リストに載ります。無視は受信箱の画面からだけ受け付けます（画面の cookie が要り、エージェントの直接の要求では無視できません）。無視リストを読むのは取り込みだけで、明示した取り込みでも外れます。GitHub・Linear には何も書かず、lane の段・枠・配信は変わりません。

次にどの lane を動かすかは、repo をまたぐ 1 本の並びで決めます（`idd order [--json]` で読み、`idd order move IDD-xxx --to N|--before LANE|--after LANE|--first|--last` で動かし、`idd order urgent IDD-xxx` / `idd order unurgent IDD-xxx` で急ぎを付け外しします）。上限のある段（計画役・plan の査読・実装役・レビューの各段）は、この並びの順に lane を起こします。急ぎは先に並ぶ印 1 つで、段の上限を超える起動も、動いている lane の停止も起こしません。並びに置いていない lane は、取り込んだ時刻の古い順で後ろに続きます。並びと急ぎは engine の状態（`start-order.jsonl`）だけに持ち、GitHub・Linear には何も書きません。

### S1: 下調べ (Planner Prep)

各 lane について planner が下調べし、計画の報告に Choice の草案（GO の後に意図の記録の状態へ書かれ、`_docs/intent/` に写しが描かれます）を乗せ、`_docs/qa/<Area>/<slug>/qa.md` (AC) / `_docs/reference/<Area>/<slug>/reference.md` / `_docs/plan/<Area>/<slug>/plan.md` (依頼) を書きます。各 lane に独立 planner session と git worktree を切り、model・thinking・provider routing・並列度は `config/roles.yaml` の `pipeline.planner`（role プリセット）で決めます。完了状態は `s1_ready` (人間 GO 待ち) と `pending_question` (質問 batch を発して回答待ち) の 2 種です。

### GO 判断

人間が Web UI で GO を押すと `s1_go` event が ledger に直接書き込まれます (AI 非経由)。GO を受けた lane だけが S2 に進みます。

GO を待つ間に作業本流が plan の触る場所（依頼の触る範囲や reference のパス）に進むと、tick が lane に 1 回だけ記録し（`s1_base_advanced`、段は変わりません）、GO カードに変更のあったファイルを出します。確かめ直させるときは、GO カードの差し戻しで planner に頼みます。

### S2: 実装 (Executor)

executor session が独立 worktree で実装します。model と並列度は `config/roles.yaml` の `pipeline.executor` で決めます。完了すると `s2_result` (outcome: success / partial) が記録されます。

### S3: 衝突確認 (Integration Check)

`git merge-tree` で作業本流との衝突を機械判定します。clean なら人間が diff と QA を review して `s3_ok` / `s3_reject` / `s3_defer` を判定します。自動の衝突解消は未実装です。公開側の更新は専用 worktree で解消して受け入れられます。

### S4: 提出 (Ship)

公開する差分、文章、検査結果を確認対象として固定します。push と PR 作成は人間が押したときだけ行います (DEC-692)。merge は観測して記録するだけです (DEC-697)。

### 未実装のもの

| 項目 | 現状 |
| --- | --- |
| 意味類似の重複判定 | `DuplicateDetector` の口のみ。URL 完全一致のみ稼働 |
| cron 登録 | scheduler 不在。cron-run 記録は書く |
| verifier agent | 人間が兼ねる暫定 (DEC-693) |
| 自動の衝突解消 | 手動解消の受け入れ経路は実装済み |

## 設計の正本と判断の記録

- **設計の正本**: [`_meta/extended-idd-design/`](_meta/extended-idd-design/README.md) — S0-S4 の全体フロー設計の引き継ぎ資料 (SSOT)
- **判断の記録**: [`_docs/intent/`](_docs/intent/) — 意図の記録（Purpose と Choice）の写し。正は propter の状態にある

## 開発規約

このリポジトリ自身は intent-driven development の規約で開発されています。すべての変更は同じ順を踏みます:

```text
触る Place の Choice を知る → 出口を選ぶ → 変える → Choice を記録するか Waive を宣言する
```

- 意図は Purpose と Choice の 2 単位で、propter の口（`idd intent`）から状態に記録され、`_docs/intent/` に写しが描かれます。コードとの対応は Choice の place が持ち、コードにポインタコメントは置きません
- AC は `qa.md` に置き、lane の検証の記録は propter が持ちます。lane の外の手の変更は `qa.md` / `maintenance.md` に Round を書きます
- 品質は機械 (validator が構造を強制) と agent review が担います
- ローカル検証は `./scripts/check-docs.sh` でまとめて実行します (CI も同一 script)

詳細は [_docs/standards/workflow.md](_docs/standards/workflow.md) (規約の構成とループ)、[_docs/standards/records.md](_docs/standards/records.md) (記録の形) と [_docs/standards/document_contracts.md](_docs/standards/document_contracts.md) (文書種別ごとの契約) を参照してください。初めての場合は [QUICKSTART.md](QUICKSTART.md) から。

## ライセンス

このリポジトリは [MIT ライセンス](LICENSE.txt) の下でライセンスされています。

### 派生元

このリポジトリは [pi-web](https://github.com/agegr/pi-web) v0.8.9 の固定派生です (MIT)。上流の README と機能の説明は [pi-web のリポジトリ](https://github.com/agegr/pi-web) を参照してください。

---

# Extended IDD — Intent-Driven Development pipeline

> This README is available in English and Japanese. 日本語版は上を参照してください。

## What this repository is

This repository is a fixed fork of [pi-web](https://github.com/agegr/pi-web) v0.8.9, the browser UI for the [pi coding agent](https://github.com/earendil-works/pi), with the **extended IDD (intent-driven development) pipeline and decision UI** built in.

Extended IDD is an AI-driven development pipeline that realizes "wake up in the morning to N work lanes waiting for your judgment." Tickets (GitHub issues) are ingested into lanes, a planner researches each lane and produces a contract (Choice drafts / ACs / reference / request), **humans only make GO / DEFER decisions**, and executors implement in parallel in separate git worktrees.

- **S0 Intake**: GitHub issues (label `idd-ready`) are added to the backlog
- **S1 Planner Prep**: a planner produces Choice drafts / ACs (qa.md) / reference / a request (plan.md) per lane
- **GO decision**: a human decides GO / DEFER in the web UI
- **S2 Implementation**: an executor implements in a separate worktree
- **S3 Integration Check**: conflicts against the configured work base are detected mechanically
- **S4 Ship**: public diff, text and checks → approval of the commit message (and a new PR's text) on the card → overlay export → push to the PR, or create it

Layout:

| Location | Contents |
| --- | --- |
| `packages/idd-core` | State read/write and the intake / plan / check / ship stages |
| `packages/idd-engine` | The engine (the API of the resident separate process): state, tick and the supervisor. Started with `bin/idd-engine` |
| `packages/idd-cli` | CLI（取り込み・提出・受け入れ・記録回収） |
| `packages/idd-gui` | The screen (Inbox / Work / conversations). It reads only the engine's API, and the engine serves it at `/gui/` |
| `lib/idd-ui` | The types and card texts the engine and the screen share |

## Getting Started

### Development server

```bash
npm install
npm run build:gui    # write the screen's bundle to packages/idd-gui/dist/ (Bun)
bin/idd-engine       # engine (a separate process) — http://127.0.0.1:30144 by default
```

The engine serves the API and the screen on the same port. Open the screen at `http://127.0.0.1:30144/gui/`. On start the engine puts an `idd` wrapper under the state and shows it to the bash of the agents it starts.

`packages/idd-gui/` is a screen that reads only the engine's HTTP API. It is built with Bun and adds no dependency. The bundle carries the commit it was built from in `build.json`, and the engine serves **only a bundle built from its own commit**. A bundle from another commit, and the earlier bundle after a rebuild failed, are not served: `/gui/` answers 503 with the reason and the build command (`npm run build:gui`). The engine reads `dist/` on every request, so a rebuild needs no restart.

An approval that needs a signature goes through only from a screen opened on `localhost` (a key is bound to the host it was registered with, so opening the screen by IP address cannot sign). From a terminal, `idd approve CARD` passes one card at a time: it prints the content being signed in full, then asks for the PIN on the controlling terminal (never from an argument, the environment, a file or a pipe) and sends only the proof to decide — the write itself stays in the engine.

### Installing a release

Distribution is a clone of a release tag (`v<semver>`) from the public repo. Nothing is published to the npm registry.

```bash
git clone --branch v0.9.0 https://github.com/penne-0505/pi-web-idd.git ~/propter
cd ~/propter
npm ci          # install the dependencies (a fresh clone has no node_modules)
bin/idd install --state-dir <the state's absolute path> --pi-bin <the pi's absolute path> # put it on this machine
```

On a tag clone both `--state-dir` and `--pi-bin` are required. Pass the values of your own machine. For the state, if idd already runs on this machine, pass the absolute path of the state it uses now as it is (pointing at a new place would hide the running lanes and the ledger); on a first install, pass the absolute path where you want it. For the pi, use the absolute path `command -v pi` answers. The values you pass are recorded in `install.json`, written into the units and `~/.local/bin/idd`, and do not change when `idd upgrade` moves to another tag.

`idd install` creates:

- `~/.config/idd/` (mode 700): the settings place. `roles.yaml`, `repos.yaml` and `modes.yaml` are copied from the examples when they are not there (an existing file is never touched).
- `~/.agents/skills` and `~/.claude/skills`: the `propter-*` skills.
- `~/.config/systemd/user/`: `idd-engine.service`, `idd-tick.service` and `idd-tick.timer` (the engine serves the screen, so there is no unit for it). `WorkingDirectory` and `ExecStart` point at the cloned checkout, and `PATH` copies the shell that ran install. `--state-dir` and `--pi-bin` write their absolute paths into the units too (see "Moving the running system to a tag clone" below).
- `~/.local/bin/idd`: a wrapper that execs the checkout's `bin/idd` (not a symlink).
- `~/.config/idd/install.json`: the checkout and version that were installed.

An existing key (`gateway.env` and the like), setting, hand-written unit, or unmarked `~/.local/bin/idd` is never overwritten; what was left out is reported. The units are not enabled or started, so run the `systemctl --user enable --now ...` commands the result prints.

To move to another release use `idd upgrade` (`--to <tag>` names the tag, `--here` runs only the stages after the checkout); machine-side changes use `idd migrate`; a repo fixed to an older template uses `idd repo migrate`.

### Moving the running system to a tag clone (run clone)

Units that run from the mainline work tree take every edit and every conflicted merge on the mainline as a deploy. Run the system from a dedicated clone made from a tag (the run clone) instead. The state and the pi are decided once, at install, and written into the units and `~/.local/bin/idd` as absolute paths. A started process does not read them again to decide them anew, and `gateway.env` never overrides a value the environment already has.

- The order of values is: what was passed in the environment → the install record → the default. `idd install` records the `--state-dir` and `--pi-bin` it was given in `install.json`, and keeps the record when they are not given.
- Calling the run clone's `bin/idd` or `bin/idd-engine` directly follows the same order. With no value in the environment they use `state_dir` and `pi_bin` of `~/.config/idd/install.json`, only when the record's `checkout` is that clone (a record of another clone is never borrowed). The record comes before a same-named line in `gateway.env`; only when there is neither does the state become `<clone>/state`. The units, `~/.local/bin/idd` and a direct call all point at the same state.
- On a checkout that sits on a tag, both `--state-dir` and `--pi-bin` are required (with only one, it stops without writing a unit or the wrapper). A checkout that is not on a tag (development) may leave both out.
- An engine on a tag starts with its automatic replacement (`IDD_RELOAD`) off, because a run clone only moves by `idd upgrade`. An engine on a checkout that is not on a tag can still ask for a replacement, as before.
- Where the settings (`roles.yaml`, `repos.yaml`, `modes.yaml`) are read from does not change (environment variable → the checkout's `config/` → `~/.config/idd`). The units neither set nor unset `IDD_*_FILE`.
- The state is not moved. The records of running lanes, `agent-token` and the ledger live in it, so pass the absolute path of the state you were actually using before the switch (the effective value of step 5) as it is. If the lanes are not visible after starting, the noted value was not the effective one.

A person does the switch in this order. **Running lanes are not stopped**: a lane's agent runs in a scope apart from the units, so it runs to the end even though the units are stopped. A report that could not reach the engine while it was down is retried by the CLI.

1. Check the open conversations and close them. Stopping the engine cuts the process of an open conversation.
2. Stop the tick timer: `systemctl --user stop idd-tick.timer`
3. Wait for a running `idd-tick.service` to end (a tick runs up to 20 minutes): until `systemctl --user is-active idd-tick.service` answers `inactive`. Stopping the timer does not stop a tick that has already started.
4. Stop the engine: `systemctl --user stop idd-engine.service`. If you ran `idd-web.service` (the old screen) before, stop and disable it too: `systemctl --user disable --now idd-web.service`
5. Note the `IDD_STATE_DIR` and `IDD_PI_BIN` that are actually in effect now. The effective value is the first that is set among: (1) the value the current unit's `ExecStart=` passes as `env IDD_STATE_DIR=… IDD_PI_BIN=…` (a unit `idd install` drew; read it with `systemctl --user cat idd-engine.service`; systemd treats an `EnvironmentFile` value as stronger than `Environment=`, but the arguments of `ExecStart` take effect after both); (2) the line in `~/.config/idd/gateway.env`, if it has one (the hand-written unit's `EnvironmentFile=-%h/.config/idd/gateway.env` takes precedence over the unit's `Environment=`); (3) the unit's `Environment=` value; (4) for the state, `state` under the unit's `WorkingDirectory` (the current checkout). Only read `gateway.env`; do not edit or delete it. Before step 4, `/proc/$(systemctl --user show -p MainPID --value idd-engine.service)/environ` holds the values the running engine actually has, so compare the noted values with it (`tr '\0' '\n' < /proc/<PID>/environ | grep -E '^IDD_(STATE_DIR|PI_BIN)='`). When `IDD_PI_BIN` is set nowhere, the pi in use is `<current checkout>/node_modules/.bin/pi` if that exists, otherwise the absolute path `command -v pi` answers; note that. Then move `~/.config/systemd/user/idd-{engine,tick}.service` (and `idd-web.service`, if there is one) and `idd-tick.timer` to `~/.config/idd/units-hand-written/`. `idd install` does not rewrite a unit without the mark (`# idd-install: managed`); it only reports what is there and what it would have written.
6. Make the run clone, without `--depth` (`idd upgrade --to` judges a tag's ancestry with git): `git clone --branch v<tag> https://github.com/penne-0505/pi-web-idd.git ~/propter-run && cd ~/propter-run && npm ci`
7. Install: `bin/idd install --state-dir <the state's absolute path you noted> --pi-bin <the pi's absolute path you noted>` (pass the effective values decided in step 5). `install.json` records the pointers and the commit that first added the pointers mechanism. Check that the recorded `state_dir` equals the value you noted. The new unit passes `env IDD_STATE_DIR=…` in ExecStart and so wins over `gateway.env`, and a direct call reads the record before `gateway.env`; leave the `gateway.env` lines in place.
8. Start: run the `systemctl --user enable --now idd-engine.service` and `idd-tick.timer` commands the result prints, in that order.

Once started, the line above the screen's lane list shows the commit the engine started from, whether or not it is behind. If the same lanes are visible, the same state is being read.

#### Going back to the previous version (rollback)

One `idd upgrade --to <previous tag>` moves back. While a unit is running, upgrade stops with nothing changed and prints the commands that stop it: run them, then run the upgrade, and afterwards run the restart commands it prints. It can go back as far as a tag that holds the commit that first added the pointers mechanism (`bin/gateway-env.sh`; `pointers_commit` in `install.json`, not the HEAD you installed at); a tag that does not is refused with the checkout left where it was. When the record has no pointers, it also stops, without redrawing a unit, and asks for `idd install`, but only on a tag or when a unit already carries the value; a development checkout installed without pointers runs the later stages as before. A shallow clone cannot name a floor, so `--to` is refused there: run `git fetch --unshallow`, then `idd install` again.

### Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `IDD_STATE_DIR` | Where state files live (backlog.jsonl / lifecycle / cron-run, etc.). When the environment has none, the install record's value | `<checkout>/state` |
| `IDD_INTENT_DIR` | Root of the intent (DEC) records | `<cwd>/_docs/intent` |
| `IDD_ENGINE_PORT` | The port the engine listens on, and the default destination of the CLI and the agents' reports | `30144` |
| `IDD_AGENT_BASE_URL` | Where agents write back (envelope delivery target) and where the CLI sends its API calls. An explicit value wins over `IDD_ENGINE_PORT` | `http://127.0.0.1:$IDD_ENGINE_PORT` |
| `IDD_INBOX_BASE_URL` | The origin of the inbox URL the CLI returns (set it when the engine is opened under another name; `/gui/` is appended) | `http://127.0.0.1:$IDD_ENGINE_PORT` |
| `IDD_PI_BIN` | The pi the agents use. The units and `~/.local/bin/idd` carry the install record's value, and a direct call uses it when the environment has none | `<checkout>/node_modules/.bin/pi`, else `pi` on PATH |
| `IDD_AGENT_TOKEN` | Token for agent write endpoints | Auto-generated at `<state>/agent-token` |
| `IDD_GATEWAY_ENV` | The file that holds the provider keys (`AI_GATEWAY_API_KEY` and the like). `bin/idd` and `bin/idd-engine` read this path but never override a value the environment already has. `idd-engine.service` ignores the variable and read the path written in the unit's `EnvironmentFile` (the same as the default) | `~/.config/idd/gateway.env` |

### CLI

```bash
bun run packages/idd-cli/bin/idd.ts intake   # S0 intake (no engine needed; writes state directly)
bun run packages/idd-cli/bin/idd.ts tick     # One pass through S0 → S3 (engine required, POST /api/idd/tick)
```

## The pipeline (S0-S4)

### S0: Intake

GitHub issues (area config `intake_filter.github_labels`, default `idd-ready`) and Linear issues assigned to the key's owner (routed to a repo by `intake_filter.linear_teams`, states from `linear_statuses`, default `Todo`, with every label in `linear_labels` required) are picked up and appended to `backlog.jsonl`. An Issue carrying any label in `intake_filter.linear_exclude_labels` is left out until it is named. A repo that writes `intake_filter.linear_include_unassigned: true` also takes in its teams' unassigned Issues under the same conditions (a repo that writes nothing keeps taking in only the assigned ones, and no query for the unassigned is sent). Only read queries are sent to Linear. `idd intake --list` shows what would become a lane, and what would be skipped, without taking anything in; a Linear row carries its estimate and priority, or «なし» when it has none. `idd intake --list --unassigned` also shows the unassigned Issues of repos that do not take them in, marked `[未アサイン]` and apart from the lanes (those rows never become lanes). An Issue named explicitly (`idd intake APP-1234`, `idd intake 12`, `idd intake owner/name#12`) is read by itself and taken in without the label, state or assignee conditions (a Linear Issue still needs a repo that takes its team; a GitHub one must be an open Issue in an intake repo). Only exact-URL duplicate detection (mechanical) is active. Each run's result is recorded in a per-run `cron-run-<timestamp>.json` file.

An Issue not to be worked on now goes on the state's ignore list (`intake-ignores.jsonl`) and is left out of intake (`idd ignore APP-1234` / `idd unignore APP-1234` / `idd ignores`, or the list under the lanes). The button that takes a lane out reads "無視する" on a GO card, a stuck lane's card and a lane's details header, and "今回も無視する" on a re-take card; pressing it puts the lane's Issue on the list. Only the inbox page accepts it (it needs the page's cookie). Only intake reads the list, named intake included; nothing is written to GitHub or Linear, and no lane's stage, slot or delivery changes.

Which lane runs next is decided by one order that spans repos (`idd order [--json]` reads it, `idd order move IDD-xxx --to N|--before LANE|--after LANE|--first|--last` moves a lane, and `idd order urgent IDD-xxx` / `idd order unurgent IDD-xxx` set and clear the urgent mark). Every capped stage (planner, plan review, executor, the review stages) starts lanes in that order. An urgent lane is one mark that sorts it ahead; it never starts a lane past a stage's cap and never stops a running lane. A lane that is not placed follows, by when it was taken in. The order and the marks live only in the engine's state (`start-order.jsonl`); nothing is written to GitHub or Linear.

### S1: Planner Prep

A planner researches each lane, carries its Choice drafts on the plan report (written to the intent state after GO, with projections drawn under `_docs/intent/`), and writes `_docs/qa/<Area>/<slug>/qa.md` (ACs), `_docs/reference/<Area>/<slug>/reference.md` and `_docs/plan/<Area>/<slug>/plan.md` (the request). Each lane gets its own planner session and git worktree; the role, the models it runs, thinking, provider routing and concurrency come from `pipeline.planner` in `config/roles.yaml`. A lane finishes in one of two states: `s1_ready` (waiting for a human GO) or `pending_question` (a question batch was sent, waiting for answers).

### GO decision

When a human presses GO in the web UI, an `s1_go` event is written directly to the ledger (not through AI). Only lanes with GO proceed to S2.

While a lane waits for GO, the tick records once (`s1_base_advanced`, not a stage) when the work branch moves into the plan's places (the request's touched range and the paths in its reference), and the GO card lists the changed files. To have the plan checked again, send it back from the GO card.

### S2: Implementation

An executor session implements in a separate worktree; model and concurrency come from `pipeline.executor` in `config/roles.yaml`. Completion is recorded as `s2_result` (outcome: success / partial).

### S3: Integration Check

`git merge-tree` checks for conflicts against the configured work base. If clean, a human reviews the diff and QA and decides `s3_ok` / `s3_reject` / `s3_defer`. Automatic conflict resolution is not implemented. Public updates can be resolved in a dedicated worktree and accepted after review.

### S4: Ship

The public diff, text and check results are frozen for confirmation. Push and PR creation happen only when a human presses the button (DEC-692). Merges are observed and recorded, never performed (DEC-697).

### Not implemented

| Item | Current state |
| --- | --- |
| Semantic duplicate detection | Only the `DuplicateDetector` port exists; exact-URL matching is active |
| Cron registration | No scheduler; cron-run records are written |
| Verifier agent | A human stands in provisionally (DEC-693) |
| Automatic conflict resolution | Manually resolved updates can be reviewed and accepted |

## Design source of truth and decision records

- **Design source of truth**: [`_meta/extended-idd-design/`](_meta/extended-idd-design/README.md) — the handoff document for the S0-S4 pipeline design (SSOT)
- **Decision records**: [`_docs/intent/`](_docs/intent/) — projections of the intent records (Purposes and Choices); the source of truth is propter's state

## Development conventions

This repository itself is developed under the intent-driven development conventions. Every change follows the same order:

```text
read the Choices of the places you touch → choose the exit → change → record a Choice or declare a Waive
```

- Intent is recorded as Purposes and Choices through propter's door (`idd intent`) into its state, and projections are drawn under `_docs/intent/`. The link to code lives in a Choice's place; no pointer comments go into code
- ACs live in `qa.md`; propter keeps a lane's verification log. A change made outside a lane appends a Round to `qa.md` / `maintenance.md`
- Quality is held by machines (validators enforce structure) and agent review
- Run the local documentation validators together with `./scripts/check-docs.sh`; CI runs the same script

See [_docs/standards/workflow.md](_docs/standards/workflow.md) (the standards' map and the loop), [_docs/standards/records.md](_docs/standards/records.md) (the records' shape) and [_docs/standards/document_contracts.md](_docs/standards/document_contracts.md) (per-document contracts). If this is your first time, start with [QUICKSTART.md](QUICKSTART.md).

## License

This repository is licensed under the [MIT License](LICENSE.txt).

### Upstream

This repository is a fixed fork of [pi-web](https://github.com/agegr/pi-web) v0.8.9 (MIT). See the [pi-web repository](https://github.com/agegr/pi-web) for the upstream README and feature documentation.


## Overlay workspace

This repository develops the IDD core, UI, CLI and validation tools in one monorepo.
Copy `config/repos.example.yaml` to `config/repos.yaml`. Every repo is split into an upstream clone and a private work clone; register both, with the public base branch and the work base branch. The same file configures review copies and checks for ad-hoc lanes and review lanes, and a repo without an `issue_lane` section is never taken into the Issue lane.
The private work branch (`work_base`) must contain a usable `overlay.manifest` before creating lanes: commit it on that branch of the work clone, one repo-relative path per line, with the manifest's own line included. `idd intake` and `idd intake --list` refuse a repo whose work branch lacks one, and say what to write.
The manifest is the sole list of paths excluded from publication.

Run the CLI with `node --experimental-strip-types packages/idd-cli/bin/idd.ts help`.
The runtime runs as the user service `idd-engine.service` (the engine, port 30144), which also serves the screen at `/gui/`. `bin/idd` sends to the engine by default and returns the screen's inbox URL (`/gui/?view=inbox&card=<id>`).
After changing the code, restart `idd-engine` for the engine's code; the screen needs only `npm run build:gui`.
The engine also does this by itself: once no conversation is open and no request is in flight, it replaces itself with the checkout's code, and asks for `idd gui-build` (a rebuild of the bundle, with no restart) when the screen's code changed. Until the bundle is rebuilt for the engine's commit, `/gui/` answers 503 with the reason. The Inbox shows when the engine or the screen is behind, and a card offers to close the open conversations and replace the engine. Turn either off in the unit's environment with `IDD_RELOAD=off` (the engine) or `IDD_GUI_BUILD=off` (the screen); the manual steps above keep working. An engine started by a unit drawn on a tag has the replacement off already (see "Moving the running system to a tag clone").
`tick --no-intake` advances the lanes without taking in new Issues.
`propose LANE [PR_JSON]` checks the exact diff, title, body and checks for confirmation; it never pushes.
The optional JSON file contains `title` and `body`.
Every push is approved on the Inbox submit card, which shows its commit message and where it goes.
The tick checks the lane and drafts the commit message after the repository's own commit rules, but never pushes.
A commit message that still contains an ID of the records (`DEC-001`, `INV-1`, `AC-1`, `IDD-12`) or a Japanese word of the workflow cannot be approved until it is edited; an English word of the workflow (`overlay`, `record`, `lane`) is only shown as a warning, since repositories use such words in their own sense.
For a lane without a PR, the same card approves the PR title, body and commit message together; for a lane with an open PR, the push goes to that PR and its title and body stay unchanged.
The CLI does not push or create PRs: `ship` and `export` only point to the Inbox card.
Existing PR bodies are updated through their own outbound card with a diff.
`local-complete LANE TOKEN` recovers records for a proposal with no public changes.
These commands require explicit human execution; agents must not call them automatically.

For external updates, use `receive LANE [BRANCH]` or `adopt LANE BRANCH`.
Resolve conflicts and commit in the returned recovery worktree.
Then run `review-receive LANE` and `accept-receive LANE TOKEN` after checking the returned diff.
For the work branch, use `propose-import AREA`, `review-import AREA`, then `import AREA TOKEN`.
`sync AREA` runs these three steps and then reclaims and closes the merged lanes.
It stops without changing the work branch on a conflict or a failing required check.
The import has no effect outside this machine, so agents may run `sync`.
The Inbox also exposes these operations.
To replace an outdated preparation, use `cancel-receive` or `cancel-import`; recovery worktrees remain available.

After a PR merges, the tick imports the public base into the work branch, recovers the lane records and closes the lane; nobody types `sync AREA`.
It does so only for repos that have a merged lane waiting, and its checks must fit inside one tick (their longest run, with the grace past each limit, at most 17 minutes, and started so that it ends within 18 minutes of the tick's start); a repo whose checks cannot is left to `sync AREA`, and its Inbox card says so.
When the import conflicts, a required check fails, the work branch is not clean or the records cannot be recovered, the lane stays open and its Inbox card gives the reason and the place to fix.
The card is not raised again for the same cause, and the lane is not tried again while it is up.
For an import conflict, once it is resolved and committed in the recovery worktree (or the cause is otherwise cleared), the next tick reads it again, imports and closes the lane; you may also answer the card with retry.
For a conflict while recovering the lane records, committing in its recovery worktree is not enough: merge the resolved result into the work branch, and the next tick then reads it again (the card names that place).
`sync AREA` stays for a person who wants it now. A failed recovery keeps the lane available.
A failed push or PR operation can be retried by approving the same card again.
An interrupted process may leave `idd-overlay.lock` in the Git common directory.
Check its `owner.json` and confirm that the recorded process has stopped before removing that lock directory.
Keep the proposal and recovery records; they are needed to determine which operation completed.

Run overlay regression tests with `node --experimental-strip-types --test packages/idd-core/test/overlay.test.mjs`.
