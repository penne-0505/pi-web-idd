/**
 * What the device stage (pipeline.device_check) does for a lane, read from the judge its qa.md's 全体 line declares
 * and from the pictures committed under the lane's compare/. The stage judges the lane's overall statement by
 * comparing the implementation's pictures with the prototype's, but who judges is the lane's declaration, not the
 * stage's: a lane judged by the picture-viewing role runs the role and takes its findings to the judgement, a lane
 * judged by a person runs the role only when there is a set of pictures and leaves its findings on the submit card.
 * A picture set that is missing, or one that cannot be said to be of the head's screen, is never read as "no
 * difference": for the picture-viewing judge it is a must; for the person it is said on the card.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { BacklogRecord } from "../schema/records.ts";
import { areaSegment, parseIntent, slugOf } from "../intent/parse.ts";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** the compare/ directory of a lane, relative to the repo root */
export function compareDirOf(rec: BacklogRecord): string {
  return join("_docs", "qa", areaSegment(rec.area), slugOf(rec), "compare");
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** the images committed at `head` under the lane's compare/: what the device stage's copy of that head holds */
export function comparePictures(worktree: string, rec: BacklogRecord, head: string): string[] {
  const rel = compareDirOf(rec);
  const out = git(worktree, ["ls-tree", "-r", "--name-only", head, "--", rel]);
  if (!out) return [];
  return out.split("\n").map((l) => l.trim()).filter((l) => l && IMAGE_EXT.test(l));
}

/**
 * Whether the images can be said to be of the screen `head` holds, read from the lane's own history: the commit
 * that last set them, and whether any code commit follows it. A record under `_docs/` is not the screen, so a
 * commit touching only records leaves the pictures as they are.
 */
export function picturesStandForHead(worktree: string, pictures: string[], head: string): { ok: boolean; reason?: string } {
  const shot = (git(worktree, ["log", "-1", "--format=%H", head, "--", ...pictures]) ?? "").trim();
  if (!shot) return { ok: false, reason: "compare/ の絵が commit されていません" };
  const after = (git(worktree, ["log", "--format=%H", `${shot}..${head}`, "--", ".", ":(exclude)_docs"]) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (after.length) return { ok: false, reason: `絵を撮った commit の後に code が変わっています（${after.length} commit）` };
  return { ok: true };
}

/** what the stage does: leave the lane alone (with the reason), write a must itself, or run the role */
export type DeviceAction =
  | { action: "skip"; reason: string }
  | { action: "must"; reason: string; statement: string; pictures: string[] }
  | { action: "run"; judge: "viewer" | "human"; statement: string; pictures: string[]; stale?: string };

/**
 * The stage's decision for a lane. The judge comes from the lane's qa.md (`root` is the lane's worktree, read the
 * same way the AC are); a lane with no 全体 line, or with a judge the stage has no role for, is left alone and the
 * reason is recorded. A person's lane needs a set of pictures to have anything to put before them. The
 * picture-viewing judge needs a set that can be said to be of the head's screen: without one the stage records a
 * must itself, so the lane is fixed rather than passed.
 */
export function deviceVerdict(rec: BacklogRecord, at: { worktree: string; head: string }): DeviceAction {
  const overall = parseIntent(rec.area, slugOf(rec), { root: at.worktree }).overall;
  if (overall.judge === "none" || overall.judge === "other") {
    const why = overall.word ? `qa.md の全体の行の判定者が「${overall.word}」` : "qa.md に全体の行か判定者が無い";
    return { action: "skip", reason: `${why}ので、絵を見比べる役を起こさない` };
  }
  const pictures = comparePictures(at.worktree, rec, at.head);
  const fresh = pictures.length ? picturesStandForHead(at.worktree, pictures, at.head) : { ok: false, reason: `${compareDirOf(rec)} に絵がありません` };
  if (overall.judge === "human") {
    if (!pictures.length) return { action: "skip", reason: "判定者が人の lane で compare/ に絵が無いので、絵を見比べる役を起こさない" };
    return { action: "run", judge: "human", statement: overall.text, pictures, ...(fresh.ok ? {} : { stale: fresh.reason }) };
  }
  if (!pictures.length) return { action: "must", reason: `compare/ に判定する画面の絵がありません（${compareDirOf(rec)}）`, statement: overall.text, pictures };
  if (!fresh.ok) return { action: "must", reason: fresh.reason ?? `${compareDirOf(rec)} の絵は head の画面と言えません`, statement: overall.text, pictures };
  return { action: "run", judge: "viewer", statement: overall.text, pictures };
}
