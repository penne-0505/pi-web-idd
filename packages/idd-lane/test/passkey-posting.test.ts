import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approveOutbound, createOutbound, outboundContentFor, readOutbound, resolveOutboundFinal, type Approval, type FinalText, type Poster, type Rewriter } from "../src/outbound.ts";
import { createChallenge, createRegistrationOptions, finishRegistration } from "../../idd-core/src/passkey.ts";
import { softwareAuthenticator } from "../../idd-core/test/passkey-fixture.mjs";
import { isolateRepos, ownRepos } from "./helpers/repos.ts";

const ORIGIN = "http://localhost:30142";
const RP_ID = "localhost";
const rewriter: Rewriter = async (_kind, text) => ({ text, role: "rewriter", model: "m" });

/** rewrite a record on disk, the way another process could between the challenge and the approval */
function rewriteRecord(id: string, patch: (rec: Record<string, unknown>) => void) {
  const path = join(process.env.IDD_STATE_DIR as string, "outbound", `${id}.json`);
  const rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { target: Record<string, unknown>; parts?: Record<string, unknown>[] };
  patch(rec);
  writeFileSync(path, JSON.stringify(rec));
}

let auth: ReturnType<typeof softwareAuthenticator>;

isolateRepos();

beforeEach(async () => {
  process.env.IDD_STATE_DIR = mkdtempSync(join(tmpdir(), "idd-passkey-post-"));
  auth = softwareAuthenticator();
  const { nonce, options } = createRegistrationOptions();
  const done = await finishRegistration({ nonce, response: auth.registration({ challenge: String(options.challenge), origin: ORIGIN, rpId: RP_ID }), name: "test", localScreen: true });
  if (!done.ok) throw new Error(done.error);
});

/** the signature the page would make for this exact approval over this record */
function signatureFor(final: Approval, rec: { id: string }) {
  const record = readOutbound(rec.id);
  if (!record) throw new Error("no record");
  const resolved = resolveOutboundFinal(record, final);
  if (!resolved.ok) throw new Error(resolved.error);
  const content = outboundContentFor(record, resolved.text, resolved.event);
  const { nonce, challenge } = createChallenge(content);
  return { nonce, assertion: auth.assertion({ challenge, origin: ORIGIN, rpId: RP_ID }) };
}

describe("a posting is signed over exactly what goes out", () => {
  test("an approval that matches its signature posts; a changed body or title is refused and nothing is posted", async () => {
    const calls: FinalText[] = [];
    const poster: Poster = async (_rec, final) => { calls.push(final); return { url: "https://github.com/o/r/issues/1" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b" }, rewriter);
    const signed = signatureFor({ title: "T", body: "本文" }, rec);
    const done = await approveOutbound(rec.id, { title: "T", body: "本文", ...signed }, poster);
    expect(done.status).toBe("posted");
    expect(calls).toEqual([{ title: "T", body: "本文" }]);
  });

  test("a body changed after the signature does not post", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b" }, rewriter);
    const signed = signatureFor({ title: "T", body: "署名した本文" }, rec);
    await expect(approveOutbound(rec.id, { title: "T", body: "別の本文", ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("a review whose kind (event) or labels were changed after the signature does not post", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "o/r", pr: 7, expectHead: "abc", event: "comment" }, title: "T", body: "b" }, rewriter);
    const signed = signatureFor({ title: "T", body: "本文", event: "approve" }, rec);
    // the event was part of what was signed: the same text as a comment is refused
    await expect(approveOutbound(rec.id, { title: "T", body: "本文", event: "comment", ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
    // the signed kind goes through
    const again = await approveOutbound(rec.id, { title: "T", body: "本文", event: "approve", ...signatureFor({ title: "T", body: "本文", event: "approve" }, rec) }, poster);
    expect(again.status).toBe("posted");
    expect(calls).toBe(1);
  });

  test("the challenge is built from the same normalized text the gate writes, so whitespace and unkept labels match", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    // the card sends the title with spaces and the review labels as it shows them; both sides trim/keep the same
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "o/r", pr: 7, expectHead: "abc", event: "comment" }, title: "T", body: "b" }, rewriter);
    const final: Approval = { title: "  題  ", body: "本文", event: "comment", labels: { remove: [], add: [] } };
    const signed = signatureFor(final, rec);
    const done = await approveOutbound(rec.id, { ...final, ...signed }, poster);
    expect(done.status).toBe("posted");
    expect(calls).toBe(1);
    expect(readOutbound(rec.id)?.final?.title).toBe("題");
  });

  test("a review whose title changed after the signature does not post", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "o/r", pr: 7, expectHead: "abc", event: "comment" }, title: "T", body: "b" }, rewriter);
    const signed = signatureFor({ title: "T", body: "本文", event: "comment" }, rec);
    await expect(approveOutbound(rec.id, { title: "T2", body: "本文", event: "comment", ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("a review whose labels changed after the signature does not post", async () => {
    // the signature is the subject, not the registry: the repo asks for the swap that the approval then edits
    ownRepos("repos:\n  Dayseum/daysai-flutter:\n    upstream: /u/flutter\n    work: /w/flutter\n    review_labels:\n      comment: { remove: [awaiting review], add: [feedback] }\n");
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-pr-review", target: { repo: "Dayseum/daysai-flutter", pr: 7, expectHead: "abc", event: "comment" }, title: "T", body: "b" }, rewriter);
    const signedFinal: Approval = { title: "T", body: "本文", event: "comment", labels: { remove: ["awaiting review"], add: ["feedback"] } };
    const signed = signatureFor(signedFinal, rec);
    // the approval keeps only the addition: the labels were part of what was signed
    await expect(approveOutbound(rec.id, { ...signedFinal, labels: { remove: [], add: ["feedback"] }, ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("an Issue whose labels are rewritten after the signature does not post", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r", labels: ["bug"] }, title: "T", body: "b" }, rewriter);
    const signed = signatureFor({ title: "T", body: "本文" }, rec);
    rewriteRecord(rec.id, (r) => { r.target.labels = ["bug", "security"]; });
    await expect(approveOutbound(rec.id, { title: "T", body: "本文", ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("a reply whose destination thread is rewritten after the signature is not posted", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-pr-replies", target: { repo: "o/r", pr: 7, expectHead: "abc" }, title: "T", body: "", parts: [{ ref: "C-1", label: "alice", quote: "> said", draft: "直しました", resolve: true, thread_id: "THREAD-1" }], noRewrite: true }, rewriter);
    const final: Approval = { title: rec.title, body: "", parts: [{ ref: "C-1", body: "直しました", resolve: true }] };
    const signed = signatureFor(final, rec);
    rewriteRecord(rec.id, (r) => { (r.parts ?? [])[0].thread_id = "THREAD-OTHER"; });
    await expect(approveOutbound(rec.id, { ...final, ...signed }, poster)).rejects.toThrow(/中身/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });

  test("an approval with no signature at all is refused and nothing is posted", async () => {
    let calls = 0;
    const poster: Poster = async () => { calls += 1; return { url: "u" }; };
    const rec = await createOutbound({ kind: "gh-issue", target: { repo: "o/r" }, title: "T", body: "b" }, rewriter);
    await expect(approveOutbound(rec.id, { title: "T", body: "b" }, poster)).rejects.toThrow(/署名/);
    expect(calls).toBe(0);
    expect(readOutbound(rec.id)?.status).toBe("ready");
  });
});
