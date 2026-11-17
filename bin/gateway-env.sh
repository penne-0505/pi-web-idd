# bin/idd と bin/idd-engine が source する。gateway の鍵の file（AI_GATEWAY_API_KEY など）を環境へ足す。
# 既に環境にある名前は上書きしない。unit や install の入口が渡した指し先（IDD_STATE_DIR・IDD_PI_BIN など）は、
# この file の同名の値に負けない。中身はここにも記録にも書かない。
load_gateway_env() {
  local file="$1" entry name loader
  [ -f "$file" ] || return 0
  # file は subshell で読み、環境に出た名前と値を NUL 区切りで受ける（値に改行があっても壊れない）
  exec {gateway_fd}< <(set -e; set -a; . "$file"; env -0)
  loader=$!
  while IFS= read -r -d '' entry <&"$gateway_fd"; do
    name="${entry%%=*}"
    case "$name" in '' | *[!A-Za-z0-9_]* | [0-9]*) continue ;; esac
    [ -n "${!name+x}" ] && continue
    export "$name=${entry#*=}"
  done
  exec {gateway_fd}<&-
  # file を読めなかったとき（構文の誤りなど）は、鍵が足りないまま進まず止める
  wait "$loader"
}
