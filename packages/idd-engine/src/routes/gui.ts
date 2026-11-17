import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GUI_BUILD_COMMAND as BUILD_WORDS, GUI_STAMP_FILE } from "@idd/lane";
import { guiServing } from "../server/gui-build.ts";

/**
 * The built screen is served under this prefix, on the engine's own port, so the screen and the API share an
 * origin and the Host / Origin guard already in front of every route covers it.
 */
export const GUI_PREFIX = "/gui";

/** the one line the screen's door answers with when there is nothing built yet, and names how to build it */
export const GUI_BUILD_COMMAND = BUILD_WORDS.join(" ");

/** where the bundle is; tests point `IDD_GUI_DIST` at a temporary place */
export function guiDistDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IDD_GUI_DIST) return resolve(env.IDD_GUI_DIST);
  return fileURLToPath(new URL("../../../../packages/idd-gui/dist/", import.meta.url));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The names the directory holds directly, regular files only. A symlink is left out on purpose: its name is in the
 * bundle's place but reading it follows a file that may be outside. A missing directory returns null.
 */
export function filesIn(dir: string): Set<string> | null {
  try {
    return new Set(readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    return null;
  }
}

function missing(): Response {
  return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** the bundle's answer for one name: a name not in the listing, or not a regular file, is never read */
export function serveGuiFile(dir: string, name: string): Response {
  const names = filesIn(dir);
  if (names === null) {
    return new Response(`${GUI_BUILD_COMMAND}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  // the build's stamp is the engine's own bookkeeping, not a part of the screen
  if (name === GUI_STAMP_FILE || !names.has(name)) return missing();
  const full = join(dir, name);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return missing();
  }
  // the name may have become a symlink after the listing was taken: check again right before reading
  if (!stat.isFile()) return missing();
  const cache = extname(name) === ".html" ? "no-store" : "public, max-age=31536000, immutable";
  return new Response(readFileSync(full), { headers: { "content-type": contentTypeFor(name), "cache-control": cache } });
}

/**
 * `/gui` and `/gui/:file`. `matchRoute` drops the slashes on both sides, so `/gui` and `/gui/` reach the same
 * pattern; the handler looks at the raw pathname and sends a single redirect from the bare prefix to the slashed
 * one (never a redirect of the slashed one to itself).
 */
export function GET(req: Request, params: Record<string, string>): Response {
  const dir = guiDistDir();
  // a bundle built from another commit than the engine's is not served: the screen and the API are one piece of code
  if (filesIn(dir) !== null) {
    const serving = guiServing(dir);
    if (!serving.ok) {
      return new Response(`画面の bundle を配りません: ${serving.reason}\n作り方: ${GUI_BUILD_COMMAND}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
  }
  const pathname = new URL(req.url).pathname;
  const file = params.file;
  if (file === undefined) {
    if (!pathname.endsWith("/")) {
      const search = new URL(req.url).search;
      return new Response(null, { status: 302, headers: { location: `${GUI_PREFIX}/${search}` } });
    }
    return serveGuiFile(dir, "index.html");
  }
  return serveGuiFile(dir, file);
}
