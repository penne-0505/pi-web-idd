import { execFileSync } from "node:child_process";

import { getAgentRunner } from "../agent/port.ts";
import { readAreas, publishes } from "../config/areas.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { laneBase } from "./review.ts";
import { AGENT_DRAFT, buildSubmit, commitDraftAt, lanesAwaitingShip, openPrOnRecord, prDraftOf, publicIssueUrl, withIssueLine } from "./ship.ts";
import { prDraftPick } from "./ledger-reads.ts";
import type { ProposeRecord } from "../overlay/export.ts";

export interface PrDraftResult {
  drafted: string[];
  errors: { iddId: string; error: string }[];
}

function changedFiles(worktree: string): string[] {
  try {
    const base = laneBase(worktree) ?? "main";
    return execFileSync("git", ["diff", "--name-status", `${base}...HEAD`], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** what the PR text is written from: the Issue, the decisions, the acceptance criteria, the commits and the files */
export function prMaterial(view: NonNullable<ReturnType<typeof buildSubmit>>, issueUrl: string | null): string {
  const decisions = view.pr.body.filter((b) => !b.issue && !b.text.startsWith("Closes ")).map((b) => b.text);
  return [
    "  <material>",
    `    <title>${view.title}</title>`,
    `    <issue-url>${issueUrl ?? ""}</issue-url>`,
    "    <decisions>",
    ...decisions.map((d) => `      - ${d}`),
    "    </decisions>",
    "    <criteria>",
    ...view.criteria.map((c) => `      - ${c.id}: ${c.text}`),
    "    </criteria>",
    "    <commits>",
    ...view.pr.commits.map((c) => `      - ${c}`),
    "    </commits>",
    "    <changed-files>",
    ...changedFiles(view.worktree).map((f) => `      - ${f}`),
    "    </changed-files>",
    "  </material>",
  ].join("\n");
}

/**
 * Draft the PR title and body once per submit for lanes at the submit card. The card starts from the
 * draft; without one (no runner support, or the draft failed) it keeps the plain list of decisions.
 */
export async function runPrDrafts(): Promise<PrDraftResult> {
  const result: PrDraftResult = { drafted: [], errors: [] };
  const runner = getAgentRunner();
  if (!runner?.draftPrText) return result;
  const events = readLifecycle();
  for (const rec of lanesAwaitingShip()) {
    const evs = events.filter((e) => e.idd_id === rec.idd_id);
    const area = readAreas().areas[rec.area];
    // the fold answers whether this lane's PR text is drafted: a repo that does not publish gets none (a push and a
    // PR are never made for it), a lane whose PR is open gets none (its revision is pushed to the PR as it is, and a
    // body update is a card of its own), and one whose last draft failed after its last submit gets none either. The
    // submit view and the linked repo are read only once the cheaper readings have passed (C-200-2).
    const pick = prDraftPick(
      evs,
      {
        publishes: publishes(area),
        hasDraftRunner: Boolean(runner?.draftPrText),
        hasPrDraft: Boolean(prDraftOf(evs)),
        openPr: Boolean(openPrOnRecord(rec.idd_id, evs)),
      },
      () => ({ hasView: Boolean(buildSubmit(rec.idd_id)), hasRepo: Boolean(area?.linked_repo) }),
    );
    if (!pick) continue;
    // the fold's answer already required these readings: a view and a linked repo are there
    const view = buildSubmit(rec.idd_id) as NonNullable<ReturnType<typeof buildSubmit>>;
    const repo = area!.linked_repo!;
    const issueRec = readBacklog().find((b) => b.idd_id === rec.idd_id) ?? rec;
    const issueUrl = publicIssueUrl(issueRec, area);
    try {
      const draft = await runner.draftPrText({ repo, material: prMaterial(view, issueUrl), lane: rec.idd_id });
      // the Issue line is put on the record in the repo's form: the submit card starts from the recorded body as it is.
      // The agent's own text is recorded as it was written: the card says the line is missing instead
      await appendLifecycle("s4_pr_drafted", rec.idd_id, { title: draft.title, body: draft.model === AGENT_DRAFT ? draft.body : withIssueLine(draft.body, issueRec, area), model: draft.model, ...(draft.conventions?.length ? { conventions: draft.conventions } : {}) });
      result.drafted.push(rec.idd_id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await appendLifecycle("s4_pr_draft_failed", rec.idd_id, { error: error.slice(0, 300) });
      result.errors.push({ iddId: rec.idd_id, error });
    }
  }
  return result;
}

/**
 * What the commit message of a push is written from: the lane's subject and decisions, the lane's commits since
 * what it last pushed, and the files the push changes on the public side. For a lane with an open PR (`existingPr`),
 * the push is the PR's next revision; a PR on record as closed is not named as the one the push goes to.
 */
export function commitMaterial(view: NonNullable<ReturnType<typeof buildSubmit>>, saved: ProposeRecord, pr?: { number: number } | null): string {
  const decisions = view.pr.body.map((b) => b.text).filter((t) => !t.startsWith("Closes "));
  return [
    "  <material>",
    `    <title>${view.title}</title>`,
    `    <target>${pr ? `この push は PR #${pr.number} の次の版になる（PR の題名と本文は変えない）。` : "この push で新しい PR を作る。"}</target>`,
    "    <decisions>",
    ...decisions.map((d) => `      - ${d}`),
    "    </decisions>",
    "    <commits>作業側の履歴。公開側では 1 つの commit にまとまる。",
    ...saved.commits.map((c) => `      - ${c}`),
    "    </commits>",
    "    <changed-files>公開側で変わるファイル",
    ...saved.publish.map((f) => `      - ${f}`),
    "    </changed-files>",
    "  </material>",
  ].join("\n");
}

/**
 * Draft the commit message of the lane's checked push once for its head, for the card to show before penne
 * approves the push. A failure is recorded once for the head; the card then asks penne to write it.
 */
export async function draftCommitMessage(iddId: string, head: string, saved: ProposeRecord): Promise<"drafted" | "failed" | "skipped"> {
  const runner = getAgentRunner();
  if (!runner?.draftCommitMessage) return "skipped";
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const round = evs.slice(Math.max(0, evs.map((e) => e.event).lastIndexOf("s4_submit_started")));
  if (commitDraftAt(round, head)) return "skipped";
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  const repo = rec ? readAreas().areas[rec.area]?.linked_repo : undefined;
  const view = buildSubmit(iddId);
  if (!repo || !view) return "skipped";
  try {
    const draft = await runner.draftCommitMessage({ repo, material: commitMaterial(view, saved, view.existingPr), lane: iddId });
    await appendLifecycle("s4_commit_drafted", iddId, { head, message: draft.message, model: draft.model, ...(draft.conventions?.length ? { conventions: draft.conventions } : {}) });
    return "drafted";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await appendLifecycle("s4_commit_draft_failed", iddId, { head, error: error.slice(0, 300) });
    return "failed";
  }
}
