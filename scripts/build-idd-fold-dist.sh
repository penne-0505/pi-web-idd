#!/usr/bin/env bash
# packages/idd-fold/dist/ の build 済みの JS を、源（packages/idd-fold/*.mbt）から作り直す。
# 取り込みの検査（config/repos.yaml の moonbit）が比べる手順と同じ: _build/js を消して build し、dist/ にある 3 つの
# ファイルを build の出力で置き換える。取り込みの段は、生成物（config/repos.yaml の generated_files）の衝突や食い違いを
# これで作り直す。手で源を変えたときも、同じ commit でこれを回す。
# moon は lane の PATH に無いので、PATH に無ければ既定の置き場（${MOON_HOME:-$HOME/.moon}/bin）を探す。
set -eu

cd "$(dirname "$0")/../packages/idd-fold"

moon_bin="$(command -v moon || true)"
if [ -z "$moon_bin" ]; then
  c="${MOON_HOME:-$HOME/.moon}/bin/moon"
  [ -x "$c" ] && moon_bin="$c"
fi
if [ -z "$moon_bin" ]; then
  echo 'moon が見つかりません。PATH と ${MOON_HOME:-$HOME/.moon}/bin を探しました' >&2
  # 127: 道具が無い。取り込みの段はこの終了コードを、環境の不足（源の build の失敗ではない）と読む
  exit 127
fi

rm -rf _build/js
"$moon_bin" build --target js --release

for n in idd-fold.js idd-fold.d.ts moonbit.d.ts; do
  built="$(find _build/js/release/build -name "$n" -type f 2>/dev/null | head -n 1)"
  if [ -z "$built" ]; then
    echo "build の出力に $n がありません" >&2
    exit 1
  fi
  cp "$built" "dist/$n"
done
