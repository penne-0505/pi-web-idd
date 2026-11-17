---
name: propter-handoff
description: 利用者が会話の内容を Issue か lane に渡すと明示したときだけ使う。宛先の repo を決め、Issue の下書きを送出カードに載せて止まる。会話の workspace が IDD の repo でなくても使える。
---

# chat から lane へ渡す handoff

会話で固まった話を Issue（lane の入口）の下書きにする。その下書きを送出カードに載せる。

載せた後は投稿を待たない。card の場所を利用者に伝えて終える。投稿は利用者が受信箱の card で署名したときだけ行われる。

## 使う条件

利用者が、会話の内容を Issue か lane に渡すと明示したときだけ使う。Issue の話題が出ただけでは使わない。

## 手順

1. テンプレを決める。`~/.config/idd/handoff-template.md` があればそれを使う。無ければこの skill の dir の `template.md` を使う。2 つを混ぜない。
2. `idd out targets` を呼ぶ。渡せる repo と、その取り込みのラベルと対外文書の言語が返る。
3. 宛先の repo（owner/name）を、会話と一覧から決める。決まらなければ利用者に聞く。
4. 一覧に無い repo へは渡さない。渡せないと伝えて止まる。
5. テンプレに沿って題と本文を書く。題は宛先の repo の対外文書の言語で書く。本文は会話の言語のままでよい。清書は題も本文も直す。
6. 下書きを利用者に見せる必要は無い。card が下書きと清書の両方を見せる。
7. 本文を OS の一時 dir のファイルに書く。workspace を汚さない。
8. 下書きを載せる。

```
idd out draft --kind gh-issue --repo owner/name --title "題" --body-file /tmp/handoff.md --source "chat handoff" --lane
```

9. 出力の `url` を利用者に伝えて終える。投稿は待たない。

## 守ること

- `gh issue create` を使わない。`gh api` の書き込みも使わない。Issue は card の署名を通ったときだけ作られる。
- 清書を止める指定は付けない。宛先の repo に Issue のテンプレがあれば、清書はその構成を優先する。
- cwd の repo に記録を作らない。下書きは送出カードだけに置く。
- ラベルを自分で推測しない。`--label` を足さない。ラベルは `--lane` が宛先の repo の設定から付ける。
- CLI が断ったときは、その文面をそのまま利用者に伝えて止まる。断りは、宛先が GitHub の Issue を取り込む設定に無いことを意味する。

## 書くとき

- 会話に無い事実を足さない。
- 決まっていないことは未決として書く。
