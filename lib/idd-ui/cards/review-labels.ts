export type ReviewEvent = "comment" | "request-changes" | "approve";

export interface LabelSwap { remove: string[]; add: string[] }

export type ReviewLabelRules = Partial<Record<ReviewEvent, LabelSwap>>;

/** one checkbox on the outbound card: a label the repo's rule takes off or puts on for a kind of review */
export interface LabelChoice { key: string; op: "remove" | "add"; label: string; checked: boolean }

/** the checkboxes for the kind of review penne picked; `off` holds the keys she unchecked (each kind keeps its own) */
export function labelChoices(rules: ReviewLabelRules | undefined, event: ReviewEvent, off: ReadonlySet<string>): LabelChoice[] {
  const rule = rules?.[event];
  if (!rule) return [];
  return [
    ...rule.remove.map((label) => ({ op: "remove" as const, label })),
    ...rule.add.map((label) => ({ op: "add" as const, label })),
  ].map((c) => {
    const key = `${event}:${c.op}:${c.label}`;
    return { ...c, key, checked: !off.has(key) };
  });
}

/** what goes to the server: the checked labels only, so an unchecked one is not swapped */
export function chosenLabels(choices: LabelChoice[]): LabelSwap {
  return {
    remove: choices.filter((c) => c.checked && c.op === "remove").map((c) => c.label),
    add: choices.filter((c) => c.checked && c.op === "add").map((c) => c.label),
  };
}

/** one line for the approval's confirmation, or null when no label changes */
export function labelSummary(swap: LabelSwap): string | null {
  const parts = [
    ...(swap.remove.length ? [`${swap.remove.join("・")} を外す`] : []),
    ...(swap.add.length ? [`${swap.add.join("・")} を付ける`] : []),
  ];
  return parts.length ? `ラベル: ${parts.join("、")}` : null;
}
