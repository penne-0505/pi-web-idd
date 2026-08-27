# 拡張 IDD flowchart (FigJam)

## FigJam URL

https://www.figma.com/board/8E3YqusFdl8eSefc8wPet3

fileKey: `8E3YqusFdl8eSefc8wPet3`

## Page 構成

| Page 名 | Page ID | 内容 |
| --- | --- | --- |
| `overview` | `0:1` | 拡張 IDD 全体像 (5 subgraph 縦並び + cross-stage 差し戻し矢印) + ぺんねさんの元の下書き section |
| `S0 detail` | `42:1619` | Intake — cron/手動 trigger, Linear/GH 取得, 重複判定, backlog append |
| `S1 detail` | `42:1620` | Planner Prep — priority sort, 並列 planner spawn, DEC/INV/QA/reference 生成, 質問 batch flow |
| `S2 detail` | `42:1621` | Executor Implementation — supervisor, 実装 loop, blocked/fallback/recovery |
| `S3 detail` | `42:1622` | Integration Check — Integrator 3 態度 (mechanical/sub todo/user), cascading merge-tree, user review |
| `S4 detail` | `42:1623` | Ship — Phase A (Verifier 込み) + Phase B (polling/Responder/3 態度) + cleanup 7 手順 |

## 読み順

1. **overview** で全 stage の関係を把握
2. **S0 → S1 → S2 → S3 → S4** の順に detail を読む
3. 各 detail は上から下へ flow を追う

## 過去の retrofit 履歴 (参考)

- 初期に "TODO-042" prefix → "IDD-042" prefix に変更 (generic な TODO 衝突回避)
- Intent 配置を pi-web-idd の state ではなく worktree の `_docs/intent/**` (msync overlay で管理) に確定
- S2 で connector 検知を退け → 全 conflict 責務を S3 に集中
- S3 に Integrator agent (LLM) を追加 (機械 gate + 人間判断) から (AI 主導解決) へ転換
- S4 の branch 名を独自 pattern → Linear API 取得 (Meltly) に retrofit (山下さん指摘)
- S4 の PR body を intent template → 全 commit AI 要約 に retrofit (山下さん指摘)
- S4 Phase A に Verifier agent (GLM 5.3 medium) 追加

## flowchart 生成時の技術メモ

- Mermaid.js flowchart TB 記法で作成
- FigJam に generate_diagram tool 経由で描画
- connector の routing は Figma 側 auto layout に依存
- 個別 node の position を変更すると connector routing が破壊されるため、位置調整は section 単位の appendChild reparent で行うのが安全 (座標を触らない)
