#!/usr/bin/env bash
set -euo pipefail

# validator はこの script の置き場（パッケージの scripts/）から呼ぶ。cwd からの相対で呼ぶと、
# scripts/ を写していない repo では回らない（`idd rules check` は写しの無い repo を検査する）。
# 検査の対象（TODO.md・_docs/・git の差分）は、今の cwd の repo とする。
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
template_root="$(cd "$here/.." && pwd -P)"
config_args=()
if [ -f "$template_root/deno.json" ]; then config_args=(--config "$template_root/deno.json"); fi

# TODO.md は root に置く。未展開の出荷物では配る TODO が starter/ 側にあるので、
# root を先に選ぶ。
if [ -f "TODO.md" ]; then
  todo_file="TODO.md"
elif [ -f "starter/TODO.md" ]; then
  todo_file="starter/TODO.md"
else
  echo "check-docs: TODO.md not found at root or starter/" >&2
  exit 1
fi
export DD_TODO_FILE="$todo_file"

# 危ないパスの宣言（config/repos.yaml の risk_paths）。検査は既定の危ないパスを持たず、宣言だけを読む。
# harness の段は IDD_RISK_PATHS で渡す。渡されていない手の実行と CI では、パッケージの登録から cwd の repo の宣言を引く。
# 宣言の無い repo は黙って進む。引けなかったとき（登録の外のパス、node が無い・古い）は、下限が掛からないことを 1 行で言う。
# 登録（repos.yaml）が読めないときは、黙って下限を落とさず risk-paths の段を落とす。
risk_broken=""
if [ -z "${IDD_RISK_PATHS+x}" ]; then
  lookup="$template_root/packages/idd-lane/src/risk-paths-main.ts"
  risk_line=""
  if [ ! -f "$lookup" ]; then
    risk_line="unavailable 宣言を引く script（packages/idd-lane/src/risk-paths-main.ts）がありません"
  elif ! command -v node >/dev/null 2>&1; then
    risk_line="unavailable node がありません"
  else
    risk_line="$(node --experimental-strip-types --no-warnings "$lookup" "$PWD" 2>/dev/null)" || risk_line="unavailable node で宣言を引けません（node 22.6 以降と依存の install が要る）"
  fi
  case "$risk_line" in
    "declared "*) export IDD_RISK_PATHS="${risk_line#declared }" ;;
    none) ;;
    "broken "*) risk_broken="${risk_line#broken }" ;;
    *) echo "check-docs: 危ないパスの宣言を引けなかったので、宣言による Risk の下限は掛からない（${risk_line#* }）" >&2 ;;
  esac
fi

# 途中導入したプロジェクトは、導入時点の upstream の commit（idd init が lock に記録）以降だけを検査する
if [ -z "${DD_SCOPE_BASE:-}" ] && [ -f docs-template.lock.json ]; then
  adopted="$(sed -n 's/.*"adopted_base": *"\([0-9a-f]\{7,40\}\)".*/\1/p' docs-template.lock.json | head -1)"
  if [ -n "$adopted" ]; then export DD_SCOPE_BASE="$adopted"; fi
fi

# 各段は失敗しても最後まで走らせ、最後に失敗した段をまとめて返す。1 つの赤で後ろの検査が走らないと、別の赤が隠れる
failed=()
step() {
  local name="$1"; shift
  if ! "$@"; then failed+=("$name"); fi
}

if [ -n "$risk_broken" ]; then
  echo "check-docs: 危ないパスの宣言を読めない: $risk_broken" >&2
  failed+=("risk-paths")
fi

# validator 自身の検査は、この script が cwd の scripts/ にあるときだけ回す。つまり、
# パッケージの repo（pi-web-idd と scripts/ を写した採用先）でだけ回す。自己テストは cwd の
# scripts/ を起動し cwd の _docs/standards/ を読むので、写しの無い repo では落ちる。
# これはパッケージの健全性の検査であり、採用先の記録の検査ではない。
self_tests=0
if [ -d scripts ] && [ "$(cd scripts && pwd -P)" = "$here" ]; then self_tests=1; fi

if [ "$self_tests" = 1 ]; then
  # only the template's own scripts: a project that adopted the overlay may keep its own TypeScript in scripts/
  template_ts=()
  for f in "$here"/*.ts; do
    case "$(basename "$f")" in
      agent-workflow-hook.ts | generate-doc-probe.ts | intent-readings.ts | round-fields.ts | scope.ts | test-agent-workflow-hook.ts | test-agent-workflow-smoke.ts | test-validators.ts | validate-*.ts) template_ts+=("$f") ;;
    esac
  done
  step fmt deno fmt --check "${config_args[@]}" "${template_ts[@]}"
  step typecheck deno check "${config_args[@]}" "${template_ts[@]}"
  step comments-test deno test "${config_args[@]}" "$here/validate-comments.test.ts"
  step intent-delta-test deno test "${config_args[@]}" --allow-read --allow-write --allow-env --allow-run "$here/validate-intent-delta.test.ts"
fi

step frontmatter deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-frontmatter.ts"
step todo deno run "${config_args[@]}" --allow-read "$here/validate-todo.ts" "$todo_file"
# root と starter/ の両方があるときは、配る starter の TODO も同じ validator に通す
if [ "$todo_file" = "TODO.md" ] && [ -f "starter/TODO.md" ]; then
  step todo-starter deno run "${config_args[@]}" --allow-read "$here/validate-todo.ts" starter/TODO.md
fi
step doc-links deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-doc-links.ts"
step qa deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-qa.ts"
step survey deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-survey.ts"
step comments deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-comments.ts"
# 記録が公開側へ漏れていないか: _docs/ の standards 以外と root の TODO.md が、
# manifest の除外に当たることを確かめる。manifest の無い repo では何もしない。
step overlay-records deno run "${config_args[@]}" --allow-read --allow-run=git "$here/validate-overlay-records.ts"

step intent-delta deno run "${config_args[@]}" --allow-read --allow-env --allow-run=git "$here/validate-intent-delta.ts"

if [ "$self_tests" = 1 ]; then
  step workflow-hook deno run "${config_args[@]}" --allow-read --allow-write --allow-env --allow-run "$here/test-agent-workflow-hook.ts"
  # validator と出荷物の自己テストはテンプレートを開発する側の検査。見本（fixtures）を持つ repo でだけ回す
  if [ -d "_meta/validator-fixtures" ]; then
    step validators-selftest deno run "${config_args[@]}" --allow-read --allow-write --allow-env --allow-run "$here/test-validators.ts"
    step workflow-smoke deno run "${config_args[@]}" --allow-read "$here/test-agent-workflow-smoke.ts"
  fi
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "check-docs: FAILED: ${failed[*]}" >&2
  exit 1
fi

# 射程の明示。exit 0 を「完了の根拠」へ流用させないための最後の 1 行。
echo "check-docs: documentation contracts and validator health only."
echo "check-docs: the project's own build / typecheck / lint / test gates are separate — run them too."
