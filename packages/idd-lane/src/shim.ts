import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { laneStateDir, repoRoot } from "./paths.ts";

/**
 * PATH shims that refuse outward-facing / history-rewriting commands inside a lane.
 * The real binary is resolved through IDD_LANE_REAL_PATH so the shim dir itself is skipped.
 *
 * A command the table of `idd hold` can take in hand (boundary.ts) is not refused here: it goes to that door, which
 * answers 0 (taken in hand, nothing written outside), 86 (not taken, and says why) or 87 (a read: run the real one).
 * When the door cannot be reached the command is refused in the words below, which promise nothing: a success that
 * was not recorded would let a lane's work vanish while its agent believed it done.
 */
const HOLD_FN = (tool: string) => `# hand a boundary command to the table; $1 is the refusal to give when the table cannot be asked
# (an empty one means the command is a read, and the real one runs)
hold() {
  fallback="$1"; shift
  bin="\${IDD_HOLD_CLI:-}"
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    "$bin" hold run ${tool} "$@"; rc=$?
    case "$rc" in
      0|86) exit "$rc" ;;
      87) exec "$real" "$@" ;;
    esac
  fi
  [ -n "$fallback" ] || exec "$real" "$@"
  guide "$fallback"
}
`;

const GH_SHIM = `#!/usr/bin/env bash
# idd lane shim: gh は読み取りだけ許可する（表に無い gh の書き込みは実物に届かない）
set -u
self_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
real=""
IFS=: read -ra __dirs <<< "\${IDD_LANE_REAL_PATH:-$PATH}"
for __d in "\${__dirs[@]}"; do
  [ -z "$__d" ] && continue
  [ "$(cd "$__d" 2>/dev/null && pwd -P)" = "$self_dir" ] && continue
  if [ -x "$__d/gh" ]; then real="$__d/gh"; break; fi
done
[ -n "$real" ] || { echo "gh: not found" >&2; exit 127; }
# the old line, kept for the refusals that have no way out to point at
deny() { echo "idd-lane: gh $* はレーン内では禁止されています（投稿・変更は人間が行う）" >&2; exit 86; }
# a refusal that says which way out to take instead (the message is written out in full by the caller)
guide() { echo "$*" >&2; exit 86; }
${HOLD_FN("gh")}case "\${1:-}" in
  pr)
    case "\${2:-}" in
      create) hold "idd-lane: gh pr create はレーン内では禁止されています。PR の作成は、受信箱の提出前確認のカードで人が承認したときだけ行います。Issue の lane では、作業を commit して終えるとハーネスがこのカードを開きます" "$@" ;;
      edit) hold "idd-lane: gh pr edit はレーン内では禁止されています。この書き換えは「idd out draft --kind gh-pr-body」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います" "$@" ;;
      checks|status) hold "" "$@" ;;
      review) guide "idd-lane: gh pr review はレーン内では禁止されています。この投稿に合う下書きの種類がないので、報告に書いて人に渡してください" ;;
      comment) guide "idd-lane: gh pr comment はレーン内では禁止されています。この投稿に合う下書きの種類がないので、報告に書いて人に渡してください" ;;
      merge|close|reopen|ready|lock|unlock|update-branch|revert) deny "$1 $2" ;;
      view|list|diff|checkout|-h|--help|help|"") ;;
      *) guide "idd-lane: gh $* は、今は預からない操作です。レーン内では実行されません。報告に書いて人に渡してください" ;;
    esac ;;
  issue)
    case "\${2:-}" in
      create) hold "idd-lane: gh issue create はレーン内では禁止されています。この投稿は「idd out draft --kind gh-issue」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います" "$@" ;;
      comment) guide "idd-lane: gh issue comment はレーン内では禁止されています。この投稿に合う下書きの種類がないので、報告に書いて人に渡してください" ;;
      edit) guide "idd-lane: gh issue edit はレーン内では禁止されています。この投稿に合う下書きの種類がないので、報告に書いて人に渡してください" ;;
      close|reopen|delete|transfer|pin|unpin|lock|unlock|develop) deny "$1 $2" ;;
      view|list|status|-h|--help|help|"") ;;
      *) guide "idd-lane: gh $* は、今は預からない操作です。レーン内では実行されません。報告に書いて人に渡してください" ;;
    esac ;;
  run)
    case "\${2:-}" in
      list|view|watch) hold "" "$@" ;;
      rerun|cancel|delete) deny "$1 $2" ;;
      download|-h|--help|help|"") ;;
      *) guide "idd-lane: gh $* は、今は預からない操作です。レーン内では実行されません。報告に書いて人に渡してください" ;;
    esac ;;
  repo)
    case "\${2:-}" in
      create) guide "idd-lane: gh repo create はレーン内では禁止されています。この作成は「idd out draft --kind gh-repo」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います" ;;
      *) deny "$1" ;;
    esac ;;
  release|secret|variable|workflow|label|gist|ssh-key|gpg-key|auth|cache|project|codespace|extension|alias|config|org|copilot|agent-task) deny "$1" ;;
  api)
    for a in "$@"; do
      case "$a" in
        -X*|--method*|-f*|-F*|--field*|--raw-field*|--input*) hold "idd-lane: gh api の書き込みはレーン内では禁止されています。issue・repo・PR の本文なら「idd out draft」で送出カードの下書きにできます（--kind は gh-issue・gh-repo・gh-pr-body）。それ以外は報告に書いて人に渡してください" "$@" ;;
      esac
    done ;;
  ruleset)
    case "\${2:-}" in
      list|view|check|-h|--help|help|"") ;;
      *) guide "idd-lane: gh $* は、今は預からない操作です。レーン内では実行されません。報告に書いて人に渡してください" ;;
    esac ;;
  browse|completion|search|status|licenses|attestation|version|help|-h|--help|--version|"") ;;
  *) guide "idd-lane: gh $* は、今は預からない操作です。レーン内では実行されません。報告に書いて人に渡してください" ;;
esac
exec "$real" "$@"
`;

const GIT_SHIM = `#!/usr/bin/env bash
# idd lane shim: git は push と履歴書き換え・hook 迂回を拒否する
set -u
self_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
real=""
IFS=: read -ra __dirs <<< "\${IDD_LANE_REAL_PATH:-$PATH}"
for __d in "\${__dirs[@]}"; do
  [ -z "$__d" ] && continue
  [ "$(cd "$__d" 2>/dev/null && pwd -P)" = "$self_dir" ] && continue
  if [ -x "$__d/git" ]; then real="$__d/git"; break; fi
done
[ -n "$real" ] || { echo "git: not found" >&2; exit 127; }
# the old line, kept for the refusals that have no way out to point at
deny() { echo "idd-lane: git $* はレーン内では禁止されています" >&2; exit 86; }
# a refusal that says which way out to take instead (the message is written out in full by the caller)
guide() { echo "$*" >&2; exit 86; }
${HOLD_FN("git")}# what the table says of one command: push goes to the door, a history rewrite or a hook bypass is refused
vet() {
  sub="$1"; shift
  case "$sub" in
    push) hold "idd-lane: git push はレーン内では禁止されています。push は、受信箱の提出前確認のカードで人が承認したときだけ行います。Issue の lane では、作業を commit して終えるとハーネスがこのカードを開きます" "$@" ;;
    commit)
      for a in "$@"; do case "$a" in --amend|--no-verify|-n) deny "commit $a" ;; esac; done ;;
    rebase|filter-branch|reflog) deny "$sub" ;;
    branch)
      for a in "$@"; do case "$a" in -D|--delete|-d|-M) deny "branch $a" ;; esac; done ;;
    reset)
      for a in "$@"; do case "$a" in --hard) deny "reset --hard" ;; esac; done ;;
  esac
  for a in "$@"; do case "$a" in --no-verify) deny "--no-verify" ;; esac; done
}
# the subcommand is the first word that is not an option or the value of one that takes the next word. The command as
# it was typed is vetted first, and so is each command an alias stands for (git's own words for it, with the options
# that came before), or \`git p\` would reach push by a name the table does not know. A name git itself has is never
# looked up as an alias (git ignores an alias that hides one of its own commands), so \`-c alias.reset=status reset
# --hard\` is the reset it runs. A shell alias is refused: git puts its own directory first on the PATH for it, so the
# git it runs again is the real one and never meets this shim.
# An alias value is cut into words the way git cuts it (split_cmdline): at white space outside quotes, a single quote
# keeps its contents as they are, and a backslash outside single quotes makes the next character a plain one. The
# quotes are gone from the words, so \`reset '--hard'\` is vetted as the reset --hard git runs. A quote left open or a
# trailing backslash is a value git cannot use either (returns 1). Nothing is expanded and nothing is evaluated.
split_alias() {
  words=()
  local s="$1" n="\${#1}" k=0 c q="" cur="" has=0
  while [ "$k" -lt "$n" ]; do
    c="\${s:k:1}"; k=$((k + 1))
    if [ "$c" = '\\' ] && [ "$q" != "'" ]; then
      [ "$k" -lt "$n" ] || return 1
      cur+="\${s:k:1}"; has=1; k=$((k + 1)); continue
    fi
    if [ -n "$q" ]; then
      if [ "$c" = "$q" ]; then q=""; else cur+="$c"; fi
      continue
    fi
    case "$c" in
      "'"|'"') q="$c"; has=1 ;;
      ' '|$'\\t'|$'\\n') if [ "$has" = 1 ]; then words+=("$cur"); cur=""; has=0; fi ;;
      *) cur+="$c"; has=1 ;;
    esac
  done
  [ -z "$q" ] || return 1
  if [ "$has" = 1 ]; then words+=("$cur"); fi
  return 0
}
orig=("$@")
depth=0
while :; do
  g=(); sub=""; skip=0; i=1
  while [ "$i" -le "$#" ]; do
    a="\${!i}"
    if [ "$skip" = 1 ]; then skip=0; g+=("$a"); i=$((i + 1)); continue; fi
    case "$a" in
      -C|-c|--git-dir|--work-tree|--namespace) skip=1; g+=("$a") ;;
      -*) g+=("$a") ;;
      *) sub="$a"; break ;;
    esac
    i=$((i + 1))
  done
  vet "$sub" "$@"
  [ -n "$sub" ] || break
  if "$real" --list-cmds=builtins 2>/dev/null | grep -qxF -- "$sub"; then break; fi
  val="$("$real" \${g[@]+"\${g[@]}"} config --get "alias.$sub" 2>/dev/null)" || break
  case "$val" in
    '') break ;;
    '!'*) guide "idd-lane: git の shell alias（$sub）はレーン内では禁止されています。alias の中身を git のコマンドとして直接打ってください" ;;
  esac
  depth=$((depth + 1))
  [ "$depth" -le 5 ] || deny "alias $sub"
  split_alias "$val" || guide "idd-lane: git の alias（$sub）の値は引用符か末尾の逆斜線が閉じておらず、git でも使えません。alias の中身を git のコマンドとして直接打ってください"
  set -- \${g[@]+"\${g[@]}"} \${words[@]+"\${words[@]}"} "\${@:$((i + 1))}"
done
exec "$real" "\${orig[@]}"
`;

export function ensureShimDir(): string {
  const dir = join(laneStateDir(), "shim");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // other lanes may be running these right now: a shim that already says the same is left alone, and a stale one
  // is replaced by renaming a new file over it, never rewritten in place (ETXTBSY, or a half-written script)
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    try {
      if (readFileSync(p, "utf8") === body && (statSync(p).mode & 0o777) === 0o755) return;
    } catch { /* not there yet */ }
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, body, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, p);
  };
  write("gh", GH_SHIM);
  write("git", GIT_SHIM);
  return dir;
}

/**
 * The shims' environment. IDD_HOLD_CLI is the door the shims hand a boundary command to: this checkout's own `idd`,
 * unless the caller already named one (a test hands in a stand-in). It is a path and not a name on the PATH, because
 * the `idd` the PATH happens to resolve to may be another version.
 */
export function shimEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = ensureShimDir();
  const realPath = (base.IDD_LANE_REAL_PATH ?? base.PATH ?? "").split(":").filter((p) => p && p !== dir).join(":");
  return { ...base, IDD_LANE_REAL_PATH: realPath, PATH: `${dir}:${realPath}`, IDD_HOLD_CLI: base.IDD_HOLD_CLI?.trim() || join(repoRoot(), "bin", "idd") };
}
