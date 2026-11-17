import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planReviewState } from "../src/plan-review.ts";
import { reviewRunState } from "../src/review-runs.ts";
import { laneDir, laneStatus, readLane, type LaneRecord } from "../src/runner.ts";
import { runTranscript } from "../src/transcript.ts";

/*
 * A run whose supervisor was lost (a reboot, a kill) keeps "running" in its record; the reading doors and
 * `idd lane status` have to close it so the tick stops waiting for it. Tests write lane.json directly under a
 * temporary state dir, and use process numbers that are already gone.
 */

const ENV_KEYS = ["IDD_STATE_DIR", "IDD_REPOS_FILE"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** a fresh state dir; lanes live at <state>/lanes/<id>/lane.json */
function useState(): string {
  const root = mkdtempSync(join(tmpdir(), "idd-run-liveness-"));
  roots.push(root);
  process.env.IDD_STATE_DIR = join(root, "state");
  process.env.IDD_REPOS_FILE = join(root, "repos.yaml");
  writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
  mkdirSync(process.env.IDD_STATE_DIR, { recursive: true });
  return process.env.IDD_STATE_DIR;
}

/** a process number that is already gone: the child exits before spawnSync returns */
function deadPid(): number {
  return spawnSync("true").pid ?? 999_999;
}

function lane(id: string, over: Partial<LaneRecord> = {}): LaneRecord {
  const dir = join(process.env.IDD_STATE_DIR!, "lanes", id);
  mkdirSync(dir, { recursive: true });
  const rec: LaneRecord = {
    id, role: "r", model: "x/y", worktree: dir, spec: "", report: join(dir, "report"),
    status: "running", started_at: new Date().toISOString(), ...over,
  };
  writeFileSync(join(dir, "lane.json"), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

function rawRecord(id: string): string {
  return readFileSync(join(laneDir(id), "lane.json"), "utf8");
}

function writeReport(rec: LaneRecord): void {
  writeFileSync(`${rec.report}.json`, JSON.stringify({ findings: [] }));
}

/** a repo with one review copy cut from it, the way the review run's meta names both */
function reviewCopy(state: string): { copy: string; source: string } {
  const source = mkdtempSync(join(tmpdir(), "idd-run-liveness-repo-"));
  roots.push(source);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: source });
  execFileSync("git", ["init", "-q", source]);
  writeFileSync(join(source, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const root = join(state, "pipeline", "review-wt");
  mkdirSync(root, { recursive: true });
  const copy = join(root, "copy1");
  git("worktree", "add", "-q", copy, "HEAD");
  return { copy, source };
}

describe("a run whose process is gone", () => {
  test("the plan review's door answers failed", () => {
    useState();
    lane("R1", { supervisor_pid: deadPid(), pid: deadPid() });
    expect(planReviewState("R1").state).toBe("failed");
  });

  test("the review run's door answers failed and cleans the run's copy", () => {
    const state = useState();
    const { copy, source } = reviewCopy(state);
    const rec = lane("RUN1", { supervisor_pid: deadPid(), pid: deadPid(), worktree: copy, report: join(copy, "report") });
    mkdirSync(join(state, "pipeline", "review-runs"), { recursive: true });
    writeFileSync(join(state, "pipeline", "review-runs", "RUN1.json"), JSON.stringify({ lane_id: "RUN1", stage: "triage", role: "judge", copy, source }));
    const st = reviewRunState("RUN1");
    expect(st.state).toBe("failed");
    expect(existsSync(rec.worktree)).toBe(false);
    expect(JSON.parse(readFileSync(join(state, "pipeline", "review-runs", "RUN1.json"), "utf8")).cleaned).toBe(true);
  });

  test("the closed record carries the failure and the reason, and a run with a report closes as done", () => {
    useState();
    lane("R1", { supervisor_pid: deadPid(), pid: deadPid() });
    const st = planReviewState("R1");
    expect(st.state).toBe("failed");
    if (st.state === "failed") expect(st.error).toBe("runner process ended before the lane finished");
    const after = readLane("R1");
    expect(after.status).toBe("failed");
    expect(after.error).toBe("runner process ended before the lane finished");

    lane("R2", { supervisor_pid: deadPid(), pid: deadPid(), report_md: true });
    expect(laneStatus("R2")[0].status).toBe("done");
  });
});

describe("a run with a live process", () => {
  test("stays running through both doors and its record is not rewritten", () => {
    useState();
    lane("R1", { supervisor_pid: process.pid, pid: deadPid() });
    const before = rawRecord("R1");
    expect(planReviewState("R1").state).toBe("running");
    expect(reviewRunState("R1").state).toBe("running");
    expect(rawRecord("R1")).toBe(before);

    lane("R2", { supervisor_pid: deadPid(), pid: process.pid });
    const r2 = rawRecord("R2");
    expect(planReviewState("R2").state).toBe("running");
    expect(reviewRunState("R2").state).toBe("running");
    expect(rawRecord("R2")).toBe(r2);
  });
});

describe("the log a close leaves", () => {
  test("one line names the close, and reading the run again adds none", () => {
    useState();
    lane("R1", { supervisor_pid: deadPid(), pid: deadPid() });
    expect(planReviewState("R1").state).toBe("failed");
    const log = join(laneDir("R1"), "supervisor.log");
    const first = readFileSync(log, "utf8");
    expect(first).toContain("[gone]");
    expect(first.trim().split("\n").length).toBe(1);
    expect(planReviewState("R1").state).toBe("failed");
    expect(readFileSync(log, "utf8")).toBe(first);
  });
});

describe("a record that finished while the process was checked", () => {
  test("is left as it ended and the door answers done", () => {
    useState();
    const p1 = lane("R1", { supervisor_pid: 111_111, pid: 111_111 });
    writeReport(p1);
    const finishPlan = () => {
      const cur = readLane("R1");
      cur.status = "done";
      writeFileSync(join(laneDir("R1"), "lane.json"), `${JSON.stringify(cur, null, 2)}\n`);
      return false;
    };
    expect(planReviewState("R1", { alive: finishPlan }).state).toBe("done");
    expect(readLane("R1").status).toBe("done");

    const p2 = lane("R2", { supervisor_pid: 222_222, pid: 222_222 });
    writeReport(p2);
    const finishReview = () => {
      const cur = readLane("R2");
      cur.status = "done";
      writeFileSync(join(laneDir("R2"), "lane.json"), `${JSON.stringify(cur, null, 2)}\n`);
      return false;
    };
    expect(reviewRunState("R2", { alive: finishReview }).state).toBe("done");
    expect(readLane("R2").status).toBe("done");
  });
});

describe("a record that names no process", () => {
  test("stays running inside the start grace", () => {
    useState();
    const started = new Date(Date.now() - 10_000).toISOString();
    lane("R1", { started_at: started });
    const before = rawRecord("R1");
    expect(planReviewState("R1", { now: Date.parse(started) + 10_000 }).state).toBe("running");
    expect(reviewRunState("R1", { now: Date.parse(started) + 10_000 }).state).toBe("running");
    expect(rawRecord("R1")).toBe(before);
  });

  test("is closed once the start grace has passed", () => {
    useState();
    const started = new Date(Date.now() - 120_000).toISOString();
    lane("R1", { started_at: started });
    lane("R2", { started_at: started });
    expect(planReviewState("R1", { now: Date.parse(started) + 31_000 }).state).toBe("failed");
    expect(reviewRunState("R2", { now: Date.parse(started) + 31_000 }).state).toBe("failed");
  });
});

describe("a conversation lane", () => {
  test("is not closed by a reading door, even past the start grace with no process named", () => {
    useState();
    const started = new Date(Date.now() - 120_000).toISOString();
    lane("CONV1", { mode: "conversation", started_at: started });
    const before = rawRecord("CONV1");
    expect(laneStatus("CONV1")[0].status).toBe("running");
    expect(rawRecord("CONV1")).toBe(before);
  });
});

describe("idd lane status", () => {
  test("goes through the same judgement as the doors", () => {
    useState();
    lane("DONE1", { supervisor_pid: deadPid(), pid: deadPid(), report_md: true });
    lane("ALIVE1", { supervisor_pid: process.pid, pid: process.pid });
    lane("GRACE1", { started_at: new Date().toISOString() });
    lane("PAST1", { started_at: new Date(Date.now() - 120_000).toISOString() });
    const by = Object.fromEntries(laneStatus().map((r) => [r.id, r.status]));
    expect(by.DONE1).toBe("done");
    expect(by.ALIVE1).toBe("running");
    expect(by.GRACE1).toBe("running");
    expect(by.PAST1).toBe("failed");
  });
});

describe("the screen's read", () => {
  test("calls a run with a gone process interrupted and writes nothing", () => {
    useState();
    lane("R1", { supervisor_pid: deadPid(), pid: deadPid() });
    const before = rawRecord("R1");
    expect(runTranscript("R1")?.status).toBe("interrupted");
    expect(rawRecord("R1")).toBe(before);
  });
});

describe("a re-read that cannot be read", () => {
  test("closes nothing, throws nothing, and still closes once the record reads again", () => {
    useState();
    const broken = '{"id":"R1"';
    const rec = lane("R1", { supervisor_pid: deadPid(), pid: deadPid() });
    const st = planReviewState("R1", { alive: () => { writeFileSync(join(laneDir("R1"), "lane.json"), broken); return false; } });
    expect(st.state).toBe("running");
    expect(rawRecord("R1")).toBe(broken);
    writeFileSync(join(laneDir("R1"), "lane.json"), `${JSON.stringify(rec, null, 2)}\n`);
    expect(planReviewState("R1").state).toBe("failed");

    const rec2 = lane("R2", { supervisor_pid: deadPid(), pid: deadPid() });
    const st2 = reviewRunState("R2", { alive: () => { writeFileSync(join(laneDir("R2"), "lane.json"), broken); return false; } });
    expect(st2.state).toBe("running");
    expect(rawRecord("R2")).toBe(broken);
    writeFileSync(join(laneDir("R2"), "lane.json"), `${JSON.stringify(rec2, null, 2)}\n`);
    expect(reviewRunState("R2").state).toBe("failed");
  });
});
