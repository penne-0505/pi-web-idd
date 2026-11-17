import { readFileSync } from "node:fs";

import { parseStructure } from "../config/structure.ts";
import { scanTreeDetailed } from "./structure.ts";

/**
 * The command a repo's structure declaration names (`config/structure.yaml` `command`): it counts the tree in
 * `IDD_STRUCTURE_ROOT` by the declaration in `IDD_STRUCTURE_DECL` and prints the counts as one JSON object on its last
 * line. A landing runs it from the mainline tip's copy against both trees, so both are counted by the same rules.
 *
 * With `IDD_STRUCTURE_FILES` set, the lines before the counts list each file's share of `duplicate-tokens`
 * (`<positions>\t<path>`, most first, summing to the count), so an executor whose change raised the count sees which
 * files to look at. A landing does not set it: the counts stay the one line it reads.
 */
const root = process.env.IDD_STRUCTURE_ROOT?.trim();
const declPath = process.env.IDD_STRUCTURE_DECL?.trim();
if (!root || !declPath) {
  process.stderr.write("IDD_STRUCTURE_ROOT と IDD_STRUCTURE_DECL を指定してください\n");
  process.exit(2);
}
const decl = parseStructure(readFileSync(declPath, "utf8"), declPath);
const scan = scanTreeDetailed(root, decl);
if (process.env.IDD_STRUCTURE_FILES?.trim()) {
  for (const f of scan.duplicateFiles) process.stdout.write(`${f.positions}\t${f.path}\n`);
}
process.stdout.write(`${JSON.stringify(scan.counts)}\n`);
