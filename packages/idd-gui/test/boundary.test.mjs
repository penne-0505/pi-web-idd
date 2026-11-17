import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const SRC = join(PKG, "src");
const ROOT = resolve(PKG, "..", "..");
const CONTRACT = "packages/idd-engine/src/gui-contract.ts";

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const ALLOWED_INSIDE = /^\./;
const ALLOWED_REACT = /^(react|react-dom)(\/.*)?$/;

test("the screen reaches outside only through the engine's one contract door", () => {
  const outside = [];
  for (const file of sourceFiles(SRC)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (file.endsWith(join("src", "engine", "contract.ts"))) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (ALLOWED_INSIDE.test(specifier) || ALLOWED_REACT.test(specifier)) continue;
      if (specifier.startsWith("@/")) continue;
      outside.push(`${relative(ROOT, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(outside, [], "only src/engine/contract.ts may import from outside the package");
});

test("the contract door is the engine's gui-contract and nothing else", () => {
  const door = join(SRC, "engine", "contract.ts");
  const text = readFileSync(door, "utf8");
  const specifiers = [...text.matchAll(SPECIFIER)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    const target = relative(ROOT, resolve(dirname(door), specifier));
    assert.equal(target, CONTRACT, `${specifier} must point at ${CONTRACT}`);
  }
});

test("the screen does not copy the engine's types", () => {
  const copies = [];
  for (const file of sourceFiles(SRC)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const name of ["InboxItem", "GoItem", "StuckItem", "DuplicateItem", "QuestionItem", "RequeueItem", "IddState", "WorkView", "WorkLaneView", "WorkDoneView", "WorkRepoView", "WorkDecisionsView", "DecisionTabView", "WorkWaitRef", "ConversationSummary", "ConversationOpenState", "ConversationListResult", "ConversationGroup", "QueueItem", "ConversationDocument", "ContextUsage", "ConversationEvent", "ConversationEventType", "ConversationNotice", "ConversationModelOption", "IdeaChallengeResponse", "IdeaDocumentStatus", "IdeaExitIssueStatus", "IdeaExitRowStatus", "IdeaExitSummary", "IdeaGateResponse", "IdeaGateStatus", "IdeaRunOutcome", "IdeaRunResponse", "IdeaSectionStatus", "IdeaStatusResponse", "IdeaUnreadableStatus"]) {      const declarations = [`interface ${name}\\b`, `type ${name}\\s*=`];
      for (const pattern of declarations) {
        if (new RegExp(pattern).test(text)) copies.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(copies, []);
});

test("the contract door does not carry the server's code", () => {
  const text = readFileSync(join(ROOT, CONTRACT), "utf8");
  assert.doesNotMatch(text, /node:/, "no node module");
  // every export is a type re-export or one of the pure helpers, never a server module
  assert.doesNotMatch(text, /buildState|readLifecycle|applySnoozes/);
});

test("the built bundle carries no server code", () => {
  let bun = true;
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
  } catch {
    bun = false;
  }
  const dist = join(PKG, "dist");
  if (bun) execFileSync("bun", ["run", "--cwd", PKG, "build"], { stdio: "ignore", timeout: 120_000 });
  if (!existsSync(dist)) {
    assert.ok(!bun, "the bundle could not be built, so this check cannot pass");
    return;
  }
  const js = readdirSync(dist).filter((name) => name.endsWith(".js"));
  assert.ok(js.length > 0, "the bundle has at least one js file");
  for (const name of js) {
    const text = readFileSync(join(dist, name), "utf8");
    for (const forbidden of ["node:fs", "node:path", "readLifecycle", "buildState", "@idd/core", "@idd/lane"]) {
      assert.equal(text.includes(forbidden), false, `${name} must not carry ${forbidden}`);
    }
  }
});
