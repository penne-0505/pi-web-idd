// intent: DEC-666 — buildState / buildLaneDetail を node --test から import するため、tsconfig paths だけの "@idd/core" alias 解決をこの hook に閉じ込める

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const coreEntry = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../../../packages/idd-core/src/index.ts"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@idd/core") return { url: coreEntry, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
