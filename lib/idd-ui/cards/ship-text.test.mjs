import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { followDraft, pushLine, offersCheck, commitMessageProblem, commitVocabularyNotes, shipApproval, commitSubject, approvalText, branchGoneLine, conflictForecastLine, waitingLanesLine, shipCardKey, shipConfirmKey, confirmCommitText } = await jiti.import("./ship-text.ts");

test("a PR draft that arrives while the submit card is open replaces the text only if penne has not edited it", () => {
  const draft = { title: "docs: keep the files", body: "Closes #1" };
  assert.deepEqual(followDraft({ title: "docs(public): 一覧", body: "- a", touched: false }, draft), draft);
  assert.deepEqual(followDraft({ title: "my title", body: "my body", touched: true }, draft), { title: "my title", body: "my body" });
});

test("the submit card tells a PR check that failed after the push from a push that failed", () => {
  const pushed = { branch: "idd/x", commit: "0123456789abcdef" };
  const retrying = pushLine({ pushed, existingPr: { url: "u", number: 5 }, prCheckFailed: "connection reset by peer" });
  assert.match(retrying, /push 済み/);
  assert.match(retrying, /PR #5 の確認に失敗/);
  assert.match(retrying, /connection reset by peer/);
  assert.match(retrying, /10 分/);
  assert.doesNotMatch(retrying, /push に失敗/);
  assert.match(pushLine({ pushed, existingPr: { url: "u", number: 5 } }), /見つかっていません/);
  assert.match(pushLine({ pushed }), /PR はまだ作っていません/);
  assert.match(pushLine({ pushed, pushHeld: "base が違う" }), /base が違う/);
  assert.equal(pushLine({ pushHeld: "検査が通らない" }), "push を保留しています: 検査が通らない");
  assert.match(pushLine({}), /検査が通ると/);
});

test("a pushed submit whose settings or Git destination changed since says why and offers the check again, which the pushed card otherwise does not", () => {
  const pushed = { branch: "idd/IDD-1", commit: "0123456789abcdef" };
  const recheck = "提出先の設定が変更されました";
  assert.equal(typeof offersCheck, "function");
  assert.equal(offersCheck({ pushed }, false), false, "a pushed submit waits for the PR's approval");
  assert.equal(offersCheck({ pushed, recheck }, false), true);
  assert.equal(offersCheck({}, false), true);
  assert.equal(offersCheck({}, true), false, "a local completion ready to go is approved, not checked");
  const line = pushLine({ pushed, recheck });
  assert.match(line, /push 済み/);
  assert.match(line, /提出先の設定が変更されました/);
  assert.match(line, /検査し直/);
  // what stopped the tick after the push is still named with it
  assert.match(pushLine({ pushed, recheck, pushHeld: "push の後の確認で止まりました" }), /push の後の確認で止まりました/);
});

// --- push のたびの承認（2026-09-26） ---

test("a commit message with a word of the records, or an empty one, cannot be approved; a word the repo allows can", () => {
  assert.match(commitMessageProblem("", []) ?? "", /空/);
  assert.match(commitMessageProblem("  \n", []) ?? "", /空/);
  const flagged = commitMessageProblem("fix: DEC-001 の対応を本 lane で直す", []);
  assert.match(flagged ?? "", /語彙/);
  assert.match(flagged ?? "", /DEC-001/);
  assert.match(flagged ?? "", /本 lane/);
  assert.equal(commitMessageProblem("fix: 本 lane の表示を直す", ["本 lane"]), null);
  assert.equal(commitMessageProblem("fix: 表示を直す\n\n説明", []), null);
});

test("an English word of the workflow in the commit message is a warning on the card, not a stop of the approval", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "feat: t", body: "b" } };
  const card = (commitMessage) => ({ title: "feat: 題", body: "本文", commitMessage, vocabAllow: [] });
  const overlay = shipApproval({ proposal }, card("feat(IllustCrop): overlay の位置を直す"));
  assert.equal(overlay.ready, true, overlay.why);
  assert.equal(shipApproval({ proposal, existingPr: { number: 3 } }, card("fix: record focused view state before the handoff")).ready, true);
  assert.equal(shipApproval({ proposal }, card("feat: DEC-001 を入れる")).ready, false);
  // what the card says under the commit message: the stop for an ID or a Japanese word, the warning for an English word
  const both = commitVocabularyNotes("feat: DEC-001 の overlay", []);
  assert.match(both.block ?? "", /DEC-001/);
  assert.match(both.block ?? "", /承認できません/);
  assert.match(both.warn ?? "", /overlay/);
  assert.doesNotMatch(both.warn ?? "", /承認できません/);
  assert.deepEqual(commitVocabularyNotes("feat(IllustCrop): overlay の位置を直す", []).block, undefined);
  assert.match(commitVocabularyNotes("feat(IllustCrop): overlay の位置を直す", []).warn ?? "", /overlay/);
  assert.deepEqual(commitVocabularyNotes("feat: overlay", ["overlay"]), {});
  assert.deepEqual(commitVocabularyNotes("fix: 表示を直す", []), {});
});

test("the submit card approves a new PR with its title, body and commit message together, and not while the commit message fails the check", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "feat: t", body: "b" } };
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更", vocabAllow: [] };
  const ok = shipApproval({ proposal }, card);
  assert.equal(ok.kind, "new-pr");
  assert.equal(ok.ready, true, ok.why);
  const flagged = shipApproval({ proposal }, { ...card, commitMessage: "feat: DEC-001 の変更" });
  assert.equal(flagged.ready, false);
  assert.match(flagged.why ?? "", /語彙/);
  assert.equal(shipApproval({ proposal }, { ...card, commitMessage: "" }).ready, false);
  assert.equal(shipApproval({ proposal }, { ...card, title: " " }).ready, false);
  assert.equal(shipApproval({ proposal: { ...proposal, blocking: 1 } }, card).ready, false);
  assert.equal(shipApproval({}, card).ready, false, "nothing checked yet");
});

test("a push to the lane's open PR is approved with its commit message only; a pushed submit makes its PR with the title and body only", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" } };
  const toPr = shipApproval({ proposal, existingPr: { number: 5 } }, { title: "", body: "", commitMessage: "fix: 直し" });
  assert.deepEqual([toPr.kind, toPr.ready], ["push-to-pr", true]);
  assert.equal(shipApproval({ proposal, existingPr: { number: 5 } }, { title: "", body: "", commitMessage: "fix: 記録側の指摘" }).ready, false);
  // an English word of the workflow is a warning on the card, not a stop
  assert.equal(shipApproval({ proposal, existingPr: { number: 5 } }, { title: "", body: "", commitMessage: "fix: R2 の指摘" }).ready, true);
  const prOnly = shipApproval({ proposal, pushed: { branch: "b", commit: "c" } }, { title: "feat: 題", body: "本文", commitMessage: "" });
  assert.deepEqual([prOnly.kind, prOnly.ready], ["pr-only", true]);
  assert.equal(shipApproval({ proposal: { ...proposal, mode: "local" } }, { title: "t", body: "b", commitMessage: "" }).kind, "local");
});

test("the submit card no longer says a push goes out without an approval", () => {
  assert.doesNotMatch(pushLine({}), /承認なし/);
  assert.doesNotMatch(pushLine({ pushed: { branch: "b", commit: "0123456789" } }), /承認なし/);
});

// --- blind review round 7 ---

test("the card names a commit by its first line with text, as the approval trims it", () => {
  assert.equal(typeof commitSubject, "function");
  assert.equal(commitSubject("\n\n  feat: 前に空行\n\n本文"), "feat: 前に空行");
  assert.equal(commitSubject("fix: 直す"), "fix: 直す");
  assert.equal(commitSubject("  \n"), "");
});

test("a lane whose branch is gone after its PR merged or closed is approved as a new branch with a new PR, and the card says why", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" } };
  // buildSubmit leaves out the lane's PR when its branch is gone: the approval is a new PR's
  const approval = shipApproval({ proposal }, { title: "fix: 題", body: "本文", commitMessage: "fix: 直し" });
  assert.equal(approval.kind, "new-pr");
  assert.equal(typeof branchGoneLine, "function");
  const merged = branchGoneLine({ branchGone: { pr: 3, merged: true } });
  assert.match(merged, /PR #3/);
  assert.match(merged, /merge 済み/);
  assert.match(merged, /新しい PR/);
  const closed = branchGoneLine({ branchGone: { pr: 3, merged: false } });
  assert.match(closed, /閉じ/);
  assert.match(closed, /公開本流の上/);
  assert.match(branchGoneLine({ branchGone: { merged: false } }), /公開 branch が消えて/);
  assert.equal(branchGoneLine({}), "");
});

test("after the PR check failed on a lane whose PR is open, the approval records the push on that PR, and its button says so", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" } };
  const pushed = { branch: "b", commit: "c" };
  const again = shipApproval({ proposal, pushed, existingPr: { number: 5 }, prCheckFailed: "connection reset by peer" }, { title: "", body: "", commitMessage: "" });
  assert.deepEqual([again.kind, again.ready], ["record-on-pr", true], again.why);
  assert.equal(typeof approvalText, "function");
  const text = approvalText(again, 5);
  assert.match(text.label, /PR #5/);
  assert.doesNotMatch(text.label, /PR を作る/);
  assert.doesNotMatch(text.confirm, /PR を作る/);
  // a pushed submit without an open PR still makes its PR
  const prOnly = shipApproval({ proposal, pushed }, { title: "feat: 題", body: "本文", commitMessage: "" });
  assert.match(approvalText(prOnly).label, /PR を作る/);
});

test("a checked submit past its approval window cannot be approved: the card asks for the check again", () => {
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更" };
  const now = Date.parse("2026-09-26T12:00:00Z");
  const expired = shipApproval({ proposal: { mode: "publish", blocking: 0, pr: { title: "t", body: "b" }, expiresAt: "2026-09-26T11:59:59Z" } }, card, now);
  assert.equal(expired.ready, false);
  assert.match(expired.why ?? "", /期限/);
  const valid = shipApproval({ proposal: { mode: "publish", blocking: 0, pr: { title: "t", body: "b" }, expiresAt: "2026-09-27T11:59:59Z" } }, card, now);
  assert.equal(valid.ready, true, valid.why);
});


test("an expired check says the tick checks it again only when the tick will: not while the push is held at this head", () => {
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更" };
  const now = Date.parse("2026-09-26T12:00:00Z");
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" }, expiresAt: "2026-09-26T11:59:59Z" };
  assert.match(shipApproval({ proposal }, card, now).why ?? "", /tick も次の回で検査し直します/);
  const held = shipApproval({ proposal, pushHeld: "レビューの後に公開側の変更があります" }, card, now);
  assert.equal(held.ready, false);
  assert.match(held.why ?? "", /期限/);
  assert.doesNotMatch(held.why ?? "", /tick も/, "a held lane is not checked again by the tick");
});

test("a check made at another head than the lane's cannot be approved: the card asks for the check again", () => {
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更" };
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" }, head: "aaa111" };
  const stale = shipApproval({ proposal, head: "bbb222" }, card);
  assert.equal(stale.ready, false);
  assert.match(stale.why ?? "", /検査し直/);
  assert.equal(shipApproval({ proposal, head: "aaa111" }, card).ready, true);
  assert.equal(shipApproval({ proposal: { ...proposal, mode: "local" }, head: "bbb222" }, { ...card, title: "t", body: "b" }).ready, false, "a local completion too");
});

test("the submit card is keyed by the submit (the lane's head), so an edit of one submit is not carried to the next", () => {
  const a = shipCardKey({ iddId: "IDD-1", head: "aaa111", proposal: { head: "aaa111", token: "t1" } });
  assert.notEqual(a, shipCardKey({ iddId: "IDD-1", head: "bbb222", proposal: { head: "aaa111", token: "t1" } }), "the lane moved on");
  assert.equal(a, shipCardKey({ iddId: "IDD-1", head: "aaa111", proposal: { head: "aaa111", token: "t2" } }), "checked again at the same head keeps penne's edits");
  assert.notEqual(a, shipCardKey({ iddId: "IDD-2", head: "aaa111" }));
  assert.equal(typeof shipCardKey({ iddId: "IDD-1" }), "string");
  // the lane's head reaches the card
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../../../packages/idd-engine/src/server/state.ts"), /submit\.head \? \{ head: submit\.head \}/);
});

// --- blind review round 9 ---

test("the confirm of the approval is for what it sends: a new check (token), a commit message replaced by the draft or edited, or the PR text changed is another confirm", () => {
  const sent = { token: "t1", kind: "new-pr", commitMessage: "feat: 下書き", title: "feat: 題", body: "本文" };
  const a = shipConfirmKey(sent);
  assert.equal(a, shipConfirmKey({ ...sent }), "the same approval keeps its confirm open");
  assert.notEqual(a, shipConfirmKey({ ...sent, token: "t2" }), "checked again at the same head");
  assert.notEqual(a, shipConfirmKey({ ...sent, commitMessage: "feat: 届いた下書き" }), "the draft arrived while the confirm was open");
  assert.notEqual(a, shipConfirmKey({ ...sent, title: "feat: 別の題" }));
  assert.notEqual(a, shipConfirmKey({ ...sent, body: "別の本文" }));
  assert.notEqual(a, shipConfirmKey({ ...sent, kind: "push-to-pr" }));
  // the text a push does not send does not close its confirm
  const toPr = { ...sent, kind: "push-to-pr" };
  assert.equal(shipConfirmKey(toPr), shipConfirmKey({ ...toPr, title: "feat: 別の題" }));
  const prOnly = { ...sent, kind: "pr-only" };
  assert.equal(shipConfirmKey(prOnly), shipConfirmKey({ ...prOnly, commitMessage: "feat: 別" }));
});

test("the confirm of a push shows the whole commit message as the commit carries it, not only its subject", () => {
  assert.equal(confirmCommitText("new-pr", "\n\nfeat: 題\n\n本文の 1 行目\n本文の 2 行目\n\n"), "feat: 題\n\n本文の 1 行目\n本文の 2 行目");
  assert.equal(confirmCommitText("push-to-pr", "fix: 直す\n\n理由"), "fix: 直す\n\n理由");
  for (const kind of ["pr-only", "record-on-pr", "local"]) assert.equal(confirmCommitText(kind, "feat: x"), null, kind);
});

test("a repo that does not publish approves the landing", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const card = { title: "t", body: "b", commitMessage: "" };
  const ready = shipApproval({ land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future }, head: "abc" }, card);
  assert.equal(ready.kind, "land");
  assert.equal(ready.ready, true);
  // another head, an expired check, a failing check and a conflict all refuse
  for (const item of [
    { land: { blocking: 0, head: "old", mergeCommit: "def", expiresAt: future }, head: "abc" },
    { land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: "2000-01-01T00:00:00Z" }, head: "abc" },
    { land: { blocking: 1, head: "abc", mergeCommit: "def", expiresAt: future }, head: "abc" },
    { land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future, conflict: ["app.txt"] }, head: "abc" },
  ]) assert.equal(shipApproval(item, card).ready, false, JSON.stringify(item));
  assert.equal(shipApproval({ landBlocked: "work 側が dirty" }, card).ready, false);
  // an approval already in force and owed: the card says so, with the tick's reason, and asks for nothing again
  const waiting = shipApproval({ land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future }, head: "abc", landPending: { hold: "work 側の checkout に commit していない変更があります" } }, card);
  assert.equal(waiting.ready, false);
  assert.match(String(waiting.why), /merge 待ち/);
  assert.match(String(waiting.why), /commit していない変更/);
  const bare = shipApproval({ land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future }, head: "abc", landPending: {} }, card);
  assert.equal(bare.ready, false);
  assert.match(String(bare.why), /merge 待ち/);
  assert.equal(approvalText({ kind: "land" }).label, "work 側の本流へ merge する");
});

test("AC-002: a land card with no record for this head says the head is being checked, and offers no check", () => {
  const card = { title: "t", body: "b", commitMessage: "" };
  // a lane nothing was checked for yet and one whose record was made at another head reach the card the same way
  const approval = shipApproval({ land: null, head: "abc" }, card);
  assert.equal(approval.kind, "land");
  assert.equal(approval.ready, false);
  assert.match(String(approval.why), /検査中/);
  assert.match(String(approval.why), /head/);
  // the check cannot be run from the card: the tick checks this head, and the record of another head is not reused
  assert.equal(offersCheck({ land: null }, false), false);
});

test("a passing land card offers no check, and fields the R2 gate once carried change nothing (R2 removed 2026-10-22)", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const card = { title: "t", body: "b", commitMessage: "" };
  const land = { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future };
  assert.deepEqual(shipApproval({ land, head: "abc", r2Gate: { must: 1, should: 0 }, r2Hold: "x" }, card), { kind: "land", ready: true });
  assert.deepEqual(approvalText({ kind: "land" }), { label: "work 側の本流へ merge する", confirm: "merge する" });
  // the landing is checked by the tick: neither a checked, an unchecked nor a blocked land card offers the check
  assert.equal(offersCheck({ land }, false), false);
  assert.equal(offersCheck({ land: null }, false), false);
  assert.equal(offersCheck({ landBlocked: "work 側が dirty" }, false), false);
});

test("a land card whose check is running says so, asks for no approval, and offers no second check (C-144-8)", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const card = { title: "t", body: "b", commitMessage: "" };
  const item = { land: null, head: "abc", landChecking: "検査中です。終わると承認できます" };
  const approval = shipApproval(item, card);
  assert.equal(approval.kind, "land");
  assert.equal(approval.ready, false, "nothing is checked yet, so there is nothing to approve");
  assert.match(String(approval.why), /検査中/);
  assert.equal(offersCheck(item, false), false, "a second check of the same head would say nothing new");
  // the same card once the run wrote its result: the approval is offered from that record
  const checked = { land: { blocking: 0, head: "abc", mergeCommit: "def", expiresAt: future }, head: "abc" };
  assert.equal(shipApproval(checked, card).ready, true);
  // a check running over a record of the same head is read as checking, not as the old result
  assert.equal(shipApproval({ ...checked, landChecking: "検査中です。終わると承認できます" }, card).ready, false);
});

test("a land card offers the check exactly while a blocking check failed (AC-007 / AC-008)", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const base = { iddId: "IDD-1", branch: "idd/IDD-1", head: "abc", workBase: "work", mainTip: "def", mergeCommit: "0123456789abcdef", checks: [], blocking: 0, token: "tok", expiresAt: future, configKey: "cfg", status: "prepared" };
  // AC-007: a failing test and a timeout are not told apart: either leaves a blocking check failed
  assert.equal(offersCheck({ land: { ...base, blocking: 1 } }, false), true);
  assert.equal(offersCheck({ land: { ...base, blocking: 3 } }, false), true);
  // AC-008: all checks passed, or the landing cannot be checked now
  assert.equal(offersCheck({ land: { ...base, blocking: 0 } }, false), false);
  assert.equal(offersCheck({ land: { ...base, blocking: 1, reason: "本流と衝突しています" } }, false), false);
  assert.equal(offersCheck({ land: { ...base, blocking: 1 }, landPending: {} }, false), false);
  assert.equal(offersCheck({ land: { ...base, blocking: 1 }, landPending: { hold: "work 側が dirty" } }, false), false);
  assert.equal(offersCheck({ land: { ...base, blocking: 1 }, landBlocked: "work 側が dirty" }, false), false);
  assert.equal(offersCheck({ land: null }, false), false);
  // a local completion ready to go is approved, not checked, even with a failed check
  assert.equal(offersCheck({ land: { ...base, blocking: 1 } }, true), false);
  // a publishing repo's card is unchanged
  assert.equal(offersCheck({}, false), true);
  assert.equal(offersCheck({ pushed: { branch: "b", commit: "c" } }, false), false);
  assert.equal(offersCheck({ pushed: { branch: "b", commit: "c" }, recheck: "設定が変わった" }, false), true);
});

test("the landing card's forecast is one line that names the mainline, the other card and the file", () => {
  const line = conflictForecastLine({ conflictForecast: { mainline: { conflict: false, files: [] }, others: [{ lane: "IDD-2", conflict: true, files: ["app.txt", "TODO.md", "a.ts", "b.ts", "c.ts"] }] } });
  assert.equal(typeof line, "string");
  assert.equal(line.includes("\n"), false, "one line");
  assert.match(line, /今の本流とは衝突しない/);
  assert.match(line, /IDD-2/);
  assert.match(line, /app\.txt/);
  assert.match(line, /ほか 2 件/);
  // nothing conflicts with anyone
  const quiet = conflictForecastLine({ conflictForecast: { mainline: { conflict: false, files: [] }, others: [{ lane: "IDD-2", conflict: false, files: [] }] } });
  assert.match(quiet, /先に取り込む card とも衝突しない/);
  // the mainline itself conflicts
  const now = conflictForecastLine({ conflictForecast: { mainline: { conflict: true, files: ["app.txt"] }, others: [] } });
  assert.match(now, /今の本流と衝突（app\.txt）/);
  // no forecast: no line
  assert.equal(conflictForecastLine({}), null);
});

test("the submit card tells penne which lanes this landing would release, and says nothing when none waits", () => {
  assert.equal(waitingLanesLine({}), null);
  assert.equal(waitingLanesLine({ waitingLanes: [] }), null);
  const line = waitingLanesLine({ waitingLanes: [{ lane: "IDD-2", files: ["app.txt"] }, { lane: "IDD-3", files: ["b.ts"] }] });
  assert.equal(typeof line, "string");
  assert.equal(line.includes("\n"), false, "one line");
  assert.match(line, /IDD-2 を待たせている/);
  assert.match(line, /IDD-3 を待たせている/);
  // a lane with a place shows it; a lane without one reads as it always did
  const placed = waitingLanesLine({ waitingLanes: [{ lane: "IDD-A", files: ["app.txt"], rank: 2 }, { lane: "IDD-B", files: ["b.ts"] }] });
  assert.match(placed, /IDD-A（2 番目）を待たせている/);
  assert.match(placed, /IDD-B を待たせている/);
});

test("a push is approved as a plain push: fields the R2 gate once carried change nothing (R2 removed 2026-10-22)", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "t", body: "b" } };
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更" };
  const plain = shipApproval({ proposal }, card);
  assert.deepEqual(plain, { kind: "new-pr", ready: true });
  assert.deepEqual(shipApproval({ proposal, r2Gate: { must: 1, should: 0 }, r2Hold: "idd r2-record" }, card), plain);
  assert.deepEqual(approvalText(plain), approvalText({ kind: "new-pr" }));
});

// --- Issue #231: what holds the signature is named, and a title waiting for the draft is not a commit message ---

test("the approval of a push or a landing says which checks hold it, whether they failed or did not run, and never only how many", () => {
  const checks = [
    { name: "typecheck", status: "pass", severity: "blocking" },
    { name: "check-mutation", status: "fail", severity: "blocking", detail: "検査が提出内容を変更しました:\n M a.pyc\n変えた path 1 件。うち追跡されたバイナリ（生成物）1 件: a.pyc" },
    { name: "unittest", status: "skipped", severity: "blocking" },
    { name: "docs", status: "fail", severity: "non-blocking", detail: "x" },
  ];
  const proposal = { mode: "publish", blocking: 2, checks, pr: { title: "t", body: "b" } };
  const card = { title: "feat: 題", body: "本文", commitMessage: "feat: 変更", vocabAllow: [] };
  const held = shipApproval({ proposal }, card);
  assert.equal(held.ready, false);
  assert.equal(held.why, "止めている検査: check-mutation（変えた path 1 件。うち追跡されたバイナリ（生成物）1 件: a.pyc）、unittest（未実行）");
  assert.deepEqual(held.blocking.map((b) => [b.name, b.status]), [["check-mutation", "fail"], ["unittest", "skipped"]]);
  // a local completion held by a check is held by that check, not by "a different text"
  assert.match(shipApproval({ proposal: { ...proposal, mode: "local" } }, card).why ?? "", /^止めている検査: check-mutation/);
  const landed = shipApproval({ land: { blocking: 1, checks: [checks[1]], mergeCommit: "m" } }, card);
  assert.match(landed.why ?? "", /^止めている検査: check-mutation/);
  assert.equal(landed.blocking.length, 1);
  // a record of the older shape that kept only the count can still say how many
  assert.equal(shipApproval({ proposal: { mode: "publish", blocking: 2, pr: proposal.pr } }, card).why, "止める検査が 2 件あります");
  // when nothing blocks, no check is named
  const clear = shipApproval({ proposal: { ...proposal, blocking: 0, checks: [checks[0]] } }, card);
  assert.equal(clear.ready, true);
  assert.equal(clear.blocking, undefined);
});

test("a push is not approvable while its commit message is still being drafted, and a message penne wrote or the repo's own form is", () => {
  const proposal = { mode: "publish", blocking: 0, pr: { title: "Summary", body: "b" } };
  const card = (commitMessage) => ({ title: "Summary", body: "b", commitMessage, vocabAllow: [] });
  const waiting = shipApproval({ proposal, commit: { pending: true } }, card(""));
  assert.equal(waiting.ready, false);
  assert.match(waiting.why ?? "", /下書きを作っている途中/);
  assert.doesNotMatch(waiting.why ?? "", /Summary/);
  // the submit card has no field to write a message in, so the wait does not invite one
  assert.doesNotMatch(waiting.why ?? "", /自分で書|書いても/);
  assert.equal(shipApproval({ proposal, commit: { pending: true } }, card("feat: 自分で書いた")).ready, true);
  assert.equal(shipApproval({ proposal, commit: { draft: "feat: 下書き" } }, card("feat: 下書き")).ready, true);
  // a submit that is not pushing a commit does not wait for one
  assert.equal(shipApproval({ proposal, pushed: { branch: "b", commit: "c" }, commit: { pending: true } }, card("")).ready, true);
});
