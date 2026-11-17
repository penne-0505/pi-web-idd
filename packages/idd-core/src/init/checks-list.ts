import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { nameForCommand, type DetectedCheck } from "./prerequisites.ts";

/** the public-side checks and setup a person has gone over, in the shape the registration writes them */
export interface CheckList {
  checks: DetectedCheck[];
  setup: string[];
}

const LINE_KEYS = ["name", "command", "from"];

const unknownKeys = (obj: Record<string, unknown>, known: string[]): string[] => Object.keys(obj).filter((k) => !known.includes(k));

/** a YAML scalar that survives any command text */
const text = (v: string) => JSON.stringify(v);

/**
 * The list a person goes over before registering: every check with the file its command was read from, and the setup
 * lines. It is YAML so the person can comment, add, drop and edit lines with an editor; the registration writes
 * exactly what the list holds back into config/repos.yaml.
 */
export function renderCheckList(list: CheckList): string {
  return [
    "# idd repo init が repo の CI と入口から読み取った、公開側の検査と setup の一覧です。",
    "# 直して --checks-file で渡すと、この一覧のとおりに config/repos.yaml へ登録されます（足した行も、外した行も、直した command も）。",
    "#   checks: 提出の前に必ず通す検査。command が要ります。name は省くと command から付き、from は読んだ file（足した行は省けます）です。",
    "#   setup:  検査の複製で、検査の前に回す準備の command（install など）です。",
    "# 検査でない command は行ごと外し、漏れた検査は行を足してください。",
    // an empty list stays a block (not `[]`), so a line can be added under it
    "checks:",
    ...(list.checks.length ? [] : ["  # - name: test", "  #   command: npm test", "  #   from: .github/workflows/ci.yml"]),
    ...list.checks.flatMap((c) => [`  - name: ${text(c.name)}`, `    command: ${text(c.command)}`, `    from: ${text(c.from)}`]),
    "setup:",
    ...(list.setup.length ? [] : ["  # - npm ci"]),
    ...list.setup.map((c) => `  - ${text(c)}`),
    "",
  ].join("\n");
}

/**
 * Read a list back. An unreadable one (no such file, not YAML, a line without a command, a field the registration does
 * not take) comes back as the reason, so the registration can stop before it writes anything.
 */
export function readCheckList(path: string): { list: CheckList } | { error: string } {
  const fail = (why: string) => ({ error: `検査と setup の一覧 ${path} を読めません: ${why}` });
  if (!existsSync(path)) return fail("file がありません");
  let data: unknown;
  try {
    data = yamlLoad(readFileSync(path, "utf8"));
  } catch (err) {
    return fail(`YAML として読めません（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("checks と setup を持つ形ではありません");
  const top = data as Record<string, unknown>;
  const unknownTop = unknownKeys(top, ["checks", "setup"]);
  if (unknownTop.length) return fail(`知らない欄があります: ${unknownTop.join(", ")}（checks と setup だけです）`);
  const rawChecks = top.checks ?? [];
  const rawSetup = top.setup ?? [];
  if (!Array.isArray(rawChecks)) return fail("checks は行の並びで書いてください");
  if (!Array.isArray(rawSetup)) return fail("setup は command の並びで書いてください");
  const checks: DetectedCheck[] = [];
  for (const [i, raw] of rawChecks.entries()) {
    const at = `checks の ${i + 1} 行目`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(`${at}が name・command・from を持つ形ではありません`);
    const line = raw as Record<string, unknown>;
    const extra = unknownKeys(line, LINE_KEYS);
    if (extra.length) return fail(`${at}に知らない欄があります: ${extra.join(", ")}（name・command・from だけです）`);
    if (typeof line.command !== "string" || !line.command.trim()) return fail(`${at}に command がありません`);
    for (const k of ["name", "from"]) if (line[k] !== undefined && (typeof line[k] !== "string" || !(line[k] as string).trim())) return fail(`${at}の ${k} は文字で書いてください`);
    const command = line.command.trim();
    checks.push({
      name: typeof line.name === "string" ? line.name.trim() : nameForCommand(command),
      command,
      from: typeof line.from === "string" ? line.from.trim() : `${basename(path)} で足した行`,
    });
  }
  const names = checks.map((c) => c.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) return fail(`name が重なっています: ${[...new Set(twice)].join(", ")}（検査の名前は 1 つずつです）`);
  const setup: string[] = [];
  for (const [i, raw] of rawSetup.entries()) {
    if (typeof raw !== "string" || !raw.trim()) return fail(`setup の ${i + 1} 行目が command の文字ではありません`);
    setup.push(raw.trim());
  }
  return { list: { checks, setup } };
}
