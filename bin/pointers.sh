# bin/idd と bin/idd-engine が source する。state と pi の指し先を shell 側で決める唯一の場所。
# 値の順は、渡された環境 → install の記録 → gateway.env → 既定。unit と ~/.local/bin/idd が記録の値を渡すのと同じ順で、
# 記録のある機械では、gateway.env の古い行が直接呼びの指し先だけを動かすことがない。
# 記録は ~/.config/idd/install.json で、checkout がこの入口の置き場と同じ実体のときだけ読む（別の clone の記録を借りない）。
# 読むだけで何も書かない。記録が無い・読めない・checkout が違うときは何もせず、既定に落ちる。

# install.json の 1 行 1 欄（JSON.stringify の 2 space）から文字列の値を 1 つ取る。引用符と backslash を含む値は取らない
# （install はその path を受け付けない）
record_string() {
  sed -n 's/^[[:space:]]*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$1" | head -n 1
}

# 環境に無い IDD_STATE_DIR・IDD_PI_BIN を、記録の値で足す。gateway.env を読む前に呼ぶ。
apply_install_pointers() {
  local root="$1" file="$HOME/.config/idd/install.json" checkout value
  if [ -n "${IDD_STATE_DIR:-}" ] && [ -n "${IDD_PI_BIN:-}" ]; then return 0; fi
  [ -f "$file" ] || return 0
  checkout="$(record_string "$file" checkout)"
  [ -n "$checkout" ] && [ -d "$checkout" ] || return 0
  [ "$(cd "$checkout" && pwd -P)" = "$(cd "$root" && pwd -P)" ] || return 0
  if [ -z "${IDD_STATE_DIR:-}" ]; then
    value="$(record_string "$file" state_dir)"
    if [ -n "$value" ]; then export IDD_STATE_DIR="$value"; fi
  fi
  if [ -z "${IDD_PI_BIN:-}" ]; then
    value="$(record_string "$file" pi_bin)"
    if [ -n "$value" ]; then export IDD_PI_BIN="$value"; fi
  fi
}

# 環境にも記録にも gateway.env にも無いときだけ、この checkout の state を既定にする。gateway.env を読んだ後に呼ぶ。
apply_default_pointers() {
  local root="$1"
  export IDD_STATE_DIR="${IDD_STATE_DIR:-$root/state}"
}
