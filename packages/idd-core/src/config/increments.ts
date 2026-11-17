/**
 * A repo's increment checks (config/repos.yaml `increments`): a count of problems the repo's mainline has, measured
 * the same way in the mainline tip and in the merge commit a landing would make, so a landing that adds one is
 * stopped. The declaration names the command and how its output is read as a number; the measurement and the
 * comparison live in the overlay (`overlay/increment.ts`), which is the only place that runs it.
 *
 * The declaration is kept beside the areas (like `risk_paths`) so a repo that writes one does not change any repo's
 * settings hash, and so a repo that writes nothing keeps exactly the checks it had.
 */

import { declaredList, declaredMinutes } from "./declared-list.ts";

/** how a command's output is read as one number */
export type IncrementCount = "eslint-json" | "number";

export interface AreaIncrement {
  /** the name the landing card shows for the row */
  name: string;
  command: string[];
  /** `eslint-json`: `-f json` output, the warnings summed; `number`: the last line of the output */
  count: IncrementCount;
  /** a required increment stops a landing that increased the count */
  required: boolean;
  /** the limit of one run of the command (minutes) */
  timeoutMinutes: number;
}

/** how long one increment command may run, when the declaration names no limit: this repo's eslint takes ~94 s */
export const DEFAULT_INCREMENT_MINUTES = 15;

const COUNTS: readonly IncrementCount[] = ["eslint-json", "number"];
const FIELDS = ["name", "command", "count", "required", "timeout_minutes"];

/**
 * The `increments` list of one repo. An unknown field, a missing name or command, an unknown count, a value that is
 * neither true nor false, and a limit that is not a positive number are config errors, not silent defaults: a
 * declaration that is read as something else stops the wrong landings (or none at all).
 */
export function parseIncrements(where: string, raw: unknown): AreaIncrement[] | undefined {
  const seen = new Set<string>();
  return declaredList(where, raw, FIELDS, (o, i): AreaIncrement => {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) throw new Error(`${where}[${i}].name: 名前を書いてください`);
    if (seen.has(name)) throw new Error(`${where}: 名前 ${name} が 2 回書かれています`);
    seen.add(name);
    const command = typeof o.command === "string" ? ["bash", "-c", o.command] : Array.isArray(o.command) ? o.command.map(String) : [];
    if (!command.length) throw new Error(`${where}[${i}].command: 検査のコマンドを書いてください`);
    const count = o.count === undefined ? "eslint-json" : o.count;
    if (typeof count !== "string" || !COUNTS.includes(count as IncrementCount)) {
      throw new Error(`${where}[${i}].count: ${COUNTS.join(" / ")} のどれかで書いてください`);
    }
    if (o.required !== undefined && o.required !== null && typeof o.required !== "boolean") {
      throw new Error(`${where}[${i}].required: true か false で書いてください`);
    }
    return { name, command, count: count as IncrementCount, required: o.required !== false, timeoutMinutes: declaredMinutes(where, i, o, DEFAULT_INCREMENT_MINUTES) };
  });
}

/**
 * The checks a landing reads from an increment's run instead of running them (config/repos.yaml
 * `checks[].land_from_increment: <increment name>`): the increment's command answers the check's pass / fail too, so
 * one run of the same copy serves both rows. The field sits on the check, which every reader of a check list ignores
 * when it does not know it, so an older engine that reads this config still reads the declaration. A name that is not
 * a declared increment, and a records check, are config errors: the check would silently run nowhere.
 */
export function parseIncrementShares(where: string, rawChecks: unknown, increments: AreaIncrement[] | undefined): Record<string, string> | undefined {
  if (!Array.isArray(rawChecks)) return undefined;
  const out: Record<string, string> = {};
  for (const item of rawChecks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const c = item as Record<string, unknown>;
    if (c.land_from_increment === undefined || c.land_from_increment === null) continue;
    const name = String(c.name);
    const from = typeof c.land_from_increment === "string" ? c.land_from_increment.trim() : "";
    if (!from) throw new Error(`${where}.${name}.land_from_increment: 増分の名前を書いてください`);
    if (!increments?.some((i) => i.name === from)) throw new Error(`${where}.${name}.land_from_increment: ${from} は increments に宣言されていません`);
    if (c.scope === "records") throw new Error(`${where}.${name}.land_from_increment: 記録の検査には書けません`);
    out[name] = from;
  }
  return Object.keys(out).length ? out : undefined;
}
