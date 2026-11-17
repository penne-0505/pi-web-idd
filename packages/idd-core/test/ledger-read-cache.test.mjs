import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import fs, { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import { readBacklog, readLifecycle, readSessions } from "../src/ledger/read.ts";
import { readOpenQuestions } from "../src/plan/ledger-reads.ts";
import { readRows } from "../src/intent/store.ts";
import { ColumnUnreadable, jsonlCacheRevision, readJsonlCached, readJsonlColumn, resetJsonlCache, statColumn } from "../src/ledger/read-cache.ts";

/**
 * The reading keeps what it already parsed, so every case here compares it against the answer the whole file gives
 * at that same moment: the copy may only ever answer what the file holds. The interesting cases are the ones where
 * a cheap guess about "nothing moved" or "only the end moved" would be wrong — another process appending, a line
 * that is not finished yet, a new repo's file appearing, and a file made over from the top.
 */

let savedState;
let dir;

beforeEach(() => {
  savedState = process.env.IDD_STATE_DIR;
  dir = scratchDir("ledger-read-cache-");
  process.env.IDD_STATE_DIR = dir;
  resetJsonlCache();
});

afterEach(() => {
  if (savedState === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = savedState;
  resetJsonlCache();
  rmSync(dir, { recursive: true, force: true });
});

const at = (n) => `2026-10-18T00:0${n}:00.000Z`;

function row(iddId, event, n, attrs = {}) {
  return { idd_id: iddId, event, at: at(n), attrs };
}

/** the answer the whole ledger gives right now: every lifecycle file, joined, oldest first */
function wholeLedger() {
  return readdirSync(dir)
    .filter((f) => f.startsWith("lifecycle-") && f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        }),
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function writeLines(name, lines, { trailing = true } = {}) {
  writeFileSync(join(dir, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}${trailing && lines.length ? "\n" : ""}`);
}

test("a file that is only appended reads as the whole file reads, whoever appended it", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0)]);
  assert.deepEqual(readLifecycle(), wholeLedger());

  // another process appends: the reading may not be keyed on this process's own writes
  const script = `require("node:fs").appendFileSync(${JSON.stringify(join(dir, "lifecycle-A.jsonl"))}, ${JSON.stringify(
    `${JSON.stringify(row("IDD-1", "s1_go", 1))}\n`,
  )})`;
  const ran = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readLifecycle(), wholeLedger());
  assert.equal(readLifecycle().length, 2);

  // this process appends too, and a second file joins
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-2", "lane_open", 2))}\n`);
  writeLines("lifecycle-B.jsonl", [row("IDD-3", "lane_open", 3)]);
  assert.deepEqual(readLifecycle(), wholeLedger());
  assert.equal(readLifecycle().length, 4);
});

test("a later line whose `at` is earlier sorts where the whole file puts it", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 5)]);
  readLifecycle();
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-1", "s1_go", 1))}\n`);
  const answer = readLifecycle();
  assert.deepEqual(answer, wholeLedger());
  assert.deepEqual(answer.map((r) => r.at), [at(1), at(5)]);
});

test("a half-written last line is held back until its line ends", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0)]);
  readLifecycle();

  // the append that is still being written: the newline has not landed, so the line is not a record yet
  appendFileSync(join(dir, "lifecycle-A.jsonl"), JSON.stringify(row("IDD-1", "s1_go", 1)).slice(0, 20));
  assert.deepEqual(readLifecycle(), wholeLedger());
  assert.equal(readLifecycle().length, 1);

  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-1", "s1_go", 1)).slice(20)}\n`);
  assert.deepEqual(readLifecycle(), wholeLedger());
  assert.deepEqual(readLifecycle().map((r) => r.event), ["lane_open", "s1_go"]);
});

test("a file made over from the top reads as the whole file reads", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0), row("IDD-1", "s1_go", 1)]);
  assert.equal(readLifecycle().length, 2);

  // the same path, different records: the rows of the old file may not survive
  writeLines("lifecycle-A.jsonl", [row("IDD-9", "lane_open", 3)]);
  assert.deepEqual(readLifecycle(), wholeLedger());

  // a rewrite that grew the file, with different records at the top
  writeLines("lifecycle-A.jsonl", [row("IDD-8", "s1_defer", 4), row("IDD-8", "lane_close", 5), row("IDD-8", "lane_open", 6)]);
  assert.deepEqual(readLifecycle(), wholeLedger());

  // and a file that is gone
  rmSync(join(dir, "lifecycle-A.jsonl"));
  assert.deepEqual(readLifecycle(), []);
});

test("the reading repeats the same answer and repeats it as a separate array", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0)]);
  const first = readLifecycle();
  const second = readLifecycle();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first.push(row("IDD-2", "lane_open", 1));
  assert.equal(readLifecycle().length, 1);
});

test("a row a caller pushes onto its answer is not in the next answer (whole read and grown read)", () => {
  writeLines("backlog.jsonl", [{ idd_id: "IDD-1" }]);
  const whole = readBacklog();
  whole.push({ idd_id: "IDD-2" });
  assert.deepEqual(readBacklog().map((r) => r.idd_id), ["IDD-1"], "a whole read answers a copy");

  // the same after the copy read on from the end: intake appends its row itself and then pushes it onto its read
  appendFileSync(join(dir, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-3" })}\n`);
  const grown = readBacklog();
  assert.deepEqual(grown.map((r) => r.idd_id), ["IDD-1", "IDD-3"]);
  grown.push({ idd_id: "IDD-4" });
  assert.deepEqual(readBacklog().map((r) => r.idd_id), ["IDD-1", "IDD-3"], "a grown read answers a copy too");
  assert.equal(readBacklog().length, 2);
});

test("the other append-only files are read the same way, and the revision follows what moved", () => {
  const sessions = join(dir, "executor-sessions.jsonl");
  writeFileSync(sessions, `${JSON.stringify({ idd_id: "IDD-1" })}\n`);
  assert.deepEqual(readSessions("executor"), [{ idd_id: "IDD-1" }]);

  const quiet = jsonlCacheRevision();
  assert.equal(jsonlCacheRevision(), quiet, "an unchanged file does not move the revision");
  assert.deepEqual(readSessions("executor"), [{ idd_id: "IDD-1" }]);
  assert.equal(jsonlCacheRevision(), quiet);

  appendFileSync(sessions, `${JSON.stringify({ idd_id: "IDD-2" })}\n`);
  assert.deepEqual(readSessions("executor").map((r) => r.idd_id), ["IDD-1", "IDD-2"]);
  assert.notEqual(jsonlCacheRevision(), quiet, "an appended file moves the revision");
});

test("the intent column reads as the whole column reads, after an append and after a rewrite", () => {
  const column = join(dir, "intent-me%2Fapp.jsonl");
  const whole = () =>
    readFileSync(column, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const parsed = JSON.parse(l);
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });

  const a = { event: "created", at: at(0), repo: "me/app", by: { lane: "IDD-1" }, id: "C-1-1" };
  writeFileSync(column, `${JSON.stringify(a)}\n`);
  assert.deepEqual(readRows(column), whole());

  const b = { event: "confirmed", at: at(1), repo: "me/app", by: { lane: "IDD-1" }, id: "C-1-1" };
  spawnSync(process.execPath, ["-e", `require("node:fs").appendFileSync(${JSON.stringify(column)}, ${JSON.stringify(`${JSON.stringify(b)}\n`)})`]);
  assert.deepEqual(readRows(column), whole());
  assert.equal(readRows(column).length, 2);

  // a row that is not an object is left out, the same as the reader that reads the whole column
  appendFileSync(column, `[1,2,3]\n"a string"\n`);
  assert.deepEqual(readRows(column), whole());
  assert.deepEqual(readRows(column).length, 2);
});

test("an unreadable or absent file answers empty rather than throwing", () => {
  assert.deepEqual(readJsonlCached(join(dir, "nope.jsonl")), []);
  assert.deepEqual(readLifecycle(), []);
  rmSync(join(dir, "lifecycle-A.jsonl"), { force: true });
  mkdirSync(join(dir, "lifecycle-C.jsonl"));
  assert.deepEqual(readLifecycle(), []);
});

const batch = (iddId, batchId) => ({
  idd_id: iddId, batch_id: batchId, asked_at: at(0),
  questions: [{ question_id: "q1", question: "どちらにしますか", context: "", options: [{ index: 1, label: "A" }] }],
});

test("a lane's unanswered question stops being waited on once the lane ends, and no row of the record moves", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0), row("IDD-2", "lane_open", 0), row("IDD-3", "lane_open", 0)]);
  writeLines("pending-questions.jsonl", [batch("IDD-1", "b1"), batch("IDD-2", "b1"), batch("IDD-3", "b1")]);
  const files = ["lifecycle-A.jsonl", "pending-questions.jsonl"];
  const before = files.map((f) => readFileSync(join(dir, f), "utf8"));
  assert.deepEqual(readOpenQuestions().map((b) => b.idd_id), ["IDD-1", "IDD-2", "IDD-3"]);

  // the read just before is what the copy holds: the close appended after it is the line it must not miss
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-1", "lane_close", 1, { outcome: "aborted" }))}\n`);
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-2", "s1_defer", 1))}\n`);
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-3", "s3_defer", 1))}\n`);
  assert.deepEqual(readOpenQuestions().map((b) => b.idd_id), []);

  // an open lane's question still waits, and the record's rows are what they were (the appended ones aside)
  appendFileSync(join(dir, "pending-questions.jsonl"), `${JSON.stringify(batch("IDD-4", "b1"))}\n`);
  appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-4", "lane_open", 2))}\n`);
  assert.deepEqual(readOpenQuestions().map((b) => b.idd_id), ["IDD-4"]);
  assert.ok(readFileSync(join(dir, files[0]), "utf8").startsWith(before[0]));
  assert.ok(readFileSync(join(dir, files[1]), "utf8").startsWith(before[1]));
});

test("a lane opened by a requeue or a redo asks as its own lane while the lane it came from stays out", () => {
  writeLines("lifecycle-A.jsonl", [
    row("IDD-1", "lane_open", 0), row("IDD-1", "lane_close", 1, { outcome: "redone" }),
    row("IDD-2", "lane_open", 2, { redo_of: "IDD-1" }),
  ]);
  writeLines("pending-questions.jsonl", [batch("IDD-1", "b1"), batch("IDD-2", "b1")]);
  assert.deepEqual(readOpenQuestions().map((b) => b.idd_id), ["IDD-2"]);
});

test("a close appended while the lifecycle is being read is in the next read, and its lane's question stops being waited on", () => {
  writeLines("lifecycle-A.jsonl", [row("IDD-1", "lane_open", 0)]);
  writeLines("pending-questions.jsonl", [batch("IDD-1", "b1")]);

  // the close lands after the read has taken its mark and before the file is opened: the read holds the rows up to
  // its own stat, so the close can only come back through the next read
  const real = fs.openSync;
  let raced = false;
  fs.openSync = (p, ...rest) => {
    if (!raced && basename(String(p)).startsWith("lifecycle-")) {
      raced = true;
      appendFileSync(join(dir, "lifecycle-A.jsonl"), `${JSON.stringify(row("IDD-1", "lane_close", 1, { outcome: "aborted" }))}\n`);
    }
    return real(p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    readLifecycle();
  } finally {
    fs.openSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(raced, true);

  assert.deepEqual(readLifecycle(), wholeLedger());
  assert.deepEqual(readLifecycle().map((r) => r.event), ["lane_open", "lane_close"]);
  assert.deepEqual(readOpenQuestions(), []);
});

test("a column read for its faults is empty only when it is not there, follows an append like the cached read, and throws when it is there and cannot be read", () => {
  const path = join(dir, "col.jsonl");
  assert.deepEqual(readJsonlColumn(path), [], "not there: no rows");
  writeFileSync(path, '{"n":1}\n');
  assert.deepEqual(readJsonlColumn(path), [{ n: 1 }]);
  appendFileSync(path, '{"n":2}\nnot json\n');
  assert.deepEqual(readJsonlColumn(path), readJsonlCached(path));
  assert.deepEqual(readJsonlColumn(path), [{ n: 1 }, { n: 2 }]);
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => readJsonlColumn(path), ColumnUnreadable, "a directory in its place is not an empty column");
  assert.deepEqual(readJsonlCached(path), [], "the cached read keeps answering an empty list for the columns it was made for");
  rmSync(path, { recursive: true });
  assert.deepEqual(readJsonlColumn(path), []);
});

test("a column whose copy is warm and whose read permission is then lost is unreadable, and reads again once the permission is back", { skip: process.getuid?.() === 0 }, () => {
  const path = join(dir, "col.jsonl");
  writeFileSync(path, '{"n":1}\n');
  assert.deepEqual(readJsonlColumn(path), [{ n: 1 }], "warm");
  assert.deepEqual(readJsonlColumn(path), [{ n: 1 }], "and answered from the copy");
  chmodSync(path, 0o000);
  try {
    assert.throws(() => readJsonlColumn(path), ColumnUnreadable, "the copy is not returned for a file that cannot be opened");
  } finally {
    chmodSync(path, 0o644);
  }
  assert.deepEqual(readJsonlColumn(path), [{ n: 1 }]);
});

test("a path that holds a link to something missing is a column that cannot be read, and is an empty column only once nothing is there", () => {
  const path = join(dir, "col.jsonl");
  symlinkSync(join(dir, "missing.jsonl"), path);
  assert.throws(() => readJsonlColumn(path), ColumnUnreadable, "a dangling link is there, and cannot be read");
  rmSync(path);
  assert.deepEqual(readJsonlColumn(path), [], "nothing at the path: not made yet");
});

test("a column made between the stat that missed it and the lstat that found it is read, and a link to nothing that stays missing is not", () => {
  const path = join(dir, "col.jsonl");
  writeFileSync(path, '{"n":1}\n');
  const real = fs.statSync(path);
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  let stats = 0;
  const raced = statColumn(path, { stat: () => { if (stats++ === 0) throw enoent(); return real; }, lstat: () => real });
  assert.equal(raced, real, "the second stat finds the column that was made in between");
  assert.equal(stats, 2, "stat is asked once more, no oftener");
  assert.throws(
    () => statColumn(path, { stat: () => { throw enoent(); }, lstat: () => real }),
    ColumnUnreadable,
    "a second miss with a path still there is the dangling link",
  );
  assert.equal(statColumn(path, { stat: () => { throw enoent(); }, lstat: () => { throw enoent(); } }), undefined, "nothing at all: not made yet");
  let n = 0;
  const failsAgainElsewise = () => {
    if (n++ === 0) throw enoent();
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  assert.throws(() => statColumn(path, { stat: failsAgainElsewise, lstat: () => real }), ColumnUnreadable, "a retry that fails for another reason is unreadable");
});
