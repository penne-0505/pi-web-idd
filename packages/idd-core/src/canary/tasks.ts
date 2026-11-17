import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkoutRoot } from "../config/files.ts";

/**
 * The questions the canary asks every day. The same questions run against the same repo fixtures, every day, so a
 * week's values are read against the week before's. They are not scored: the structure check only asks whether the
 * answer has the shape the question asked for, so a model that answers differently is still measured by the same
 * numbers.
 *
 * The questions carry no tools and no fixture path: the fixture's text is put in the prompt, so a model cannot read
 * a different version of the repo than the one the record was taken from.
 */

export type CanaryTaskKind = "read" | "json" | "diff";

export interface CanaryTask {
  id: string;
  kind: CanaryTaskKind;
  /** the fixture the question is asked about, repo-relative */
  fixture: string;
  /** what to ask, written once: a changed question would break the comparison with the weeks before */
  instruction: string;
}

const TASKS: readonly CanaryTask[] = Object.freeze([
  {
    id: "read-exports",
    kind: "read",
    fixture: "packages/idd-core/src/canary/fixtures/sample-module.ts",
    instruction: "この code が公開している関数をすべて挙げ、それぞれが何をするかを 1 行ずつ説明してください。",
  },
  {
    id: "summarize",
    kind: "read",
    fixture: "packages/idd-core/src/canary/fixtures/sample-module.ts",
    instruction: "この code を、この code を読んでいない人に 3 行以内で要約してください。",
  },
  {
    id: "json-items",
    kind: "json",
    fixture: "packages/idd-core/src/canary/fixtures/sample-data.md",
    instruction: [
      "材料の表から、JSON を 1 つだけ出力してください。",
      '鍵は "title"（見出しの文字列）、"items"（{"name": 品目, "count": 数} の配列）、"total"（数の合計）です。',
      "前置きもコードフェンスも書かず、JSON だけを出力してください。",
    ].join("\n"),
  },
  {
    id: "diff-fix",
    kind: "diff",
    fixture: "packages/idd-core/src/canary/fixtures/buggy.ts",
    instruction: "この code の不具合を直してください。直した結果を unified diff だけで出力し、前置きは書かないでください。",
  },
]);

/** the questions of a run, in the order they are asked */
export function canaryTasks(): readonly CanaryTask[] {
  return TASKS;
}

/** the fixture's text, at the checkout the running code sits in; "" when it cannot be read */
export function fixtureText(fixture: string): string {
  const path = join(checkoutRoot(), fixture);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** the one prompt a task is asked with: the instruction, then the fixture's text as material */
export function canaryPrompt(task: CanaryTask, fixture = fixtureText(task.fixture)): string {
  return [
    "次の材料を読み、指示に答えてください。",
    "道具はありません。材料に書かれた事実だけを使います。",
    "",
    task.instruction,
    "",
    `--- 材料（${task.fixture}）---`,
    fixture,
  ].join("\n");
}

/** what the structure check found: the answer's shape, never whether the answer is right */
export interface CanaryStructure {
  verdict: "ok" | "fail";
  /** why the shape failed, in a line */
  detail?: string;
}

/** the answer without a fence or a wrapper, so a model that wraps its JSON is not read as a failure */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function structureOfRead(text: string): CanaryStructure {
  const lines = text.trim().split("\n").filter((line) => line.trim().length > 0);
  if (text.trim().length < 20 || lines.length === 0) return { verdict: "fail", detail: "答えが空か、短すぎます" };
  return { verdict: "ok" };
}

function structureOfJson(text: string): CanaryStructure {
  const body = unfence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { verdict: "fail", detail: "JSON として読めません" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { verdict: "fail", detail: "JSON が object ではありません" };
  const obj = parsed as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.title !== "string") missing.push("title");
  if (!Array.isArray(obj.items)) missing.push("items");
  else {
    const badItem = (obj.items as unknown[]).some((item) => {
      if (!item || typeof item !== "object") return true;
      const o = item as Record<string, unknown>;
      return typeof o.name !== "string" || typeof o.count !== "number";
    });
    if (badItem) missing.push("items[].name/items[].count");
  }
  if (typeof obj.total !== "number") missing.push("total");
  return missing.length ? { verdict: "fail", detail: `鍵が欠けています: ${missing.join(", ")}` } : { verdict: "ok" };
}

function structureOfDiff(text: string): CanaryStructure {
  const body = unfence(text);
  const lines = body.split("\n");
  const missing: string[] = [];
  if (!lines.some((line) => line.startsWith("@@"))) missing.push("hunk (@@)");
  if (!lines.some((line) => line.startsWith("-") && !line.startsWith("---"))) missing.push("消した行 (-)");
  if (!lines.some((line) => line.startsWith("+") && !line.startsWith("+++"))) missing.push("足した行 (+)");
  return missing.length ? { verdict: "fail", detail: `diff の形になっていません: ${missing.join(", ")}` } : { verdict: "ok" };
}

/** the shape of an answer for one task; a model that could not answer has no shape to judge (the record says so) */
export function structureOf(task: CanaryTask, text: string): CanaryStructure {
  switch (task.kind) {
    case "json":
      return structureOfJson(text);
    case "diff":
      return structureOfDiff(text);
    default:
      return structureOfRead(text);
  }
}
