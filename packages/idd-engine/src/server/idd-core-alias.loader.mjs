
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// node --test cannot read the tsconfig path aliases that Next uses for the workspace packages
const packages = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const coreEntry = pathToFileURL(join(packages, "idd-core/src/index.ts")).href;
const laneEntry = pathToFileURL(join(packages, "idd-lane/src/index.ts")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@idd/core") return { url: coreEntry, shortCircuit: true };
  if (specifier === "@idd/lane") return { url: laneEntry, shortCircuit: true };
  // a file under the core's source, named the way tsconfig's alias names it (the submit card's rules read two)
  if (specifier.startsWith("@idd/core/")) return { url: pathToFileURL(join(packages, "idd-core/src", specifier.slice("@idd/core/".length))).href, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
