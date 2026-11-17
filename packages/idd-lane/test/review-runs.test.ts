import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load as yamlLoad } from "js-yaml";

import { reviewRunState, startReviewRuns, stopReviewRun, STAGE_SLOT, STAGE_TASK, stageTask } from "../src/review-runs.ts";
import { JUDGE_SEVERITY_RULES, SEVERITY_RULES } from "../../idd-core/src/plan/review-rules.ts";
import { parseSpec, renderBrief, reportJsonSchema } from "../src/spec.ts";
import { parseRoles } from "../src/roles.ts";
import { readLane } from "../src/runner.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("the confirm stages", () => {
  test("an S2 confirm checks only the refs the fix was sent to: a nit left out of the list is not unresolved", () => {
    expect(STAGE_TASK.confirm).toMatch(/confirm-<巡>\.md/);
    expect(STAGE_TASK.confirm).toMatch(/一覧の ref だけ/);
    expect(STAGE_TASK.confirm).toMatch(/一覧にない指摘は items に入れない/);
  });

  test("the confirm's no-status rule is scoped to new_findings, so it does not fight the ref-by-ref resolution report", () => {
    for (const stage of ["confirm", "feedback_confirm"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/new_findings では、前の指摘（自分のものを含む）/);
      expect(STAGE_TASK[stage]).not.toMatch(/^前の指摘（自分のものを含む）/m);
    }
    // the input reads for both the S2 ref list and the review lane's judgement report alone
    expect(STAGE_TASK.confirm).toMatch(/一覧が渡されないとき（他人の PR の査読 lane）は、判定の報告にある受理の ref を一覧とする/);
    expect(STAGE_TASK.confirm).toMatch(/一覧の ref だけを、ref ごとに解消したか判定する/);
  });

  test("the confirm after a fix of PR feedback checks the refs the judgement sent to the fix", () => {
    expect(STAGE_SLOT.feedback_confirm).toBe("confirm");
    expect(STAGE_TASK.feedback_confirm).toMatch(/list は判定が fix にした指摘の一覧/);
    expect(STAGE_TASK.feedback_confirm).toMatch(/confirm-<巡>\.md/);
    expect(STAGE_TASK.feedback_confirm).not.toMatch(/重要度によらず/);
    expect(STAGE_TASK.feedback_confirm).not.toMatch(/nit は[^。]*items に入れない/);
  });
});

describe("the triage of an S4 confirm's leftovers", () => {
  test("runs on the triage slot and sends every accepted leftover to the fix, nits included", () => {
    expect(STAGE_SLOT.feedback_leftovers).toBe("triage");
    expect(STAGE_TASK.feedback_leftovers).toMatch(/レビュアーにそのまま返せる/);
    expect(STAGE_TASK.feedback_leftovers).toMatch(/missing/);
    expect(STAGE_TASK.feedback_leftovers).not.toMatch(/受理した should の action は既定で followup/);
  });

  test("the usual triage keeps its instructions: an accepted nit is not fixed", () => {
    expect(STAGE_TASK.triage).toMatch(/nit は残件として記録されるだけで、修正には回らない/);
    // a question penne answered on a stuck card is not put to her again (IDD-292's round 6)
    expect(STAGE_TASK.triage).toMatch(/「penne が答えた判定の問い」があれば[^"]*答えた問いと同じことを尋ねる問いを再び escalate にせず/);
    // the answer reaches only as far as its question, on either side
    expect(STAGE_TASK.triage).toMatch(/問いの外の部分は答えとして読まない。答えを、それ以外の指摘を受理する根拠にも棄却する根拠にもしない/);
  });
});

describe("the refs of the leftovers and the review lane's judgement", () => {
  test("the leftovers keep the reviewer's C refs, give new problems N refs, and say so in the JSON shape", () => {
    expect(STAGE_TASK.feedback_leftovers).not.toMatch(/F-1 から振/);
    expect(STAGE_TASK.feedback_leftovers).toMatch(/元の C-<連番> を保ち/);
    expect(STAGE_TASK.feedback_leftovers).toMatch(/N-<連番> を振/);
    const schema = reportJsonSchema("triage", "feedback_leftovers");
    expect(schema).toContain("元の C-<連番>");
    expect(schema).toContain("N-<連番>");
  });

  test("the PR judgement and the leftovers carry the fix-only action rule; the confirm does not", () => {
    for (const stage of ["feedback", "feedback_leftovers"] as const) expect(STAGE_TASK[stage]).toMatch(/fix だけが修正に回る/);
    expect(STAGE_TASK.feedback_confirm).not.toMatch(/fix だけが修正に回る/);
  });

  test("the review lane's judgement decides what reaches the author; the Issue lane's does not", () => {
    expect(STAGE_TASK.triage).not.toMatch(/report にした should だけがレビュー本文に載る/);
    const review = stageTask("triage", { laneKind: "review" });
    expect(review).toMatch(/作者に伝える価値（report）/);
    expect(review).toMatch(/must と、report にした should だけがレビュー本文に載る/);
    expect(review).toMatch(/作者への往復を増やさないことを、伝えることより優先する/);
  });
});

describe("a reversal of an earlier round's fix", () => {
  test("every judging stage tells it apart and hands it to penne instead of the fix", () => {
    for (const stage of ["triage", "feedback", "feedback_leftovers"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/history/);
      expect(STAGE_TASK[stage]).toMatch(/逆向き/);
      expect(STAGE_TASK[stage]).toMatch(/reverts/);
      expect(STAGE_TASK[stage]).toMatch(/ユーザーの決定/);
      // only an escalated finding with both positions is a reversal; one turned down by penne's boundary is a plain reject
      expect(STAGE_TASK[stage]).toMatch(/reverts は escalate にした往復にだけ/);
      expect(STAGE_TASK[stage]).toMatch(/決定に反する要求は reject にして/);
    }
  });

  test("the run's decisions keep the mark: the earlier ref and both positions", () => {
    const state = tmpDir("idd-runs-");
    const prev = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try {
      const report = join(state, "report");
      writeFileSync(`${report}.json`, JSON.stringify({ decisions: [
        { ref: "F-1", verdict: "escalate", severity: "should", path: "t.py", claim: "語彙で文言を縛る", reverts: { prior_ref: "2-final/F-1", prior: "通過が判別できることを確かめる", current: "特定の語で合否を決めない" } },
        { ref: "F-2", verdict: "accept", severity: "should", path: "a.py", claim: "c", fix: "f", reverts: null },
        { ref: "F-3", verdict: "accept", severity: "should", path: "a.py", claim: "d", fix: "g", reverts: {} },
        { ref: "F-4", verdict: "accept", severity: "should", path: "a.py", claim: "e", fix: "h", reverts: { prior_ref: "なし", prior: "なし", current: "-" } },
        { ref: "F-5", verdict: "escalate", severity: "should", path: "a.py", claim: "f", reverts: { prior_ref: "1-blind/F-1", prior: "厳しく", current: "特になし" } },
      ] }));
      mkdirSync(join(state, "lanes", "L1"), { recursive: true });
      writeFileSync(join(state, "lanes", "L1", "lane.json"), JSON.stringify({ id: "L1", role: "r", model: "x", worktree: state, spec: "", report, status: "done", started_at: "" }));
      const st = reviewRunState("L1");
      if (st.state !== "done") throw new Error(st.state);
      expect(st.decisions?.[0].reverts).toEqual({ prior_ref: "2-final/F-1", prior: "通過が判別できることを確かめる", current: "特定の語で合否を決めない" });
      expect(st.decisions?.[1].reverts).toBeUndefined();
      expect(st.decisions?.[2].reverts).toBeUndefined();
      // a mark with nothing in it ("なし" and the like) is no mark
      expect(st.decisions?.[3].reverts).toBeUndefined();
      expect(st.decisions?.[4].reverts?.current).toBe("");
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });
});

describe("where a judged finding came from", () => {
  test("the Issue lane's triage names the runs a finding came from, is not told a reviewer's weight, and reads penne's corrections", () => {
    expect(STAGE_TASK.triage).toMatch(/from（[^）]*report\.json の親ディレクトリ名/);
    // the judgement decides the weight from the code and the harm table: it is neither asked for the reviewer's weight nor told to demote against it
    expect(STAGE_TASK.triage).not.toMatch(/reported_severity/);
    expect(STAGE_TASK.triage).toMatch(/指摘者の付けた重さ・推奨の対応・頻度が付いていない/);
    // the previous fixes are no longer handed to the judgement to check
    expect(STAGE_TASK.triage).not.toMatch(/prior-<巡>/);
    expect(STAGE_TASK.triage).toMatch(/前の巡の修正が解けたかは確かめない/);
    // penne's corrections stand: the same nature is not accepted again, and the correction is cited
    expect(STAGE_TASK.triage).toMatch(/penne の訂正/);
    expect(STAGE_TASK.triage).toMatch(/correction_ref/);
    // a review lane's judgement is read the same way: it is told the findings carry no weight, decides from the same table
    // and the repo's examples, and is not asked for the reviewer's weight (C-210-1)
    const review = stageTask("triage", { laneKind: "review" });
    expect(review).not.toMatch(/reported_severity/);
    expect(review).toMatch(/指摘者の付けた重さ・推奨の対応・頻度が付いていない/);
    expect(review).toMatch(/from（[^）]*report\.json の親ディレクトリ名/);
    expect(review).toContain(JUDGE_SEVERITY_RULES);
    expect(review).toMatch(/害の例（harm-examples-\*\.md）/);
    // the diff reviewers' bar is not the review lane's judgement's
    expect(review).not.toContain(SEVERITY_RULES);
    // the harm lines are the same words in both lanes' judgements
    expect(STAGE_TASK.triage).toMatch(/害の例（harm-examples-\*\.md）があれば、何が害でどの等級かの判断に使う/);
  });

  test("the harm table's text carries the common over-weighings and a should is fixed by the change's intent, not by the file", () => {
    expect(STAGE_TASK.triage).toMatch(/よくある過大評価/);
    expect(STAGE_TASK.triage).toMatch(/独立したまれな条件が重なる経路/);
    expect(STAGE_TASK.triage).toMatch(/この変更の意図の中で小さく直せ/);
    expect(STAGE_TASK.triage).not.toMatch(/受理した must と同じファイル/);
  });

  test("the run's decisions keep a well-formed origin and drop a malformed one", () => {
    const state = tmpDir("idd-runs-");
    const prev = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try {
      const report = join(state, "report");
      writeFileSync(`${report}.json`, JSON.stringify({ decisions: [
        { ref: "F-1", verdict: "accept", severity: "should", claim: "a", fix: "f", from: ["1-blind-r-a1", 3, "", "1-blind-s-b2"], reported_severity: "must" },
        { ref: "F-2", verdict: "reject", severity: "nit", claim: "b", reason: "r", from: [4], reported_severity: "blocker" },
        { ref: "F-3", verdict: "reject", severity: "nit", claim: "c", reason: "r", from: "1-blind-r-a1" },
      ] }));
      mkdirSync(join(state, "lanes", "L1"), { recursive: true });
      writeFileSync(join(state, "lanes", "L1", "lane.json"), JSON.stringify({ id: "L1", role: "r", model: "x", worktree: state, spec: "", report, status: "done", started_at: "" }));
      const st = reviewRunState("L1");
      if (st.state !== "done") throw new Error(st.state);
      expect(st.decisions?.[0].from).toEqual(["1-blind-r-a1", "1-blind-s-b2"]);
      expect(st.decisions?.[0].reported_severity).toBe("must");
      expect(st.decisions?.[1]).not.toHaveProperty("from");
      expect(st.decisions?.[1]).not.toHaveProperty("reported_severity");
      expect(st.decisions?.[2]).not.toHaveProperty("from");
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });

  test("a decision keeps the correction it cites, and drops a blank or malformed one", () => {
    const state = tmpDir("idd-runs-");
    const prev = process.env.IDD_STATE_DIR;
    process.env.IDD_STATE_DIR = state;
    try {
      const report = join(state, "report");
      writeFileSync(`${report}.json`, JSON.stringify({ decisions: [
        { ref: "F-1", verdict: "accept", severity: "must", claim: "a", fix: "f", correction_ref: " 2-blind/F-4 " },
        { ref: "F-2", verdict: "accept", severity: "must", claim: "b", fix: "f", correction_ref: "  " },
        { ref: "F-3", verdict: "accept", severity: "must", claim: "c", fix: "f", correction_ref: 4 },
      ] }));
      mkdirSync(join(state, "lanes", "L1"), { recursive: true });
      writeFileSync(join(state, "lanes", "L1", "lane.json"), JSON.stringify({ id: "L1", role: "r", model: "x", worktree: state, spec: "", report, status: "done", started_at: "" }));
      const st = reviewRunState("L1");
      if (st.state !== "done") throw new Error(st.state);
      expect(st.decisions?.[0].correction_ref).toBe("2-blind/F-4");
      expect(st.decisions?.[1]).not.toHaveProperty("correction_ref");
      expect(st.decisions?.[2]).not.toHaveProperty("correction_ref");
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });
});

describe("the confirm after a boundary penne decided", () => {
  test("both confirms check the boundaries the fix was sent toward, by their refs", () => {
    for (const stage of ["confirm", "feedback_confirm"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/boundaries-<巡>\.md/);
      expect(STAGE_TASK[stage]).toMatch(/境目[^。]*items に入れる/);
    }
  });
});

describe("a finished run's state", () => {
  test("carries the report's own verdict, which the S3 R2 writes into the lane's qa", () => {
    const prev = process.env.IDD_STATE_DIR;
    const state = tmpDir("idd-rr-");
    process.env.IDD_STATE_DIR = state;
    try {
      const dir = join(state, "lanes", "RUN1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.json"), JSON.stringify({ findings: [{ severity: "should", path: "a.ts", claim: "c" }], verdict: "request-changes" }));
      writeFileSync(join(dir, "lane.json"), JSON.stringify({ id: "RUN1", status: "done", report: join(dir, "report") }));
      const st = reviewRunState("RUN1");
      expect(st.state).toBe("done");
      if (st.state === "done") {
        expect(st.verdict).toBe("request-changes");
        expect(st.findings.length).toBe(1);
        expect(st.findings[0].how).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });

  test("reads the how-to-fix a whole-diff review wrote, and a report without one as it always read", () => {
    const prev = process.env.IDD_STATE_DIR;
    const state = tmpDir("idd-rr-how-");
    process.env.IDD_STATE_DIR = state;
    try {
      for (const [id, finding] of [["RUN2", { severity: "must", path: "a.ts", claim: "購読が残る", how: "dispose を finally に置く" }], ["RUN3", { severity: "must", path: "a.ts", claim: "購読が残る" }]] as const) {
        const dir = join(state, "lanes", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.json"), JSON.stringify({ findings: [finding] }));
        writeFileSync(join(dir, "lane.json"), JSON.stringify({ id, status: "done", report: join(dir, "report") }));
        const st = reviewRunState(id);
        expect(st.state).toBe("done");
        if (st.state === "done") {
          expect(st.findings[0].claim).toBe("購読が残る");
          expect(st.findings[0].how).toBe(id === "RUN2" ? "dispose を finally に置く" : undefined);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });
});

describe("the weight basis and the recommended handling", () => {
  test("every task of the two stages that read the whole diff asks for the how-to-fix", () => {
    for (const task of [STAGE_TASK.blind, STAGE_TASK.final, stageTask("blind", { scope: "conflict" }), stageTask("final", { scope: "conflict" }), stageTask("final", { scope: "increment" })]) {
      expect(task).toMatch(/各指摘に how（どう直すか）を付ける/);
    }
    // the stages that judge or confirm read findings, so they are not asked to write a plan
    for (const stage of ["triage", "confirm", "feedback", "feedback_leftovers", "device"] as const) expect(STAGE_TASK[stage]).not.toMatch(/各指摘に how/);
  });

  test("the judgement is told the action rules: a must is fix, and a should is placed unless it is small in the change's intent and meets the harm table", () => {
    expect(STAGE_TASK.triage).toMatch(/must の action は必ず fix/);
    expect(STAGE_TASK.triage).toMatch(/should の action は既定で followup/);
    expect(STAGE_TASK.triage).toMatch(/fix にしてよいのは、この変更の意図の中で小さく直せ、害の表で should 以上に当たる指摘だけ/);
    expect(STAGE_TASK.triage).toMatch(/同じファイルや関数に must があるかは理由にしない/);
    expect(STAGE_TASK.triage).toMatch(/「記録だけ」の指摘は、直さずに場所に付ける/);
    // no repo-specific example of harm is in the engine's text (a repo's examples arrive as an input)
    expect(STAGE_TASK.triage).not.toMatch(/利用者のデータや文面が黙って欠ける/);
    expect(STAGE_TASK.triage).not.toMatch(/engine や tick が止まる/);
    expect(STAGE_TASK.triage).not.toMatch(/ほかの lane を巻き込む/);
  });

  test("a reviewer's request is judged by the feedback rules, not the loop's", () => {
    for (const stage of ["feedback", "feedback_leftovers"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/レビュアーにそのまま返せる/);
      expect(STAGE_TASK[stage]).toMatch(/should: この PR の範囲で小さく直せるなら fix/);
    }
  });

  test("the reviewing and judging stages weigh a must as what stops the merge", () => {
    for (const stage of ["blind", "final", "triage", "confirm", "feedback", "feedback_leftovers", "feedback_confirm"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/must: マージを止める問題/);
      expect(STAGE_TASK[stage]).toMatch(/formatter や linter で拾えるものは nit にもしない/);
    }
  });

  test("the stages that carry a recommended handling ask for the action and the frequency", () => {
    for (const stage of ["blind", "final", "confirm"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/推奨の対応（fix = この変更で直す \/ followup = follow-up \/ skip = 見送り）/);
      expect(STAGE_TASK[stage]).toMatch(/頻度の見立て/);
    }
    // the stages that judge PR feedback leave a reviewer's request fixed whatever its weight: no recommended handling there
    for (const stage of ["feedback", "feedback_leftovers", "feedback_confirm"] as const) {
      expect(STAGE_TASK[stage]).not.toMatch(/推奨の対応（fix/);
    }
  });

  test("the diff review writes only what it observes and never fills a section", () => {
    for (const stage of ["blind", "final"] as const) {
      expect(STAGE_TASK[stage]).toMatch(/今のコードで観測できる問題だけを書く/);
      expect(STAGE_TASK[stage]).toMatch(/埋めるための指摘をしない/);
      expect(STAGE_TASK[stage]).toMatch(/回答は日本語で書く/);
    }
    // blind is handed no earlier round, so only the stages that are report a status rule
    expect(STAGE_TASK.blind).not.toMatch(/その状態は報告しない/);
    expect(STAGE_TASK.final).toMatch(/その状態は報告しない/);
    expect(STAGE_TASK.confirm).toMatch(/その状態は報告しない/);
  });

  test("the judgement re-decides the recommended handling: a rare but real hole is accepted, not turned down for being rare", () => {
    expect(STAGE_TASK.triage).not.toMatch(/起きる見込みが低い/);
    expect(STAGE_TASK.triage).toMatch(/まれでも実在する穴は棄却せず、受理して action を followup か skip にする/);
    expect(STAGE_TASK.triage).toMatch(/受理した各指摘の action/);
    expect(STAGE_TASK.triage).toMatch(/must の action は必ず fix/);
  });
});

describe("a finished run's report", () => {
  test("keeps the recommended handling and the frequency the reviewer wrote", () => {
    const prev = process.env.IDD_STATE_DIR;
    const state = tmpDir("idd-rr-action-");
    process.env.IDD_STATE_DIR = state;
    try {
      const dir = join(state, "lanes", "RUN2");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.json"), JSON.stringify({
        findings: [{ severity: "should", path: "a.ts", claim: "c", evidence: "", action: "followup", frequency: "まれ（条件が重なるとき）" }],
        decisions: [{ ref: "F-1", verdict: "accept", severity: "should", claim: "d", fix: "f", action: "skip" }],
      }));
      writeFileSync(join(dir, "lane.json"), JSON.stringify({ id: "RUN2", status: "done", report: join(dir, "report") }));
      const st = reviewRunState("RUN2");
      expect(st.state).toBe("done");
      if (st.state === "done") {
        expect(st.findings[0].action).toBe("followup");
        expect(st.findings[0].frequency).toBe("まれ（条件が重なるとき）");
        expect(st.decisions?.[0].action).toBe("skip");
      }
    } finally {
      if (prev === undefined) delete process.env.IDD_STATE_DIR;
      else process.env.IDD_STATE_DIR = prev;
    }
  });
});

describe("the report of each judgement", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();

  function setup(): { state: string; root: string; head: string; restore: () => void } {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
    const state = tmpDir("idd-rr-reports-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, "models:\n  x-j:\n    model: x/j\nroles:\n  judge: { model: x-j, report: triage }\npipeline:\n  triage: { role: judge }\n");
    const root = tmpDir("idd-rr-repo-");
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "AGENTS.md"), "# a\n");
    gitIn(root, "add", "-A"); gitIn(root, "commit", "-q", "-m", "base");
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    return { state, root, head: gitIn(root, "rev-parse", "HEAD"), restore };
  }

  const fakeRuns = () => {
    const started: string[] = [];
    return {
      started,
      deps: {
        runLane: async (specPath: string) => { started.push(specPath); return { id: `L${started.length}` } as never; },
        stopLane: () => ({}) as never,
      },
    };
  };

  test("the round's judgement and the judgement of the confirm's leftovers in the same round keep their own reports", async () => {
    const { root, head, restore } = setup();
    try {
      const f = fakeRuns();
      const opts = { iddId: "IDD-1", stage: "triage" as const, round: 1, worktree: root, base: head, head, inputs: [] };
      await startReviewRuns(opts, f.deps);
      const first = (yamlLoad(readFileSync(f.started[0], "utf8")) as { report: string }).report;
      writeFileSync(`${first}.json`, JSON.stringify({ decisions: [{ ref: "F-1", verdict: "accept", severity: "must", claim: "blind の指摘", fix: "直す" }] }));
      writeFileSync(`${first}.md`, "# 1 巡目の判定\n");
      // after the fix and its confirm, the leftovers are judged in the same round, on the same slot
      await startReviewRuns(opts, f.deps);
      expect(f.started[1]).not.toBe(f.started[0]);
      const second = (yamlLoad(readFileSync(f.started[1], "utf8")) as { report: string }).report;
      expect(second).not.toBe(first);
      // the first judgement's report, which the record points at and the next stages read, is left as it was
      expect(readFileSync(`${first}.md`, "utf8")).toBe("# 1 巡目の判定\n");
      expect(JSON.parse(readFileSync(`${first}.json`, "utf8")).decisions[0].claim).toBe("blind の指摘");
      // and the second run starts with no report of its own, so the older one is never taken for its answer
      expect(existsSync(`${second}.json`)).toBe(false);
      expect(existsSync(`${second}.md`)).toBe(false);
    } finally { restore(); }
  });

  test("the norms a stage is handed go into its spec, and a stage handed none has none", async () => {
    const { state, root, head, restore } = setup();
    try {
      const f = fakeRuns();
      const opts = { iddId: "IDD-1", stage: "triage" as const, round: 1, worktree: root, base: head, head, inputs: [] };
      await startReviewRuns({ ...opts, norms: ["ハーネスの規則 1"], iddNorms: ["IDD の規範 1"] }, f.deps);
      const first = yamlLoad(readFileSync(f.started[0], "utf8")) as { norms?: string[]; idd_norms?: string[] };
      expect(first.norms).toEqual(["ハーネスの規則 1"]);
      expect(first.idd_norms).toEqual(["IDD の規範 1"]);
      await startReviewRuns(opts, f.deps);
      const second = yamlLoad(readFileSync(f.started[1], "utf8")) as { norms?: string[]; idd_norms?: string[] };
      expect(second.norms).toBeUndefined();
      expect(second.idd_norms).toBeUndefined();
    } finally {
      restore();
      for (const d of [state, root]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("a run recorded in the older place, named by the round, stage and role alone, is still read from its record", async () => {
    const { state, root, head, restore } = setup();
    try {
      const dir = join(state, "pipeline", "review", "IDD-1", "1-triage-judge");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.json"), JSON.stringify({ decisions: [{ ref: "F-1", verdict: "reject", severity: "should", claim: "古い判定", reason: "r" }] }));
      writeFileSync(join(dir, "report.md"), "# old\n");
      mkdirSync(join(state, "lanes", "OLD1"), { recursive: true });
      writeFileSync(join(state, "lanes", "OLD1", "lane.json"), JSON.stringify({ id: "OLD1", role: "judge", model: "x/j", worktree: root, spec: join(dir, "spec.yaml"), report: join(dir, "report"), status: "done", started_at: "" }));
      // a new run of the same round and stage does not land on it
      const f = fakeRuns();
      await startReviewRuns({ iddId: "IDD-1", stage: "triage", round: 1, worktree: root, base: head, head, inputs: [] }, f.deps);
      expect((yamlLoad(readFileSync(f.started[0], "utf8")) as { report: string }).report).not.toBe(join(dir, "report"));
      const st = reviewRunState("OLD1");
      if (st.state !== "done") throw new Error(st.state);
      expect(st.reportMd).toBe(join(dir, "report.md"));
      expect(st.decisions?.[0].claim).toBe("古い判定");
    } finally { restore(); }
  });
});

describe("stopping a run whose lane was taken out", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();

  function setup(): { state: string; source: string; copy: string; restore: () => void } {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
    const state = mkdtempSync(join(tmpdir(), "idd-rr-stop-"));
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, "repos: {}\n");
    const source = mkdtempSync(join(tmpdir(), "idd-rr-stop-repo-"));
    execFileSync("git", ["init", "-q", source]);
    writeFileSync(join(source, "a.txt"), "a\n");
    gitIn(source, "add", "-A"); gitIn(source, "commit", "-q", "-m", "base");
    const root = join(state, "pipeline", "review-wt"); mkdirSync(root, { recursive: true });
    const copy = join(root, "copy1");
    gitIn(source, "worktree", "add", "-q", copy, "HEAD");
    mkdirSync(join(state, "lanes", "L1"), { recursive: true });
    writeFileSync(join(state, "lanes", "L1", "lane.json"), JSON.stringify({ id: "L1", role: "judge", model: "x/j", worktree: copy, spec: join(copy, "spec.yaml"), report: join(copy, "report"), status: "running", started_at: "" }));
    mkdirSync(join(state, "pipeline", "review-runs"), { recursive: true });
    writeFileSync(join(state, "pipeline", "review-runs", "L1.json"), JSON.stringify({ lane_id: "L1", stage: "triage", role: "judge", copy, source }));
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const d of [state, source]) rmSync(d, { recursive: true, force: true });
    };
    return { state, source, copy, restore };
  }

  test("a stopped run is marked stopped, its review copy goes, and its record says the copy is cleaned", () => {
    const f = setup();
    try {
      stopReviewRun("L1");
      expect(existsSync(f.copy)).toBe(false);
      expect(readLane("L1").status).toBe("stopped");
      expect(JSON.parse(readFileSync(join(f.state, "pipeline", "review-runs", "L1.json"), "utf8")).cleaned).toBe(true);
    } finally { f.restore(); }
  });

  test("a copy already gone is no failure: the record is still marked cleaned, and the stop is written once", () => {
    const f = setup();
    try {
      rmSync(f.copy, { recursive: true, force: true });
      stopReviewRun("L1");
      expect(readLane("L1").status).toBe("stopped");
      expect(JSON.parse(readFileSync(join(f.state, "pipeline", "review-runs", "L1.json"), "utf8")).cleaned).toBe(true);
    } finally { f.restore(); }
  });
});

describe("the repo's checks reach the stage spec that lists them", () => {
  test("a blind spec carries the repo's checks with each limit; a triage spec carries none", async () => {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
    const state = tmpDir("idd-rr-checks-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, "models:\n  x-b:\n    model: x/b\n  x-j:\n    model: x/j\nroles:\n  blind: { model: x-b, report: review, require_clean: false }\n  judge: { model: x-j, report: triage }\npipeline:\n  review_blind: { role: blind }\n  triage: { role: judge }\n");
    const root = tmpDir("idd-rr-checks-repo-");
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "base"], { cwd: root });
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, `repos:\n  me/app:\n    upstream: ${root}\n    work: ${root}\n    remote: ""\n    public_base: main\n    checks:\n      - { name: typecheck, command: "true", timeout_minutes: 7 }\n      - { name: lint, command: "true", required: false }\n`);
    const started: string[] = [];
    const deps = {
      runLane: async (specPath: string) => { started.push(specPath); return { id: `L${started.length}` } as never; },
      stopLane: () => ({}) as never,
      addWorktree: (() => ({ path: join(state, "copy"), branch: "b" })) as never,
      removeWorktree: (() => { /* no copy was made */ }) as never,
    };
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      await startReviewRuns({ iddId: "IDD-1", stage: "blind", round: 1, worktree: root, base: head, head, inputs: [] }, deps);
      const spec = yamlLoad(readFileSync(started[0], "utf8")) as { checks?: { name: string; timeout_minutes?: number }[] };
      expect(spec.checks).toEqual([{ name: "typecheck", timeout_minutes: 7 }, { name: "lint" }]);
      await startReviewRuns({ iddId: "IDD-1", stage: "triage", round: 1, worktree: root, base: head, head, inputs: [] }, deps);
      const triage = yamlLoad(readFileSync(started[1], "utf8")) as { checks?: unknown };
      expect(triage.checks).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(state, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a copy with its records taken out is not told of the checks that need the records", () => {
  const ROLES = "models:\n  x-b:\n    model: x/b\n  x-c:\n    model: x/c\nroles:\n  blind: { model: x-b, report: review, require_clean: false }\n  confirmer: { model: x-c, report: confirm }\npipeline:\n  review_blind: { role: blind }\n  spec_check: { role: blind }\n  confirm: { role: confirmer }\n";
  const CHECKS = [
    "      - { name: typecheck, command: \"true\", scope: public }",
    "      - { name: docs, command: \"true\", required: false, scope: records }",
    "      - { name: plain, command: \"true\" }",
    "      - { name: odd, command: \"true\", scope: elsewhere }",
  ].join("\n");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, encoding: "utf8" }).trim();

  /** a repo registered with the checks above; with a manifest row the blind and final cut a recordless copy */
  async function checksOfRuns(stage: "blind" | "final" | "spec" | "confirm" | "feedback_confirm", opts: { manifest: boolean; spec?: { count: number; inputs: string[] } }): Promise<string[][]> {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
    const state = tmpDir("idd-rr-scope-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, ROLES);
    const root = tmpDir("idd-rr-scope-repo-");
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "a\n");
    if (opts.manifest) writeFileSync(join(root, "overlay.manifest"), "_docs/\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    process.env.IDD_REPOS_FILE = join(state, "repos.yaml");
    writeFileSync(process.env.IDD_REPOS_FILE, `repos:\n  me/app:\n    upstream: ${root}\n    work: ${root}\n    remote: ""\n    public_base: main\n    checks:\n${CHECKS}\n`);
    const started: string[] = [];
    const deps = {
      runLane: async (specPath: string) => { started.push(specPath); return { id: `L${started.length}` } as never; },
      stopLane: () => ({}) as never,
      addWorktree: (() => ({ path: join(state, "copy"), branch: "b" })) as never,
      addRecordlessCopy: ((_r: unknown, o: { revs: Record<string, string> }) => ({ meta: { path: join(state, "copy"), branch: "b" }, refs: { ...o.revs } })) as never,
      removeWorktree: (() => { /* no copy was made */ }) as never,
    };
    try {
      const head = git(root, "rev-parse", "HEAD");
      await startReviewRuns({ iddId: "IDD-1", stage, round: 1, worktree: root, base: head, head, inputs: [], ...(opts.spec ? { spec: opts.spec } : {}) }, deps);
      // `started` follows the plans: the round's blinds first, then the spec check's runs beside them
      return started.map((path) => ((yamlLoad(readFileSync(path, "utf8")) as { checks?: { name: string }[] }).checks ?? []).map((c) => c.name));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(state, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function checksOf(stage: "blind" | "final" | "spec" | "confirm" | "feedback_confirm", opts: { manifest: boolean }): Promise<string[]> {
    return (await checksOfRuns(stage, opts))[0];
  }

  test("the blind and the final read a recordless copy and list no records check; a check with no scope or an unknown one stays", async () => {
    for (const stage of ["blind", "final"] as const) {
      expect(await checksOf(stage, { manifest: true })).toEqual(["typecheck", "plain", "odd"]);
    }
  });

  test("the stages that read the records list every check, as before", async () => {
    for (const stage of ["spec", "confirm", "feedback_confirm"] as const) {
      expect(await checksOf(stage, { manifest: true })).toEqual(["typecheck", "docs", "plain", "odd"]);
    }
  });

  test("the spec check a blind round starts beside its blinds reads the records, so it keeps the records check", async () => {
    for (const stage of ["blind", "final"] as const) {
      expect(await checksOfRuns(stage, { manifest: true, spec: { count: 1, inputs: [] } })).toEqual([
        ["typecheck", "plain", "odd"],
        ["typecheck", "docs", "plain", "odd"],
      ]);
    }
  });

  test("a repo with no manifest row cuts the blind and the final an ordinary copy, which lists the records check", async () => {
    for (const stage of ["blind", "final"] as const) {
      expect(await checksOf(stage, { manifest: false })).toEqual(["typecheck", "docs", "plain", "odd"]);
    }
  });
});

describe("the blind round's input", () => {
  test("carries neither the planner's six-kind table nor a repo's declared dangerous paths", () => {
    for (const stage of ["blind", "final"] as const) {
      const task = stageTask(stage);
      expect(task).not.toMatch(/risk_table|risk_paths|該当表|危ないパス/);
      for (const kind of ["authz", "billing", "permission", "data_loss"]) {
        expect(task).not.toMatch(new RegExp(kind));
      }
    }
  });

  test("carries neither the existing-DEC index nor the planner's impact report (AC-017)", () => {
    for (const stage of ["blind", "final", "confirm", "map", "triage"] as const) {
      const task = stageTask(stage);
      expect(task).not.toMatch(/existing-decisions/);
      expect(task).not.toMatch(/intent_impact|intent-impact/);
    }
  });
});

describe("the reviewer's overview", () => {
  test("a diff reviewer is handed the repo's overview, and an injection is not (AC-017)", () => {
    const dir = tmpDir("idd-rv-over-");
    const specPath = join(dir, "spec.yaml");
    const roles = parseRoles("models:\n  x-v:\n    model: x/v\nroles:\n  v: { model: x-v, report: review }\n");
    writeFileSync(specPath, `role: v\nworktree: ${dir}\nreport: ${join(dir, "report")}\ninputs: []\nrules: []\noverview: 在庫を正しく数える。\n`);
    const brief = renderBrief(parseSpec(readFileSync(specPath, "utf8"), dir), roles.roles.v);
    expect(brief).toContain("<overview>在庫を正しく数える。</overview>");
    expect(brief).not.toContain("intent_lookup");
    // a repo with no top-level Purpose gets no overview section
    writeFileSync(specPath, `role: v\nworktree: ${dir}\nreport: ${join(dir, "report")}\ninputs: []\nrules: []\n`);
    expect(renderBrief(parseSpec(readFileSync(specPath, "utf8"), dir), roles.roles.v)).not.toContain("<overview>");
  });
});

describe("the v2 lane's stage tasks (AC-026 / AC-027)", () => {
  test("the judgement names the Choice file instead of decision.md", () => {
    const task = stageTask("triage", { recordsShape: "state" });
    expect(task).toContain("Choice のファイル / qa.md");
    expect(task).not.toContain("decision.md / qa.md");
    expect(stageTask("triage", {})).toContain("decision.md / qa.md");
  });

  test("AC-032: the feedback, confirm and fix-plan stages read the Choice file too, and the plan wording differs by shape", () => {
    for (const stage of ["triage", "feedback", "feedback_leftovers", "confirm", "feedback_confirm", "fix_plan"] as const) {
      const v2 = stageTask(stage, { recordsShape: "state" });
      expect(v2, stage).not.toContain("decision.md");
      expect(v2, stage).toContain("Choice のファイル");
      expect(stageTask(stage, {}), stage).toContain("decision.md");
    }
    // the confirm and the feedback confirm share CONFIRM_CHECK, so its record name is replaced for both
    for (const stage of ["confirm", "feedback_confirm"] as const) {
      expect(stageTask(stage, { recordsShape: "state" })).toContain("記録（Choice のファイルなど）");
      expect(stageTask(stage, {})).toContain("記録（decision.md など）");
    }
    // a lane with a plan.md gets its own wording, one string per shape
    expect(stageTask("triage", { hasPlan: true })).toContain("実装の指示（plan.md があればそれと、decision.md / qa.md）");
    const planned = stageTask("triage", { hasPlan: true, recordsShape: "state" });
    expect(planned).toContain("実装の指示（plan.md があればそれと、Choice のファイル / qa.md）");
    expect(planned).not.toContain("decision.md");
  });
});

describe("the delivery's plan run", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "-C", cwd, ...args], { encoding: "utf8" }).trim();

  test("the stage runs one read-only run in the lane's worktree, on the slot's role, with the plan task (AC-006, AC-016)", async () => {
    const saved = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_ROLES_FILE: process.env.IDD_ROLES_FILE };
    const state = tmpDir("idd-rr-fixplan-");
    process.env.IDD_STATE_DIR = state;
    process.env.IDD_ROLES_FILE = join(state, "roles.yaml");
    writeFileSync(process.env.IDD_ROLES_FILE, "models:\n  x-f:\n    model: x/f\nroles:\n  fix: { model: x-f, report: fix_plan }\npipeline:\n  fix_plan: { role: fix }\n");
    const root = tmpDir("idd-rr-fp-repo-");
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "AGENTS.md"), "# a\n");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-q", "-m", "base");
    const head = gitIn(root, "rev-parse", "HEAD");
    const started: string[] = [];
    const deps = {
      runLane: async (specPath: string) => { started.push(specPath); return { id: `L${started.length}` } as never; },
      stopLane: () => ({}) as never,
    };
    try {
      const res = await startReviewRuns({ iddId: "IDD-1", stage: "fix_plan", round: 0, worktree: root, base: head, head, inputs: [] }, deps);
      expect(res.runIds.length).toBe(1);
      const spec = yamlLoad(readFileSync(started[0], "utf8")) as { stage: string; role: string; worktree: string; task: string; setup?: string[]; inject_lane?: string };
      expect(spec.stage).toBe("fix_plan");
      expect(spec.role).toBe("fix");
      expect(spec.worktree).toBe(root);
      expect(spec.task).toContain("守る不変");
      expect(spec.task).toContain("言い換えず");
      expect(spec.task).toContain("コードも文書も変更しない");
      // the lane's context document is read beside the contract, and the run never appends to it
      expect(spec.task).toContain("lane の重要なコンテクストの文書（context.md、あれば）");
      expect(spec.task).toContain("この文書は読むだけで、追記しない");
      // read-only: the run is handed no setup, which is the only other way a stage could change the worktree
      expect(spec.setup).toBeUndefined();
      // the injection is attached to the plan run too: it has to read the lane's Choices to plan
      expect(spec.inject_lane).toBe("IDD-1");
      // a role that writes another report format is refused before anything starts
      writeFileSync(process.env.IDD_ROLES_FILE, "models:\n  x-w:\n    model: x/w\nroles:\n  wrong: { model: x-w, report: review }\npipeline:\n  fix_plan: { role: wrong }\n");
      await expect(startReviewRuns({ iddId: "IDD-1", stage: "fix_plan", round: 0, worktree: root, base: head, head, inputs: [] }, deps)).rejects.toThrow(/fix_plan/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(state, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const file of ["roles.yaml", "roles.example.yaml"]) {
    shippedConfigTest([file], `${file} declares the plan preset and slot, with the executor's model (AC-016)`, () => {
      const roles = parseRoles(readFileSync(shippedConfig(file), "utf8"));
      // the slots name the roles: the fix plan's role runs on the model the executor slot's role runs on (DEC-121-2)
      const planRole = roles.pipeline.fix_plan?.role ?? "";
      const execRole = roles.pipeline.executor?.role ?? "";
      const preset = roles.roles[planRole];
      expect(preset, `${file}: ${planRole}`).toBeDefined();
      expect(roles.roles[execRole], `${file}: ${execRole}`).toBeDefined();
      expect(preset.report, file).toBe("fix_plan");
      expect(preset.tools, file).toContain("read");
      // the plan must not change the lane's worktree: a role that can write is checked after its run (require_clean),
      // not kept from writing by its tools (C-claude-desktop-supervisor-20261025-1)
      const canWrite = ["edit", "write", "bash", "apply_patch", "multiedit", "str_replace"].some((t) => preset.tools.includes(t));
      if (canWrite) expect(preset.requireClean, `${file}: ${planRole} require_clean`).toBe(true);
      // DEC-121-2: the fix plan runs on the executor's model and harness
      expect(preset.model, file).toBe(roles.roles[execRole].model);
      expect(preset.harness ?? "pi", file).toBe(roles.roles[execRole].harness ?? "pi");
      expect(roles.pipeline.fix_plan?.concurrency, file).toBeGreaterThan(0);
    });
  }

  test("AC-031: the example's fix-planner carries every tool, is checked after its run, and carries the executor's provider block", () => {
    const roles = parseRoles(readFileSync(shippedConfig("roles.example.yaml"), "utf8"));
    const preset = roles.roles["fix-planner"];
    expect(preset).toBeDefined();
    expect(preset.tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(preset.requireClean).toBe(true);
    // the same provider routing the example writes for the executor of the same model
    const executor = roles.roles["executor"];
    expect(preset.model).toBe(executor.model);
    expect(preset.provider).toEqual(executor.provider);
    expect((preset.provider as { order?: string[] })?.order?.length).toBeGreaterThan(0);
    expect((preset.provider as { allow_fallbacks?: boolean })?.allow_fallbacks).toBe(false);
  });
});
