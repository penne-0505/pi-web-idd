# idd-fold

台帳の fold — lane の状態（lifecycle から）と意図の記録（意図の列から）を畳む MoonBit の module。engine の
状態の口も、Work の口も、書き込みの口が断るかの判断も、CLI の答えも、`packages/idd-core/src/intent/store.ts`
の `laneStates` / `foldRows` を通ってここへ来る。呼び手によって畳みが違うと、画面に出た状態と書き込みの判断が
食い違うので、畳みは 1 つだけ置く。

同じ理由で、lifecycle から決まる lane の読みもここに置く: review の巡の状態、段（Claude の枠待ちの文を
被せる前の記録だけの答え）、lane を止める判定、lane の終わり、blocker の lane の着地、そして取り込みの
承認の 4 つの読み（署名済みの承認が今も効いているか、着地の待ちの理由、R2 の記録の待ちと直せるか、S3 と
R2 が最後に見た head）。engine・CLI・tick・card は `packages/idd-core/src/intent/moonbit-fold.ts` の
`laneAnswer` を通ってここへ来る。巡の状態が立つ判定（受理の読み・回の方針・衝突の差し戻し・停滞・上限）と
深さの表もここに 1 つだけ置き、TS の読み手はその答えを読む。git・manifest・鍵を読む判定（取り込みの
記録だけの断り、署名の検証、見た head の tree の比較）はここに置かない。

## 何が入っているか

| ファイル | 中身 |
| --- | --- |
| `event.mbt` | event の名前を閉じた型（`LifecycleEvent` / `IntentEvent`）に変える境界。知らない名前も型の 1 つの値として残す |
| `rows.mbt` | 1 行を JSON から読む。畳みが決める欄だけ型にし、畳みがそのまま返す欄（`forms`・`origin`・`by`・`at`）は JSON のまま持つ |
| `time.mbt` | `at` の instant と、読めない値どうしの比べ。instant の読みは host の `Date.parse`、文字列の順序も host の `<`（どちらも境界の `extern "js"`）に任せる |
| `place.mbt` | Place を module に読み替え、`places_moved` の移動を当てる |
| `lanes.mbt` | lifecycle → lane の状態（`mergedAt`・`endedAt`・GO が名指した Purpose） |
| `fold.mbt` | 意図の列 → Purposes・Choices・Waives・harm examples |
| `writer.mbt` | 答えを JSON の文として書く。木を作って書き出すより速い |
| `js_val.mbt` | 行の値を TS と同じ規則で読む（truthiness・`Number()`・`String()`・`toFixed`）。文法と丸めは host の `extern "js"` に任せる |
| `derived_event.mbt` | 導出が読む event の名前を閉じた型（`DerivedEvent`）に変える境界。知らない名前も 1 つの値として残す |
| `lifecycle.mbt` | 導出が読む 1 行（`DerivedRow`）。畳みの読み（`rows.mbt`）とは別に、`attrs` を `RowAttrs` として持つ |
| `attrs.mbt` | 導出が読む行の `attrs` の欄を 1 か所で宣言する（`RowAttrs`）。宣言に無い欄は境界で捨てる |
| `land_reads.mbt` | 取り込みの承認の 4 つの読み（承認が効いているか・着地の待ち・R2 の記録の待ちと直せるか・S3 と R2 が見た head） |
| `land_failure.mbt` | 取り込みの検査が落ちた原因の読み（環境の失敗か変更の失敗か、検査の行と作り直せなかった記録のどちらからも）。作っていない記録の見分け（`is_unbuilt_land`）と、その区分（`unbuilt_cause`）を 1 か所に置く |
| `land_step.mbt` | 取り込みの段の次の一歩（署名済みの承認を入れる・失敗した検査の後始末・新しい検査）。書く記録・呼ぶ helper・段の結果を閉じた一歩の列で返す。作り直せなかった 1 本ずつの取り込みの次の一歩（差し戻し・人への引き継ぎ・待ち・試し直し）は `land_unbuilt_next` の 1 つの判定が決め、最初の検査・失敗の後始末・承認済みの各経路はその答えを当てるだけである |
| `next_step.mbt` | review の巡の次の一歩（巡のどの leg を踏むか、そこで書く event と、次にすること） |
| `pick.mbt` | 段ごとに、その段が lane を拾うか、拾わないならその理由 |
| `submit_step.mbt` | 提出の段の次の一歩（書く記録・呼ぶ helper・段の結果） |
| `start_steps.mbt` | lane の始動の次の一歩（書く記録・呼ぶ helper） |
| `review_judge.mbt` | review の巡の方針（roles.yaml）と、判定が台帳の外から要る事実 |
| `turn.mbt` | Claude Code の枠の読みと、lane の turn が記録の外から要る事実 |
| `value_types.mbt` | 意図の記録の状態（Choice の status など）の閉じた型 |
| `json_read.mbt` | JSON の値を安全に読む小さな関数（欠けた key・配列・object） |
| `pre_merge.mbt` | 最初のレビューの前の本流の取り込み（action と、そこで書く記録・呼ぶ helper）。git・runner・lane の lock の読みは事実として渡し、merge と封筒と記録の書き込みは呼び手に残す |
| `review_loop.mbt` | 巡の状態と、その読み手が共有する判定（受理・回の方針・衝突・停滞・上限）、review の読み手の答え |
| `stage.mbt` | 段（記録だけの答え）、lane を止める判定、plan の査読の段、粒度の待ち、lane の終わりと着地、深さの表 |
| `ledger_reads.mbt` | 残った台帳の読み（PR 待ち・lane の終わり・退役の対象と記録・PR の下書き・取り込みが閉じた lane と着地した lane・終わりの一覧） |
| `api.mbt` | 境界。行を渡す（`put_lifecycle` / `put_intent`）、畳む（`lane_states` / `fold_records`）、導出に答える（`lane_answer`）、深さの表と review の event の一覧を渡す |

## build 済みの JS を commit する

engine・CLI・node のテストは **build をせずに** 源を走らせる。`dist/` の JS は源と同じ commit で持ち、
取り込みの検査（`config/repos.yaml` の `moonbit`）が、源から build し直した物と 1 byte も違わないことを
確かめる。ずれた差分は取り込めない。

源を変えたら、同じ commit で次を回す。

```sh
bash scripts/build-idd-fold-dist.sh
```

script は `moon build --target js --release` を回し、`_build/js/release/build/` の `idd-fold.js`・`idd-fold.d.ts`・
`moonbit.d.ts` を `dist/` に写す。moon は lane の PATH に無いので、script は PATH に無ければ `${MOON_HOME:-$HOME/.moon}/bin`
を探す。

取り込みの段（`config/repos.yaml` の `generated_files`）も同じ script で `dist/` を作り直す。lane か本流のどちらかが
`dist/` を変えた取り込みは、merge した源から作り直した `dist/` が本流に入る。`dist/` だけが衝突しても lane は戻らない。

作り直せないときの扱いは、1 本ずつの取り込みとまとめた取り込み（batch）で違う。

- **1 本ずつの取り込み**: 作り直せなかった tree は検査も承認もしない（記録は merge commit を持たず、`rebuildFailure` に
  区分・path・理由・時刻を持つ）。区分は 1 つの判定（`land_failure.mbt` の `unbuilt_cause`）が決める。
  - 環境の失敗（道具が無い・起動しない・時間切れ）は、同じ head と本流の先端で検査と同じ間隔（2 分）と上限（3 回）で
    試し直し、上限の後は理由つきで人の判断を待つ。
  - 変更の失敗（build が落ちる・宣言した path を書かない）は、build の出力を伴って実装役へ 1 度だけ差し戻し、
    試し直さない。
  - 次の一歩は `land_step.mbt` の `land_unbuilt_next` の 1 つの判定から出る。最初の検査・失敗の後始末・承認済み
    （承認の carry と再準備）の各経路はその答えを当てるだけで、経路ごとの分岐を持たない。承認済みの経路は先に承認を
    外し、作っていない記録に承認が効いたままにならない。mergeCommit と `rebuildFailure` を併せ持つ旧い形の記録は
    承認されず、計画し直される。
- **まとめた取り込み（batch、`packages/idd-core/src/overlay/batch.ts`）**: 上の分け方は当てない。結果はこの変更の前の
  まま（応急処置）で、生成物だけが衝突し作り直せないときは、その lane をまとめから外す。衝突の無い併合で作り直せない
  ときは、git が作った tree のまま通し、失敗は区分と path つきでまとめの記録（`rebuildFailures`）と card に残す。
  まとめの側で環境と変更を分け、作っていない tree を通さない直しは #324 にある。

## 2 つの読みを突き合わせる

入れ替える前の TypeScript の読みは、走る経路の外にそのまま残す。テストと突き合わせだけが読む。

- `packages/idd-core/src/intent/fold-reference.ts` — 意図の記録と lane の状態の畳み。
- `packages/idd-core/src/ledger/review-loop-reference.ts` — 巡の状態と、その読み手の答え。
- `packages/idd-core/src/plan/submit-step-reference.ts` — 提出の段の次の一歩（書く記録・呼ぶ helper・読み直す点）。
- `packages/idd-core/src/ledger/derive-reference.ts` — 段（枠待ちの文を被せる前の記録だけの答え）。
- `packages/idd-core/src/overlay/land-reads-reference.ts` — 取り込みの承認の 4 つの読み（git と鍵を読まない側だけ）。
- `packages/idd-core/src/plan/land-step-reference.ts` — 取り込みの段の次の一歩（書く記録・呼ぶ helper・段の結果）。
- `packages/idd-core/src/plan/ledger-reads-reference.ts` — 残った台帳の読み（PR 待ち・lane の終わり・退役・PR の下書き・閉じた lane）。

取り込みの検査で回るのは、commit した fixture だけを読むテストである。どの機械でも同じ結果になる。

- `packages/idd-core/test/fold-moonbit.test.mjs` — `fixtures/fold/` の意図の列と lifecycle。
- `packages/idd-core/test/derive-moonbit.test.mjs` — `fixtures/derive/lifecycle.jsonl`。全 prefix で巡の状態・
  段・終わり・着地と、読み手の答えを比べる。
- `packages/idd-core/test/land-step.test.mjs` — 取り込みの段の次の一歩を、台帳の組と観測値の組で比べる。
- `packages/idd-core/test/land-reads-moonbit.test.mjs` — `fixtures/land/lifecycle.jsonl`。全 prefix で取り込みの
  4 つの読みを比べ、印の無い承認がどの入口でも承認として読まれないこと、card の印が畳みの答えから来ることを
  確かめる。

本物の台帳との突き合わせは、state の置き場を名指して回す。全 lane の全 prefix で、巡の状態・段・終わり・
着地・取り込みの 4 つの読みを比べ、#186 の 2 つの畳みも同じ実行で比べる。

```sh
node --experimental-strip-types packages/idd-fold/crosscheck.mjs <state の置き場>
```

### 片割れのサロゲートは境界で U+FFFD にする

MoonBit の String は UTF-8 で、片割れのサロゲート（`\ud800`）を表せない。MoonBit の JSON parser もその
escape を拒む。行を JSON で渡す口では、1 行の壊れた文字で列の transfer 全体が落ち、TS なら畳める台帳が
畳めなくなる。だから `moonbit-fold.ts` が行を渡す直前に、その code unit だけを U+FFFD に置き換える。置き換えは
境界だけで行い、畳みと導出の中では行わない。その 1 行の文面だけが TS の答えと変わる（C-191-4）。

## 規範

MoonBit の書き方は `skills/propter-moonbit/SKILL.md` に従う。とくに、enum の `match` を `_` で逃げないこと
（event の型に値を足すと、扱いを書くまで `moon check --deny-warn` が通らない）、inline snapshot test を
書くこと、`Any` と `%identity` を境界の外へ出さないこと。
