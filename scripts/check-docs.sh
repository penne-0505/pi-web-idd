#!/usr/bin/env bash
set -euo pipefail

# 未初期化 template では TODO.md が starter/ 側にある。展開後は root へ戻るため、
# どちらの状態でも同じコマンドで検証できるよう実在するほうを選ぶ。
if [ -f "TODO.md" ]; then
  todo_file="TODO.md"
elif [ -f "starter/TODO.md" ]; then
  todo_file="starter/TODO.md"
else
  echo "check-docs: TODO.md not found at root or starter/" >&2
  exit 1
fi
export DD_TODO_FILE="$todo_file"

deno fmt --check scripts/*.ts
deno check scripts/*.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-frontmatter.ts
deno run --allow-read scripts/validate-todo.ts "$todo_file"
deno run --allow-read --allow-env --allow-run=git scripts/validate-doc-links.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-intent.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-qa.ts
deno run --allow-read --allow-env --allow-run=git scripts/validate-comments.ts

# intent-delta presence は展開後の利用者 project の規範。未初期化 template
# (starter/ が存在) は meta-work 例外により対象外。
if [ ! -d "starter" ]; then
  deno run --allow-read --allow-env --allow-run=git scripts/validate-intent-delta.ts
fi
deno run --allow-read --allow-write --allow-env --allow-run scripts/test-validators.ts
deno run --allow-read --allow-write --allow-env --allow-run scripts/test-agent-workflow-hook.ts
deno run --allow-read scripts/test-agent-workflow-smoke.ts

# 射程の明示。exit 0 を「完了の根拠」へ流用させないための最後の 1 行。
echo "check-docs: documentation contracts and validator health only."
echo "check-docs: the project's own build / typecheck / lint / test gates are separate — run them too."
