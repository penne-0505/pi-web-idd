/**
 * The findings a stopped review card lists for penne to decide, read from the engine's answer alone (C-272-1, C-272-3).
 *
 * The engine declares, on the operations that continue or accept, every finding the last judgement accepted with the
 * handlings each may be given and whether the fix then takes it. This module only looks those up: it holds no rule of
 * what the fix takes, so the refs listed before a press and the refs the press sends are one reading of the engine's.
 */
import type { CardOperation, InboxItem, OperationCorrections } from "../engine/contract";

export type DeclaredFinding = OperationCorrections["findings"][number];
export type DeclaredHandling = DeclaredFinding["handlings"][number];
export type FindingAction = DeclaredHandling["action"];

/** what penne picked for each finding, by ref; a finding she did not touch has no entry */
export type StuckPicks = Readonly<Record<string, FindingAction>>;

/** the correction a press sends for one finding */
export interface SentCorrection { ref: string; severity: string; action: FindingAction; reason: string }

/** the findings an operation of the engine's answer declares (none for an operation that does not take them) */
export function declaredFindings(op: CardOperation | undefined): DeclaredFinding[] {
  return op?.input.kind === "text" ? op.input.corrections?.findings ?? [] : [];
}

/** the findings of a stuck card: those its continue operation declares, or its accept's when only that is offered */
export function stuckFindingsOf(item: InboxItem): DeclaredFinding[] {
  const ops = item.decision?.operations ?? [];
  const found = declaredFindings(ops.find((op) => op.id === "continue")).length ? ops.find((op) => op.id === "continue") : ops.find((op) => op.id === "accept");
  return declaredFindings(found);
}

/** the handling penne picked for a finding, when the engine declares it */
export function pickedHandling(finding: DeclaredFinding, picks: StuckPicks): DeclaredHandling | undefined {
  const action = picks[finding.ref];
  return action ? finding.handlings.find((h) => h.action === action) : undefined;
}

/** whether the finding goes to the fix as penne has it now: the handling she picked, else the one it stands at */
export function goesToFix(finding: DeclaredFinding, picks: StuckPicks): boolean {
  return (pickedHandling(finding, picks) ?? finding).inFix;
}

/** the refs a press sends to the fix, in the order the engine listed the findings */
export function sentRefs(findings: readonly DeclaredFinding[], picks: StuckPicks): string[] {
  return findings.filter((f) => goesToFix(f, picks)).map((f) => f.ref);
}

/**
 * The corrections a press sends: one for each finding whose picked handling is not the one it stands at. A must put off
 * carries the card's note as the reason, since that is the weight it is lowered from.
 */
export function correctionsFor(findings: readonly DeclaredFinding[], picks: StuckPicks, note: string): SentCorrection[] {
  return findings.flatMap((f): SentCorrection[] => {
    const h = pickedHandling(f, picks);
    if (!h || h.current) return [];
    const lowered = f.severity === "must" && h.severity !== "must";
    return [{ ref: f.ref, severity: h.severity, action: h.action, reason: lowered ? note.trim() : "" }];
  });
}

/** the picks that still name a handling of a finding the card declares: a read that changed the findings lets the others go */
export function validPicks(findings: readonly DeclaredFinding[], picks: StuckPicks): StuckPicks {
  const out: Record<string, FindingAction> = {};
  for (const f of findings) {
    const action = picks[f.ref];
    if (action && f.handlings.some((h) => h.action === action)) out[f.ref] = action;
  }
  return out;
}
