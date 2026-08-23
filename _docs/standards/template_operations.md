# Template Operations

本書はテンプレートの導入・継続更新の標準である。読まれるのは導入時とテンプレ更新時のみ。
日常のループは `workflow.md`、文書契約は `document_contracts.md` を参照。

## Template revision provenance

この template を適用した project が後続 release を継続的に取り込めるよう、upstream template の
provenance を `docs-template.lock.json` に記録する。雛形は root の `docs-template.lock.example.json`
とする。

```json
{
  "schema": 1,
  "source": "https://github.com/penne-0505/intent_driven_dev_template.git",
  "revision": {
    "tag": "v2.5.3",
    "commit": "<tagが解決するfull 40-character commit SHA>"
  }
}
```

- **更新単位**: upstream が推奨する immutable release tag を使う。branch 名や moving tip を lock に
  記録しない。
- **実体の固定**: tag 名だけでなく、その tag が解決する full commit SHA を記録する。後から同名 tag の
  解決先が変わった場合は migration を停止する。
- **初回導入**: tagged release から開始した project は、雛形を `docs-template.lock.json` へコピーし、
  採用 tag の full SHA を記録する。lock は project の tracked file とする。
- **通常更新**: lock の revision を `B`、次の推奨 tag を `U` とし、`docs-template-migration` skill で
  project customization を含む three-way migration を行う。`U` の配布ファイルを reconciliation し、
  compatibility checks が成功した後に、lock を最後の migration write として `U` へ進める。
  closure verification では更新後の tag と full SHA を確認する。
- **schema 状態との分離**: lock は統合済み upstream revision だけを示す。strict schema migration の
  完了・延期・残リスクは QA round に記録し、lock schema へ混在させない。
- **pre-v1.0.0 bootstrap**: tag、lock、local migration skill がない既存 project は、repository
  history、導入記録、upstream と一致する blob から最後に採用した commit `B` を復元する。project
  固有ルールを安全境界とし、対象 `U` の skill を外部入力としてレビューしてから書き込みを行う。
  `v1.0.0` を中継せず、`v1.0.0` 以降の任意の推奨 tag へ直接移行できる。`B` が一意に特定できない
  場合は owner 判断を推測せず停止する。compatibility migration の PASS 後に初回 lock を `U` で
  作成する。
- **template release 側**: release tag を作成する commit では、`docs-template.lock.example.json` の
  `revision.tag` をその tag 名へ更新しておく。commit SHA は tag 作成後に解決するため、雛形では
  placeholder のままとする。

`DD_SCOPE_BASE` は導入先 repository 内の validator 対象を決める project-local git ref であり、
upstream template の採用 revision を示す値ではない。両者を兼用しない。

## 採用側 toolchain との境界

template が配布する実行コードは Deno を対象とする。`scripts/` の validator と `_meta/` の
validator fixture がこれに当たる。いずれも採用先 repository の source tree 内へ置かれるため、
採用先が自前の TypeScript / JavaScript toolchain を持つ場合、既定の glob (`**/*.ts` など) が
これらを巻き込む。

- **除外は採用側の責務**: 採用先の tsconfig、formatter、linter、bundler の対象から `scripts/` と
  `_meta/` を除外する。template は採用先の設定ファイルを所有しないため、この除外を代行できない。
- **template gate の射程**: `./scripts/check-docs.sh` は docs 規約と validator 自身の健全性だけを
  検証する。`deno check` の対象は `scripts/` に限られ、`_meta/` の fixture は意図的に型検査しない
  (壊れた入力を再現する fixture を含むため)。**採用先の build / typecheck / lint が通ることは、
  この gate からは導けない。**
- **fixture の設計制約**: fixture は validator への入力として壊れていてよいが、採用先の
  typechecker に読まれるだけで新しい error を生む書き方をしない。抑制対象のない
  `@ts-expect-error` のように、対象言語の処理系が単独で error にする記述を置かない。
- **更新時の確認**: release 統合後は docs gate に加えて採用先自身の build / typecheck / lint を
  実行し、upstream 由来のファイルが採用先の gate を壊していないことを確認する。

理由: template の配布物は採用先の source tree に同居する。template 側の gate だけを緑にして
完了と判定すると、採用先の build が壊れたまま release 統合が PASS になる。

## 段階的導入スコープ (Incremental Adoption)

既存プロジェクトへ後付け導入する際、テンプレート規約に従っていない既存 docs / コードが一斉に
検証対象となり CI が埋まるのを避けるため、validator は「導入以降に追加・変更されたファイル」だけを
判定対象に絞る opt-in スコープ機構を持つ。本節を段階的導入スコープの正典とする。

- **既定は全走査**: 環境変数が未設定なら、各 validator は従来通り全対象を走査する。テンプレート
  自身の CI はこの既定で dogfooding を続ける。
- **`DD_SCOPE_BASE`**: 導入時点の git ref (commit / tag) を設定すると、
  `git diff --name-only --diff-filter=A <ref>...HEAD` で得た「追加されたファイル」のみを判定対象に
  する。
- **`DD_SCOPE_DIFF_FILTER`**: `DD_SCOPE_BASE` 使用時の git `--diff-filter` を上書きする。既定は
  `A`。既存ファイルを編集した時点で管理対象にしたい導入先では `ACMR` を設定する。
- **`DD_SCOPE_PATHS`**: 改行 / コロン区切りの明示パスリスト。優先順位は
  `DD_SCOPE_PATHS > DD_SCOPE_BASE > 未設定`。
- **`TODO.md` は常時検証**: `validate-todo.ts` はスコープの影響を受けない。
- **横断チェックの扱い**: リンク / references の整合チェックは判定の起点ファイルだけをスコープで
  絞り、参照先の存在確認はファイルシステム全体に対して行う。
- **必要権限**: スコープ対応 validator の実行には `--allow-env` を、`DD_SCOPE_BASE` (git) 使用時は
  加えて `--allow-run=git` を付与する。権限が無い場合は安全側 (全走査) へフォールバックする。
- **CI 設定**: `DD_SCOPE_BASE` を使う場合、baseline commit を参照できるよう `actions/checkout` で
  `fetch-depth: 0` を設定する。

既存コード・仕様書・過去の記録から intent を掘り起こす導入時の手順 (意図採掘) は、本標準の
射程外であり、`intent-mining` skill が担う。テンプレートの構造を統合するのが
`docs-template-migration`、既存プロジェクトに眠る why を DEC として回収するのが
`intent-mining` である。
