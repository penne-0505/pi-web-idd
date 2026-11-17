
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readAreas, publishes } from "../config/areas.ts";
import type { AreaConfig } from "../config/areas.ts";
import { branchNameCheck, linearIdentifierOf } from "../config/lane-names.ts";
import { branchLine, conventionLines, mergedTitleLine } from "./convention-rows.ts";
import { approvedCommitMessage, commitConventionCheck, commitMessageProblem, internalTerms, publicVocabularyAllow } from "./vocab.ts";
import type { CommitConvention } from "./vocab.ts";
import { areaSegment, slugOf } from "../intent/parse.ts";
import { laneIntent } from "./lane-intent.ts";
import type { LaneIntent } from "./lane-intent.ts";
import { deriveStage, laneOverBudget, laneStall } from "../ledger/derive.ts";
import { closedByPenne, MERGE_ONLY_SKIP_EVENT, routesOf, shouldFixCounts, submitLeftovers } from "../ledger/review-loop.ts";
import type { ShouldFixCounts } from "../ledger/review-loop.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle, transition } from "../ledger/write.ts";
import { proposeAdmitted, readProposal, proposalPath, validateProposal, exportUnderWorkLock, laneLocations, custodyPath, outdatedReason, settleUnsavedPush, carriesAlready, PermanentSubmitError, goneUnknownReason, pushTargetTip, shipContentFor } from "../overlay/export.ts";
import type { Custody, GoneBranch, LaneLocation, ProposeRecord, ProposeView, PushApproved } from "../overlay/export.ts";
import { approvalGateOpen, consumeNonce, localCompleteContent, SignatureRefusedError, verifyApproval } from "../passkey.ts";
import { save, lock, read, remoteTip, isLockRefusal } from "../overlay/git.ts";
import { reclaimLane } from "../overlay/reclaim.ts";
import { failingAtBaseOnRecord } from "../overlay/check-base.ts";
import { approveLand, currentLandApproval, landForecastFor, lastLandHold, mainlineTip, prepareLand, readLand, landBlocker, readLandForecast, recordsOnlyRefusal } from "../overlay/land.ts";
import type { LandChecking, LandForecast, LandRecord } from "../overlay/land.ts";
import { landRunChecking } from "../overlay/land-run.ts";
import { prOf } from "./pr-feedback.ts";
import { unreviewedChange } from "./reviewed-head.ts";
import { laneBase } from "./review.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { acStatesForLane, allCriteriaVerified, readWorkRows, workColumnPath } from "./work-records.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export interface SubmitView {
  iddId: string;
  title: string;
  branch: { from: string; to: string; repo: string };
  /** issue: the line that names the lane's Issue (not one of the decisions) */
  pr: { title: string; body: { text: string; flagged?: { original: string }; issue?: boolean }[]; commits: string[]; vocabAllow: string[]; draftBody?: string };
  /** the acceptance criteria the submit card checks against, told to the PR draft's material */
  criteria: { id: string; text: string }[];
  /**
   * the card's acceptance lines. `reason`: why the line reads as it does, when it has more to say than its label;
   * `key`: a line that is judged again on the screen as the message is edited (the commit message's form)
   */
  checks: { label: string; ok: boolean; reason?: string; key?: "commit-convention" }[];
  /**
   * the repo's declared form of its commit message with the recent public commits, for a repo that declares one: the
   * screen judges the message penne edits by the same function the line here was made with
   */
  commitConvention?: { convention: CommitConvention; precedents: string[] };
  worktree: string;
  proposal: ProposeView | null;
  /** what the S2 loop and S3 found, for lanes that went through the loop */
  review?: SubmitReview;
  /** the submit went out on penne's approval; a lane without an open PR waits for penne to approve the PR itself */
  pushed?: { branch: string; commit: string };
  /** why the tick did not get the current head ready for the card: penne checks it again from the card. With `pushed`: what stopped the tick after the push (the PR it could not settle) */
  pushHeld?: string;
  /**
   * the lane's PR while nothing on record says it is no longer open (`openPrOnRecord`): a push goes to it, and its
   * title and body are not changed. Without it the push goes out with a new PR, approved on the same card
   */
  existingPr?: { url: string; number: number };
  /** the lane's head as the card was built: a check made at another head cannot be approved */
  head?: string;
  /** pushed to the lane's PR, whose check after the push failed for a passing cause: the tick asks again (DEC-789) */
  prCheckFailed?: string;
  /**
   * the pushed submit no longer matches the lane's Git destination or settings: its token can make no PR, and the
   * card checks it again (under the settings as they are now) instead of waiting on it
   */
  recheck?: string;
  /**
   * the commit message of the lane's head, which penne approves (or rewrites) on the card before the push. `draft`: the
   * drafted one. `pending`: nothing is drafted for this head yet, so the card has no message to show (a PR's title is
   * not one). `failed`: the draft failed (it is not made again for the head). `start`: the message the card starts
   * from when it has no draft to start from: the form the repo's own `commit_message` pattern made, or, after a failed
   * draft, the record's message (the PR's title when the repo has no pattern), so the lane is not left with nothing
   */
  commit?: { draft?: string; model?: string; failed?: string; pending?: true; start?: string };
  /** checked while the lane's public branch was gone: its last PR (merged, or closed unmerged), and it goes out as a new branch with a new PR */
  branchGone?: { merged: boolean; pr?: number };
  /**
   * the lane belongs to a repo that does not publish (`publish: false`): instead of a push and a PR the card shows
   * the landing into the work side's mainline, with the checked merge commit and the checks. Null while the land
   * cannot be made (a dirty checkout, an open branch) — the reason is then on the card
   */
  land?: LandRecord | null;
  /** why the land cannot be made (the card says it next to the landing) */
  landBlocked?: string;
  /**
   * the lane adds nothing to the mainline's public side (its difference from the mainline is the manifest's records
   * alone): the landing refuses its approval, and the card says so and offers no signature. `reason` is the refusal
   */
  recordsOnly?: { reason: string };
  /**
   * a landing check of this lane is running in a run of its own: nothing is checked yet, so the card asks for no
   * approval and offers no re-check, and it says so instead (C-144-8)
   */
  landChecking?: string;
  /**
   * the saved conflict forecast for this lane's landing card: the mainline as it was checked, and the cards that
   * would conflict if they landed first. Absent when nothing was taken, when the saved one is stale, or when the
   * repo holds one card. A hint for the order of approvals only; it changes no check.
   */
  conflictForecast?: LandForecast;
  /**
   * penne approved the landing and the merge has not gone in yet (the mainline moved, the checkout is not clean, the
   * lock was held): the card says so and does not ask for the same approval again. `hold` is why the tick is waiting
   */
  landPending?: { hold?: string };
}

export interface SubmitReview {
  fixRounds: number;
  /** "loop": converged on its own / "penne": penne went on without a fix (as is, or continuing without one) / "skipped": no review slot */
  closedBy: "loop" | "penne" | "skipped";
  /**
   * accepted but not fixed: the last judgement's, and those of the judgements penne answered in the same pass
   * (read from what the fix right after each carried), with the questions no fix answered
   */
  leftovers: { severity: string; /** the weight the judgement gave, when penne set another */ judgedSeverity?: string; claim: string; path?: string; action?: string; /** the harm the judgement gave for a recommended fix */ fixBasis?: string }[];
  rejected: { claim: string; reason?: string }[];
  /**
   * the follow-ups the judgements sent to a follow-up: the ones written into the lane's TODO (with the task), and
   * the ones that could not be written (with the reason), so the card can show both
   */
  followups: { severity: string; judgedSeverity?: string; claim: string; path?: string; task?: string; failed?: string }[];
  device?: {
    skipped?: string; blocking?: number; reportMd?: string; failed?: string;
    /** the judge the lane declared (人 / 絵を見る役): a person's findings stay on the card, never sent to a fix */
    judge?: string;
    /** the picture-viewing role's findings, kept on the record for the submit card when the judge is a person */
    findings?: { severity: string; claim: string; path?: string }[];
    /** the pictures in compare/ could not be said to be of the head's screen */
    stale?: string;
    /** how many pictures the stage handed the role */
    pictures?: number;
  };
  /** the accepted shoulds of the last pass's judgements and the ones the judgements recommended fixing (DEC-10081/10082) */
  shouldFix?: ShouldFixCounts;
  /**
   * the errors the records check left after the last send-back: the lane was told about them and could not fix
   * them, so the card shows them where the human decides (the land check stops the landing with them as well)
   */
  recordsErrors?: { rule: string; id: string; reason: string }[];
  /**
   * the routes of the round's map: how many routes the map brought (route_count), whether that passed the cap, and
   * each route's files, question and harm kinds, so a person can read why the map cut the diff that way (C-152-6).
   */
  routes?: { count: number; overCap: boolean; items: { paths: string[]; question: string; harms: string[] }[] };
  conflicts: string[];
}

function lastOf(events: { event: string; attrs?: Record<string, unknown> }[], name: string) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return events[i];
  return undefined;
}

/** the index of the last of the named records, or -1 when none of them is there */
function lastIndexOfAny(events: { event: string }[], names: readonly string[]): number {
  let at = -1;
  for (let i = 0; i < events.length; i += 1) if (names.includes(events[i].event) && i > at) at = i;
  return at;
}

export function buildSubmitReview(events: { event: string; attrs?: Record<string, unknown> }[]): SubmitReview | undefined {
  const names = events.map((e) => e.event);
  if (!names.some((n) => n.startsWith("s2_review_") || n === "s2_triage_done")) return undefined;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const triage = lastOf(events, "s2_triage_done");
  const closedBy = closedByPenne(events as LifecycleRecord[]) ? "penne" : names.includes("s2_review_started") ? "loop" : "skipped";
  // the picture comparison of the head the lane submits: the last of its records. A result that belongs to an earlier
  // round is not shown as this head's: a round that read nothing (the head was only the mainline merged in) has no
  // comparison of its own, and the card says the comparison was left out instead. A skip says the comparison was
  // left out and why, so the head's own skip is the one the card shows.
  const deviceAt = lastIndexOfAny(events, ["s2_device_done", "s2_device_skipped"]);
  const deviceStartedAt = lastIndexOfAny(events, ["s2_device_started"]);
  const roundEndAt = lastIndexOfAny(events, ["s2_review_converged", "s2_review_skipped", MERGE_ONLY_SKIP_EVENT]);
  const mergeSkipAt = lastIndexOfAny(events, [MERGE_ONLY_SKIP_EVENT]);
  const deviceEvent = deviceAt >= 0 ? events[deviceAt] : undefined;
  const device = deviceEvent?.event === "s2_device_done" && deviceAt > roundEndAt ? deviceEvent : undefined;
  const deviceSkip = deviceEvent?.event === "s2_device_skipped" ? deviceEvent : undefined;
  // the comparison of this head is running: its result is not on the record yet, so the card says nothing about it
  const deviceRunning = deviceStartedAt > roundEndAt && deviceStartedAt > deviceAt;
  // the errors the records check left after the last send-back: the lane was told about them and could not fix them,
  // so the card shows them where the human decides (the land check stops the landing with them as well)
  const intentChecked = lastOf(events, "s2_intent_checked");
  const recordsErrors = intentChecked && Array.isArray(intentChecked.attrs?.remaining)
    ? arr<{ rule: string; id: string; reason: string }>(intentChecked.attrs.remaining)
    : [];
  // the last routed round: its map's routes, the count it brought, and whether that passed the cap
  const routedBack = events.slice().reverse().findIndex((e) => e.event === "s2_review_started" && e.attrs?.mapped_routes);
  const routedIdx = routedBack >= 0 ? events.length - 1 - routedBack : -1;
  const routedStart = routedIdx >= 0 ? events[routedIdx] : undefined;
  let mapDone: (typeof events)[number] | undefined;
  if (routedIdx >= 0) for (let i = routedIdx - 1; i >= 0; i -= 1) if (events[i].event === "s2_map_done") { mapDone = events[i]; break; }
  const routeItems = mapDone ? routesOf(mapDone.attrs?.routes) : [];
  const conflict = names.lastIndexOf("s3_check_conflict") > names.lastIndexOf("s3_check_clean") ? lastOf(events, "s3_check_conflict") : undefined;
  // what was written to the TODO, and what could not be: the card shows both, so a follow-up never disappears.
  // A failure of an earlier pass stands until the item is written, whatever a later pass did or did not do
  type FollowupEntry = { severity: string; judgedSeverity?: string; claim: string; path?: string; task?: string; failed?: string };
  const writtenFollowups = events.filter((e) => e.event === "s3_followups_written").flatMap((e) => arr<FollowupEntry>(e.attrs?.entries));
  const writtenKeys = new Set(writtenFollowups.map((f) => `${f.path ?? ""}|${f.claim}`));
  const failedByKey = new Map<string, FollowupEntry>();
  for (const e of events) {
    if (e.event !== "s3_followups_not_written") continue;
    for (const f of arr<FollowupEntry>(e.attrs?.entries)) {
      const k = `${f.path ?? ""}|${f.claim}`;
      if (!writtenKeys.has(k)) failedByKey.set(k, f);
    }
  }
  return {
    followups: [...writtenFollowups, ...failedByKey.values()], 
    fixRounds: names.filter((n) => n === "s2_fix_sent").length,
    closedBy,
    leftovers: submitLeftovers(events as LifecycleRecord[]),
    shouldFix: shouldFixCounts(events as LifecycleRecord[]),
    rejected: arr<{ claim: string; reason?: string }>(triage?.attrs?.rejected).map((r) => ({ claim: r.claim, ...(r.reason ? { reason: r.reason } : {}) })),
    ...(deviceRunning ? {}
      : device ? { device: device.attrs?.failed ? { failed: String(device.attrs?.error ?? "") } : {
          blocking: Number(device.attrs?.blocking ?? 0),
          ...(device.attrs?.judge ? { judge: String(device.attrs.judge) } : {}),
          ...(device.attrs?.stale_reason ? { stale: String(device.attrs.stale_reason) } : {}),
          ...(Array.isArray(device.attrs?.findings) ? { findings: arr<{ severity: string; claim: string; path?: string }>(device.attrs.findings) } : {}),
          ...(typeof device.attrs?.pictures === "number" ? { pictures: Number(device.attrs.pictures) } : {}),
          ...(device.attrs?.skipped_reason ? { skipped: String(device.attrs.skipped_reason) } : {}), ...(device.attrs?.report_md ? { reportMd: String(device.attrs.report_md) } : {}),
        } }
      : deviceSkip ? { device: { skipped: String(deviceSkip.attrs?.reason ?? "") } }
      : mergeSkipAt >= 0 && mergeSkipAt === roundEndAt ? { device: { skipped: "この head では絵の見比べを回していない" } } : {}),
    ...(recordsErrors.length ? { recordsErrors } : {}),
    ...(routedStart ? { routes: {
      count: Number(routedStart.attrs?.route_count ?? routeItems.length) || routeItems.length,
      overCap: routedStart.attrs?.routes_over_cap === true,
      items: routeItems.map((r) => ({ paths: r.paths, question: r.question, harms: r.harms })),
    } } : {}),
    conflicts: arr<string>(conflict?.attrs?.conflict_files),
  };
}


export function lanesAwaitingShip(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  return readBacklog().filter((rec) => deriveStage(byLane.get(rec.idd_id) ?? []).decision === "ship");
}

/** the `model` a PR draft carries when it is the lane's agent's own text (`heldPrText`): the Issue line is not put on it */
export const AGENT_DRAFT = "agent";

/** the PR text drafted for the current submit, if the draft came back; `agent`: it is the text the lane's agent handed over, as it was */
export function prDraftOf(events: { event: string; attrs?: Record<string, unknown> }[]): { title: string; body: string; agent?: true } | null {
  const names = events.map((e) => e.event);
  const at = names.lastIndexOf("s4_pr_drafted");
  if (at < 0 || at < names.lastIndexOf("s4_submit_started")) return null;
  const a = events[at].attrs ?? {};
  return typeof a.title === "string" && a.title ? { title: a.title, body: String(a.body ?? ""), ...(a.model === AGENT_DRAFT ? { agent: true as const } : {}) } : null;
}

/**
 * The lane's PR while nothing on record says it is no longer open: not merged, not found closed after a push
 * (`no_open_pr`), its branch not found gone after a push, nor by the lane's last check (the submit's `branchGone`).
 * Read from the records only, not from GitHub: a PR closed on GitHub that nothing here has seen yet counts as open,
 * and the push to it finds it closed. A new PR made after it counts from its own creation.
 */
export function openPrOnRecord(iddId: string, evs: LifecycleRecord[]): { repo: string; pr: number; url: string } | null {
  const pr = prOf(evs);
  if (!pr) return null;
  const at = evs.map((e) => e.event).lastIndexOf("s4_pr_created");
  const closed = evs.slice(at + 1).some((e) => e.event === "s4_merged"
    || (e.event === "s4_push_held" && e.attrs?.no_open_pr)
    || (e.event === "s4_ship_failed" && e.attrs?.branch_gone));
  if (closed) return null;
  const saved = readProposal(iddId);
  return saved?.branchGone && saved.status !== "complete" ? null : pr;
}

type IssueRecord = Pick<BacklogRecord, "source_type" | "gh_issue_url"> & Partial<Pick<BacklogRecord, "linear_issue_url">>;

/**
 * The Issue a PR may name. A GitHub lane's Issue always; a Linear lane's only when the repo says how its PRs
 * name Linear (pr_linear_reference), since the team's precedent decides whether a PR links the Issue or closes it.
 */
export function publicIssueUrl(rec: IssueRecord, cfg?: Pick<AreaConfig, "pr_linear_reference">): string | null {
  if (rec.source_type !== "linear") return rec.gh_issue_url ?? null;
  return cfg?.pr_linear_reference ? rec.linear_issue_url ?? null : null;
}

const CLOSING = /^\s*[-*]?\s*(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+/i;

/**
 * The drafted body as the PR goes out with it: the line naming the Issue is the repo's form, put there by the
 * submit rather than left to the drafter. A draft line that already names the Issue in that form (or, for a
 * link, any line that links it) is kept; a closing line in the wrong form is replaced.
 */
export function withIssueLine(body: string, rec: IssueRecord, cfg?: Pick<AreaConfig, "pr_linear_reference">): string {
  const line = publicIssueLine(rec, cfg);
  const url = publicIssueUrl(rec, cfg);
  if (!line || !url) return body;
  const number = rec.source_type === "linear" ? undefined : /\/issues\/(\d+)/.exec(url)?.[1];
  const names = (l: string) => l.includes(url) || (number !== undefined && new RegExp(`#${number}\\b`).test(l));
  const closes = line.startsWith("Closes ");
  const lines = body.split("\n");
  // a closing line where the repo links the Issue would move its state: it goes
  const kept = closes ? lines : lines.filter((l) => !(names(l) && CLOSING.test(l)));
  const present = kept.some((l) => names(l) && (closes ? CLOSING.test(l) : true));
  const text = kept.join("\n").trim();
  if (present) return text;
  return text ? `${line}\n\n${text}` : line;
}

/** the line of the PR body that names the Issue: Closes for GitHub, and for Linear the repo's form */
export function publicIssueLine(rec: IssueRecord, cfg?: Pick<AreaConfig, "pr_linear_reference">): string | null {
  const url = publicIssueUrl(rec, cfg);
  if (!url) return null;
  if (rec.source_type === "linear" && cfg?.pr_linear_reference === "link") return `[${linearIdentifierOf(url) ?? url}](${url})`;
  return `Closes ${url}`;
}

/**
 * What the submit card reads from git and from the lane's worktree: the seconds of the card. A derivation takes
 * these and an answer replays them, so everything else the card says — the proposal, the land record, the review, the AC states, the drafted text — is read at the moment of the answer, because a judgment wrote those
 * rows and the card must show the judgment penne just made.
 */
export interface SubmitReadings {
  /** the lane's worktree from its last session, while it is still there; null when the lane has none */
  worktree: string | null;
  /** where the lane's own commits start (`laneBase`), or null when it cannot be read */
  base: string | null;
  /** the subjects of the commits above the base, oldest first */
  commits: string[];
  /** the worktree holds no uncommitted change */
  clean: boolean;
  /** the lane's head */
  head: string | undefined;
  /** the work-side mainline tip the landing forecast is checked against; null when nothing is forecast */
  landTip: string | null;
  /** the lane's intent as the reader took it; a caller that hands readings in says what it read */
  intent?: LaneIntent;
}

export function readSubmitReadings(iddId: string): SubmitReadings {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  const worktree = rec && session?.worktree_path && existsSync(session.worktree_path) ? session.worktree_path : null;
  if (!rec || !worktree) return { worktree: null, base: null, commits: [], clean: false, head: undefined, landTip: null };
  const base = laneBase(worktree);
  const commits = (tryGit(worktree, ["log", "--reverse", "--format=%s", `${base ?? "main"}..HEAD`]) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const clean = tryGit(worktree, ["status", "--porcelain"]) === "";
  const head = tryGit(worktree, ["rev-parse", "HEAD"])?.trim();
  const area = readAreas().areas[rec.area];
  const landLoc = publishes(area) ? null : laneLocations(iddId);
  const landTip = landLoc?.config.local_path && landLoc.config.work_base
    ? mainlineTip(landLoc.config.local_path, landLoc.config.work_base)
    : null;
  return { worktree, base, commits, clean, head, landTip, intent: laneIntent(rec, { root: worktree }) };
}

export function buildSubmit(iddId: string, readings: SubmitReadings = readSubmitReadings(iddId)): SubmitView | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  const area = readAreas().areas[rec.area];
  const worktree = readings.worktree;
  if (!worktree) return null;

  const base = readings.base ?? "main";
  const commits = readings.commits;
  const intent = readings.intent ?? laneIntent(rec, { root: worktree });
  // the AC states come from the lane's own reports, folded oldest first; a lane that reported nothing yet is
  // read from the older `s2_result` records, so its confirmation does not go backwards
  const acStates = acStatesForLane({
    lane: iddId,
    rows: readWorkRows(workColumnPath(rec.area)),
    events: readLifecycle().filter((e) => e.idd_id === iddId),
  });

  const vocabAllow = publicVocabularyAllow(area);
  const drafted = prDraftOf(readLifecycle().filter((e) => e.idd_id === iddId));
  const body: SubmitView["pr"]["body"] = [];
  const issueLine = publicIssueLine(rec, area);
  if (issueLine) body.push({ text: issueLine, issue: true });
  for (const d of intent.decisions) {
    const terms = internalTerms(d.text, vocabAllow);
    body.push(terms.length ? { text: d.text, flagged: { original: terms.join(", ") } } : { text: d.text });
  }

  const docsOk = readings.clean;
  // a lane of a repo that does not publish is not pushed: the card shows the landing, and the PR vocabulary and
  // commit-message rules (both about public text) are left out of its checks
  const publishesArea = publishes(area);
  const checks: SubmitView["checks"] = [
    { label: "作業ツリーに未 commit の変更が無い", ok: docsOk },
    { label: "commit がある", ok: commits.length > 0 },
    {
      label: "満たすべき条件がすべて確認済み",
      ok: allCriteriaVerified(intent.criteria, acStates),
    },
    ...(publishesArea ? [
      {
        label: "PR のタイトルと本文に IDD の語彙が残っていない",
        ok: drafted
          ? internalTerms(`${drafted.title}\n${drafted.body}`, vocabAllow).length === 0
          : !body.some((b) => b.flagged) && internalTerms(commits[0] ?? rec.title, vocabAllow).length === 0,
      },
    ] : []),
  ];

  // the agent's own text goes out as it was written; the repo's form of the Issue line is not put on it, so a
  // body without that line says so where the person signs
  if (publishesArea && drafted?.agent) {
    const lined = withIssueLine(drafted.body, rec, area);
    if (lined.trim() !== drafted.body.trim()) {
      checks.push({
        label: "PR の本文に Issue の行が無い",
        ok: false,
        reason: "本文は agent が渡したままです。この本文には Issue を閉じる行が無いので、merge しても Issue は閉じません。要るなら本文に足してください",
      });
    }
  }

  const proposal = publishesArea ? readProposal(iddId) : null;
  const landLoc = laneLocations(iddId);
  const head = readings.head;
  // a land record checked at another head answers for a head penne is not looking at: it is handed on as no check at
  // all, so the card and the engine say this head is being checked and offer no approval for the old one
  const savedLand = publishesArea ? undefined : readLand(iddId);
  const land = !savedLand || savedLand.head === head ? savedLand : null;
  // a landing check runs in its own process now (C-144-1): while one reads this lane's head and mainline tip, the
  // card has no result to show and asks for nothing, and the run record is where that is read (C-144-8)
  const landChecking = publishesArea ? undefined : (landRunChecking(iddId) ? "検査中です。終わると承認できます" : undefined);
  const landBlocked = publishesArea ? undefined : (landLoc ? landBlocker(iddId, landLoc) ?? undefined : "lane の作業場所を読めません");
  // a lane whose public side is the mainline's is marked on the card itself, before any check: the landing's guards
  // refuse its approval, and the card must not read as one waiting for a signature. Only a landing is asked: a repo
  // that publishes closes nothing by itself (its local completion reclaims the records and leaves the Issue open), so
  // the harm (an Issue closed over records alone) is the landing's. A lane the landing refuses for another reason
  // (`landBlocked`) keeps that reason, in the order the guards read them
  const recordsOnly = publishesArea || !landLoc || landBlocked ? undefined : recordsOnlyRefusal(iddId, landLoc) ?? undefined;
  const round = submitEvents(iddId);
  const heldAt = round.map((e) => e.event).lastIndexOf("s4_push_held");
  const held = heldAt >= 0 ? round[heldAt] : undefined;
  const pushedAt = round.map((e) => e.event).lastIndexOf("s4_pushed");
  const landForecast = (() => {
    if (publishesArea || !head || !landLoc?.config.local_path || !landLoc.config.work_base) return undefined;
    const group = readLandForecast(landLoc.config.local_path);
    if (!group) return undefined;
    const tip = readings.landTip ?? mainlineTip(landLoc.config.local_path, landLoc.config.work_base);
    return tip ? landForecastFor(group, iddId, head, tip) : undefined;
  })();
  const lanePr = prOf(readLifecycle().filter((e) => e.idd_id === iddId));
  const pushedHere = proposal?.status === "pushed" && proposal.head === head;
  const recheck = pushedHere ? outdatedOf(iddId, proposal) ?? goneAfterPush(round, pushedAt) : null;
  // checked while the branch was gone: it goes out as a new branch with a new PR, not to the lane's last PR
  const gone = proposal && proposal.status !== "complete" && proposal.head === head ? proposal.branchGone : undefined;
  // the one commit message that goes out is judged by the repo's declared form (a repo that declares none shows no
  // line: a line nothing judged is not a pass). The lane's own commits are squashed and never go out, so they are not
  // what is read; the message is the head's draft, or the pushed one, or the form the repo's own pattern made
  const commitDrafted = pushedHere || !head || !publishesArea ? undefined : commitDraftAt(round, head);
  // a draft of the head wins; without one the message is shown only when it is the repo's own form (its `commit_message`
  // pattern) or the draft failed and the lane must go on. A PR's title waiting for the draft is not a commit message
  const commitStart = !commitDrafted?.draft && (commitDrafted?.failed || area?.commit_message) ? proposal?.commitMessage : undefined;
  const commitView: SubmitView["commit"] | undefined = pushedHere || !head || !publishesArea ? undefined
    : commitDrafted?.draft ? commitDrafted
      : { ...(commitDrafted ?? { pending: true as const }), ...(commitStart ? { start: commitStart } : {}) };
  // a local completion publishes no commit: there is no message to judge
  const convention = publishesArea && proposal?.mode !== "local" ? readAreas().commitConvention?.[rec.area] : undefined;
  const conventionPrecedents = proposal?.precedents ?? [];
  if (convention) {
    const out = pushedHere ? proposal?.commitMessage : commitView?.draft ?? commitView?.start;
    const verdict = commitConventionCheck(convention, out, conventionPrecedents);
    checks.push({ label: verdict.label, ok: verdict.ok, reason: verdict.reason, key: "commit-convention" });
  }
  if (publishesArea && proposal?.mode !== "local") {
    // the lines on the repo's declared rules and the team's practice: shown to the person who signs, never read by the
    // approval. The sections are read from the public base at the check; the branch is judged by the repo's rule
    const pushBranch = laneLocations(iddId)?.branch ?? session?.branch ?? "";
    const branchRule = branchNameCheck(area?.branch_name_pattern, iddId, rec, pushBranch).rule;
    const declared = { ...(convention ? { convention } : {}), ...(branchRule ? { branchRule } : {}), ...(area?.public_language ? { language: area.public_language } : {}) };
    const lines = [
      ...conventionLines(proposal?.conventions, declared, `origin/${area?.public_base ?? "main"}`),
      mergedTitleLine(convention, proposal?.mergedTitles, proposal?.mergedTitlesUnread === true, proposal?.conventions?.some((r) => r.kind === "commit" && r.found) === true),
      branchLine(area?.branch_name_pattern, iddId, rec, pushBranch),
    ];
    for (const line of lines) if (line) checks.push(line);
  }
  return {
    iddId,
    title: rec.title,
    branch: {
      from: laneLocations(iddId)?.branch ?? session?.branch ?? "",
      to: area?.public_base ?? "未設定",
      repo: area?.linked_repo ?? rec.area,
    },
    pr: { title: drafted?.title ?? commits[0] ?? rec.title, body, commits, vocabAllow, ...(drafted ? { draftBody: drafted.agent ? drafted.body : withIssueLine(drafted.body, rec, area) } : {}) },
    criteria: intent.criteria,
    checks,
    ...(convention ? { commitConvention: { convention, precedents: conventionPrecedents } } : {}),
    worktree,
    proposal: proposal?.status === "complete" ? null : proposal,
    // pushed only for the head it pushed: a lane that moved on is checked (and pushed) again from the card
    ...(pushedHere && proposal.outputCommit ? { pushed: { branch: proposal.branch, commit: proposal.outputCommit } } : {}),
    ...((() => {
      const heldHere = held && held.attrs?.head === head ? String(held.attrs?.reason ?? "") : "";
      if (proposal?.status === "pushed") {
        // what stopped the tick after this push for good (a PR it could not settle), not a hold from before the push
        // went out, nor one an earlier tick recorded for a passing failure (the tick asks again)
        const stop = proposal.head === head ? lastStopAfterPush(round, pushedAt) : undefined;
        const afterPush = stop ? String(stop.attrs?.reason ?? "") : "";
        const failed = pushedHere && !stop && lanePr ? lastFailureAfter(round, pushedAt) : "";
        return { ...(afterPush ? { pushHeld: afterPush } : {}), ...(failed ? { prCheckFailed: failed } : {}) };
      }
      return heldHere ? { pushHeld: heldHere } : {};
    })()),
    ...((() => {
      const open = gone ? null : openPrOnRecord(iddId, readLifecycle().filter((e) => e.idd_id === iddId));
      return open ? { existingPr: { url: open.url, number: open.pr } } : {};
    })()),
    ...(head ? { head } : {}),
    ...(land !== undefined ? { land } : {}),
    ...(landBlocked ? { landBlocked } : {}),
    ...(recordsOnly ? { recordsOnly: { reason: recordsOnly } } : {}),
    ...(landChecking ? { landChecking } : {}),
    ...(landForecast ? { conflictForecast: landForecast } : {}),
    ...((() => {
      if (publishesArea || !head) return {};
      const evs = readLifecycle().filter((e) => e.idd_id === iddId);
      const approval = currentLandApproval(evs);
      if (!approval || approval.head !== head) return {};
      const hold = lastLandHold(evs);
      return { landPending: { ...(hold ? { hold } : {}) } };
    })()),
    ...(gone ? { branchGone: { merged: gone.merged, ...(gone.pr !== undefined ? { pr: gone.pr } : {}) } } : {}),
    ...(recheck ? { recheck } : {}),
    ...(commitView ? { commit: commitView } : {}),
    ...((() => {
      const review = buildSubmitReview(readLifecycle().filter((e) => e.idd_id === iddId));
      return review ? { review } : {};
    })()),
  };
}

/** why the lane's saved submit no longer matches where it submits, read from the local configuration only */
function outdatedOf(iddId: string, saved: ProposeRecord): string | null {
  const loc = laneLocations(iddId);
  if (!loc) return null;
  try {
    return outdatedReason(saved, loc);
  } catch (err) {
    // the destination cannot be read (the clone's remotes are not one same URL): the token is refused as well
    return String((err as Error).message ?? err);
  }
}

/** the commit message drafted in this submit for the head, or why the draft failed */
export function commitDraftAt(round: { event: string; attrs?: Record<string, unknown> }[], head: string): SubmitView["commit"] | null {
  for (let i = round.length - 1; i >= 0; i -= 1) {
    const e = round[i];
    if (e.attrs?.head !== head) continue;
    if (e.event === "s4_commit_drafted" && typeof e.attrs?.message === "string") return { draft: e.attrs.message, ...(e.attrs.model ? { model: String(e.attrs.model) } : {}) };
    if (e.event === "s4_commit_draft_failed") return { failed: String(e.attrs?.error ?? "").slice(0, 300) };
  }
  return null;
}

/**
 * Why a submit card did not open, and what opens it later (`then`, empty when nothing does on its own).
 * busy: the lane gate stayed held; the next tick opens it. fault: the gate or a record failed; the next tick tries
 * again. held: the lane is stopped for penne (over its budget, its agent stopped); the tick does not open it until
 * penne moves it on. unbuilt: the executor's worktree is gone, so the card cannot be built on any tick until it is
 * back. stage: the lane is closed, or its stage does not take the submit.
 */
export interface SubmitOpenFailure {
  error: string;
  kind: "busy" | "fault" | "held" | "unbuilt" | "stage";
  then: string;
}

/**
 * Open the submit card of a lane that passed S3: the card, or why it cannot be opened (it cannot be built, the lane
 * ended or is stopped, or its stage does not take the submit). The start is checked inside the lane gate; a start
 * another caller wrote meanwhile counts as opened. A fault of the gate or of a record is thrown.
 */
async function openSubmit(iddId: string): Promise<SubmitView | SubmitOpenFailure> {
  const gone: SubmitOpenFailure = { error: "提出する lane がありません", kind: "stage", then: "" };
  if (!readBacklog().some((r) => r.idd_id === iddId)) return gone;
  const eventsNow = () => readLifecycle().filter((e) => e.idd_id === iddId);
  const events = eventsNow();
  const stage = deriveStage(events);
  if (stage.group === "closed") return gone;
  if (stage.decision === "stuck") {
    const then = laneOverBudget(events) ? "予算を足すと、次の tick で開きます" : laneStall(events) ? "lane を再開すると、次の tick で開きます" : "";
    return { error: `lane が止まっています: ${stage.blockedBy ?? ""}`, kind: "held", then };
  }
  const view = buildSubmit(iddId);
  if (!view) return { error: "executor の worktree が見つからないため、提出カードを組み立てられません", kind: "unbuilt", then: "worktree が戻るまで開けません" };
  if (stage.decision !== "ship") {
    // the head the submit opens at: the tick gets nothing public beyond it ready (runSubmitPush)
    const head = tryGit(view.worktree, ["rev-parse", "HEAD"])?.trim();
    const started = await transition(iddId, "s4_submit_started", head ? { head } : {}, { then: [{ event: "s4_verify_started", attrs: { verifier_session_id: null } }] });
    if (!started.ok && deriveStage(eventsNow()).decision !== "ship") {
      return started.busy
        ? { error: started.reason, kind: "busy", then: "次の tick で開き直します" }
        : { error: started.reason, kind: "stage", then: "" };
    }
  }
  return view;
}

/** open the submit card as `openSubmit`, with a fault of the gate or of a record answered as a failure instead of thrown */
export async function tryOpenSubmit(iddId: string): Promise<SubmitView | SubmitOpenFailure> {
  try {
    return await openSubmit(iddId);
  } catch (err) {
    return { error: String(err).slice(0, 400), kind: "fault", then: "次の tick でもう一度試します" };
  }
}

/** what is said of a card that did not open: the lead, the reason, and what opens it when something will */
export function submitOpenMessage(lead: string, failure: SubmitOpenFailure): string {
  return `${lead}（${failure.error}）${failure.then ? `。${failure.then}` : ""}`;
}

/** what an approval or a check is told when the lane is no longer at the submit card (sent back meanwhile, say) */
export const NOT_AT_SUBMIT = "提出前確認の段にない lane です（差し戻しなどで段が変わりました）。提出は保存も push もしていません。画面を読み込み直してください";

/**
 * Why the lane's records as they are now do not take a submit, or null when the lane is at the submit card. A lane
 * held for penne (over its budget, or its session stopped) is said to be stopped, with why: it was not sent back, and
 * its stuck card is where it goes on
 */
export function notAtSubmit(lane: { event: string; attrs?: Record<string, unknown> }[]): string | null {
  const stage = deriveStage(lane as LifecycleRecord[]);
  if (stage.decision === "ship") return null;
  if (stage.decision === "stuck") return `lane が止まっています（${stage.blockedBy ?? "要判断"}）。提出は保存も push もしていません。受信箱の止まった lane のカードで続けるか無視を選んでください`;
  return NOT_AT_SUBMIT;
}

/** the same, read for the lane by its id: what a check asks inside the lane gate before it saves its submit */
export function laneNotAtSubmit(iddId: string): string | null {
  return notAtSubmit(readLifecycle().filter((e) => e.idd_id === iddId));
}

export async function startSubmit(iddId: string): Promise<SubmitView | null> {
  const opened = await openSubmit(iddId);
  return "error" in opened ? null : opened;
}

/**
 * After penne passed S3 on its card: the submit card, or the warning that goes back to the screen when it did not
 * open (the pass is recorded either way). The warning says what opens the card: the tick's next pass only when the
 * tick will (a busy gate or a fault), penne when the lane is stopped, nothing on its own when the card cannot be built.
 */
export async function openSubmitAfterS3(iddId: string): Promise<{ view: SubmitView } | { warning: string }> {
  const opened = await tryOpenSubmit(iddId);
  if (!("error" in opened)) return { view: opened };
  return { warning: submitOpenMessage("S3 の承認は記録しましたが、提出前確認を開けませんでした", opened) };
}

export interface ShipResult {
  ok: boolean;
  pushedBranch?: string;
  prUrl?: string;
  /** the branch already had an open PR: the push went to it, its title and body left as they are */
  existingPr?: boolean;
  /** the lane's PR was found merged at what the branch carries: no new PR, the lane goes to the reclaim */
  merged?: { number: number; url: string };
  /** the lane's earlier PR, found no longer open after the push (and not merged at the pushed commit), with the commit it closed at */
  previousPr?: { number: number; state: string; headRefOid?: string | null };
  /** the error does not go away by trying again (the PR's base, several PRs, a changed destination) */
  permanent?: boolean;
  /** the lane had a PR and none is open after the push: the card goes on to approve a new one */
  noOpenPr?: boolean;
  /** the overlay lock's refusal: a wait, not a failed push, so the tick records no failure and tries again (DEC-2328) */
  lockRefused?: true;
  error?: string;
}

/** what penne approved on the submit card */
export interface ShipApproval {
  /** the commit message the pushed commit carries; needed whenever the approval pushes */
  commitMessage?: string;
  /** the title and body of a new PR; a lane without an open PR gets its PR only with these */
  pr?: { title: string; body: string };
  /** the one-time nonce of the approval's signature (from the challenge route) */
  nonce?: string;
  /** the WebAuthn assertion the page made over the challenge, checked once at the head of the approval */
  assertion?: unknown;
  /** the PIN's proof over the challenge, used when the approval came from the confirm stage's PIN rather than a key */
  pinProof?: unknown;
}

function gh(cwd: string, args: string[]): string {
  return execFileSync(process.env.IDD_GH_BIN?.trim() || "gh", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** the open PR of the lane's public branch, if there is one */
function openPrOf(loc: LaneLocation, branch: string): { url: string; number: number } | null {
  const existing = JSON.parse(gh(loc.upstream, ["pr", "list", "--repo", loc.config.linked_repo, "--head", branch, "--state", "open", "--json", "url,number,baseRefName"])) as { url: string; number: number; baseRefName: string }[];
  if (existing.length > 1) throw new PermanentSubmitError("公開 branch に複数の PR があります");
  if (existing[0] && existing[0].baseRefName !== loc.config.public_base) throw new PermanentSubmitError("既存 PR の base が設定と異なります");
  return existing[0] ?? null;
}

interface PrState { state: string; headRefOid: string | null; mergedAt?: string; mergedBy?: string }

/** the lane's last PR as GitHub has it now */
function prStateOf(loc: LaneLocation, pr: { repo: string; pr: number }): PrState {
  const v = JSON.parse(gh(loc.upstream, ["pr", "view", String(pr.pr), "--repo", pr.repo, "--json", "state,headRefOid,mergedAt,mergedBy"])) as { state?: string; headRefOid?: string | null; mergedAt?: string | null; mergedBy?: { login?: string } | null };
  return { state: String(v.state ?? ""), headRefOid: v.headRefOid ?? null, ...(v.mergedAt ? { mergedAt: v.mergedAt } : {}), ...(v.mergedBy?.login ? { mergedBy: v.mergedBy.login } : {}) };
}

/** the merge, recorded once for the submit that found it: the lane then waits for the import and the reclaim (runClose) */
async function recordMerged(iddId: string, pr: { pr: number; url: string }, st: PrState): Promise<void> {
  const names = readLifecycle().filter((e) => e.idd_id === iddId).map((e) => e.event);
  const since = Math.max(...["s4_pr_created", "s4_submit_started", "s4_pushed", "s4_ship_failed", "s2_result"].map((n) => names.lastIndexOf(n)));
  if (names.lastIndexOf("s4_merged") > since) return;
  await appendLifecycle("s4_merged", iddId, { merged_at: st.mergedAt, merged_by: st.mergedBy, pr_number: pr.pr, pr_url: pr.url, found_by: "submit" });
}

/**
 * The lane's PR merged at the commit the lane last pushed (its custody's public tip): nothing the lane has published
 * is left out of it. The caller makes sure the lane has nothing public since (a records-only fix): the merge is
 * then recorded and the lane goes to the reclaim, with no new PR from the merged branch.
 */
export async function settleMergedPr(iddId: string): Promise<{ number: number; url: string } | null> {
  const loc = laneLocations(iddId);
  const custody = read<Custody>(custodyPath(iddId));
  const pr = prOf(readLifecycle().filter((e) => e.idd_id === iddId));
  if (!loc || !custody || !pr) return null;
  const st = prStateOf(loc, pr);
  if (st.state !== "MERGED" || !st.headRefOid || st.headRefOid !== custody.publicTip) return null;
  await recordMerged(iddId, pr, st);
  return { number: pr.pr, url: pr.url };
}

/**
 * Why the lane's public branch is gone from the remote, when that decides what goes out next (the check's `gone`):
 * its PR merged at the commit the lane last pushed (GitHub deletes a merged branch), or at an earlier push of the
 * lane that its records show it pushed on over after the merge (`pushedAfterMerge`), or never merged (its PR closed,
 * or no PR made). The next public change then goes out on the branch again, as a new push on penne's approval with
 * a new PR. Undefined while the branch is there, and when GitHub says something else (merged at another commit,
 * still open): the check then refuses, since what the public base carries of the lane is not known. Asks the remote,
 * and GitHub when the branch is gone, so the tick and penne's check call it, not the card's build. Throws when
 * GitHub cannot be asked.
 */
export function goneBranchOf(iddId: string): GoneBranch | undefined {
  const loc = laneLocations(iddId);
  const custody = read<Custody>(custodyPath(iddId));
  if (!loc || !custody) return undefined;
  if (remoteTip(loc.upstream, custody.branch) !== null) return undefined;
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const pr = prOf(evs);
  if (!pr) return { tip: custody.publicTip, merged: false };
  const st = prStateOf(loc, pr);
  if (st.state === "MERGED") {
    if (st.headRefOid === custody.publicTip) return { tip: custody.publicTip, merged: true, pr: pr.pr };
    return st.headRefOid && pushedAfterMerge(loc.work, evs, pr.pr, st.headRefOid, custody.publicTip)
      ? { tip: custody.publicTip, merged: true, pr: pr.pr, mergedAt: st.headRefOid }
      : undefined;
  }
  return st.state === "CLOSED" ? { tip: custody.publicTip, merged: false, pr: pr.pr } : undefined;
}

/**
 * The lane's records say that its PR merged at `mergedAt`, a commit the lane pushed, and that the lane then pushed on
 * over it up to `tip`: the push of `mergedAt`, a later push of `tip` (a descendant of it), and the PR found merged
 * at `mergedAt` after that push (the hold that waits for a new PR). The public base then carries the branch only up
 * to `mergedAt`. GitHub's answer alone does not decide it: without the records, the lane is not put out again.
 */
function pushedAfterMerge(work: string, evs: LifecycleRecord[], pr: number, mergedAt: string, tip: string): boolean {
  const at = evs.findIndex((e) => e.event === "s4_pushed" && e.attrs?.commit === mergedAt);
  if (at < 0) return false;
  const later = evs.slice(at + 1);
  if (!later.some((e) => e.event === "s4_pushed" && e.attrs?.commit === tip)) return false;
  if (!later.some((e) => e.event === "s4_push_held" && e.attrs?.previous_pr === pr && e.attrs?.previous_pr_state === "MERGED" && e.attrs?.previous_pr_head === mergedAt)) return false;
  return tryGit(work, ["merge-base", "--is-ancestor", mergedAt, tip]) !== null;
}

/** what a hold that waits for a new PR records of the lane's earlier PR found no longer open: read back by `goneBranchOf` */
export function previousPrAttrs(previous?: { number: number; state: string; headRefOid?: string | null }): Record<string, unknown> {
  if (!previous) return {};
  return { previous_pr: previous.number, previous_pr_state: previous.state, ...(previous.headRefOid ? { previous_pr_head: previous.headRefOid } : {}) };
}

/** a pushed submit whose public branch is gone: its token can make no PR, and the card checks the lane again */
class BranchGoneError extends PermanentSubmitError {}

/** what the card says of a push whose branch was found gone after it (a PR approval, the tick's PR check) */
function goneAfterPush(round: { event: string; attrs?: Record<string, unknown> }[], pushedAt: number): string | null {
  if (pushedAt < 0) return null;
  for (let i = round.length - 1; i > pushedAt; i -= 1) if (round[i].attrs?.branch_gone) return "公開 branch が公開先から消えています";
  return null;
}

/**
 * The tick's hold that stops it for good after the push at `pushedAt` (a PR it could not settle: `after_push`, or
 * none open: `no_open_pr`). A hold without either (an earlier tick's, for a passing failure) does not count.
 */
function lastStopAfterPush(round: { event: string; attrs?: Record<string, unknown> }[], pushedAt: number) {
  if (pushedAt < 0) return undefined;
  for (let i = round.length - 1; i > pushedAt; i -= 1) {
    const e = round[i];
    if (e.event === "s4_push_held" && (e.attrs?.after_push || e.attrs?.no_open_pr)) return e;
  }
  return undefined;
}

export function stoppedAfterPushAt(round: { event: string; attrs?: Record<string, unknown> }[], pushedAt: number): boolean {
  return lastStopAfterPush(round, pushedAt) !== undefined;
}

/** the error of the latest failure after the push at `pushedAt`, or "" */
function lastFailureAfter(round: { event: string; attrs?: Record<string, unknown> }[], pushedAt: number): string {
  if (pushedAt < 0) return "";
  for (let i = round.length - 1; i > pushedAt; i -= 1) {
    if (round[i].event === "s4_ship_failed") return String(round[i].attrs?.error ?? "").slice(0, 300);
  }
  return "";
}

/** a push of this prepared submit that reached GitHub, as recorded when the tick or the card found it */
function unsavedOnRecord(round: { event: string; attrs?: Record<string, unknown> }[], saved: ProposeRecord): boolean {
  return Boolean(saved.outputCommit) && round.some((e) => e.event === "s4_push_unsaved" && e.attrs?.commit === saved.outputCommit && e.attrs?.head === saved.head);
}

/**
 * Put on record that the prepared submit's push reached GitHub (found by asking the remote, in the tick or an
 * operation), once per commit: the card reads this instead of asking the remote each time it is built.
 */
export async function recordUnsavedPush(iddId: string, saved: ProposeRecord): Promise<void> {
  if (unsavedOnRecord(submitEvents(iddId), saved)) return;
  await appendLifecycle("s4_push_unsaved", iddId, { head: saved.head, commit: saved.outputCommit, pushed_branch: saved.branch });
}

/** events of the lane's current submit: since its latest s4_submit_started */
function submitEvents(iddId: string) {
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const at = evs.map((e) => e.event).lastIndexOf("s4_submit_started");
  return evs.slice(Math.max(0, at));
}

/**
 * Push the checked submit (only with the commit message penne approved: without `approved`, only a push already
 * out is put on record) and, when the branch has an open PR, record the push as that PR's new revision. The
 * caller holds the lane's work lock. Nothing here writes a PR's title or body.
 */
async function pushHeld(iddId: string, token: string, saved: ProposeRecord, loc: LaneLocation, approved?: PushApproved): Promise<{ commit: string; prUrl?: string; merged?: { number: number; url: string }; previousPr?: { number: number; state: string; headRefOid?: string | null } }> {
  const result = exportUnderWorkLock(iddId, token, approved);
  if (!result.ok) throw result.signature ? new SignatureRefusedError(result.error ?? "署名が確かめられませんでした") : new Error(result.error ?? "push に失敗しました");
  const commit = String(result.commit ?? "");
  const round = submitEvents(iddId);
  if (!round.some((e) => e.event === "s4_pushed" && e.attrs?.commit === commit)) {
    await appendLifecycle("s4_pushed", iddId, { pushed_branch: saved.branch, commit });
  }
  // someone else moved the branch: asking again does not change that, the lane has to take it in first
  const tip = remoteTip(loc.upstream, saved.branch);
  // the branch was deleted after the push (its PR closed, or it was cleaned up): no PR can be made from it, and a
  // receive cannot fetch it. The lane is checked again, and goes out as a new push on penne's approval
  if (tip === null) {
    // put out again over the public base only where GitHub says why the branch is gone; otherwise the check refuses it
    // (proposeAdmitted), and the hold says so rather than offer it. GitHub that cannot be asked is asked again by the
    // tick
    if (!goneBranchOf(iddId)) throw new BranchGoneError(goneUnknownReason(saved.branch));
    throw new BranchGoneError(`公開 branch ${saved.branch} が公開先から消えています。この push からは PR を作れません。提出前確認で検査し直すと、公開本流の上に出し直す push をカードで承認できます`);
  }
  if (tip !== commit) throw new PermanentSubmitError("push 後に公開 branch が更新されました。受け入れ操作で再確認してください");
  const open = openPrOf(loc, saved.branch);
  if (!open) {
    const last = prOf(readLifecycle().filter((e) => e.idd_id === iddId));
    if (!last) return { commit };
    // the lane's PR is no longer open. Merged at exactly what the branch carries now: nothing of the lane is left
    // out of it, so no new PR is made from the merged branch and the lane goes to the reclaim
    const st = prStateOf(loc, last);
    if (st.state === "MERGED" && st.headRefOid === commit) {
      await recordMerged(iddId, last, st);
      const current = readProposal(iddId)!;
      current.status = "complete"; current.prUrl = last.url;
      save(proposalPath(iddId), current);
      return { commit, merged: { number: last.pr, url: last.url } };
    }
    return { commit, previousPr: { number: last.pr, state: st.state, headRefOid: st.headRefOid } };
  }
  if (!round.some((e) => e.event === "s4_pr_created" && e.attrs?.commit === commit)) {
    await appendLifecycle("s4_pr_created", iddId, { pr_url: open.url, pr_number: open.number, commit, existing: true });
  }
  const current = readProposal(iddId)!;
  current.status = "complete"; current.prUrl = open.url;
  save(proposalPath(iddId), current);
  return { commit, prUrl: open.url };
}

/**
 * A submit whose push reached the public branch but whose record stayed `prepared` (an error after the push, or a
 * restart between the push and the save): its commit is the branch's tip. Such a submit is finished with its own
 * token (custody, and the PR's record or the card), not checked again: a new check would find the branch moved.
 */
export function unsavedPush(iddId: string): ProposeRecord | null {
  const saved = readProposal(iddId);
  if (saved?.status !== "prepared" || !saved.outputCommit || !saved.upstream || !saved.branch) return null;
  try {
    return remoteTip(saved.upstream, saved.branch) === saved.outputCommit ? saved : null;
  } catch {
    return null;
  }
}

/**
 * The unsaved push's own token can no longer finish it: the lane's head moved since it was checked, or its Git
 * destination or settings changed (`outdatedReason`). Read from the local clone only.
 */
export function unsavedPushOutdated(iddId: string, saved: ProposeRecord): boolean {
  const loc = laneLocations(iddId);
  if (!loc) return true;
  if (tryGit(loc.work, ["rev-parse", "HEAD"])?.trim() !== saved.head) return true;
  return outdatedOf(iddId, saved) !== null;
}

/**
 * Put an unsaved push that its token can no longer finish on record as the lane's public tip (`settleUnsavedPush`),
 * with the push in the lane's events as the export would have left it. The lane then goes on as one pushed at that
 * commit: a moved head is checked and pushed over it, and changed settings are checked again from the card.
 */
export async function settleUnsaved(iddId: string): Promise<ProposeRecord | null> {
  const settled = settleUnsavedPush(iddId);
  if (!settled?.outputCommit) return settled;
  if (!submitEvents(iddId).some((e) => e.event === "s4_pushed" && e.attrs?.commit === settled.outputCommit)) {
    await appendLifecycle("s4_pushed", iddId, { pushed_branch: settled.branch, commit: settled.outputCommit, head: settled.head, unsaved: true });
  }
  return settled;
}

/**
 * The follow-up of a push penne approved, which pushes nothing: a push that reached the branch without its record
 * (an error after it, a restart), or a push whose PR check failed, is put on record. A branch with an open PR gets
 * the push as the PR's new revision and the lane goes back to waiting on it; otherwise the lane waits at the card
 * that makes the PR. A submit that still needs a push is refused (the export pushes only on an approval).
 */
export async function settlePushed(iddId: string, token: string): Promise<ShipResult> {
  let release: (() => void) | undefined;
  try {
    const { saved, loc } = validateProposal(iddId, token);
    if (saved.mode === "local") return { ok: false, error: "公開差分がありません" };
    release = lock(loc.work);
    if (saved.status === "complete") return { ok: true, pushedBranch: saved.branch, ...(saved.prUrl ? { prUrl: saved.prUrl, existingPr: true } : {}) };
    const pushed = await pushHeld(iddId, token, saved, loc);
    if (pushed.merged) return { ok: true, pushedBranch: saved.branch, merged: pushed.merged };
    return { ok: true, pushedBranch: saved.branch, ...(pushed.prUrl ? { prUrl: pushed.prUrl, existingPr: true } : {}), ...(pushed.previousPr ? { previousPr: pushed.previousPr } : {}) };
  } catch (e) {
    // the overlay lock's refusal is a wait: it is answered as one, marked so the tick does not record it as a failure,
    // and leaves no failed push on record (DEC-2328)
    if (isLockRefusal(e)) return { ok: false, error: (e as Error).message, lockRefused: true };
    await appendLifecycle("s4_ship_failed", iddId, { error: (e as Error).message, ...(e instanceof BranchGoneError ? { branch_gone: true } : {}) });
    return { ok: false, error: (e as Error).message, ...(e instanceof PermanentSubmitError ? { permanent: true } : {}) };
  } finally { release?.(); }
}

/**
 * Whether this approval must carry a signature, from the lane's saved state (not from the shape of the request):
 * a repo that does not publish (a landing) and a lane with no public change (a local completion) ask for none; a
 * publish lane whose push is not out yet asks for one; a pushed submit asks only to make its PR (a record-on-pr
 * asks for none). `runShip` and the challenge route both read this decision, so the page and the approval agree on
 * when the passkey is asked for.
 */
export function approvalNeedsSignature(saved: Pick<ProposeRecord, "mode" | "status">, out: boolean, approval: { pr?: { title: string; body: string } }): boolean {
  // an approval already carried out (the record is complete) writes nothing: it is answered without a signature
  if (saved.status === "complete") return false;
  // a local completion commits the lane's records to the work side's mainline: it needs a signature as a push does
  if (saved.mode === "local") return true;
  return saved.mode === "publish" && (!out || approval.pr !== undefined);
}

/** the content a local completion's signature is over, built the same way by the challenge and the approval */
export function localCompleteContentFor(saved: Pick<ProposeRecord, "iddId" | "repo" | "workBase" | "head">): Record<string, unknown> {
  return localCompleteContent({ iddId: saved.iddId, repo: saved.repo ?? "", workBase: saved.workBase ?? "", head: saved.head });
}

/** the same decision, gathered from the lane's saved state (the landing, the checked submit, the pushed submit) */
export function shipSignatureRequired(iddId: string, token: string, approval: { pr?: { title: string; body: string } }): boolean {
  // a repo that does not publish has a landing record instead of a submit: its approval merges into the mainline,
  // so it needs a signature. A record already complete writes nothing and is answered without one
  const land = readLand(iddId);
  if (land) {
    if (land.token !== token) return false;
    return land.status !== "complete";
  }
  const saved = readProposal(iddId);
  if (!saved || saved.token !== token) return false;
  const out = saved.status === "pushed" || unsavedPush(iddId)?.token === saved.token;
  return approvalNeedsSignature(saved, out, approval);
}

/**
 * penne's approval on the submit card, the only way a push leaves this machine. A push goes out with the commit
 * message penne approved (it passes the vocabulary check); a lane without a PR is pushed only with the PR's title
 * and body approved on the same card, and gets its PR made with them. A lane whose PR is open gets the push as the
 * PR's new revision, its title and body left as they are; one whose PR is found no longer open after the push waits
 * at the card for a new PR.
 * A pushed submit (the push is out) approves only the PR. A lane with no public change is completed locally.
 */
export async function runShip(iddId: string, token: string, approval: ShipApproval = {}): Promise<ShipResult> {
  // a repo that does not publish: the approval lands the checked merge commit in the work side's mainline and closes
  // the lane. Nothing is pushed, and no PR is made
  const cfg = areaOf(iddId);
  if (cfg && !publishes(cfg)) {
    // the same approval pressed again after it went through (the lane is closed): answered as before
    const done = readLand(iddId);
    if (done?.status === "complete") return { ok: true };
    const away = laneNotAtSubmit(iddId);
    if (away) return { ok: false, error: away };
    const res = await approveLand(iddId, token, { nonce: approval.nonce, assertion: approval.assertion, pinProof: approval.pinProof });
    return {
      ok: res.ok,
      ...(res.committed ? { pushedBranch: undefined } : {}),
      ...(res.error ? { error: res.error } : {}),
      ...(res.held ? { pushHeld: res.held } : {}),
    };
  }
  // an approval from a card of a lane no longer at the submit (sent back while its check ran, say) is refused before
  // anything, and is not a failed push. What it would write is checked again inside the lane gate below. The same
  // approval pressed again after it went through (the lane has moved on to its PR) is answered as before
  const done = readProposal(iddId);
  const away = done?.token === token && done.status === "complete" ? null : laneNotAtSubmit(iddId);
  if (away) return { ok: false, error: away };
  let release: (() => void) | undefined;
  try {
    // the submit is validated under the lane's lock: what is approved below is what the export then pushes
    const at = laneLocations(iddId);
    if (at) release = lock(at.work);
    const { saved, loc } = validateProposal(iddId, token);
    if (saved.status === "complete") return { ok: true, prUrl: saved.prUrl, pushedBranch: saved.outputCommit ? saved.branch : undefined };
    const laneEvents = readLifecycle().filter((e) => e.idd_id === iddId);
    // a submit already out at this head (a push that approves only its PR): nothing is pushed for it, so the PR's
    // gate is the one that compares what it writes
    const out = saved.status === "pushed" || unsavedPush(iddId)?.token === saved.token;
    // the signature over what this approval sends, checked once at the head: before the push's approval is recorded,
    // so a refused approval leaves no record of a push (neither s4_push_approved nor s4_ship_failed). A publishing
    // lane whose push is not out yet always needs a signature (an approval with no fields at all is refused here,
    // not as a failed push); a PR-only approval writes no such record, so its content comparison is left to the PR's
    // gate just below. When a push goes out the head also compares the content, because the approval is recorded
    // before the push's own gate
    if (approvalNeedsSignature(saved, out, approval)) {
      // what the signature covers is the approval's own kind: a local completion commits the lane's records to the
      // work side's mainline (its own content), a publish sends the checked commit and its PR text
      const content = saved.mode === "local"
        ? localCompleteContentFor(saved)
        : shipContentFor(iddId, saved, loc, { commitMessage: approval.commitMessage, pr: approval.pr });
      const checked = await verifyApproval({
        nonce: approval.nonce,
        assertion: approval.assertion,
        pinProof: approval.pinProof,
        content,
        compareContent: !out,
      });
      if (!checked.ok) return { ok: false, error: checked.reason };
    }
    if (saved.mode === "local") {
      // a branch already on the public side is not ended here unless it was merged: an open PR would be left open, and
      // a branch without one would be left unanswered
      if (read(custodyPath(iddId)) && !laneEvents.some((e) => e.event === "s4_merged")) {
        const open = openPrOf(loc, saved.branch);
        if (open) throw new Error(`開いている PR #${open.number} があります。ローカル完了では閉じません（提出前確認で検査し直すと、この版を PR に記録して PR 待ちへ戻ります）`);
        // its PR merged at what the branch carries: recorded as merged, and the lane is closed the way a merged lane
        // is (runClose: after the import, with the records reclaimed), not here
        const merged = await settleMergedPr(iddId);
        if (!merged) throw new Error("公開 branch に push 済みで、開いている PR も merge もありません。ローカル完了では閉じず、PR を作ってください（提出前確認で検査し直す）");
        saved.status = "complete"; saved.prUrl = merged.url;
        save(proposalPath(iddId), saved);
        return { ok: true, merged };
      }
      release?.(); release = undefined;
      const recovery = reclaimLane(iddId);
      if (!recovery.ok) return { ok: false, error: recovery.error };
      // closed through the gate: a lane penne aborted meanwhile is not closed a second time
      const closed = await transition(iddId, "lane_close", { outcome: "local", recovered_commit: recovery.commit }, {
        require: notAtSubmit,
        before: () => appendLifecycle("s4_local_completed", iddId, { recovered_commit: recovery.commit }),
      });
      if (!closed.ok) return { ok: false, error: closed.reason };
      saved.status = "complete";
      save(proposalPath(iddId), saved);
      return { ok: true };
    }
    const text = approval.pr;
    if (text && !text.title.trim()) throw new Error("PR の題名が空です");
    let approved: PushApproved | undefined;
    if (!out) {
      // nothing leaves without the commit message penne approved, and a lane without a PR not without its PR's text
      const message = approvedCommitMessage(approval.commitMessage);
      const problem = commitMessageProblem(message, publicVocabularyAllow(loc.config));
      if (problem) throw new Error(problem);
      if (!prOf(laneEvents) && !text) throw new Error("PR の無い lane です。PR の題名と本文を、commit message と同じカードで承認してください");
      // the approval is recorded only for a push that gets past the export's checks of the public side as it is now,
      // and only while the lane is at the submit card: checked and written inside the lane gate, so a send-back that
      // came after the card was checked stops the push. A refusal here is not a failed push
      pushTargetTip(saved, loc);
      // a push that goes out with failures the lane's base has as well keeps them on its approval: the ledger says
      // what penne let through, and that the lane did not make it
      const atBase = failingAtBaseOnRecord(saved.checks);
      const recorded = await transition(iddId, "s4_push_approved", { head: saved.head, commit_message: message, ...(text ? { pr_title: text.title } : {}), ...(atBase.length ? { failing_at_base: atBase } : {}) }, {
        require: notAtSubmit,
      });
      if (!recorded.ok) return { ok: false, error: recorded.reason };
      approved = { message, ...(text ? { pr: text } : {}), ...(approval.nonce ? { nonce: approval.nonce } : {}) };
    }
    const pushed = await pushHeld(iddId, token, saved, loc, approved);
    // the lane's PR was merged at what the branch carries: no second PR from the merged branch
    if (pushed.merged) return { ok: true, pushedBranch: saved.branch, merged: pushed.merged };
    if (pushed.prUrl) return { ok: true, pushedBranch: saved.branch, prUrl: pushed.prUrl, existingPr: true };
    if (!text) {
      // the card showed a push to the lane's PR, which is no longer open: no PR is made from text penne did not see
      const previous = pushed.previousPr;
      const reason = previous?.state === "MERGED"
        ? `push しましたが、前の PR #${previous.number} は merge 済みで、この push はそれより後の変更です。PR を作るには提出前確認のカードで題名と本文を承認してください`
        : "push しましたが、開いている PR がありません（前の PR は閉じています）。PR を作るには提出前確認のカードで題名と本文を承認してください";
      await appendLifecycle("s4_push_held", iddId, { head: saved.head, reason, no_open_pr: true, ...previousPrAttrs(previous) });
      return { ok: true, pushedBranch: saved.branch, noOpenPr: true, ...(previous ? { previousPr: previous } : {}) };
    }
    // the PR's gate: the same signature covers the PR's destination and text as it covered the push. Rebuilt from
    // what is about to be written, and only reached when the push path did not already refuse it
    const prGate = approvalGateOpen(approval.nonce, shipContentFor(iddId, saved, loc, { commitMessage: approval.commitMessage, pr: text }));
    if (!prGate.ok) throw new SignatureRefusedError(prGate.reason);
    const prUrl = gh(loc.upstream, ["pr", "create", "--repo", loc.config.linked_repo, "--base", loc.config.public_base!, "--head", saved.branch, "--title", text.title, "--body", text.body]).trim();
    await appendLifecycle("s4_pr_created", iddId, { pr_url: prUrl, pr_number: Number(prUrl.split("/").pop()), commit: pushed.commit, title: text.title });
    const current = readProposal(iddId)!;
    current.status = "complete"; current.prUrl = prUrl; current.pr = { title: text.title, body: text.body };
    save(proposalPath(iddId), current);
    return { ok: true, pushedBranch: saved.branch, prUrl };
  } catch (e) {
    // a refusal the signature caused is not a failed push: it is answered the way a lane that is no longer at the
    // submit card is, and leaves no record of a failure
    if (e instanceof SignatureRefusedError) return { ok: false, error: e.message };
    // the overlay lock's refusal is a wait, not a failed push: it is answered without a failure record (DEC-2328)
    if (isLockRefusal(e)) return { ok: false, error: (e as Error).message };
    await appendLifecycle("s4_ship_failed", iddId, { error: (e as Error).message, ...(e instanceof BranchGoneError ? { branch_gone: true } : {}) });
    return { ok: false, error: (e as Error).message, ...(e instanceof PermanentSubmitError ? { permanent: true } : {}) };
  } finally { consumeNonce(approval.nonce); release?.(); }
}

/**
 * Check the submit with the card's text (the inbox card and the CLI's propose): nothing is pushed here, the push
 * waits for penne's approval on the card. `start: false` (the server's routes) takes only a lane already at the
 * submit card: a request from elsewhere cannot move a lane there.
 */
export async function prepareSubmit(iddId: string, pr?: { title: string; body: string }, opts: { start?: boolean } = {}): Promise<ProposeView | LandRecord | LandChecking | { error: string }> {
  if (opts.start === false && deriveStage(readLifecycle().filter((e) => e.idd_id === iddId)).decision !== "ship") return { error: "提出前確認の段にない lane です" };
  // a repo that does not publish: the check is about the landing into the work side's mainline, not a push and a PR
  const area = areaOf(iddId);
  if (area && !publishes(area)) return await prepareLand(iddId);
  const view = await openSubmit(iddId);
  if ("error" in view) return { error: view.error };
  const text = pr ?? { title: view.pr.title, body: view.pr.body.map(b => `- ${b.text}`).join("\n") };
  if (!text.title.trim()) return { error: "題名を入力してください" };
  // a push that reached GitHub but was not saved is put on record with its own token, not checked again (the branch
  // has moved to it; nothing more is pushed). One its token can no longer finish (a moved head, changed settings) is
  // put on record as the lane's public tip, and the lane is checked anew from it
  const unsaved = unsavedPush(iddId);
  if (unsaved) {
    await recordUnsavedPush(iddId, unsaved);
    if (!unsavedPushOutdated(iddId, unsaved)) {
      const done = await settlePushed(iddId, unsaved.token);
      return done.ok ? readProposal(iddId) ?? unsaved : { error: done.error ?? "push の後始末に失敗しました" };
    }
    try {
      await settleUnsaved(iddId);
    } catch (err) {
      return { error: String((err as Error).message ?? err).slice(0, 300) };
    }
  }
  let gone: GoneBranch | undefined;
  try {
    gone = goneBranchOf(iddId);
  } catch (err) {
    return { error: `PR の状態を確かめられません: ${String((err as Error).message ?? err).slice(0, 300)}` };
  }
  const before = readProposal(iddId);
  // saved only while the lane is still at the submit card once the checks are done: a send-back during them leaves
  // no submit for the old card
  const proposed = await proposeAdmitted(iddId, text, { gone, admit: () => laneNotAtSubmit(iddId) });
  if ("notSaved" in proposed && proposed.notSaved) return { error: proposed.error };
  // a pushed submit whose branch is gone, with GitHub not saying why: the reason it is not put out again stays on the
  // card as what stopped it after the push (once), not only in the answer to this check
  if ("error" in proposed && before?.status === "pushed" && proposed.error === goneUnknownReason(before.branch)) {
    const round = submitEvents(iddId);
    const stop = lastStopAfterPush(round, round.map((e) => e.event).lastIndexOf("s4_pushed"));
    if (!String(stop?.attrs?.reason ?? "").includes(proposed.error)) {
      await appendLifecycle("s4_push_held", iddId, { head: before.head, reason: proposed.error, after_push: true });
    }
  }
  // a public change the review did not see is named on the card next to the approval, as the tick names it, even when
  // penne checks the lane before the tick looks at it
  if (!("error" in proposed) && proposed.mode === "publish" && !proposed.blocking) {
    const events = readLifecycle().filter((e) => e.idd_id === iddId);
    const round = events.slice(Math.max(0, events.map((e) => e.event).lastIndexOf("s4_submit_started")));
    const unreviewed = round.some((e) => e.event === "s4_push_held" && e.attrs?.head === proposed.head) ? null : unreviewedChange(events, proposed.work, proposed.head);
    if (unreviewed) await appendLifecycle("s4_push_held", iddId, { head: proposed.head, reason: unreviewed.reason, unreviewed: true, reviewed_head: unreviewed.seen });
  }
  // a branch that already carries the checked tree (a fix only in the records) needs no push: it is put on record at
  // once, as the tick does (on the lane's open PR, as merged, or waiting for a new PR)
  if (!("error" in proposed) && proposed.mode === "publish" && !proposed.blocking && carriesAlready(proposed as ProposeRecord)) {
    const done = await settlePushed(iddId, proposed.token);
    if (!done.ok) return { error: done.error ?? "PR の確認に失敗しました" };
    if (!done.prUrl && !done.merged && prOf(readLifecycle().filter((e) => e.idd_id === iddId))) {
      const previous = done.previousPr;
      await appendLifecycle("s4_push_held", iddId, {
        head: proposed.head,
        reason: previous?.state === "MERGED"
          ? `前の PR #${previous.number} は merge 済みで、公開 branch の変更はそれより後です。PR を作るには提出前確認のカードで題名と本文を承認してください`
          : "開いている PR がありません（前の PR は閉じています）。PR を作るには提出前確認のカードで題名と本文を承認してください",
        no_open_pr: true,
        ...previousPrAttrs(previous),
      });
    }
    return readProposal(iddId) ?? proposed;
  }
  return proposed;
}

export function shipArea(iddId: string): string {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? areaSegment(rec.area) : "";
}

/** the area's settings for a lane */
export function areaOf(iddId: string): AreaConfig | undefined {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? readAreas().areas[rec.area] : undefined;
}

export function intentDirOf(iddId: string): string {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? join("_docs", "intent", areaSegment(rec.area), slugOf(rec)) : "";
}

export async function completeLocal(iddId: string, token: string): Promise<ShipResult> {
  const cfg = areaOf(iddId);
  // a repo that does not publish has one completion: the landing into the work side's mainline
  if (cfg && !publishes(cfg)) return runShip(iddId, token);
  if (readProposal(iddId)?.mode !== "local") return { ok: false, error: "公開差分のある lane はローカル完了できません" };
  return runShip(iddId, token);
}
