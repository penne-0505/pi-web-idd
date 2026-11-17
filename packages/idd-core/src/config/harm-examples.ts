import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readAreas, type HarmExamples } from "./areas.ts";
import { stateDir } from "../paths.ts";

/**
 * A repo declares what harm looks like there and which conditions are always a must, beside its dangerous paths.
 * The examples are concrete ("利用者のデータや文面が黙って欠ける") because the grade table in the engine's rules is
 * written in general terms; only the repo can say what "engine が止まる" weighs there. The engine's judgement text
 * carries no repo-specific example, so one repo's bar does not reach another's judgement.
 *
 * The reader returns the declaration and the approved examples the state holds. Approving an example is a separate
 * lane (IDD-112); until then only the declaration is read, and the engine never writes back to the file.
 */
export interface HarmExample {
  harm: number;
  example: string;
}

export interface HarmExamplesRead extends HarmExamples {
  /** where the reading came from: the repo's declaration, the approved state, or both */
  from: "declaration" | "state" | "both" | "none";
}

/** the grades an example may carry: 1 (inconvenience) through 3 (irreversible, payment, auth) */
export const HARM_EXAMPLE_MAX = 3;

const isGrade = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= HARM_EXAMPLE_MAX;

/**
 * config/repos.yaml's `harm_examples` and `always_must`: the repo's own examples of what harm is and which
 * conditions are always a must. An unknown grade, a missing example, an entry that is not a table, and a
 * non-string always_must line are config errors (a misspelt grade would otherwise silently grade nothing).
 * An empty list and a missing field both come back as undefined, which is "no declaration".
 */
export function parseHarmExamples(where: string, raw: unknown, rawAlways?: unknown): HarmExamples | undefined {
  const out: HarmExamples = { examples: [], alwaysMust: [] };
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw new Error(`${where}.harm_examples: { harm: 1〜3, example: "..." } の一覧で書いてください`);
    for (const [i, item] of raw.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${where}.harm_examples[${i}]: { harm: 1〜3, example: "..." } の表で書いてください`);
      const o = item as Record<string, unknown>;
      if (!isGrade(o.harm)) throw new Error(`${where}.harm_examples[${i}].harm: 1〜3 の整数で書いてください（${String(o.harm)}）`);
      if (typeof o.example !== "string" || !o.example.trim()) throw new Error(`${where}.harm_examples[${i}].example: 例を 1 文で書いてください`);
      out.examples.push({ harm: o.harm, example: o.example.trim().replace(/\s+/g, " ") });
    }
  }
  if (rawAlways !== undefined && rawAlways !== null) {
    if (!Array.isArray(rawAlways) || rawAlways.some((x) => typeof x !== "string" || !x.trim())) {
      throw new Error(`${where}.always_must: 頻度に関わらず must にする条件の文の一覧で書いてください`);
    }
    out.alwaysMust = (rawAlways as string[]).map((x) => x.trim().replace(/\s+/g, " "));
  }
  return out.examples.length || out.alwaysMust.length ? out : undefined;
}

/**
 * The harm examples a judgement or the kept check is handed: the repo's declaration, and the approved examples the
 * state holds (none until IDD-112). A repo with no declaration returns an empty reading, not an error.
 */
export function readHarmExamples(area: string): HarmExamplesRead {
  const declared = readAreas().harmExamples?.[area];
  if (!declared) return { examples: [], alwaysMust: [], from: "none" };
  return { examples: declared.examples, alwaysMust: declared.alwaysMust, from: "declaration" };
}

/** the lines a role's brief carries, or an empty list when the repo declared nothing */
export function harmExampleLines(area: string): string[] {
  const read = readHarmExamples(area);
  if (read.from === "none") return [];
  const lines: string[] = [];
  for (const e of read.examples) lines.push(`- 害 ${e.harm}: ${e.example}`);
  for (const m of read.alwaysMust) lines.push(`- 頻度に関わらず must: ${m}`);
  return lines;
}

/**
 * Write the repo's harm examples where a stage reads them, or undefined when there is nothing to hand over.
 * Written under the state's pipeline directory, never into the repo's declaration.
 */
export function writeHarmExamplesFile(area: string, name: string): string | undefined {
  const read = readHarmExamples(area);
  if (read.from === "none") return undefined;
  const file = join(stateDir(), "pipeline", "harm-examples", `${area.replace(/[^\w.-]+/g, "_")}-${name}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    `# ${area} の害の例`,
    "",
    "この repo で何が害で、どの等級かの具体例である。等級の一般の定義（engine の文面）に当てて重さを決める。",
    "",
    ...harmExampleLines(area),
    "",
  ].join("\n"));
  return file;
}

/** whether the repo declared any harm example (the caller may skip the extra input) */
export function hasHarmExamples(area: string): boolean {
  return !!readAreas().harmExamples?.[area];
}
