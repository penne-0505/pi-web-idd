#!/usr/bin/env bun
/**
 * The screen's bundle. Bun reads `index.html` as the entry and follows the TSX and CSS it names, so no other
 * build tool is needed. Output goes to `dist/`, one level deep, with hashed names for the JS and CSS: the engine
 * serves that directory by name list, so a name that is not in the list can never be read.
 *
 * The bundle is built beside `dist/` and put in its place only when it is whole, so `dist/` is never a half build,
 * and a failed build leaves the earlier bundle where it was. `build.json` in it names the commit it was built from:
 * the engine serves a bundle only when that commit is the one it runs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** the stamp's name; the engine and `idd gui-build` read the same name (a test pins the two together) */
const STAMP_FILE = "build.json";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const fresh = join(here, "dist.next");
const previous = join(here, "dist.old");

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = head.status === 0 ? head.stdout.trim() : "";
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error("build の commit を git から読めません。repo の中で build してください");
  process.exit(1);
}

rmSync(fresh, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(here, "index.html")],
  outdir: fresh,
  target: "browser",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  rmSync(fresh, { recursive: true, force: true });
  process.exit(1);
}

writeFileSync(join(fresh, STAMP_FILE), `${JSON.stringify({ commit })}\n`);
rmSync(previous, { recursive: true, force: true });
if (existsSync(dist)) renameSync(dist, previous);
renameSync(fresh, dist);
rmSync(previous, { recursive: true, force: true });
for (const output of result.outputs) console.log(output.path.replace(fresh, dist));
