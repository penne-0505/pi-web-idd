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
// intent: DEC-682 — 置き場所と書式は repo の docs 規約に従う。読む側は旧形式も受けるが、書く側には正本の形だけを指示する
export function parseIntent(area: string, slug: string, opts: { root?: string } = {}): {
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
} {
  const seg = areaSegment(area);
  const roots = [...(opts.root ? [opts.root] : []), process.cwd()];

  const read = (rel: string): string | null => {
    for (const root of roots) {
      const p = join(root, rel);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    return null;
  };
  const readIntent = (file: string): string | null => {
    const fromRoot = read(join("_docs", "intent", seg, slug, file));
    if (fromRoot !== null) return fromRoot;
    const p = join(intentRoot(), seg, slug, file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };

  const lines = (src: string | null) => (src ?? "").split("\n");
  const pick = (src: string | null, re: RegExp) =>
    lines(src).flatMap((line) => {
      const m = line.match(re);
      return m ? [{ id: m[1], text: m[2].trim() }] : [];
    });

  const decisionSrc = readIntent("decision.md");
  const decisions = [
    ...pick(decisionSrc, /^###\s+(DEC-[\w.]+):\s*(.+?)\s*$/),
    ...pick(decisionSrc, /^##\s+(DEC-[\w.]+)\s*[—–:-]\s*(.+?)\s*$/),
  ];

  const invariants = [
    ...pick(decisionSrc, /^-\s+(INV-[\w.]+)\s*\(from [^)]+\):\s*(.+?)\s*$/),
    ...pick(readIntent("invariant.md"), HEADING),
  ];

  const qaSrc = read(join("_docs", "qa", seg, slug, "qa.md"));
  const criteria = [
    ...pick(qaSrc, /^-\s+(AC-\d+):\s*(.+?)\s*$/),
    ...pick(readIntent("qa.md"), HEADING),
  ];

  const refSrc = read(join("_docs", "reference", seg, slug, "reference.md")) ?? readIntent("reference.md");
  const references = lines(refSrc).flatMap((line) => {
    const m = line.match(/^-\s*`([^`]+)`\s*[—–:-]?\s*(.*)$/);
    return m ? [{ path: m[1], why: m[2].trim() }] : [];
  });

  return { decisions, criteria, invariants, references };
}

// intent: DEC-673 — intent の置き場所は題名ではなく lane id から作る (docs 規約が ASCII の slug を要求する)
export function slugOf(rec: BacklogRecord): string {
  return rec.idd_id.toLowerCase();
}
