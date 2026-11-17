import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const HERE = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": resolve(HERE, "..", "..", "..", "..") }, tsconfigPaths: true, interopDefault: true });
const { GET: guiGet, GUI_PREFIX, GUI_BUILD_COMMAND, guiDistDir, filesIn } = await jiti.import("./gui.ts");
const { routes, matchRoute } = await jiti.import("../routes.ts");
const { rememberEngineStart, resetStaleness, setGuiBuildFailure } = await jiti.import("../server/staleness.ts");

/** the commit the engine runs, and the one a stamped bundle names */
const ENGINE = "a".repeat(40);
const OLDER = "b".repeat(40);

/**
 * a git that answers for a checkout of two commits: `behind` is the one that is the other's ancestor, and `changed` the
 * paths between them. The engine's own start is read through `rev-parse`.
 */
function fakeGit({ older = OLDER, changed = [] } = {}) {
  return (_root, args) => {
    const out = (stdout) => ({ ok: true, stdout, stderr: "" });
    if (args[0] === "rev-parse") return out(`${ENGINE}\n`);
    if (args[0] === "merge-base") return out(`${older}\n`);
    if (args[0] === "diff") return out(changed.join("\n"));
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
}
const stamp = (commit) => writeFileSync(join(dist, "build.json"), `${JSON.stringify({ commit })}\n`);

let root;
let dist;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "idd-gui-route-"));
  dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(dist, "app-abc123.js"), "console.log('screen')");
  writeFileSync(join(dist, "app-abc123.css"), ":root{}");
  writeFileSync(join(root, "outside.js"), "the engine's own file");
  mkdirSync(join(dist, "sub"));
  symlinkSync(join(root, "outside.js"), join(dist, "external.js"));
  symlinkSync(join(dist, "index.html"), join(dist, "alias.html"));
  symlinkSync(join(dist, "sub"), join(dist, "subdir"));
  process.env.IDD_GUI_DIST = dist;
  // the plain case: the bundle was built from the commit the engine runs
  stamp(ENGINE);
  rememberEngineStart({ root, git: fakeGit() });
});
afterEach(() => {
  delete process.env.IDD_GUI_DIST;
  resetStaleness();
  rmSync(root, { recursive: true, force: true });
});

const get = (path) => guiGet(new Request(`http://localhost${path}`), matchRoute("/gui/:file", path) ?? {});

test("the route table carries the two names, and they do not shadow the API", () => {
  assert.deepEqual(routes.filter((r) => r.pattern.startsWith(GUI_PREFIX)).map((r) => r.pattern), ["/gui", "/gui/:file"]);
  assert.deepEqual(matchRoute("/api/idd/state", "/api/idd/state"), {});
  assert.equal(routes.some((r) => r.pattern === "/api/idd/state"), true);
});

test("the prefix serves index.html and a listed name with the right content type", async () => {
  const index = guiGet(new Request("http://localhost/gui/"), {});
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await index.text(), /id=root/);
  const script = await get("/gui/app-abc123.js");
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await script.text(), /screen/);
  const css = await get("/gui/app-abc123.css");
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
});

test("index.html is not cached, a hashed name is", async () => {
  assert.equal(guiGet(new Request("http://localhost/gui/"), {}).headers.get("cache-control"), "no-store");
  assert.match((await get("/gui/app-abc123.js")).headers.get("cache-control"), /immutable/);
});

test("no request can read a file outside the build output", async () => {
  for (const path of ["/gui/..", "/gui/%2e%2e", "/gui/%2f", "/gui/app-abc123.js/../../outside.js", "/gui/nope.js", "/gui//etc/passwd"]) {
    const res = await get(path);
    assert.notEqual(res.status, 200, path);
    assert.equal((await res.text()).includes("the engine's own file"), false, path);
  }
  // and a name passed straight to the handler (the decoded form) still does not read by path
  assert.equal(guiGet(new Request("http://localhost/gui/x"), { file: "../../outside.js" }).status, 404);
  assert.equal(guiGet(new Request("http://localhost/gui/x"), { file: "/etc/passwd" }).status, 404);
});

test("a symlink or a directory in the output is never returned", async () => {
  for (const name of ["external.js", "alias.html", "subdir", "sub"]) {
    const res = guiGet(new Request(`http://localhost/gui/${name}`), { file: name });
    assert.equal(res.status, 404, name);
  }
  assert.equal((filesIn(dist) ?? new Set()).has("external.js"), false);
  assert.equal((filesIn(dist) ?? new Set()).has("sub"), false);
});

test("with nothing built, the door says how to build and the API keeps working", async () => {
  delete process.env.IDD_GUI_DIST;
  process.env.IDD_GUI_DIST = join(root, "missing");
  const res = guiGet(new Request("http://localhost/gui/"), {});
  assert.equal(res.status, 503);
  assert.match(await res.text(), /npm run build:gui/);
  assert.equal(GUI_BUILD_COMMAND, "npm run build:gui");
  assert.deepEqual(matchRoute("/api/idd/state", "/api/idd/state"), {});
});

test("the bare prefix redirects once and the slashed one serves the page", () => {
  const bare = matchRoute("/gui", "/gui");
  assert.notEqual(bare, null);
  const redirect = guiGet(new Request("http://localhost/gui"), bare);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/gui/");
  const slashed = matchRoute("/gui", "/gui/");
  assert.notEqual(slashed, null);
  const page = guiGet(new Request("http://localhost/gui/"), slashed);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("location"), null);
});

test("the dist path can be pointed elsewhere for a test", () => {
  assert.equal(guiDistDir({ IDD_GUI_DIST: "/tmp/elsewhere" }), "/tmp/elsewhere");
  assert.match(guiDistDir({}), /packages\/idd-gui\/dist\/?$/);
});

test("the build's stamp is the engine's own bookkeeping and is not served", async () => {
  assert.equal(filesIn(dist).has("build.json"), true);
  assert.equal((await get("/gui/build.json")).status, 404);
});

test("a bundle from another commit than the engine's is not served, and the door says why", async () => {
  // the bundle is older than the engine and the paths between them are ones the screen reads
  stamp(OLDER);
  resetStaleness();
  rememberEngineStart({ root, git: fakeGit({ older: OLDER, changed: ["packages/idd-gui/src/main.tsx"] }) });
  for (const path of ["/gui/", "/gui/app-abc123.js", "/gui/app-abc123.css"]) {
    const res = path === "/gui/" ? guiGet(new Request(`http://localhost${path}`), {}) : await get(path);
    assert.equal(res.status, 503, path);
    const body = await res.text();
    assert.match(body, /bundle は bbbbbbbb、engine は aaaaaaaa/, path);
    assert.match(body, /npm run build:gui/, path);
  }
});

test("a bundle with no stamp, or one git cannot relate to the engine, is not served", async () => {
  rmSync(join(dist, "build.json"));
  const unstamped = guiGet(new Request("http://localhost/gui/"), {});
  assert.equal(unstamped.status, 503);
  assert.match(await unstamped.text(), /build の commit がありません/);

  stamp(OLDER);
  resetStaleness();
  rememberEngineStart({ root, git: (_root, args) => (args[0] === "rev-parse" ? { ok: true, stdout: `${ENGINE}\n`, stderr: "" } : { ok: false, stdout: "", stderr: "bad object" }) });
  assert.equal(guiGet(new Request("http://localhost/gui/"), {}).status, 503);
});

test("a bundle that differs from the engine's commit only in paths the engine would not read is still the engine's screen", async () => {
  // older than the engine, only records between them
  stamp(OLDER);
  resetStaleness();
  rememberEngineStart({ root, git: fakeGit({ older: OLDER, changed: ["_docs/x.md", "TODO.md"] }) });
  assert.equal(guiGet(new Request("http://localhost/gui/"), {}).status, 200);

  // newer than the engine (the screen was rebuilt while the engine kept running): the screen's own paths may differ...
  stamp(OLDER);
  resetStaleness();
  rememberEngineStart({ root, git: fakeGit({ older: ENGINE, changed: ["packages/idd-gui/src/main.tsx"] }) });
  assert.equal(guiGet(new Request("http://localhost/gui/"), {}).status, 200);

  // ...but not the engine's: a screen built against an engine that has not been replaced yet waits for it
  resetStaleness();
  rememberEngineStart({ root, git: fakeGit({ older: ENGINE, changed: ["packages/idd-engine/src/server/state.ts"] }) });
  const waiting = guiGet(new Request("http://localhost/gui/"), {});
  assert.equal(waiting.status, 503);
  assert.match(await waiting.text(), /engine の入れ替えを待ちます/);
});

test("when the last rebuild failed the refusal says so, and nothing of the earlier bundle is served", async () => {
  stamp(OLDER);
  resetStaleness();
  rememberEngineStart({ root, git: fakeGit({ older: OLDER, changed: ["packages/idd-gui/src/main.tsx"] }) });
  setGuiBuildFailure({ code: 2, at: "2026-11-10T00:00:00Z", kind: "build" });
  const res = guiGet(new Request("http://localhost/gui/"), {});
  assert.equal(res.status, 503);
  assert.match(await res.text(), /直近の作り直しに失敗しました（終了 2/);
  assert.equal((await get("/gui/app-abc123.js")).status, 503);
});

test("the stamp name the build writes is the one the engine reads", () => {
  const build = readFileSync(resolve(HERE, "..", "..", "..", "idd-gui", "build.ts"), "utf8");
  assert.match(build, /const STAMP_FILE = "build\.json"/);
});
