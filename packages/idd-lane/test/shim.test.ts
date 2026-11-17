import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROUTED } from "../src/boundary.ts";
import { ensureShimDir, shimEnv } from "../src/shim.ts";
import { tmpDir } from "./helpers/tmp.ts";

/**
 * The refusals are checked against their text in full: the text is what tells a lane's agent where the
 * allowed way out is, so looking at a word here and there would not catch a missing or wrong way out.
 * The text is also what the shim echoes, so a stray backtick or `$` would change what the agent reads
 * (or run something); the full-text comparison catches that too.
 */

const PUSH_MSG = "idd-lane: git push はレーン内では禁止されています。push は、受信箱の提出前確認のカードで人が承認したときだけ行います。Issue の lane では、作業を commit して終えるとハーネスがこのカードを開きます";
const PR_CREATE_MSG = "idd-lane: gh pr create はレーン内では禁止されています。PR の作成は、受信箱の提出前確認のカードで人が承認したときだけ行います。Issue の lane では、作業を commit して終えるとハーネスがこのカードを開きます";
const ISSUE_CREATE_MSG = "idd-lane: gh issue create はレーン内では禁止されています。この投稿は「idd out draft --kind gh-issue」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います";
const REPO_CREATE_MSG = "idd-lane: gh repo create はレーン内では禁止されています。この作成は「idd out draft --kind gh-repo」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います";
const PR_EDIT_MSG = "idd-lane: gh pr edit はレーン内では禁止されています。この書き換えは「idd out draft --kind gh-pr-body」で送出カードの下書きにできます。投稿は、人が受信箱の送出カードで承認したときに行います";
const API_WRITE_MSG = "idd-lane: gh api の書き込みはレーン内では禁止されています。issue・repo・PR の本文なら「idd out draft」で送出カードの下書きにできます（--kind は gh-issue・gh-repo・gh-pr-body）。それ以外は報告に書いて人に渡してください";
const REPORT_ONLY = (cmd: string) => `idd-lane: ${cmd} はレーン内では禁止されています。この投稿に合う下書きの種類がないので、報告に書いて人に渡してください`;

const OLD_GH = (cmd: string) => `idd-lane: gh ${cmd} はレーン内では禁止されています（投稿・変更は人間が行う）`;
const OLD_GIT = (cmd: string) => `idd-lane: git ${cmd} はレーン内では禁止されています`;

interface Result { status: number; stdout: string; stderr: string }

/** a door that cannot be reached: the shims then refuse in their own words, which promise nothing */
const NO_DOOR = "/nonexistent/idd";

/**
 * A PATH whose first entry holds stand-ins for gh and git. The shim refuses nothing before it has
 * found a real binary, so these also keep the checks from needing gh or git on the machine.
 * `door` is what the shims hand a boundary command to (the checkout's `idd` unless a test gives its own).
 */
function makeEnv(door: string = NO_DOOR): NodeJS.ProcessEnv {
  const bin = tmpDir("idd-lane-shim-bin-");
  const state = tmpDir("idd-lane-shim-state-");
  for (const name of ["gh", "git"]) {
    const p = join(bin, name);
    // git is also asked for aliases (`config --get alias.X`), which the stand-in has none of
    writeFileSync(p, `#!/usr/bin/env bash\n${name === "git" ? 'case " $* " in *" config --get "*) exit 1 ;; esac\n' : ""}echo "REAL ${name} $*"\n`);
    chmodSync(p, 0o755);
  }
  const saved = process.env.IDD_STATE_DIR;
  process.env.IDD_STATE_DIR = state;
  try {
    return shimEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, IDD_HOLD_CLI: door });
  } finally {
    if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
  }
}

function run(env: NodeJS.ProcessEnv, command: string): Result {
  try {
    const stdout = execFileSync("bash", ["-c", command], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

function denied(env: NodeJS.ProcessEnv, command: string, message: string): void {
  const res = run(env, command);
  expect(res.status, command).toBe(86);
  expect(res.stderr, command).toBe(`${message}\n`);
  expect(res.stdout, command).toBe("");
}

describe("shim refusals", () => {
  test("push points at the submit card", () => {
    denied(makeEnv(), "git push origin main", PUSH_MSG);
  });

  test("creating a PR points at the submit card", () => {
    denied(makeEnv(), "gh pr create --title x --body y", PR_CREATE_MSG);
  });

  test("a post that can be drafted points at idd out draft with its kind", () => {
    const env = makeEnv();
    denied(env, "gh issue create --title x --body y", ISSUE_CREATE_MSG);
    denied(env, "gh repo create name --private", REPO_CREATE_MSG);
    denied(env, "gh pr edit 1 --body y", PR_EDIT_MSG);
  });

  test("a post that cannot be drafted points at the report instead", () => {
    const env = makeEnv();
    for (const [command, name] of [
      ["gh pr review 1 --approve", "gh pr review"],
      ["gh pr comment 1 --body y", "gh pr comment"],
      ["gh issue comment 1 --body y", "gh issue comment"],
      ["gh issue edit 1 --body y", "gh issue edit"],
    ] as const) {
      const res = run(env, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).toBe(`${REPORT_ONLY(name)}\n`);
      expect(res.stderr, command).not.toContain("idd out draft");
      expect(res.stdout, command).toBe("");
    }
  });

  test("a write through gh api points at both ways out", () => {
    const env = makeEnv();
    denied(env, "gh api -X POST repos/o/n/issues", API_WRITE_MSG);
    denied(env, "gh api repos/o/n/issues -f title=x", API_WRITE_MSG);
  });

  test("the refused set still ends in 86 and never reaches the real binary", () => {
    const env = makeEnv();
    const commands = [
      "git push origin main",
      "git push --force",
      "git commit --amend -m x",
      "git commit --no-verify -m x",
      "git commit -n -m x",
      "git rebase main",
      "git filter-branch",
      "git reflog",
      "git branch -D x",
      "git branch --delete x",
      "git branch -d x",
      "git branch -M x",
      "git reset --hard HEAD~1",
      "git log --no-verify",
      "gh pr review 1",
      "gh pr comment 1",
      "gh pr edit 1",
      "gh pr merge 1",
      "gh pr create",
      "gh pr close 1",
      "gh pr reopen 1",
      "gh pr ready 1",
      "gh pr lock 1",
      "gh pr unlock 1",
      "gh pr update-branch 1",
      "gh issue create",
      "gh issue comment 1",
      "gh issue edit 1",
      "gh issue close 1",
      "gh issue reopen 1",
      "gh issue delete 1",
      "gh issue transfer 1",
      "gh issue pin 1",
      "gh issue unpin 1",
      "gh issue lock 1",
      "gh issue unlock 1",
      "gh issue develop 1",
      "gh repo create name",
      "gh repo view",
      "gh release create v1",
      "gh secret set A",
      "gh variable set A",
      "gh workflow run ci",
      "gh label create bug",
      "gh gist create f",
      "gh ssh-key add k",
      "gh gpg-key add k",
      "gh auth login",
      "gh ruleset create",
      "gh ruleset edit 1",
      "gh ruleset delete 1",
      "gh frobnicate",
      "gh pr frobnicate",
      "gh issue frobnicate",
      "gh run frobnicate",
      "gh api -X POST repos/o/n/issues",
      "gh api --method POST repos/o/n/issues",
      "gh api repos/o/n/issues -f title=x",
      "gh api repos/o/n/issues -F title=x",
      "gh api repos/o/n/issues --field title=x",
      "gh api repos/o/n/issues --raw-field title=x",
      "gh api repos/o/n/issues --input body.json",
    ];
    for (const command of commands) {
      const res = run(env, command);
      expect(res.status, command).toBe(86);
      expect(res.stdout, command).toBe("");
      expect(res.stderr, command).not.toContain("REAL ");
    }
  });

  test("refusals outside the guided ones keep their old wording", () => {
    const env = makeEnv();
    denied(env, "git commit --amend -m x", OLD_GIT("commit --amend"));
    denied(env, "git rebase main", OLD_GIT("rebase"));
    denied(env, "gh pr merge 1", OLD_GH("pr merge"));
    denied(env, "gh issue close 1", OLD_GH("issue close"));
    denied(env, "gh repo view", OLD_GH("repo"));
    denied(env, "gh release create v1", OLD_GH("release"));
  });

  test("reads go through to the real binary", () => {
    const env = makeEnv();
    for (const [command, marker] of [
      ["git --version", "REAL git --version\n"],
      ["git status", "REAL git status\n"],
      ["gh pr view 1", "REAL gh pr view 1\n"],
      ["gh api repos/o/n", "REAL gh api repos/o/n\n"],
      ["gh ruleset list", "REAL gh ruleset list\n"],
      ["gh ruleset view 1", "REAL gh ruleset view 1\n"],
      ["gh ruleset check", "REAL gh ruleset check\n"],
      ["gh search issues x", "REAL gh search issues x\n"],
      ["gh browse", "REAL gh browse\n"],
      ["gh status", "REAL gh status\n"],
      ["gh pr diff 1", "REAL gh pr diff 1\n"],
      ["gh pr list", "REAL gh pr list\n"],
      ["gh --version", "REAL gh --version\n"],
    ] as const) {
      const res = run(env, command);
      expect(res.status, command).toBe(0);
      expect(res.stdout, command).toBe(marker);
      expect(res.stderr, command).toBe("");
    }
  });
});

describe("writing the shims", () => {
  // every lane start writes them while other lanes run them: rewriting a running script in place fails (ETXTBSY)
  // or hands a half-written script to the bash reading it
  test("leaves a shim that already says the same untouched, and replaces a stale one with a new file", () => {
    const state = tmpDir("idd-lane-shim-write-");
    const saved = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try {
      const dir = ensureShimDir();
      const git = join(dir, "git");
      const first = statSync(git).ino;
      utimesSync(git, 1_000_000, 1_000_000);
      ensureShimDir();
      expect(statSync(git).ino).toBe(first);
      expect(statSync(git).mtimeMs).toBe(1_000_000_000);
      writeFileSync(git, "#!/usr/bin/env bash\necho stale\n");
      const stale = statSync(git).ino;
      ensureShimDir();
      expect(statSync(git).ino).not.toBe(stale);
      expect(readFileSync(git, "utf8")).not.toContain("echo stale");
      expect(statSync(git).mode & 0o777).toBe(0o755);
      expect(readdirSync(dir).sort()).toEqual(["gh", "git"]);
    } finally {
      if (saved === undefined) delete process.env.IDD_STATE_DIR; else process.env.IDD_STATE_DIR = saved;
    }
  });
});

/**
 * A stand-in for the door: it writes what it was asked to `DOOR_LOG` and answers with `DOOR_EXIT`. The real door
 * (`idd hold run`) is tested on its own; here only the shim's side is: which commands go to it, and what the shim
 * does with each of its three answers.
 */
function makeDoor(): { door: string; log: string } {
  const dir = tmpDir("idd-lane-shim-door-");
  const door = join(dir, "idd");
  const log = join(dir, "log");
  writeFileSync(door, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$DOOR_LOG\"\necho \"door: $*\"\nexit \"${DOOR_EXIT:-0}\"\n");
  chmodSync(door, 0o755);
  writeFileSync(log, "");
  return { door, log };
}

const asked = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);

describe("shim door", () => {
  test("every command the table takes in hand goes to the door, with its tool and its words", () => {
    const { door, log } = makeDoor();
    const env = { ...makeEnv(door), DOOR_LOG: log };
    // gh api goes to the door only with a flag that makes it a write
    const tail = (words: string[]) => `${words[0] === "api" ? "-f a=b " : ""}--probe`;
    for (const { tool, words } of ROUTED) {
      const res = run(env, `${tool} ${words.join(" ")} ${tail(words)}`);
      expect(res.status, `${tool} ${words.join(" ")}`).toBe(0);
    }
    expect(asked(log)).toEqual(ROUTED.map(({ tool, words }) => `hold run ${tool} ${words.join(" ")} ${tail(words)}`));
  });

  test("a push is found behind git's own options, and a write through gh api behind any spelling of the flag", () => {
    const { door, log } = makeDoor();
    const env = { ...makeEnv(door), DOOR_LOG: log };
    const commands = [
      "git -C . push origin x",
      "git -c user.name=x push",
      "git --git-dir=.git push",
      "gh api --method=POST repos/o/n/issues",
      "gh api -XPOST repos/o/n/issues",
      "gh api repos/o/n/issues -ftitle=x",
      "gh api repos/o/n/issues --field=title=x",
    ];
    for (const command of commands) expect(run(env, command).status, command).toBe(0);
    expect(asked(log)).toHaveLength(commands.length);
  });

  test("an alias is read as the command it stands for, so no name reaches push, a rewrite or a hook bypass unseen", () => {
    const { door, log } = makeDoor();
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const env: NodeJS.ProcessEnv = { ...makeEnv(door), DOOR_LOG: log };
    // a real git answers for the aliases: the stand-in is swapped for a link to it
    const bin = (env.IDD_LANE_REAL_PATH ?? "").split(":")[0]!;
    rmSync(join(bin, "git"));
    symlinkSync(realGit, join(bin, "git"));
    const aliases: Record<string, string> = { p: "push", q: "p", pf: "push --force", wip: "-C . push origin x", ci: "commit --amend", rb: "rebase", st: "version", loop: "loop", sh: "!git push", reset: "status", commit: "status", branch: "status", version: "reset --hard" };
    const keys = Object.entries(aliases);
    const withAliases: NodeJS.ProcessEnv = {
      ...env,
      GIT_CONFIG_COUNT: String(keys.length),
      GIT_CONFIG_NOSYSTEM: "1",
      ...Object.fromEntries(keys.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, `alias.${k}`], [`GIT_CONFIG_VALUE_${i}`, v]])),
    };
    for (const command of ["git p origin x", "git q origin x", "git -C . p", "git -c alias.z=push z origin", "git pf", "git wip"]) {
      expect(run(withAliases, command).status, command).toBe(0);
    }
    expect(asked(log)).toEqual([
      "hold run git push origin x", "hold run git push origin x", "hold run git -C . push", "hold run git -c alias.z=push push origin",
      "hold run git push --force", "hold run git -C . push origin x",
    ]);
    for (const [command, message] of [["git ci -m x", OLD_GIT("commit --amend")], ["git rb main", OLD_GIT("rebase")], ["git loop", OLD_GIT("alias loop")], ["git sh", "idd-lane: git の shell alias（sh）はレーン内では禁止されています。alias の中身を git のコマンドとして直接打ってください"]] as const) {
      const res = run(withAliases, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).toBe(`${message}\n`);
    }
    // git ignores an alias that hides one of its own commands, so the command typed is the one that runs and is vetted:
    // an alias must not turn a refused reset, amend or branch delete into something the table does not know
    for (const [command, message] of [["git reset --hard", OLD_GIT("reset --hard")], ["git -c alias.reset=status reset --hard", OLD_GIT("reset --hard")], ["git commit --amend", OLD_GIT("commit --amend")], ["git branch -D x", OLD_GIT("branch -D")]] as const) {
      const res = run(withAliases, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).toBe(`${message}\n`);
    }
    // and the same alias is not followed into a command the typed one is not: `git version` is git's, whatever alias.version says
    const own = run(withAliases, "git version");
    expect(own.status).toBe(0);
    expect(own.stdout).toMatch(/^git version /);
    // an alias for something that is not the table's runs the real command as it was typed
    const plain = run(withAliases, "git st");
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/^git version /);
  });

  test("an alias value is cut into words the way git cuts it, so a quoted word is vetted as the word git runs", () => {
    const { door, log } = makeDoor();
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const env: NodeJS.ProcessEnv = { ...makeEnv(door), DOOR_LOG: log };
    const bin = (env.IDD_LANE_REAL_PATH ?? "").split(":")[0]!;
    rmSync(join(bin, "git"));
    symlinkSync(realGit, join(bin, "git"));
    const aliases: Record<string, string> = {
      qr: "reset '--hard'",
      qd: 'reset "--ha"rd',
      qs: "reset \\--hard",
      qc: 'commit "--amend"',
      qp: "'push' origin",
      qb: "branch '-D'",
      qu: "reset 'x",
      qt: "reset --soft \\",
      qv: "version '--build-options'",
      qn: "version   --build-options",
    };
    const keys = Object.entries(aliases);
    const withAliases: NodeJS.ProcessEnv = {
      ...env,
      GIT_CONFIG_COUNT: String(keys.length),
      GIT_CONFIG_NOSYSTEM: "1",
      ...Object.fromEntries(keys.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, `alias.${k}`], [`GIT_CONFIG_VALUE_${i}`, v]])),
    };
    for (const [command, message] of [["git qr", OLD_GIT("reset --hard")], ["git qd", OLD_GIT("reset --hard")], ["git qs", OLD_GIT("reset --hard")], ["git qc", OLD_GIT("commit --amend")], ["git qb x", OLD_GIT("branch -D")]] as const) {
      const res = run(withAliases, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).toBe(`${message}\n`);
    }
    const pushed = run(withAliases, "git qp x");
    expect(pushed.status).toBe(0);
    expect(asked(log)).toEqual(["hold run git push origin x"]);
    // a value git cannot use (an open quote, a trailing backslash) is refused and never run
    for (const command of ["git qu", "git qt"]) {
      const res = run(withAliases, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).toContain("引用符か末尾の逆斜線が閉じておらず");
    }
    // a quote that hides nothing from the table is no reason to refuse: the real command runs as it was typed
    for (const command of ["git qv", "git qn"]) {
      const res = run(withAliases, command);
      expect(res.status, command).toBe(0);
      expect(res.stdout, command).toMatch(/^git version /);
    }
  });

  test("the door's three answers are the shim's: taken (0), not taken (86), a read to run (87)", () => {
    const { door, log } = makeDoor();
    const env = { ...makeEnv(door), DOOR_LOG: log };
    const taken = run({ ...env, DOOR_EXIT: "0" }, "git push");
    expect(taken.status).toBe(0);
    expect(taken.stdout).toBe("door: hold run git push\n");
    const refused = run({ ...env, DOOR_EXIT: "86" }, "gh pr create --title x");
    expect(refused.status).toBe(86);
    expect(refused.stdout).toContain("door:");
    const read = run({ ...env, DOOR_EXIT: "87" }, "gh pr checks 1");
    expect(read.status).toBe(0);
    expect(read.stdout).toBe("door: hold run gh pr checks 1\nREAL gh pr checks 1\n");
  });

  test("an answer the shim does not know, or no door at all, is a refusal in the old words and never a success", () => {
    const { door, log } = makeDoor();
    const broken = run({ ...makeEnv(door), DOOR_LOG: log, DOOR_EXIT: "1" }, "git push origin main");
    expect(broken.status).toBe(86);
    expect(broken.stderr).toBe(`${PUSH_MSG}\n`);
    expect(broken.stdout).toBe("door: hold run git push origin main\n");
    const none = run(makeEnv(NO_DOOR), "gh pr create --title x --body y");
    expect(none.status).toBe(86);
    expect(none.stderr).toBe(`${PR_CREATE_MSG}\n`);
    expect(none.stdout).toBe("");
  });

  test("a read the table only watches runs for real when the door cannot be asked", () => {
    const res = run(makeEnv(NO_DOOR), "gh pr checks 1");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("REAL gh pr checks 1\n");
  });

  test("what the table does not take never reaches the door and never reaches the real binary", () => {
    const { door, log } = makeDoor();
    const env = { ...makeEnv(door), DOOR_LOG: log };
    for (const command of [
      "gh pr merge 1", "gh pr close 1", "gh pr revert 1", "gh pr review 1 --approve", "gh pr comment 1 --body x",
      "gh issue comment 1 --body x", "gh issue edit 1 --body x", "gh issue close 1", "gh repo view", "gh repo create x",
      "gh run rerun 1", "gh run cancel 1", "gh run delete 1", "gh release create v1", "gh extension install x/y",
      "gh alias set a b", "gh config set a b", "gh cache delete 1", "gh project create",
      "git rebase main", "git reset --hard", "git commit --amend", "git branch -D x", "git reflog", "git commit --no-verify -m x",
    ]) {
      const res = run(env, command);
      expect(res.status, command).toBe(86);
      expect(res.stderr, command).not.toContain("REAL ");
      expect(res.stdout, command).toBe("");
    }
    expect(asked(log)).toEqual([]);
  });

  test("reads go past the door", () => {
    const { door, log } = makeDoor();
    const env = { ...makeEnv(door), DOOR_LOG: log };
    for (const command of ["gh pr view 1", "gh issue view 1", "gh api repos/o/n", "gh run download 1", "gh ruleset list", "gh ruleset view 1", "gh ruleset check", "gh search issues x", "gh browse", "gh status", "gh pr diff 1", "gh pr list", "git status", "git -C . log", "git fetch"]) {
      expect(run(env, command).status, command).toBe(0);
    }
    expect(asked(log)).toEqual([]);
  });
});
