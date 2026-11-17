---
name: propter-moonbit
description: MoonBit を書く前に読む規範。`Any` と `%identity` は FFI の境界でだけ使い、`raise` を握りつぶさず、enum の `match` を `_` で逃げず、inline snapshot test を書き、JS backend で bun の上に置く。MoonBit の module を持つ repo の lane で適用する。
---

# MoonBit の規範

MoonBit を書く前にこのファイルを読む。規範の正本はこの 1 本である。

一般の書き方は利用者の置き場にある mizchi/skills の skill が持つ（所在と固定する commit は下の「文法の落とし穴は mizchi の skill を版で名指して読む」の節にある）。両方を読んで食い違うときは、取り込みの検査が回る repo ではこの規範が勝つ。この規範は検査と対になっていて、一般の skill は検査の無い書き方も許すからである。

MoonBit の module がある repo では、`moon check --deny-warn`・`moon fmt --check`・`moon test` が取り込みの検査で回る。検査は compiler と道具が拒否できる雑さを止める。compiler が拒否できない雑さは、この規範が受け持つ。

## 確かめた toolchain の版

- moon 0.1.20260827（d0aaa07 2026-08-27）
- moonc v0.10.11+6ff76a5f9（2026-08-28）
- feature flag: `rr_moon_mod`・`rr_moon_pkg`

MoonBit は 1.0 の前で、0.10.x の間にも構文が変わる。だから版を書く。版が無いと、規範が手元の compiler で成り立つかを読む側が判断できない。

手元の版は `moon version --all` で確かめる。この規範の 5 点は、上の版で確かめた。

MoonBit 1.0 に上がったら、この規範を見直す。構文と道具が変わり、規範の根拠も変わるからである（#182・#185）。規範が古いまま 1.0 の差分を通すと、直すべき箇所が人のレビューに残る。

版を上げただけでは規範を外さない。規範に合わないのは compiler ではなく code の側であることが多い。

## 規範 1: `Any` と `%identity` は FFI の境界でだけ使う

`Any` と `%identity` は型を消す。`Any` を受け渡すと compiler は中身の型を確かめられない。`%identity` は型検査だけを通し、実行時の変換をしない。どちらも JS の値を運ぶ FFI の語で、`mizchi/js` の `js_core` が持つ。

自分の型を `Any` にして持ち回ると、型の取り違えが compile で落ちない。落ちるのは実行時で、そこでは別の型として読まれて黙って動くこともある。`%identity` を `Int` と `String` の間に使えば、警告なしに実行時 error になる。

書き方:

- `Any` と `%identity` は `extern "js"` の宣言と、その直後の変換だけに置く。
- 境界で自分の enum か struct に落とし、公開の関数の引数と戻り値には残さない。
- JS の object は `#external pub type` の opaque な型で包めるなら包む。

## 規範 2: `raise` を握りつぶさない

MoonBit は関数の型に error を持つ（`raise E`）。呼び出し側が失敗を知れるのは、error が型に残っているときだけである。

`catch { _ => 0 }` のように握りつぶすと、失敗が成功と同じ値になる。呼び出し側は失敗を区別できず、台帳や状態が黙って欠ける。`try?` で `Option` に潰すのも同じで、どの error だったかが消える。`try?` は 0.10.11 でも非推奨の警告が出る。

書き方:

- error は関数の型に残す（`fn parse(s : String) -> Int raise ParseError`）。
- 回復できる境界でだけ `catch` し、error の値を使って `Result` か `Option` に変える。
- error を捨てるときは、捨てた理由をその場に書く。
- `-> T!E` の書き方は非推奨である。0.10.11 でも警告が出る。

## 規範 3: enum と網羅の `match` を使い、`_` で残りを受けない

網羅しない `match` は compiler が error にする。だから enum に variant を足すと、扱いを忘れた `match` がすべて compile で落ちる。compiler を味方にできるのはこの形だけである。

`_` を 1 本置くと、この仕組みが消える。variant を足しても compile は通り、新しい variant は `_` の枝で「その他」として扱われる。誰も気づかないまま、新しい状態が古い既定に落ちる。

書き方:

- enum の `match` は variant を全部並べる。
- 外から来る値は境界で enum に変換し、enum の `match` に `_` を置かない。
- `Int` や `String` のように開いた型を `match` するときだけ `_` を使い、その `match` を型の定義の近くに置く。
- ほかの package の test から variant を作るなら、enum を `pub(all)` にする。`pub enum` の variant は read-only で、test から作れない。

## 規範 4: inline snapshot test を書く

inline snapshot は、期待する値を assertion の隣に置く。だから振る舞いが変わると差分が test の隣に出て、`moon test -u` で書き換えた内容をそのままレビューできる。

`assert_eq` を書かない test や、`true` を返すだけの test は、振る舞いが変わっても通る。通る test は、壊れたことを誰にも知らせない。

書き方:

- `test "…" { inspect(f(x), content="…") }` を書く。
- 期待値は手で書かず、`content=""` で置いて `moon test -u` に埋めさせる。埋まった値を読んでから commit する。
- `moon test -u` の後は `moon fmt` を回す。0.10.11 の `-u` は fmt の形と違う snapshot を書き、そのままでは `moon fmt --check` が落ちる。
- test を通すために期待値を書き換えない。振る舞いを直すか、期待値の変更を commit の本文に書く。
- TS の実装と結果を突き合わせる test は、突き合わせる値を snapshot にする。差分がそのまま 2 つの実装のずれになる。

## 規範 5: JS backend で bun の上に置き、`mizchi/js` の bind を使う

engine は当面 JS backend で bun の上に置く。MoonBit の native 化は 1.0 の後である（#182）。だから IO と runtime の API は JS のものを、`mizchi/js` の bind 経由で使う。

`moonbitlang/async` は native を優先し、JS backend では IO が使えない。これで fs や process を書くと、test は通り、bun の上で動かしたときに落ちる。

`extern "js"` を自分で並べると、型の付いた bind を失い、`Any` と `%identity` が境界の外へにじむ。`mizchi/js_bun` の Bun の bind は AI 生成で未検証である（#182）。使うときは、動くことを test で確かめてから頼る。

書き方:

- `moon.mod` に `preferred_target = "js"` を書く。`extern "js"` は wasm backend では compile できない。`moon check` と `moon test` はこの target で回る。
- Node の API は `mizchi/js_node`、Web 標準は `mizchi/js_web`、FFI の芯は `mizchi/js_core` を使う（`mizchi/js` は 0.13.0 でこの module に分かれた）。
- `moon.pkg` に `targets` を書くときは、`extern "js"` を含むファイルを `"js"` に限る。複数の target を持つ module ではこの欄が要る。
- JS の API を自分で宣言するのは、`mizchi/js` に無いときだけにする。

## 文法の落とし穴は mizchi の skill を版で名指して読む

0.10.x の構文の落とし穴（型引数の位置、`raise`、`fn new` の削除、trait の `fn`、`moon.mod.json` から DSL への移行）は、mizchi/skills の MoonBit の skill が版を確かめて持っている。この規範はその本文を写さない。写すと、MoonBit が minor の版で構文を壊すたびに 2 つの写しを追うことになる。

- repo: `mizchi/skills`
- 固定する commit: `a41865b34b78f2675a6c73178377a5bcc1b492c6`（2026-09-16）
- 読む skill: `moonbit-practice`（構文・test・error handling。本文は MoonBit v0.10.12 で確かめたと書く）と `moonbit-js-binding`（JS の FFI と `%identity` の使い所。v0.10.12 で確かめたと書く）。TS の移植では `ts2moonbit-migration`（JS の API の契約を保ったまま TS を MoonBit に移す手順）も読む
- 読む手段:

```sh
gh api repos/mizchi/skills/contents/moonbit-practice/SKILL.md?ref=a41865b34b78f2675a6c73178377a5bcc1b492c6 --jq .content | base64 -d
gh api repos/mizchi/skills/contents/moonbit-js-binding/SKILL.md?ref=a41865b34b78f2675a6c73178377a5bcc1b492c6 --jq .content | base64 -d
gh api repos/mizchi/skills/contents/ts2moonbit-migration/SKILL.md?ref=a41865b34b78f2675a6c73178377a5bcc1b492c6 --jq .content | base64 -d
```

commit を固定するのは、実装役が読む本文を、この規範を書いたときに確かめた本文に揃えるためである。`main` を読むと、外の更新で規範の前提が黙って変わる。

手元の moonc は 0.10.11 で、mizchi の skill の 0.10.12 より 1 つ前である。食い違ったときは compiler の warning と `moon explain <error-code>` を正とする。

skill の dir に license のファイルは無く、README は無い skill を持ち主の裁量で MIT と既定する。だから本文を配る package に写さない。名指して読むだけにする。

## 手元の道具

- moon の道具は `~/.moon/bin` にあり、lane の PATH には無い。`~/.moon/bin/moon` で呼ぶか、その session だけ `PATH="$HOME/.moon/bin:$PATH"` を通す。
- `moon ide` は `moon-ide` を PATH から探す。`moon ide` を使うときも `PATH="$HOME/.moon/bin:$PATH"` を通す。
- `moon fmt` は file を書き換える。`moon fmt --check` は書き換えずに差分を出して落ちる。
- `moon new` は `moon.mod`・`moon.pkg`・`.gitignore` と、moon 自身の `AGENTS.md` を作る。作った module は `moon fmt` を 1 回回すまで `moon fmt --check` に落ちる。
- `moon new` の `AGENTS.md` は moon の雛形の指示である。repo の規範と食い違うので、repo が要らないなら commit しない。
- `moon test` は module の `preferred_target` で回る。失敗すると終了コード 2 を返す。
