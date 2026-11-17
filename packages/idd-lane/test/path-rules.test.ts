import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";


import { diffPaths, matchesPathGlob, readRulesAt, rulesForPaths } from "../src/path-rules.ts";
import { stageRules } from "../src/review-runs.ts";
import { tmpDir } from "./helpers/tmp.ts";

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();

/** commit whatever the directory holds (a repo is made on first use) and return the commit */
function committed(root: string): string {
  if (!existsSync(join(root, ".git"))) execFileSync("git", ["init", "-q", root]);
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "--allow-empty", "-m", "c");
  return gitIn(root, "rev-parse", "HEAD");
}
const readAt = (root: string) => readRulesAt(root, committed(root));
const forPaths = (root: string, files: string[]) => rulesForPaths(root, committed(root), files);

/** a repo with rules scoped to Dart sources, to the payment feature, to native code, and one without paths */
function rulesRepo(): string {
  const root = tmpDir("idd-path-rules-");
  write(root, ".claude/rules/dart.md", "---\npaths:\n  - \"lib/**/*.dart\"\n  - \"test/**/*.dart\"\n---\n# dart\n");
  write(root, ".claude/rules/sales.md", "---\npaths:\n  - \"lib/features/{sales,billing}/**\"\n---\n# sales\n");
  write(root, ".claude/rules/native.md", "---\npaths:\n  - \"ios/**\"\n  - \"android/**\"\n---\n# native\n");
  write(root, ".claude/rules/always.md", "# no frontmatter: Claude Code loads it for every file, so it is not a path rule\n");
  write(root, ".claude/rules/empty-paths.md", "---\ndescription: no paths here\n---\n# x\n");
  write(root, ".claude/rules/nested/l10n.md", "---\npaths: \"lib/l10n/*.arb\"\n---\n# l10n\n");
  write(root, ".claude/rules/broken.md", "---\npaths: [unclosed\n---\n");
  write(root, ".claude/rules/notes.txt", "---\npaths:\n  - \"**\"\n---\n");
  return root;
}

describe("path-scoped rule globs", () => {
  test("** spans zero or more directories, * and ? stay inside one segment", () => {
    expect(matchesPathGlob("lib/main.dart", "lib/**/*.dart")).toBe(true);
    expect(matchesPathGlob("lib/a/b/c.dart", "lib/**/*.dart")).toBe(true);
    expect(matchesPathGlob("lib/a/b/c.dart", "lib/*.dart")).toBe(false);
    expect(matchesPathGlob("lib/main.dart", "lib/*.dart")).toBe(true);
    expect(matchesPathGlob("lib/main.dart.bak", "lib/**/*.dart")).toBe(false);
    expect(matchesPathGlob("src/lib/main.dart", "lib/**/*.dart")).toBe(false);
    expect(matchesPathGlob("ios/Runner/Info.plist", "ios/**")).toBe(true);
    expect(matchesPathGlob("ios", "ios/**")).toBe(true);
    expect(matchesPathGlob("iosx/a", "ios/**")).toBe(false);
    expect(matchesPathGlob("a/b/c.ts", "**/*.ts")).toBe(true);
    expect(matchesPathGlob("c.ts", "**/*.ts")).toBe(true);
    expect(matchesPathGlob("anything/at/all", "**")).toBe(true);
    expect(matchesPathGlob("lib/a.dart", "lib/?.dart")).toBe(true);
    expect(matchesPathGlob("lib/ab.dart", "lib/?.dart")).toBe(false);
  });

  test("braces expand to alternatives, also nested and next to other wildcards", () => {
    expect(matchesPathGlob("lib/features/sales/x.dart", "lib/features/{sales,billing}/**")).toBe(true);
    expect(matchesPathGlob("lib/features/billing/a/b.dart", "lib/features/{sales,billing}/**")).toBe(true);
    expect(matchesPathGlob("lib/features/post/x.dart", "lib/features/{sales,billing}/**")).toBe(false);
    expect(matchesPathGlob("src/a.tsx", "src/*.{ts,{tsx,jsx}}")).toBe(true);
    expect(matchesPathGlob("src/a.js", "src/*.{ts,{tsx,jsx}}")).toBe(false);
    expect(matchesPathGlob("lib/features/gen_image/a.dart", "lib/features/gen_*/**")).toBe(true);
  });

  test("the root is the repo: a leading ./ or / is the same glob, dot directories match, and regex characters are literal", () => {
    expect(matchesPathGlob("pubspec.yaml", "./pubspec.yaml")).toBe(true);
    expect(matchesPathGlob("pubspec.yaml", "/pubspec.yaml")).toBe(true);
    expect(matchesPathGlob(".github/workflows/test.yml", ".github/workflows/*.yml")).toBe(true);
    expect(matchesPathGlob(".github/workflows/test.yml", "**/*.yml")).toBe(true);
    expect(matchesPathGlob("pubspecXyaml", "pubspec.yaml")).toBe(false);
    expect(matchesPathGlob("a+b(c).md", "a+b(c).md")).toBe(true);
  });
});

describe("glob syntax as common globs read it", () => {
  test("a backslash makes the next character literal", () => {
    expect(matchesPathGlob("libd.dart", "lib\\d.dart")).toBe(true);
    expect(matchesPathGlob("lib5.dart", "lib\\d.dart")).toBe(false);
    expect(matchesPathGlob("a*b.md", "a\\*b.md")).toBe(true);
    expect(matchesPathGlob("axb.md", "a\\*b.md")).toBe(false);
    expect(matchesPathGlob("{a,b}.md", "\\{a,b\\}.md")).toBe(true);
    expect(matchesPathGlob("a.md", "\\{a,b\\}.md")).toBe(false);
  });

  test("classes: a leading ] is a member, ! and ^ negate, and a negated class never spans a directory", () => {
    expect(matchesPathGlob("].md", "[]].md")).toBe(true);
    expect(matchesPathGlob("a.md", "[]a].md")).toBe(true);
    expect(matchesPathGlob("b.md", "[]a].md")).toBe(false);
    expect(matchesPathGlob("b.md", "[!a].md")).toBe(true);
    expect(matchesPathGlob("a.md", "[!a].md")).toBe(false);
    expect(matchesPathGlob("a.md", "[^a].md")).toBe(false);
    expect(matchesPathGlob("x/y.md", "x[!a]y.md")).toBe(false);
    expect(matchesPathGlob("b.dart", "[a-c].dart")).toBe(true);
    expect(matchesPathGlob("d.dart", "[a-c].dart")).toBe(false);
  });

  test("? never spans a directory, and a brace without a comma is literal", () => {
    expect(matchesPathGlob("a/b", "a?b")).toBe(false);
    expect(matchesPathGlob("a-b", "a?b")).toBe(true);
    expect(matchesPathGlob("{a}.md", "{a}.md")).toBe(true);
    expect(matchesPathGlob("a.md", "{a}.md")).toBe(false);
  });

  test("an unclosed [ is literal", () => {
    expect(matchesPathGlob("lib/a[", "lib/a[")).toBe(true);
    expect(matchesPathGlob("a/[b/c]", "a/[b/c]")).toBe(true);
  });

  test("a glob that cannot be compiled is dropped with a warning, and the rule's other globs still apply", () => {
    const root = tmpDir("idd-path-bad-");
    write(root, ".claude/rules/bad.md", "---\npaths:\n  - \"lib/[z-a].dart\"\n  - \"lib/**/*.dart\"\n---\n");
    write(root, ".claude/rules/only-bad.md", "---\npaths:\n  - \"lib/[z-a].dart\"\n---\n");
    const got = forPaths(root, ["lib/main.dart"]);
    expect(got.rules).toEqual([".claude/rules/bad.md"]);
    expect(got.warnings.length).toBe(2);
    expect(got.warnings.every((w) => w.includes("lib/[z-a].dart"))).toBe(true);
    expect(got.warnings.some((w) => w.includes(".claude/rules/only-bad.md"))).toBe(true);
  });
});

describe("reading .claude/rules", () => {
  test("a rule with paths is scoped; one without frontmatter or without paths is always read; subdirectories count", () => {
    const root = rulesRepo();
    const { rules } = readAt(root);
    expect(rules.map((r) => [r.file, r.paths])).toEqual([
      [".claude/rules/always.md", null],
      [".claude/rules/dart.md", ["lib/**/*.dart", "test/**/*.dart"]],
      [".claude/rules/empty-paths.md", null],
      [".claude/rules/native.md", ["ios/**", "android/**"]],
      [".claude/rules/nested/l10n.md", ["lib/l10n/*.arb"]],
      [".claude/rules/sales.md", ["lib/features/{sales,billing}/**"]],
    ]);
  });

  test("a frontmatter that is not YAML leaves the rule out with a warning, never silently", () => {
    const root = rulesRepo();
    write(root, ".claude/rules/unquoted.md", "---\npaths:\n  - **/*.ts\n---\n");
    const { rules, warnings } = readAt(root);
    expect(rules.map((r) => r.file)).not.toContain(".claude/rules/broken.md");
    expect(rules.map((r) => r.file)).not.toContain(".claude/rules/unquoted.md");
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.startsWith(".claude/rules/broken.md"))).toBe(true);
    expect(warnings.some((w) => w.startsWith(".claude/rules/unquoted.md"))).toBe(true);
  });

  test("a byte order mark before the frontmatter is stripped", () => {
    const root = tmpDir("idd-path-bom-");
    write(root, ".claude/rules/bom.md", "\uFEFF---\r\npaths:\r\n  - \"lib/**\"\r\n---\r\n# bom\r\n");
    const got = readAt(root);
    expect(got.warnings).toEqual([]);
    expect(got.rules.map((r) => [r.file, r.paths])).toEqual([[".claude/rules/bom.md", ["lib/**"]]]);
    expect(forPaths(root, ["README.md"]).rules).toEqual([]);
    expect(forPaths(root, ["lib/a.dart"]).rules).toEqual([".claude/rules/bom.md"]);
  });

  test("paths that are not globs are dropped with a warning; a rule left with none applies to nothing", () => {
    const root = tmpDir("idd-path-odd-");
    write(root, ".claude/rules/mixed.md", "---\npaths:\n  - 3\n  - \"lib/**\"\n---\n");
    write(root, ".claude/rules/numbers.md", "---\npaths: [1, 2]\n---\n");
    write(root, ".claude/rules/map.md", "---\npaths: { a: b }\n---\n");
    const { rules, warnings } = readAt(root);
    expect(rules.map((r) => [r.file, r.paths])).toEqual([[".claude/rules/mixed.md", ["lib/**"]], [".claude/rules/numbers.md", []]]);
    expect(warnings).toHaveLength(3);
    expect(forPaths(root, ["lib/a.dart", "x"]).rules).toEqual([".claude/rules/mixed.md"]);
  });

  test("a changed file brings in the rules its path matches, and the rules without paths always come", () => {
    const root = rulesRepo();
    const always = [".claude/rules/always.md", ".claude/rules/empty-paths.md"];
    expect(forPaths(root, ["lib/features/sales/cart.dart", "docs/INDEX.md"]).rules).toEqual([always[0], ".claude/rules/dart.md", always[1], ".claude/rules/sales.md"]);
    expect(forPaths(root, ["lib/l10n/app_ja.arb"]).rules).toEqual([...always, ".claude/rules/nested/l10n.md"]);
    expect(forPaths(root, ["README.md"]).rules).toEqual(always);
    expect(forPaths(root, []).rules).toEqual(always);
  });

  test("a repo without .claude/rules has no rules", () => {
    const root = mkdtempSync(join(tmpdir(), "idd-path-rules-none-"));
    write(root, "README.md", "x\n");
    expect(readAt(root)).toEqual({ rules: [], warnings: [] });
    expect(forPaths(root, ["lib/main.dart"]).rules).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("rules are read from the given commit, not from the files in the checkout", () => {
    const root = rulesRepo();
    const base = committed(root);
    write(root, ".claude/rules/dart.md", "---\npaths: [\"nothing/**\"]\n---\n");
    write(root, ".claude/rules/added.md", "# added later\n");
    committed(root);
    write(root, ".claude/rules/uncommitted.md", "# only in the checkout\n");
    const { rules } = readRulesAt(root, base);
    expect(rules.find((r) => r.file === ".claude/rules/dart.md")?.paths).toEqual(["lib/**/*.dart", "test/**/*.dart"]);
    expect(rules.find((r) => r.file === ".claude/rules/dart.md")?.text).toContain("# dart");
    expect(rules.map((r) => r.file)).not.toContain(".claude/rules/added.md");
    expect(rules.map((r) => r.file)).not.toContain(".claude/rules/uncommitted.md");
  });

  test("a symlinked rule is read through its target inside the repo; one pointing outside is left out with a warning", () => {
    const root = tmpDir("idd-path-link-");
    write(root, "shared/dart.md", "---\npaths: [\"lib/**\"]\n---\n# shared\n");
    mkdirSync(join(root, ".claude/rules"), { recursive: true });
    symlinkSync("../../shared/dart.md", join(root, ".claude/rules/dart.md"));
    symlinkSync("/etc/hostname", join(root, ".claude/rules/outside.md"));
    const { rules, warnings } = readAt(root);
    expect(rules).toEqual([{ file: ".claude/rules/dart.md", paths: ["lib/**"], text: "---\npaths: [\"lib/**\"]\n---\n# shared\n" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(".claude/rules/outside.md");
  });

  test("symlinks are followed up to 8 entries: a longer chain or a cycle is left out with a warning", () => {
    const root = tmpDir("idd-path-hops-");
    write(root, "shared/rule.md", "# end\n");
    mkdirSync(join(root, ".claude/rules"), { recursive: true });
    // .claude/rules/ok.md -> l1 -> ... -> l6 -> the file: 7 links, then the file as the 8th entry
    const chain = (name: string, links: number) => {
      let target = "../../shared/rule.md";
      for (let i = links - 1; i >= 1; i--) {
        symlinkSync(target, join(root, `.claude/rules/${name}-l${i}.link`));
        target = `${name}-l${i}.link`;
      }
      symlinkSync(target, join(root, `.claude/rules/${name}.md`));
    };
    chain("ok", 7);
    chain("long", 8);
    symlinkSync("loop-b.md", join(root, ".claude/rules/loop-a.md"));
    symlinkSync("loop-a.md", join(root, ".claude/rules/loop-b.md"));
    const { rules, warnings } = readAt(root);
    expect(rules.map((r) => r.file)).toEqual([".claude/rules/ok.md"]);
    expect(rules[0].text).toBe("# end\n");
    expect(warnings.map((w) => w.split(":")[0]).sort()).toEqual([".claude/rules/long.md", ".claude/rules/loop-a.md", ".claude/rules/loop-b.md"]);
    expect(warnings.every((w) => w.includes("シンボリックリンクが深すぎます"))).toBe(true);
  });

  test("a commit that cannot be read gives no rules and says why", () => {
    const root = rulesRepo();
    committed(root);
    const got = readRulesAt(root, "0123456789abcdef0123456789abcdef01234567");
    expect(got.rules).toEqual([]);
    expect(got.warnings).toHaveLength(1);
  });
});

describe("the files a diff touches", () => {
  test("lists added, changed, deleted and both sides of a rename, with non-ASCII names unquoted", () => {
    const root = tmpDir("idd-path-diff-");
    execFileSync("git", ["init", "-q", root]);
    write(root, "lib/features/post/old.dart", "a\n".repeat(20));
    write(root, "lib/gone.dart", "x\n");
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "base");
    const base = gitIn(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "lib/features/sales"), { recursive: true });
    gitIn(root, "mv", "lib/features/post/old.dart", "lib/features/sales/new.dart");
    gitIn(root, "rm", "-q", "lib/gone.dart");
    write(root, "docs/画集.md", "x\n");
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "head");
    const head = gitIn(root, "rev-parse", "HEAD");
    expect(diffPaths(root, base, head)).toEqual({ paths: ["docs/画集.md", "lib/features/post/old.dart", "lib/features/sales/new.dart", "lib/gone.dart"] });
  });

  test("a diff that cannot be read gives no files and says why", () => {
    const root = tmpDir("idd-path-diff-bad-");
    execFileSync("git", ["init", "-q", root]);
    gitIn(root, "commit", "-q", "--allow-empty", "-m", "base");
    const missingRev = diffPaths(root, "HEAD", "0123456789abcdef0123456789abcdef01234567");
    expect(missingRev.paths).toEqual([]);
    expect(missingRev.warning).toContain("差分");
    const missingDir = diffPaths(join(root, "no-such-dir"), "HEAD", "HEAD");
    expect(missingDir.paths).toEqual([]);
    expect(missingDir.warning).toContain("no-such-dir");
  });

  test("a diff whose list of names is larger than a pipe's default buffer is read whole", () => {
    const root = mkdtempSync(join(tmpdir(), "idd-path-diff-big-"));
    execFileSync("git", ["init", "-q", root]);
    gitIn(root, "commit", "-q", "--allow-empty", "-m", "base");
    mkdirSync(join(root, "d"));
    // about 1.25 MB of names: over the 1 MB that execFileSync allows by default
    for (let i = 0; i < 6000; i++) writeFileSync(join(root, "d", `${String(i).padStart(5, "0")}${"x".repeat(200)}`), "");
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "head");
    const got = diffPaths(root, "HEAD~1", "HEAD");
    expect(got.warning).toBeUndefined();
    expect(got.paths).toHaveLength(6000);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the rules a review stage is handed", () => {
  /** base: the rules and the repo's own files; head: a change to the sales feature, plus `change` on top */
  function stageRepo(opts: { rules?: boolean; own?: boolean; extra?: Record<string, string>; change?: (root: string) => void } = {}) {
    const root = opts.rules === false ? tmpDir("idd-path-stage-") : rulesRepo();
    if (opts.own !== false) {
      write(root, "AGENTS.md", "# a\n");
      write(root, "AGENTS.override.md", "# o\n");
      write(root, "_docs/standards/workflow.md", "# w\n");
    }
    for (const [rel, text] of Object.entries(opts.extra ?? {})) write(root, rel, text);
    const base = committed(root);
    write(root, "lib/features/sales/cart.dart", "x\n");
    opts.change?.(root);
    const head = committed(root);
    return { root, base, head, out: tmpDir("idd-path-out-") };
  }

  const scoped = [".claude/rules/always.md", ".claude/rules/dart.md", ".claude/rules/empty-paths.md", ".claude/rules/sales.md"];

  test("a stage gets the rules the diff's files match and the rules without paths, after the repo's own rule files", () => {
    const { root, base, head, out } = stageRepo();
    expect(stageRules(root, base, head, out).rules).toEqual(["AGENTS.md", "AGENTS.override.md", ...scoped]);
  });

  test("the rules come from the base: a rule the change edits or deletes is handed as the base's copy, one it adds is not handed", () => {
    const { root, base, head, out } = stageRepo({
      change: (r) => {
        write(r, ".claude/rules/dart.md", "---\npaths: [\"nothing/**\"]\n---\n# rewritten by the change\n");
        write(r, ".claude/rules/added.md", "---\npaths: [\"lib/**\"]\n---\n# added by the change\n");
        rmSync(join(r, ".claude/rules/always.md"));
      },
    });
    const got = stageRules(root, base, head, out);
    const dart = join(out, "base-rules", ".claude/rules/dart.md");
    const always = join(out, "base-rules", ".claude/rules/always.md");
    expect(got.rules).toEqual(["AGENTS.md", "AGENTS.override.md", always, dart, ".claude/rules/empty-paths.md", ".claude/rules/sales.md"]);
    expect(readFileSync(dart, "utf8")).toContain("# dart");
    expect(readFileSync(always, "utf8")).toContain("no frontmatter");
    expect(existsSync(join(out, "base-rules", ".claude/rules/sales.md"))).toBe(false);
  });

  test("the repo's own rule files come from the base too: one the change rewrites or deletes is handed as the base's copy", () => {
    const { root, base, head, out } = stageRepo({
      change: (r) => {
        write(r, "AGENTS.md", "# rewritten by the change\n");
        rmSync(join(r, "AGENTS.override.md"));
        write(r, "_docs/standards/workflow.md", "# rewritten\n");
      },
    });
    const agents = join(out, "base-rules", "AGENTS.md");
    const override = join(out, "base-rules", "AGENTS.override.md");
    const got = stageRules(root, base, head, out);
    expect(got.rules).toEqual([agents, override, ...scoped]);
    expect(got.warnings.filter((w) => w.includes("AGENTS"))).toEqual([]);
    expect(readFileSync(agents, "utf8")).toBe("# a\n");
    expect(readFileSync(override, "utf8")).toBe("# o\n");
  });

  test("an own rule file the change adds is not handed, though the checkout has it", () => {
    const { root, base, head, out } = stageRepo({
      rules: false,
      own: false,
      change: (r) => { write(r, "AGENTS.md", "# added by the change\n"); },
    });
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(stageRules(root, base, head, out)).toEqual({ rules: [], warnings: [] });
  });

  test("when the base cannot be read, the own rule files come from the checkout, with a warning", () => {
    const { root, head, out } = stageRepo({ change: (r) => { write(r, "AGENTS.md", "# rewritten\n"); } });
    const got = stageRules(root, "0123456789abcdef0123456789abcdef01234567", head, out);
    expect(got.rules.slice(0, 2)).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    expect(got.warnings.some((w) => w.includes("worktree の版"))).toBe(true);
    expect(stageRules(root, "", head, out).rules.slice(0, 2)).toEqual(["AGENTS.md", "AGENTS.override.md"]);
  });

  test("a rule with a glob that cannot be compiled does not stop the stage: the glob is dropped with a warning", () => {
    const { root, base, head, out } = stageRepo({ extra: { ".claude/rules/bad.md": "---\npaths:\n  - \"lib/[z-a]\"\n---\n" } });
    const got = stageRules(root, base, head, out);
    expect(got.rules).toEqual(["AGENTS.md", "AGENTS.override.md", ...scoped]);
    expect(got.warnings.filter((w) => w.includes(".claude/rules/bad.md"))).toHaveLength(1);
  });

  test("a diff that cannot be read leaves a warning on the stage", () => {
    const { root, base, out } = stageRepo();
    const got = stageRules(root, base, "0123456789abcdef0123456789abcdef01234567", out);
    expect(got.warnings.some((w) => w.includes("差分"))).toBe(true);
  });

  describe("a rule the overlay manifest names is a record", () => {
    const manifest = "# overlay manifest\nAGENTS.override.md\n.claude/rules/rec.md\noverlay.manifest\n";
    const recordRepo = (extra: Record<string, string> = {}) => stageRepo({
      extra: { "overlay.manifest": manifest, ".claude/rules/rec.md": "RECORD-RULE\n", ...extra },
      change: (r) => {
        write(r, "AGENTS.override.md", "# o, rewritten by the change\n");
        write(r, ".claude/rules/rec.md", "RECORD-RULE rewritten\n");
      },
    });
    const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
    const written = (out: string) => (existsSync(join(out, "base-rules")) ? filesUnder(join(out, "base-rules")) : []);

    test("no stage is handed it, repo-relative or under base-rules, and its text is not written", () => {
      const { root, base, head, out } = recordRepo();
      const got = stageRules(root, base, head, out);
      expect(got.rules).toEqual(["AGENTS.md", ...scoped]);
      expect(got.rules.some((r) => r.includes("AGENTS.override.md") || r.includes("rec.md"))).toBe(false);
      // the fact is kept for the stage's record, not for its brief
      const omitted = got.warnings.filter((w) => w.includes("AGENTS.override.md") || w.includes(".claude/rules/rec.md"));
      expect(omitted).toHaveLength(2);
      // the reason is the row's nature, not a stage's: the warning does not say only some stages are kept from it
      for (const w of omitted) expect(w).not.toContain("隔てた段");
      expect(written(out).some((f) => /RECORD|AGENTS\.override|rec\.md/.test(f))).toBe(false);
      for (const f of written(out)) expect(readFileSync(f, "utf8")).not.toMatch(/# o\n|RECORD-RULE/);
    });

    test("a rule that is a symlink to a record is a record too", () => {
      const { root, out } = recordRepo();
      symlinkSync("../../AGENTS.override.md", join(root, ".claude/rules/alias.md"));
      const base2 = committed(root);
      write(root, "lib/features/sales/cart.dart", "y\n");
      const head2 = committed(root);
      const alias = (rules: string[]) => rules.some((r) => r.includes("alias.md"));
      expect(alias(stageRules(root, base2, head2, out).rules)).toBe(false);
    });

    test("the rows are the ones the caller cuts the copy by: a row only the lane base or the merge lists is a record too", () => {
      const { root, base, head, out } = stageRepo({ extra: { "notes/rule.md": "x\n" } });
      write(root, ".claude/rules/late.md", "LATE\n");
      const base3 = committed(root);
      write(root, ".claude/rules/late.md", "LATE rewritten\n");
      const head3 = committed(root);
      expect(base).not.toBe(head);
      // the head and base manifests have no row; the rows the caller passes decide
      expect(stageRules(root, base3, head3, out).rules).toContain(join(out, "base-rules", ".claude/rules/late.md"));
      const cut = stageRules(root, base3, head3, tmpDir("idd-path-out-"), [".claude/rules/late.md"]);
      expect(cut.rules.some((r) => r.includes("late.md"))).toBe(false);
      expect(stageRules(root, base3, head3, tmpDir("idd-path-out-"), []).rules.some((r) => r.includes("late.md"))).toBe(true);
    });

    test("without a base the checkout's record is not handed", () => {
      const { root, head, out } = recordRepo();
      const got = stageRules(root, "", head, out);
      expect(got.rules).toEqual(["AGENTS.md"]);
    });

    test("without a base a fixed rule that is a symlink to a record is not handed either", () => {
      const { root, head, out } = recordRepo();
      rmSync(join(root, "AGENTS.md"));
      symlinkSync("AGENTS.override.md", join(root, "AGENTS.md"));
      expect(stageRules(root, "", head, out).rules).toEqual([]);
    });

    test("without a base or with one git cannot read, an absolute symlink to a record in the repo is not handed", () => {
      for (const base of ["", "aaa"]) {
        const { root, head, out } = recordRepo();
        rmSync(join(root, "AGENTS.md"));
        symlinkSync(join(root, "AGENTS.override.md"), join(root, "AGENTS.md"));
        const got = stageRules(root, base, head, out);
        expect(got.rules).toEqual([]);
        expect(got.warnings.some((w) => w.includes("AGENTS.override.md"))).toBe(true);
      }
    });

    test("an absolute-then-relative symlink chain that ends at a record is not handed either", () => {
      const { root, head, out } = recordRepo();
      rmSync(join(root, "AGENTS.md"));
      symlinkSync(join(root, "alias"), join(root, "AGENTS.md"));
      symlinkSync("AGENTS.override.md", join(root, "alias"));
      expect(stageRules(root, "", head, out).rules).toEqual([]);
    });

    test("an absolute symlink to a non-record in the repo, or to a file outside it, is still handed", () => {
      const { root, head, out } = recordRepo();
      write(root, "README.md", "# readme\n");
      rmSync(join(root, "AGENTS.md"));
      symlinkSync(join(root, "README.md"), join(root, "AGENTS.md"));
      expect(stageRules(root, "", head, out).rules).toEqual(["AGENTS.md"]);
      const outside = tmpDir("idd-path-outside-");
      write(outside, "rule.md", "# outside\n");
      rmSync(join(root, "AGENTS.md"));
      symlinkSync(join(outside, "rule.md"), join(root, "AGENTS.md"));
      expect(stageRules(root, "", head, out).rules).toEqual(["AGENTS.md"]);
    });
  });

  test("with no .claude/rules, or no repo to read, a stage gets the same rule files as before", () => {
    const { root, base, head, out } = stageRepo({ rules: false });
    expect(stageRules(root, base, head, out)).toEqual({ rules: ["AGENTS.md", "AGENTS.override.md"], warnings: [] });
    const plain = tmpDir("idd-path-plain-");
    write(plain, "AGENTS.md", "# a\n");
    write(plain, ".claude/rules/always.md", "# a\n");
    const plainGot = stageRules(plain, "aaa", "bbb", out);
    expect(plainGot.rules).toEqual(["AGENTS.md"]);
    expect(plainGot.warnings.some((w) => w.includes("worktree の版"))).toBe(true);
  });
});
