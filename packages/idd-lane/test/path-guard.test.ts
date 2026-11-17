import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import registerPathGuard, { guardReason, READ_ROOT_ENV } from "../src/pi-extensions/path-guard.ts";
import { buildRouterArgs } from "../src/question-routing.ts";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "idd-path-guard-"));
  const wt = join(root, "wt");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "a.ts"), "x");
  writeFileSync(join(root, "secret.txt"), "s");
  symlinkSync(join(root, "secret.txt"), join(wt, "link.txt"));
  return { root, wt };
}

/** one call of the guard: the tool, its input and the root the call is judged against */
type GuardCall = [tool: string, input: Record<string, unknown>];

/** run `fn` on a fresh tree and remove the tree afterwards */
function inTree(fn: (t: { root: string; wt: string }) => void) {
  const t = tree();
  try {
    fn(t);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

/** every call is judged against `root`: the ones in `passes` return no reason and the ones in `blocked` return one */
function judge(root: string | undefined, passes: GuardCall[], blocked: GuardCall[]) {
  for (const [tool, input] of passes) expect(guardReason(tool, input, root), `${tool} ${JSON.stringify(input)}`).toBeNull();
  for (const [tool, input] of blocked) expect(guardReason(tool, input, root), `${tool} ${JSON.stringify(input)}`).not.toBeNull();
}

const READ_LIKE = ["read", "grep", "find", "ls"];

test("a read, grep, find or ls inside the root passes and one outside it is blocked", () => {
  inTree(({ root, wt }) => {
    judge(
      wt,
      [["read", { path: "src/a.ts" }], ["read", { path: join(wt, "src", "a.ts") }], ["ls", {}], ["grep", { pattern: "x", glob: "**/*.ts" }], ["find", { pattern: "src/**/*.ts", path: "src" }], ["write", { path: "/etc/passwd" }]],
      [
        ...["../secret.txt", join(root, "secret.txt"), "/etc/passwd", "~/.ssh/id_ed25519", "@/etc/hosts", "link.txt", "src/../../secret.txt"].map((path): GuardCall => ["read", { path }]),
        ["ls", { path: "/home" }], ["grep", { pattern: "x", path: ".", glob: "../**" }], ["find", { pattern: "/etc/*" }], ["find", { pattern: "*", path: ".." }],
      ],
    );
  });
});

test("a URI, a // start or a unicode-space variant that pi would open outside the root is blocked", () => {
  inTree(({ root, wt }) => {
    const paths = ["file:///etc/passwd", "@file:///etc/passwd", `file://${join(root, "secret.txt")}`, "//etc/passwd", "@//etc/passwd", "http://example.com/x", "~", "~/x"];
    // a no-break space is a plain space to pi, so "\u00A0src/a.ts" names a file inside the root and passes
    judge(wt, [["read", { path: "src/a.ts" }], ["read", { path: "\u00A0src/a.ts" }]], paths.flatMap((path) => READ_LIKE.map((tool): GuardCall => [tool, { path }])));
    // with no root, nothing passes
    judge(undefined, [], [["read", { path: "file:///etc/passwd" }]]);
  });
});

test("a name pi opens in another spelling (decomposed unicode, curly quote) is judged by the file it opens", () => {
  inTree(({ root, wt }) => {
    const nfc = "caf\u00e9.txt";
    const nfd = nfc.normalize("NFD");
    expect(nfc).not.toBe(nfd);
    // the symlink is stored under the decomposed name and leads out; the call names it in the composed form, which pi retries as decomposed
    symlinkSync(join(root, "secret.txt"), join(wt, nfd));
    judge(wt, [], [...READ_LIKE.map((tool): GuardCall => [tool, { path: nfc }]), ["read", { path: join(wt, nfc) }], ["read", { path: `@${nfc}` }]]);
    // the same trick through the apostrophe pi turns into a curly one
    symlinkSync(join(root, "secret.txt"), join(wt, "it\u2019s.txt"));
    judge(wt, [], [["read", { path: "it's.txt" }]]);
    // a decomposed name that is a real file inside the root still reads
    writeFileSync(join(wt, "r\u00e9sum\u00e9.md".normalize("NFD")), "x");
    judge(wt, [["read", { path: "r\u00e9sum\u00e9.md" }]], []);
    // a directory symlink under the decomposed name leads out too
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "k.txt"), "k");
    symlinkSync(join(root, "outside"), join(wt, "d\u00e9p".normalize("NFD")));
    judge(wt, [], [["read", { path: "d\u00e9p/k.txt" }]]);
  });
});

test("with no root given every guarded call is blocked, and the extension returns a block", () => {
  expect(guardReason("read", { path: "a" }, undefined)).not.toBeNull();
  let handler: ((e: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined;
  registerPathGuard({ on: (_ev, h) => { handler = h; } });
  const before = process.env[READ_ROOT_ENV];
  delete process.env[READ_ROOT_ENV];
  try {
    expect(Object.keys(handler!({ toolName: "read", input: { path: "a" } }) as object).sort()).toEqual(["block", "reason"]);
    expect(handler!({ toolName: "bash", input: {} })).toBeUndefined();
  } finally {
    if (before !== undefined) process.env[READ_ROOT_ENV] = before;
  }
});

test("the router is started with the path guard and read-only tools", () => {
  const args = buildRouterArgs({ model: "x/y", thinking: "off" } as never, "p");
  expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
  const i = args.indexOf("--extension");
  expect(i).toBeGreaterThan(0);
  expect(args[i + 1].endsWith("pi-extensions/path-guard.ts")).toBe(true);
});
