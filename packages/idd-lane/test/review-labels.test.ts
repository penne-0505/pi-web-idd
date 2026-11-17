import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { approveOutbound, createOutbound, labelsFromPayload, readOutbound } from "../src/outbound.ts";
import { parseLaneRepos, reviewLabelRules } from "../src/repos.ts";
import { approveSigned } from "./passkey-approval.ts";
import { isolateRepos, SHIPPED_REPOS, shippedReposTest } from "./helpers/repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

isolateRepos();

beforeEach(() => {
  process.env.IDD_STATE_DIR = tmpDir("idd-labels-");
});

/** a gh that logs its arguments and answers `pr view` with the head and the PR's labels; `failEdit` makes `pr edit` fail */
function fakeGh(head: string, labels: string[], failEdit = false): { log: () => string[][] } {
  const dir = tmpDir("idd-fakegh-labels-");
  const logFile = join(dir, "calls.jsonl");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (${failEdit ? "true" : "false"} && args[0] === "pr" && args[1] === "edit") { console.error("could not add label: 'no-such-label' not found"); process.exit(1); }
if (args[0] === "pr" && args[1] === "view") { console.log(JSON.stringify({ headRefOid: ${JSON.stringify(head)}, labels: ${JSON.stringify(labels.map((name) => ({ name })))} })); process.exit(0); }
console.log("");
`);
  chmodSync(bin, 0o755);
  process.env.IDD_GH_BIN = bin;
  return { log: () => { try { return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } } };
}

async function postReviewCard(repo: string, event: "comment" | "request-changes" | "approve", labels: string[]): Promise<{ edits: string[][]; status: string }> {
  const gh = fakeGh("abc1234ffff", labels);
  const rec = await createOutbound({ kind: "gh-pr-review", target: { repo, pr: 5583, expectHead: "abc1234" }, title: "PR #5583 のレビュー", body: "本文", noRewrite: true });
  const done = await approveSigned(rec.id, { title: rec.title, body: "本文", event });
  return { edits: gh.log().filter((a) => a[0] === "pr" && a[1] === "edit"), status: done.status };
}

/** the Meltly card is posted against the registry the repo ships, which is what these tests check */
function postMeltlyCard(event: "comment" | "request-changes" | "approve", labels: string[]) {
  process.env.IDD_REPOS_FILE = SHIPPED_REPOS;
  return postReviewCard("Dayseum/daysai-flutter", event, labels);
}

describe("labels swapped with a review on Meltly (Dayseum/daysai-flutter)", () => {
  shippedReposTest("a comment or a change request moves awaiting review to feedback", async () => {
    for (const event of ["comment", "request-changes"] as const) {
      const { edits, status } = await postMeltlyCard(event, ["awaiting review", "flutter"]);
      expect(status).toBe("posted");
      expect(edits).toEqual([["pr", "edit", "5583", "--repo", "Dayseum/daysai-flutter", "--remove-label", "awaiting review", "--add-label", "feedback"]]);
    }
  });

  shippedReposTest("an approve leaves the labels to GitHub's automation", async () => {
    const { edits, status } = await postMeltlyCard("approve", ["awaiting review"]);
    expect(status).toBe("posted");
    expect(edits).toEqual([]);
  });

  shippedReposTest("a PR without awaiting review keeps its labels", async () => {
    const { edits } = await postMeltlyCard("comment", ["feedback"]);
    expect(edits).toEqual([]);
  });
});

const OWN = `repos:
  me/app:
    upstream: /u/app
    work: /w/app
    review_labels:
      comment: { remove: [waiting], add: [reviewed] }
      request_changes: { remove: [waiting, triage], add: [changes, reviewed] }
      approve: { add: [approved] }
  me/plain:
    upstream: /u/plain
    work: /w/plain
`;

function ownRepos(): void {
  const dir = tmpDir("idd-repos-");
  writeFileSync(join(dir, "repos.yaml"), OWN);
  process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
}

describe("review_labels in config/repos.yaml", () => {
  test("each kind of review has its own removals and additions; an unlisted kind or repo has none", () => {
    const repos = parseLaneRepos(OWN);
    expect(repos.app.reviewLabels).toEqual({
      comment: { remove: ["waiting"], add: ["reviewed"] },
      "request-changes": { remove: ["waiting", "triage"], add: ["changes", "reviewed"] },
      approve: { remove: [], add: ["approved"] },
    });
    expect(repos.plain.reviewLabels).toBeUndefined();
    expect(reviewLabelRules("Me/App", repos).approve?.add).toEqual(["approved"]);
    expect(reviewLabelRules("me/plain", repos)).toEqual({});
    expect(reviewLabelRules("someone/else", repos)).toEqual({});
  });

  test("a misspelt kind or key, or a label that is not a name, is refused", () => {
    const base = "repos:\n  a/b:\n    upstream: /u\n    work: /w\n    review_labels:\n";
    expect(() => parseLaneRepos(`${base}      approved: { add: [x] }\n`)).toThrow(/未知のレビューの種類/);
    expect(() => parseLaneRepos(`${base}      comment: { adds: [x] }\n`)).toThrow(/未知の項目/);
    expect(() => parseLaneRepos(`${base}      comment: { add: x }\n`)).toThrow(/配列/);
  });

  shippedReposTest("the Meltly repos carry the team's swap on comments and change requests, and none on approve", () => {
    const repos = parseLaneRepos(readFileSync(SHIPPED_REPOS, "utf8"));
    const meltly = { comment: { remove: ["awaiting review"], add: ["feedback"] }, "request-changes": { remove: ["awaiting review"], add: ["feedback"] } };
    for (const name of ["Dayseum/daysai-flutter", "Dayseum/daysai-web", "Dayseum/daysai-management"]) expect(reviewLabelRules(name, repos)).toEqual(meltly);
  });
});

describe("labels swapped with a review from the card", () => {
  test("a repo without review_labels keeps every label", async () => {
    ownRepos();
    const { edits, status } = await postReviewCard("me/plain", "comment", ["awaiting review"]);
    expect(status).toBe("posted");
    expect(edits).toEqual([]);
  });

  test("only the labels penne kept are swapped, and none when she unchecked them all", async () => {
    ownRepos();
    const gh = fakeGh("abc1234ffff", ["waiting", "triage"]);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "本文", event: "request-changes", labels: { remove: ["waiting"], add: ["reviewed"] } });
    expect(done.status).toBe("posted");
    expect(done.final?.labels).toEqual({ remove: ["waiting"], add: ["reviewed"], onlyWith: ["waiting", "triage"] });
    expect(gh.log().filter((a) => a[1] === "edit")).toEqual([["pr", "edit", "7", "--repo", "me/app", "--remove-label", "waiting", "--add-label", "reviewed"]]);

    const gh2 = fakeGh("abc1234ffff", ["waiting"]);
    const rec2 = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    expect((await approveSigned(rec2.id, { title: rec2.title, body: "本文", event: "comment", labels: { remove: [], add: [] } })).status).toBe("posted");
    expect(gh2.log().filter((a) => a[1] === "edit")).toEqual([]);
  });

  test("keeping only the addition still waits for the PR to carry a label the rule takes off", async () => {
    ownRepos();
    const gh = fakeGh("abc1234ffff", ["other"]);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    await approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment", labels: { remove: [], add: ["reviewed"] } });
    expect(gh.log().filter((a) => a[1] === "edit")).toEqual([]);
  });

  test("an approve follows the repo's rule for approve; a rule with nothing to take off always applies", async () => {
    ownRepos();
    const { edits } = await postReviewCard("me/app", "approve", []);
    expect(edits).toEqual([["pr", "edit", "5583", "--repo", "me/app", "--add-label", "approved"]]);
  });

  test("the rule of the kind penne picked last is the one checked, and a label outside it is refused unposted", async () => {
    ownRepos();
    const gh = fakeGh("abc1234ffff", ["waiting"]);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234", event: "request-changes" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    // the card still sent the change request's labels after penne switched to a comment
    await expect(approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment", labels: { remove: ["waiting"], add: ["changes"] } })).rejects.toThrow(/changes/);
    expect(gh.log()).toEqual([]);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("a registry that cannot be read refuses the post rather than dropping the labels", async () => {
    const dir = tmpDir("idd-repos-bad-");
    writeFileSync(join(dir, "repos.yaml"), "repos:\n  me/app:\n    upstream: /u\n    work: /w\n    review_labels:\n      approved: { add: [x] }\n");
    process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
    const gh = fakeGh("abc1234ffff", []);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    await expect(approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment" })).rejects.toThrow(/未知のレビューの種類/);
    expect(gh.log()).toEqual([]);
  });

  test("a label swap that fails after the review went out keeps the post as posted, with a warning, and never posts it twice", async () => {
    ownRepos();
    const gh = fakeGh("abc1234ffff", ["waiting"], true);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    const done = await approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment" });
    expect(done.status).toBe("posted");
    expect(done.posted?.warning).toMatch(/ラベル.*no-such-label/s);
    await expect(approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment" })).rejects.toThrow(/posted/);
    expect(gh.log().filter((a) => a[0] === "pr" && a[1] === "review").length).toBe(1);
  });

  test("the same label written twice in a rule is kept once", () => {
    const repos = parseLaneRepos("repos:\n  a/b:\n    upstream: /u\n    work: /w\n    review_labels:\n      comment: { remove: [x, x], add: [feedback, feedback] }\n");
    expect(repos.b.reviewLabels?.comment).toEqual({ remove: ["x"], add: ["feedback"] });
    expect(() => parseLaneRepos("repos:\n  a/b:\n    upstream: /u\n    work: /w\n    review_labels:\n      comment: { remove: [x], add: [x] }\n")).toThrow(/両方/);
  });

  test("a malformed labels payload counts as not sent, so the rule is made in full rather than dropped", async () => {
    expect(labelsFromPayload({ remove: ["waiting"], add: [] })).toEqual({ remove: ["waiting"], add: [] });
    for (const bad of [[], {}, "feedback", null, { remove: "waiting", add: [] }, { remove: [], add: [1] }, { remove: [] }]) expect(labelsFromPayload(bad)).toBeUndefined();
    ownRepos();
    const gh = fakeGh("abc1234ffff", ["waiting"]);
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "me/app", pr: 7, expectHead: "abc1234" }, title: "PR #7 のレビュー", body: "本文", noRewrite: true });
    const labels = labelsFromPayload([]);
    await approveSigned(rec.id, { title: rec.title, body: "本文", event: "comment", ...(labels ? { labels } : {}) });
    expect(gh.log().filter((a) => a[1] === "edit")).toEqual([["pr", "edit", "7", "--repo", "me/app", "--remove-label", "waiting", "--add-label", "reviewed"]]);
  });
});
