import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The TypeScript copies of the readings stay off the running path.
 *
 * The MoonBit fold answers the lane's state, its turn, the stages' picks and the review loop's next step, and
 * the TypeScript copies of those readings (`*-reference.ts`) are kept only as the yardstick the cross-check and
 * the fixture tests measure against (C-186-2, C-191-1, C-199-1, C-201-1). A reading that is answered twice makes
 * the tick's step and the screen's card disagree as soon as one of them is fixed (P-4), and a broken fold that
 * quietly falls back hides itself behind the second reading.
 *
 * So: a file on the running path may name a copy only for its types. A value import, a dynamic import or a
 * `require` of a copy is a failure this test reports by name.
 *
 * The other side of the same fence is the copy's own imports: a copy that reaches the MoonBit answers (directly, or
 * through the running path a value import leads into) shares the answer it is held against, and a fold that takes the
 * wrong end for a lane's would agree with the copy (C-206-1, C-206-2). Both checks read a file's imports the one
 * way, so the reader has to see a copy named with `.js` and must not read a `from` of the next statement as this
 * statement's (F-201-5).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

/** the packages whose source runs with the engine */
const PACKAGES = ["idd-core", "idd-engine"];

/** every source file of a package, as paths relative to the repo root */
function sourcesOf(pkg) {
  const base = join(ROOT, "packages", pkg, "src");
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name.endsWith(".ts") || name.endsWith(".mts")) out.push(path);
    }
  };
  walk(base);
  return out.sort();
}

/** the imports of a file, as the text of each import statement */
function importsOf(text) {
  const out = [];
  // a clause ends with its statement: a `from` of the next statement is not this statement's. A clause carries no
  // quote, so the statement below a side-effect import is not read as the module of the one above it.
  const pattern = /(?:^|\n)\s*(import|export)\s+([^;"'`]*?)from\s*["']([^"']+)["']/g;
  let match = pattern.exec(text);
  while (match) {
    out.push({ kind: match[1], clause: match[2], module: match[3] });
    match = pattern.exec(text);
  }
  // a side-effect import and a dynamic import carry no `from`
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  match = bare.exec(text);
  while (match) {
    out.push({ kind: "import", clause: "", module: match[1] });
    match = bare.exec(text);
  }
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  match = dynamic.exec(text);
  while (match) {
    out.push({ kind: "dynamic", clause: "", module: match[1] });
    match = dynamic.exec(text);
  }
  const required = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  match = required.exec(text);
  while (match) {
    out.push({ kind: "require", clause: "", module: match[1] });
    match = required.exec(text);
  }
  return out;
}

/** whether the module a statement names is a TypeScript copy's, with or without the extension the import writes */
function isCopyModule(module) {
  return /-reference(\.[cm]?[jt]s)?$/.test(module);
}

/** whether an import carries code: a type-only clause does not */
function valueImport(entry) {
  return !/^type\s/.test(entry.clause.trim());
}

/** the file a relative specifier names, with the extension a compiled import writes read back to the source */
function resolveSource(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  const candidates = [base];
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/js$/, "ts"), base.replace(/js$/, "mts"));
  else if (!/\.[cm]?[jt]s$/.test(base)) candidates.push(`${base}.ts`, `${base}.mts`, join(base, "index.ts"));
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/** the packages' MoonBit answers: the door every reading goes through, and the built module behind it */
const FOLD_DOOR = join(ROOT, "packages", "idd-core", "src", "intent", "moonbit-fold.ts");
const FOLD_DIST = join(ROOT, "packages", "idd-fold", "dist") + sep;

/** whether a file is the MoonBit fold's answer, or the built module it reads */
function isFoldAnswer(path) {
  return path === FOLD_DOOR || path.startsWith(FOLD_DIST);
}

/**
 * Every chain of value imports that leads from a file to the MoonBit answers: the copies' own, and the running path's.
 * A type-only import carries no code, so it is not followed; a cycle is walked once.
 */
function chainsToFold(start) {
  const chains = [];
  const seen = new Set();
  const walk = (file, chain) => {
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const entry of importsOf(text)) {
      if (!valueImport(entry)) continue;
      const next = resolveSource(file, entry.module);
      if (!next) continue;
      if (isFoldAnswer(next)) {
        chains.push([...chain, next]);
        continue;
      }
      if (seen.has(next)) continue;
      walk(next, [...chain, next]);
    }
  };
  walk(start, [start]);
  return chains;
}

test("the running path names a TypeScript copy only for its types", () => {
  const offenders = [];
  for (const pkg of PACKAGES) {
    for (const path of sourcesOf(pkg)) {
      if (path.endsWith("-reference.ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const entry of importsOf(text)) {
        if (!isCopyModule(entry.module)) continue;
        // a type-only import carries no code: the copy's functions are not reachable from it
        if (!valueImport(entry)) continue;
        offenders.push(`${relative(ROOT, path)}: ${entry.kind} ${entry.module}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `実行の経路が TS の写しを読んでいます:\n${offenders.join("\n")}`);
});

test("the fold's failure is a failure the caller sees, and never a second reading", () => {
  const text = readFileSync(join(ROOT, "packages", "idd-core", "src", "intent", "moonbit-fold.ts"), "utf8");
  // the door has one answer: the fold's. A fallback to a TypeScript reading is not written here.
  assert.equal(/reviewLoopStateReference|turnReference|pickReference|deriveStageReference/.test(text), false);
  // the copies are named by the files that measure against them, and by nothing else
  const copies = sourcesOf("idd-core").filter((path) => path.endsWith("-reference.ts"));
  assert.ok(copies.length > 0, "比較の基準になる TS の写しがありません");
});

test("the import reader sees a copy named .js and stops at the statement's end", () => {
  const entries = importsOf([
    'import { x } from "./a-reference.js";',
    'import type { T } from "./b-reference.ts";',
    'import "./styles.css";',
    'export { y } from "./c-reference.js";',
  ].join("\n"));
  const modules = entries.map((entry) => entry.module);
  // a compiled name is still a copy's name
  assert.equal(isCopyModule("./a-reference.js"), true);
  assert.equal(isCopyModule("./c-reference.js"), true);
  assert.equal(isCopyModule("./a-reference.ts"), true);
  assert.equal(isCopyModule("./a-reference"), true);
  assert.equal(isCopyModule("./references.ts"), false);
  assert.ok(modules.includes("./a-reference.js"));
  assert.ok(modules.includes("./c-reference.js"));
  // the side-effect import is its own entry, not the module of the statement below it
  assert.deepEqual(entries.filter((entry) => entry.module === "./styles.css"), [{ kind: "import", clause: "", module: "./styles.css" }]);
  // and no entry carries a statement's end inside its clause, which is how a `from` of the next statement got taken
  assert.deepEqual(entries.filter((entry) => entry.clause.includes(";")), []);
});

test("no TypeScript copy reaches the MoonBit answers", () => {
  // the reader finds the running path's own route, so an empty answer below is the copies' doing, not the reader's
  const running = chainsToFold(join(ROOT, "packages", "idd-core", "src", "intent", "store.ts"));
  assert.ok(running.length > 0, "実行の経路から畳みへの経路を、検査が読めていません");
  const copies = sourcesOf("idd-core").filter((path) => path.endsWith("-reference.ts"));
  const offenders = [];
  for (const copy of copies) {
    // the shortest chain first: it is the one to cut
    for (const chain of chainsToFold(copy).sort((a, b) => a.length - b.length)) {
      offenders.push(chain.map((path) => relative(ROOT, path)).join(" -> "));
    }
  }
  assert.deepEqual(offenders, [], `TS の写しが MoonBit の畳みの答えに値で届いています:\n${offenders.join("\n")}`);
});
