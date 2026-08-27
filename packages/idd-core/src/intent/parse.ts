// intent: DEC-604 — DEC / QA の本文は event ではなく intent file から parse する

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { intentRoot } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";

const HEADING = /^#{2,3}\s*((?:DEC|QA|INV)-[\w.]+)\s*[—–:-]?\s*(.+?)\s*$/;

// intent: DEC-673 — area は repo 名を含みうるが、intent の path 要素は最後の 1 語だけを使う
export function areaSegment(area: string): string {
  return area.split("/").pop() || area;
}

// intent: DEC-681 — 下調べの成果物は lane の worktree にある。読む側も lane の worktree を先に見る
export function parseIntent(area: string, slug: string, opts: { root?: string } = {}): {
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
} {
  const seg = areaSegment(area);
  const candidates = [
    ...(opts.root ? [join(opts.root, "_docs", "intent", seg, slug)] : []),
    join(intentRoot(), seg, slug),
  ];
  const dir = candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
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

// intent: DEC-673 — intent の置き場所は題名ではなく lane id から作る (docs 規約が ASCII の slug を要求する)
export function slugOf(rec: BacklogRecord): string {
  return rec.idd_id.toLowerCase();
}
