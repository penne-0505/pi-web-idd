import { getAgentRunner } from "../agent/port.ts";
import { readAreas } from "../config/areas.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { prMaterial } from "./pr-draft.ts";
import { prOf } from "./pr-feedback.ts";
import { buildSubmit, publicIssueUrl, withIssueLine } from "./ship.ts";

export type PrBodyProposal = { ok: true; outboundId: string; drafted: boolean } | { ok: false; error: string };

/**
 * A proposed update of the lane's open PR text, on an outbound card that shows it against the PR's text as it is
 * now; nothing is written until penne approves the card. The drafter starts from the PR's current body and the
 * lane's material (decisions, commits, files); without a drafter the card starts from the current text for penne
 * to edit. Any lane with a PR may ask, at any time: after a review round, or when penne wants to. The proposed body
 * keeps the line naming the Issue in the repo's form, whoever wrote the rest: a body update that drops it would stop
 * the merge from closing the Issue.
 */
export async function proposePrBodyUpdate(iddId: string): Promise<PrBodyProposal> {
  const runner = getAgentRunner();
  if (!runner?.queueOutbound || !runner.prText) return { ok: false, error: "この実行環境では PR の本文の案を出せません（サーバーの画面から出してください）" };
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return { ok: false, error: `lane ${iddId} がありません` };
  const pr = prOf(readLifecycle().filter((e) => e.idd_id === iddId));
  if (!pr) return { ok: false, error: "この lane にはまだ PR がありません" };
  try {
    const now = runner.prText(pr.repo, pr.pr);
    const area = readAreas().areas[rec.area];
    let text = now;
    let drafted = false;
    const view = buildSubmit(iddId);
    if (runner.draftPrText && view) {
      const material = [
        prMaterial(view, publicIssueUrl(rec, area)),
        "",
        "## 今の PR の題名",
        now.title,
        "",
        "## 今の PR の本文",
        "この本文を土台にし、材料から変わったと分かるところだけを直す。直す必要のない行は、語も並びも変えずに残す。",
        "",
        now.body,
      ].join("\n");
      const draft = await runner.draftPrText({ repo: pr.repo, material, lane: iddId, revise: true });
      text = { title: draft.title, body: draft.body };
      drafted = true;
    }
    const lined = withIssueLine(text.body, rec, area);
    // a body that already has the line stays as it is, with its own line ends
    if (lined !== text.body.trim()) text = { title: text.title, body: lined };
    const { id } = await runner.queueOutbound({
      kind: "gh-pr-body",
      target: { repo: pr.repo, pr: pr.pr, baseTitle: now.title, baseBody: now.body },
      title: text.title,
      body: text.body,
      source: iddId,
    });
    await appendLifecycle("s4_pr_body_proposed", iddId, { outbound_id: id, pr: pr.pr, drafted });
    return { ok: true, outboundId: id, drafted };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 400) };
  }
}
