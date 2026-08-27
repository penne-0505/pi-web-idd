# Web UI ↔ LLM 通信 envelope schema

Web UI (pi-web-idd) と各 agent session (Planner / Executor / Integrator / Verifier / Responder) の間で受け渡す message の formal schema。

## 通信方向と方式

- **LLM → Web UI**: 一般的な tool call (agent が pi-web-idd の API を叩く)
- **Web UI → LLM**: **user prompt 前挿入方式** — 次の会話 turn の user prompt 位置に envelope を挿入する

## 共通 envelope 形式

XML-like tag での wrap を採用。boundary が明確で LLM が識別しやすい。

```
<idd-system-message>
  <sent-at>ISO 8601 timestamp with JST</sent-at>
  <type>message type</type>
  <idd-id>IDD-XXX (該当 lane がある場合)</idd-id>
  ...type-specific payload...
</idd-system-message>
```

**必須 field**:
- `<sent-at>`: 送信時刻
- `<type>`: message type
- `<idd-id>`: 該当 lane の ID (該当ある時のみ)

**必要な理由**:
- 「ユーザー発言と区別する識別子」として tag boundary が明確
- LLM が「これは system 通知」と即座に認識できる
- 属性値ではなく child element にすることで、JP text 内の特殊文字 escape 問題を回避

## Message type 一覧

### `question_batch_answered`

質問 batch の全 question に回答が集まった時、planner/executor に通知。

```xml
<idd-system-message>
  <sent-at>2026-08-25T07:25:00+09:00</sent-at>
  <type>question_batch_answered</type>
  <idd-id>IDD-042</idd-id>
  <batch-id>B-001</batch-id>
  <qa-pairs>
    <qa-pair>
      <question-id>Q-001</question-id>
      <question>ダークモードのトグルはどこに配置しますか?</question>
      <context>既存の設定パネル (SettingsPanel.tsx) は 3 tab 構成で...</context>
      <options>
        <option>
          <index>1</index>
          <label>既存の設定パネル内に追加する</label>
          <description>4 tab 目になるが、設定関連が一箇所にまとまる</description>
        </option>
        <option>
          <index>2</index>
          <label>header の右上に独立配置する</label>
          <description>常時表示で切り替えは速いが、視覚密度が上がる</description>
        </option>
        <option>
          <index>3</index>
          <label>既存パネルを再構成してから追加する</label>
          <description>手間はかかるが情報設計としては根本改善</description>
        </option>
      </options>
      <selection>
        <index>3</index>
        <label>既存パネルを再構成してから追加する</label>
      </selection>
      <reason>既存パネルの情報密度が理想と比べると微妙で、この機会に整理し直したいから</reason>
      <notes>ただし今回の lane 内で再構成まで踏み込まず、再構成は別 lane として起票してから着手すること</notes>
    </qa-pair>
    <!-- 他 question も同構造 -->
  </qa-pairs>
</idd-system-message>
```

**self-containment 原則**: `<question>`, `<context>`, `<options>` (選ばれなかったものも含む), `<selection>`, `<reason>`, `<notes>` を全て echo する。planner が session context の一部を失っても、この envelope だけで判断を復元できる。

**その他 選択時**: `<selection>` の中に `<index>` を含めない (label のみ)。`<notes>` に実際の回答本文が入る。

### `priority_elevated`

Level 1 interrupt (人間が「これを最優先に」と指示) を該当 lane の agent に通知。

```xml
<idd-system-message>
  <sent-at>2026-08-25T10:00:00+09:00</sent-at>
  <type>priority_elevated</type>
  <idd-id>IDD-042</idd-id>
  <reason>顧客から緊急依頼が来たため最優先で進めてほしい</reason>
</idd-system-message>
```

### `lane_rejected`

S3_reject の時に executor / planner session に通知。

```xml
<idd-system-message>
  <sent-at>2026-08-25T18:00:00+09:00</sent-at>
  <type>lane_rejected</type>
  <idd-id>IDD-042</idd-id>
  <reject-reason>既存の localStorage 実装を破壊している (INV-2 違反)</reject-reason>
  <next-stage>s2_retry</next-stage>
  <feedback>localStorage の theme key を上書きせず、'theme.v2' として並存させて。既存の theme key を読んでいる code (SettingsPanel.tsx:42, ThemeInitializer.ts:15) が影響を受けるため。</feedback>
</idd-system-message>
```

- `<next-stage>`: `"s2_retry" | "s1_rethink" | "deferred"`
  - `s2_retry` → executor session に届く (resume して feedback を元に再実装)
  - `s1_rethink` → planner session に届く (方針から見直し)
  - `deferred` → agent session を穏当に終了

### `lane_deferred`

人間が defer 判定した時、agent に作業停止を通知。

```xml
<idd-system-message>
  <sent-at>2026-08-25T18:00:00+09:00</sent-at>
  <type>lane_deferred</type>
  <idd-id>IDD-042</idd-id>
  <reason>スコープが大きすぎるので一旦保留</reason>
</idd-system-message>
```

### `info_update`

外部で状況が変わった (Linear 側 priority 変更等) 時の再確認要請。

```xml
<idd-system-message>
  <sent-at>2026-08-25T14:00:00+09:00</sent-at>
  <type>info_update</type>
  <idd-id>IDD-042</idd-id>
  <description>Linear 側で issue の priority が Medium → High に変更されました。intent 側で反映が必要か確認してください。</description>
</idd-system-message>
```

## Type ごとの適用先 agent

| Type | 送信先 agent |
| --- | --- |
| `question_batch_answered` | Planner (S1), Executor (S2 blocked時) |
| `priority_elevated` | 該当 lane の active agent (any) |
| `lane_rejected` | Executor (s2_retry) or Planner (s1_rethink) |
| `lane_deferred` | 該当 lane の active agent |
| `info_update` | 該当 lane の active agent |

## agent 側の処理指針

各 agent は envelope を受け取ったら以下の順で処理:

1. `<type>` を見て自分がすべきことを判定
2. 該当する payload を読み込む (self-contained なので context 復元可能)
3. 作業を継続 or 停止

**特に `question_batch_answered` の handling**:
- 受け取った回答 (selection + reason + notes) を DEC 生成の判断材料として使う
- reason には user の意図 (「なぜこれを選んだか」) が含まれるので、DEC の記述に反映
- notes に補足がある場合 (「A を選ぶが B も併用」等) は制約として尊重

## 実装上の考慮

- envelope の生成: pi-web-idd server 側の関数 (`buildEnvelope(type, data): string`)
- 送信: 該当 agent の pi session の次 user prompt に文字列として prepend
- 送信 timing:
  - `question_batch_answered`: batch 内全 answer が append された瞬間
  - `priority_elevated`: `priority_elevated` event 発火の瞬間
  - `lane_rejected` / `lane_deferred`: 該当 event 発火の瞬間
  - `info_update`: 外部 source 監視 (別 poller) で変更検知時
