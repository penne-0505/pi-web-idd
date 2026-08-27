// intent: DEC-690 — 提出物は lane の実物 (commit と契約) から機械的に組み立てる。AI に要約させない
// intent: DEC-691 — verifier の検査は実際に走らせられるものだけを並べる。通ったことにしない

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { areaSegment, parseIntent, slugOf } from "../intent/parse.ts";
import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readProgress, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { laneBase } from "./review.ts";
import type { BacklogRecord } from "../schema/records.ts";

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
  pr: { title: string; body: { text: string; flagged?: { original: string } }[]; commits: string[] };
  checks: { label: string; ok: boolean }[];
  worktree: string;
}

const IDD_VOCAB = /\b(DEC|INV|QA|AC|IDD)-[\w.]+/;

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

export function buildSubmit(iddId: string): SubmitView | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  const area = readAreas().areas[rec.area];
  if (!session?.worktree_path || !existsSync(session.worktree_path)) return null;

  const worktree = session.worktree_path;
  const base = laneBase(worktree) ?? "main";
  const commits = (tryGit(worktree, ["log", "--format=%s", `${base}..HEAD`]) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const intent = parseIntent(rec.area, slugOf(rec), { root: worktree });
  const progress = readProgress(iddId);
  const verified = new Set((progress?.qa_status ?? []).filter((q) => q.status === "verified").map((q) => q.qa_id));

  // intent: DEC-690 — 本文は契約と実物から組み立てる。IDD の語彙が残っている行は flag して人間に見せる
  const body: SubmitView["pr"]["body"] = [];
  const issueUrl = rec.gh_issue_url ?? rec.linear_issue_url;
  if (issueUrl) body.push({ text: `Closes ${issueUrl}` });
  for (const d of intent.decisions) {
    body.push(IDD_VOCAB.test(d.text) ? { text: d.text, flagged: { original: d.id } } : { text: d.text });
  }

  const docsOk = tryGit(worktree, ["status", "--porcelain"]) === "";
  const checks: SubmitView["checks"] = [
    { label: "作業ツリーに未 commit の変更が無い", ok: docsOk },
    { label: "commit がある", ok: commits.length > 0 },
    {
      label: "満たすべき条件がすべて確認済み",
      ok: intent.criteria.length > 0 && intent.criteria.every((c) => verified.has(c.id)),
    },
    { label: "PR 本文に IDD の語彙が残っていない", ok: !body.some((b) => b.flagged) },
    {
      label: "commit message が規約に沿う",
      ok: commits.every((c) => /^[a-z]+(\([^)]+\))?: .+/.test(c)),
    },
  ];

  return {
    iddId,
    title: rec.title,
    branch: {
      from: session.branch,
      to: "main",
      repo: area?.linked_repo ?? rec.area,
    },
    pr: { title: commits[0] ?? rec.title, body, commits },
    checks,
    worktree,
  };
}

export async function startSubmit(iddId: string): Promise<SubmitView | null> {
  const view = buildSubmit(iddId);
  if (!view) return null;
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  if (!events.some((e) => e.event === "s4_submit_started")) {
    await appendLifecycle("s4_submit_started", iddId, {});
    await appendLifecycle("s4_verify_started", iddId, { verifier_session_id: null });
  }
  return view;
}

export interface ShipResult {
  ok: boolean;
  pushedBranch?: string;
  prUrl?: string;
  error?: string;
}

// intent: DEC-692 — push と PR 作成は人間が押したときだけ。engine 側で自動的に外へ出さない
export async function runShip(iddId: string): Promise<ShipResult> {
  const view = buildSubmit(iddId);
  if (!view) return { ok: false, error: `lane を提出できる状態にできません: ${iddId}` };

  const push = tryGit(view.worktree, ["push", "-u", "origin", `${view.branch.from}:${view.branch.from}`]);
  if (push === null) return { ok: false, error: "git push に失敗しました" };
  await appendLifecycle("s4_pushed", iddId, { pushed_branch: view.branch.from });

  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const bodyLines = [
    ...view.pr.body.map((b) => `- ${b.text}`),
    "",
    `lane: ${iddId}`,
  ];
  let prUrl: string | null = null;
  try {
    prUrl = execFileSync("gh", [
      "pr", "create",
      "--repo", view.branch.repo,
      "--base", view.branch.to,
      "--head", view.branch.from,
      "--title", view.pr.title,
      "--body", bodyLines.join("\n"),
    ], { cwd: view.worktree, encoding: "utf8", timeout: 60000 }).trim();
  } catch (err) {
    return { ok: false, pushedBranch: view.branch.from, error: `gh pr create: ${(err as Error).message}` };
  }

  const number = Number(prUrl.split("/").pop());
  await appendLifecycle("s4_pr_created", iddId, { pr_url: prUrl, pr_number: Number.isFinite(number) ? number : undefined });
  if (rec) rec.pull_req_url = prUrl;
  return { ok: true, pushedBranch: view.branch.from, prUrl };
}

export function shipArea(iddId: string): string {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? areaSegment(rec.area) : "";
}

export function intentDirOf(iddId: string): string {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  return rec ? join("_docs", "intent", areaSegment(rec.area), slugOf(rec)) : "";
}
