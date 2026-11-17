import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The screen's bundle on disk, as install, upgrade, `idd gui-build` and the engine all read it. The engine serves
 * `packages/idd-gui/dist` itself; the bundle carries a stamp naming the commit it was built from, and the engine
 * serves it only when that commit is the one it runs. The stamp is written by `packages/idd-gui/build.ts`.
 */

/** the stamp's name inside the bundle (`packages/idd-gui/build.ts` writes the same name; a test pins the two together) */
export const GUI_STAMP_FILE = "build.json";

/** how the bundle is built, run from the checkout (`package.json`'s `build:gui` runs `packages/idd-gui/build.ts` with bun) */
export const GUI_BUILD_COMMAND = ["npm", "run", "build:gui"] as const;

/** where a checkout's bundle is */
export function guiBundleDir(checkout: string): string {
  return join(checkout, "packages", "idd-gui", "dist");
}

/** the commit the bundle in `dist` was built from, or null when it has no readable stamp */
export function readBundleCommit(dist: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dist, GUI_STAMP_FILE), "utf8")) as { commit?: unknown };
    return typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null;
  } catch {
    return null;
  }
}

/**
 * Whether the bundle in `dist` has to be built again for a checkout at `head`: the engine serves a bundle only when
 * the commit in its stamp is its own, and the engine runs the checkout's head after install and upgrade. A stamp that
 * is absent, unreadable or another commit counts the same, and so does a head that cannot be read.
 */
export function guiBundleNeedsBuild(dist: string, head: string | null): boolean {
  return head === null || readBundleCommit(dist) !== head;
}
