// intent: DEC-604 — DEC / QA の本文は event ではなく intent file から parse する

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { intentRoot } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";

const HEADING = /^#{2,3}\s*((?:DEC|QA|INV)-[\w.]+)\s*[—–:-]?\s*(.+?)\s*$/;

export function parseIntent(area: string, slug: string): {
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
} {
  const dir = join(intentRoot(), area, slug);
  const pick = (file: string) => {
    const p = join(dir, file);
    if (!existsSync(p)) return [] as { id: string; text: string }[];
    return readFileSync(p, "utf8").split("\n").flatMap((line) => {
      const m = line.match(HEADING);
      return m ? [{ id: m[1], text: m[2] }] : [];
    });
  };
  const refs = (() => {
    const p = join(dir, "reference.md");
    if (!existsSync(p)) return [] as { path: string; why: string }[];
    return readFileSync(p, "utf8").split("\n").flatMap((line) => {
      const m = line.match(/^-\s*`([^`]+)`\s*[—–:-]?\s*(.*)$/);
      return m ? [{ path: m[1], why: m[2] }] : [];
    });
  })();
  return { decisions: pick("decision.md"), criteria: pick("qa.md"), invariants: pick("invariant.md"), references: refs };
}

export function slugOf(rec: BacklogRecord): string {
  return basename(rec.title).toLowerCase().replace(/\s+/g, "-").slice(0, 40);
}
