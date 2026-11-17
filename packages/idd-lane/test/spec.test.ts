import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRoles } from "../src/roles.ts";
import { HARNESS_NORMS, normText } from "../../idd-core/src/plan/harness-norms.ts";
import { carriesAction, FIXED_POLICY, parseSpec, renderBrief, reportJsonSchema } from "../src/spec.ts";
import { tmpDir } from "./helpers/tmp.ts";
const ROLES = `
defaults: { thinking: medium, budget_minutes: 40 }
models:
  vercel-gw-deepseek-deepseek-v4.1-flash:
    model: vercel-gw/deepseek/deepseek-v4.1-flash
roles:
  blind-reviewer:
    model: vercel-gw-deepseek-deepseek-v4.1-flash
    thinking: high
    tools: [read, bash, grep]
    report: review
    policy: ["疑った点は実測する"]
  executor:
    model: ""
    tools: [read, bash, edit, write]
    report: exec
    require_clean: false
`;

describe("parseRoles", () => {
  test("reads presets with defaults applied", () => {
    const roles = parseRoles(ROLES);
    const blind = roles.roles["blind-reviewer"];
    expect(blind.model).toBe("vercel-gw/deepseek/deepseek-v4.1-flash");
    expect(blind.thinking).toBe("high");
    expect(blind.budgetMinutes).toBe(40);
    expect(blind.requireClean).toBe(true);
    expect(roles.roles.executor.thinking).toBe("medium");
    expect(roles.roles.executor.requireClean).toBe(false);
  });

  test("parses profiles and rejects references to undefined roles", () => {
    const r = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  a: { model: x-y }\n  b: { model: x-y }\n  e: { harness: claude, model: opus }\nprofiles:\n  est1: { blind: [a] }\n  est3: { blind: [a, b], confirm: a, plan_review: b, escalation: e, note: big }");
    expect(r.profiles.est1).toEqual({ name: "est1", blind: ["a"] });
    expect(r.profiles.est3.escalation).toBe("e");
    expect(r.profiles.est3.plan_review).toBe("b");
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  a: { model: x-y }\nprofiles:\n  p: { blind: [a], plan_review: nope }")).toThrow(/未定義の role/);
    expect(r.roles.a.maxResumes).toBe(1);
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  a: { model: x-y }\nprofiles:\n  p: { blind: [zzz] }")).toThrow(/未定義の role/);
  });

  test("parses the pipeline section and rejects undefined roles or bad concurrency", () => {
    const r = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\n  e: { model: x-y }\npipeline:\n  planner: { role: p, concurrency: 3 }\n  executor: { role: e }");
    expect(r.pipeline.planner).toEqual({ role: "p", roles: ["p"], models: [], concurrency: 3, runs: [{ role: "p", model: "x-y", thinking: "medium" }], extraRuns: { first_round: [], high_risk: [] } });
    const multi = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  a: { model: x-y }\n  b: { model: x-y }\npipeline:\n  review_blind: { roles: [a, b], concurrency: 2 }");
    expect(multi.pipeline.review_blind).toEqual({ role: "a", roles: ["a", "b"], models: [], concurrency: 2, runs: [{ role: "a", model: "x-y", thinking: "medium" }, { role: "b", model: "x-y", thinking: "medium" }], extraRuns: { first_round: [], high_risk: [] } });
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  a: { model: x-y }\npipeline:\n  review_blind: { roles: [a, zzz] }")).toThrow(/未定義の role/);
    expect(r.pipeline.executor.concurrency).toBe(1);
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\npipeline:\n  planner: { role: zzz }")).toThrow(/未定義の role/);
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\npipeline:\n  planner: { role: p, concurrency: 0 }")).toThrow(/concurrency/);
    // two runs of one role would write the same spec and report
    expect(() => parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y }\npipeline:\n  plan_review: { roles: [p, p] }")).toThrow(/重複/);
  });

  test("rejects unknown tools and report kinds", () => {
    expect(() => parseRoles("roles:\n  x: { tools: [browser] }")).toThrow(/未知の tool/);
    expect(() => parseRoles("roles:\n  x: { report: novel }")).toThrow(/report/);
  });
});

describe("parseSpec + renderBrief", () => {
  const dir = tmpDir("idd-lane-spec-");
  writeFileSync(join(dir, "body.md"), "# PR");
  const roleOf = (report: string) => parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  t: { model: x-y, report: ${report} }`).roles.t;

  test("renders the one propter-system-message frame with the closing line", () => {
    const spec = parseSpec(`role: t\nworktree: ${dir}\ndiff: { base: aaa, head: bbb, paths: [lib/a.dart] }\ninputs: [body.md]\nfocus: ["観点 1"]\nreport: r\n`, dir);
    const brief = renderBrief(spec, roleOf("review"));
    expect(brief.startsWith("<propter-system-message>")).toBe(true);
    expect(brief.trimEnd().endsWith("</propter-system-message>")).toBe(true);
    expect(brief).toContain("以上のコンテクストで task を行う。");
    for (const tag of ["norms", "task", "deliverables", "lane", "inputs"]) expect(brief).toContain(`<${tag}>`);
    expect(brief).not.toContain("<type>");
    expect(brief).not.toContain("<idd-id>");
    expect(brief).not.toContain("<sent-at>");
  });

  test("a spec's answers key (R2's only, removed 2026-10-22) is not read: the brief carries no answers element", () => {
    const spec = parseSpec(`role: t\nworktree: ${dir}\nstage: triage\ninputs: [body.md]\nanswers: ans.md\nreport: r\n`, dir);
    const brief = renderBrief(spec, parseRoles(ROLES).roles["blind-reviewer"]);
    expect(brief).not.toContain("<answers>");
    expect(brief).not.toContain("ans.md");
    expect(brief).toContain("body.md");
  });

  test("a stage brief carries no fixed prohibition and no role policy", () => {
    const spec = parseSpec(`role: blind-reviewer\nworktree: ${dir}\nstage: blind\nreport: r\n`, dir);
    const brief = renderBrief(spec, parseRoles(ROLES).roles["blind-reviewer"]);
    for (const line of FIXED_POLICY) expect(brief).not.toContain(line);
    expect(brief).not.toContain("疑った点は実測する");
    expect(brief).toContain("<host-rules>");
  });

  test("the diff element keeps its kind and hashes, and a scoped path stays quoted", () => {
    const full = renderBrief(parseSpec(`role: t\nworktree: ${dir}\ndiff: { base: aaa, head: bbb, paths: ["lib/a.dart"] }\nreport: r\n`, dir), roleOf("review"));
    expect(full).toContain('<diff kind="full" base="aaa" head="bbb">');
    expect(full).toContain("git diff aaa bbb -- 'lib/a.dart'");
    const increment = renderBrief(parseSpec(`role: t\nworktree: ${dir}\ndiff: { base: aaa, head: bbb, increment: true, merge: "0123456789abcdef0123456789abcdef01234567" }\nreport: r\n`, dir), roleOf("review"));
    expect(increment).toContain('<diff kind="increment" since="aaa" head="bbb"');
    expect(increment).toContain('merge="0123456789abcdef0123456789abcdef01234567"');
    const conflict = renderBrief(parseSpec(`role: t\nworktree: ${dir}\ndiff: { base: aaa, head: bbb, merge: "0123456789abcdef0123456789abcdef01234567" }\nreport: r\n`, dir), roleOf("review"));
    expect(conflict).toContain('<diff kind="conflict"');
    expect(conflict).toContain("git show --cc 0123456789abcdef0123456789abcdef01234567");
  });

  test("the focus becomes a focus element inside the task, and the rules go to inputs", () => {
    const spec = parseSpec(`role: t\nworktree: ${dir}\ninputs: [body.md]\nrules: [AGENTS.md]\nfocus: ["場所 1", "場所 2"]\nreport: r\n`, dir);
    const brief = renderBrief(spec, roleOf("review"));
    expect(brief).toContain("<focus>");
    expect(brief).toContain("場所 1");
    expect(brief).toContain("<inputs>");
    expect(brief).toContain("AGENTS.md");
  });

  test("fails fast on a missing worktree or report", () => {
    expect(() => parseSpec("role: x\nworktree: /nonexistent/xyz\nreport: r", dir)).toThrow(/worktree がありません/);
    expect(() => parseSpec(`role: x\nworktree: ${dir}`, dir)).toThrow(/report/);
  });
});

describe("provider routing", () => {
  test("parses provider routing and attaches it to the model in a generated models.json", async () => {
    const { buildModelsConfig } = await import("../src/agent-dir.ts");
    const roles = parseRoles(`
models:
  openrouter-deepseek-deepseek-v4-flash:
    model: openrouter/deepseek/deepseek-v4-flash
    provider: { order: [deepseek, novita], allow_fallbacks: false }
  openrouter-bench-stealth-ox-alpha:
    model: openrouter-bench/stealth/ox-alpha
    provider: { only: [x] }
roles:
  r:
    model: openrouter-deepseek-deepseek-v4-flash
  custom:
    model: openrouter-bench-stealth-ox-alpha
`);
    const cfg = buildModelsConfig({ providers: { "openrouter-bench": { models: [{ id: "stealth/ox-alpha", compat: { a: 1 } }] } } }, roles.roles.r) as { providers: Record<string, { modelOverrides?: Record<string, { compat: Record<string, unknown> }> }> };
    expect(cfg.providers.openrouter.modelOverrides!["deepseek/deepseek-v4-flash"].compat.openRouterRouting).toEqual({ order: ["deepseek", "novita"], allow_fallbacks: false });
    const cfg2 = buildModelsConfig({ providers: { "openrouter-bench": { models: [{ id: "stealth/ox-alpha", compat: { a: 1 } }] } } }, roles.roles.custom) as { providers: Record<string, { models: { compat: Record<string, unknown> }[] }> };
    expect(cfg2.providers["openrouter-bench"].models[0].compat).toEqual({ a: 1, openRouterRouting: { only: ["x"] } });
    expect(() => parseRoles("roles:\n  r: { provider: [a] }")).toThrow(/provider/);
  });
});

describe("pipeline agent dir", () => {
  test("links every user file except models.json, which carries the role's routing", async () => {
    const { writeFileSync, mkdirSync, readFileSync, lstatSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { preparePipelineAgentDir } = await import("../src/agent-dir.ts");
    const user = tmpDir("idd-user-agent-");
    // a credential for the model's provider: pi's catalog listing hides a provider it has no credential for, and
    // the lane environment's own key is not something a test may depend on
    writeFileSync(join(user, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "test" } }));
    writeFileSync(join(user, "settings.json"), JSON.stringify({ packages: ["x"] }));
    mkdirSync(join(user, "skills")); writeFileSync(join(user, "skills", "a.md"), "s");
    writeFileSync(join(user, "models.json"), JSON.stringify({ providers: { openrouter: { models: [{ id: "z-ai/glm-5.3", name: "g" }] } } }));
    process.env.IDD_PI_USER_AGENT_DIR = user;
    const base = tmpDir("idd-pipeline-agent-");
    const role = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\n    provider: { order: [novita/fp8] }\nroles:\n  planner:\n    model: openrouter-z-ai-glm-5.3").roles.planner;
    const dir = preparePipelineAgentDir(base, role);
    // the settings are a real copy of the user's with the lane's shell: pi writes settings in place, so a link
    // would let the lane's write reach the user's file
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(false);
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.packages).toEqual(["x"]);
    expect(settings.shellPath).toBe(join(dir, "lane-bash"));
    expect(lstatSync(join(dir, "lane-bash")).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(dir, "skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "skills", "a.md"))).toBe(true);
    expect(lstatSync(join(dir, "models.json")).isSymbolicLink()).toBe(false);
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(models.providers.openrouter.models[0].compat.openRouterRouting).toEqual({ order: ["novita/fp8"] });
    // idempotent: a second call relinks without failing on existing links
    expect(() => preparePipelineAgentDir(base, role)).not.toThrow();
    // a real file pi wrote into the role dir must not block a later link of the same name from the user's dir
    writeFileSync(join(dir, "models-store.json"), "{}");
    writeFileSync(join(user, "models-store.json"), "{\"user\":1}");
    expect(() => preparePipelineAgentDir(base, role)).not.toThrow();
    expect(lstatSync(join(dir, "models-store.json")).isSymbolicLink()).toBe(true);
    delete process.env.IDD_PI_USER_AGENT_DIR;
  });

  test("the user's dir is left alone, and a settings change reaches the copy on the next rebuild", async () => {
    const { writeFileSync, mkdirSync, readFileSync, lstatSync, existsSync, rmSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { preparePipelineAgentDir } = await import("../src/agent-dir.ts");
    const user = tmpDir("idd-user-agent-keep-");
    writeFileSync(join(user, "settings.json"), JSON.stringify({ packages: ["x"], theme: "dark" }));
    writeFileSync(join(user, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "test" } }));
    // a catalog id the fixture's pi can list: without it the startability check asks for a price the bare dir has none of
    writeFileSync(join(user, "models.json"), JSON.stringify({ providers: { openrouter: { models: [{ id: "z-ai/glm-5.3", name: "g" }] } } }));
    mkdirSync(join(user, "sessions", "--wt--"), { recursive: true });
    writeFileSync(join(user, "sessions", "--wt--", "s_id.jsonl"), '{"type":"session"}\n');
    process.env.IDD_PI_USER_AGENT_DIR = user;
    const before = {
      settings: readFileSync(join(user, "settings.json"), "utf8"),
      auth: readFileSync(join(user, "auth.json"), "utf8"),
      record: readFileSync(join(user, "sessions", "--wt--", "s_id.jsonl"), "utf8"),
      settingsLink: lstatSync(join(user, "settings.json")).isSymbolicLink(),
      authLink: lstatSync(join(user, "auth.json")).isSymbolicLink(),
      sessionsLink: lstatSync(join(user, "sessions")).isSymbolicLink(),
    };
    const base = tmpDir("idd-pipeline-agent-keep-");
    const role = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  planner:\n    model: openrouter-z-ai-glm-5.3").roles.planner;
    const dir = preparePipelineAgentDir(base, role);
    try {
      // the user's own files are not written: content and kind are exactly what they were
      expect(readFileSync(join(user, "settings.json"), "utf8")).toBe(before.settings);
      expect(readFileSync(join(user, "auth.json"), "utf8")).toBe(before.auth);
      expect(readFileSync(join(user, "sessions", "--wt--", "s_id.jsonl"), "utf8")).toBe(before.record);
      expect(lstatSync(join(user, "settings.json")).isSymbolicLink()).toBe(before.settingsLink);
      expect(lstatSync(join(user, "auth.json")).isSymbolicLink()).toBe(before.authLink);
      expect(lstatSync(join(user, "sessions")).isSymbolicLink()).toBe(before.sessionsLink);
      // the copy carries the user's own keys
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).theme).toBe("dark");
      // a change the user makes lands in the copy on the next rebuild
      writeFileSync(join(user, "settings.json"), JSON.stringify({ packages: ["x"], theme: "light" }));
      preparePipelineAgentDir(base, role);
      const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      expect(settings.theme).toBe("light");
      expect(settings.shellPath).toBe(join(dir, "lane-bash"));
      // an old dir whose settings was still a link to the user's is turned into a copy by the same rebuild
      rmSync(join(dir, "settings.json"), { force: true });
      symlinkSync(join(user, "settings.json"), join(dir, "settings.json"));
      preparePipelineAgentDir(base, role);
      expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).shellPath).toBe(join(dir, "lane-bash"));
      expect(existsSync(join(dir, "lane-bash"))).toBe(true);
    } finally {
      delete process.env.IDD_PI_USER_AGENT_DIR;
    }
  });
});

describe("unknown catalog id", () => {
  test("adds a custom model entry carrying the routing when the id is not in pi's catalog", async () => {
    const { buildModelsConfig } = await import("../src/agent-dir.ts");
    const role = parseRoles("models:\n  openrouter-x-y:\n    model: openrouter/x/y\n    provider: { order: [a] }\nroles:\n  r:\n    model: openrouter-x-y").roles.r;
    const cfg = buildModelsConfig({}, role, { knownToCatalog: false }) as { providers: { openrouter: { models: { id: string; compat: Record<string, unknown> }[] } } };
    expect(cfg.providers.openrouter.models[0].id).toBe("x/y");
    expect(cfg.providers.openrouter.models[0].compat.openRouterRouting).toEqual({ order: ["a"] });
  });
});

describe("the band line a reviewer is told", () => {
  const dir = mkdtempSync(join(tmpdir(), "idd-lane-norms-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const roleOf = (report: string) => parseRoles(`models:\n  x-y:\n    model: x/y\nroles:\n  t: { model: x-y, report: ${report} }`).roles.t;

  test("a spec reads the norms it is handed and puts them in the norms section", () => {
    const brief = renderBrief(parseSpec(`role: t\nworktree: ${dir}\nreport: r\nnorms: ["帯の行"]\n`, dir), roleOf("review"));
    expect(brief).toContain("帯の行");
    expect(brief).not.toContain("## ハーネスの規則");
    expect(brief).not.toContain("IDD の規範");
  });

  test("a brief handed no norms says nothing about them", () => {
    const brief = renderBrief(parseSpec(`role: t\nworktree: ${dir}\nreport: r\n`, dir), roleOf("triage"));
    expect(brief).not.toContain("ハーネスの規則");
    expect(brief).not.toContain("IDD の規範");
  });

  test("the planner's identifier norm is the one the plan review is told", () => {
    expect(normText("lane-ids")).toContain("lane");
    expect(new Set(HARNESS_NORMS.map((n) => n.id)).size).toBe(HARNESS_NORMS.length);
  });
});

describe("the recommended handling in a report's format", () => {
  test("the diff review and the confirm ask for the action and the frequency; R2 and the plan review do not", () => {
    for (const stage of ["blind", "final", "device"]) {
      expect(carriesAction("review", stage)).toBe(true);
      expect(reportJsonSchema("review", stage)).toContain('"action":"fix|followup|skip"');
    }
    // the two stages that read the whole diff say how each finding is fixed; the device check and the judgements do not
    for (const stage of ["blind", "final"]) expect(reportJsonSchema("review", stage)).toContain('"how":');
    for (const stage of ["device", "r2"]) expect(reportJsonSchema("review", stage)).not.toContain('"how"');
    expect(reportJsonSchema("triage", "triage")).not.toContain('"how"');
    expect(reportJsonSchema("confirm", "confirm")).not.toContain('"how"');
    // the device check reads only: no clean; the stages that change the tree keep it
    expect(reportJsonSchema("review", "device")).not.toContain('"clean"');
    expect(reportJsonSchema("review", "blind")).toContain('"clean"');
    expect(carriesAction("review", "r2")).toBe(false);
    expect(reportJsonSchema("review", "r2")).not.toContain('"action"');
    expect(reportJsonSchema("review", "r2")).not.toContain('"clean"');
    expect(reportJsonSchema("review")).not.toContain('"action"');
    expect(reportJsonSchema("confirm", "confirm")).toContain('"action":"fix|followup|skip"');
    expect(reportJsonSchema("triage", "triage")).toContain('"from"');
    // the Issue lane's judgement is never handed the reviewers' weights, so it does not write one back; it cites a correction it repeats
    expect(reportJsonSchema("triage", "triage")).not.toContain('"reported_severity"');
    expect(reportJsonSchema("triage", "triage")).toContain('"correction_ref"');
    // nor is a review lane's: the harness reads the weights from the reports (C-210-1)
    expect(reportJsonSchema("triage", "triage", "review")).toContain('"from"');
    expect(reportJsonSchema("triage", "triage", "review")).not.toContain('"reported_severity"');
    expect(reportJsonSchema("triage", "triage", "review")).not.toContain('"correction_ref"');
    // an Issue lane's judgement names the harm a should's fix rests on; a review lane's does not (it reports to the author)
    expect(reportJsonSchema("triage", "triage")).toContain('"fix_basis":"data_loss|halt|cross_lane"');
    expect(reportJsonSchema("triage", "triage", "review")).not.toContain('"fix_basis"');
    expect(reportJsonSchema("triage", "feedback")).not.toContain('"from"');
    expect(reportJsonSchema("triage", "feedback")).not.toContain('"reported_severity"');
  });

  test("the device format has no clean; the stages that change the tree keep it", () => {
    expect(reportJsonSchema("review", "device")).not.toContain('"clean"');
    expect(reportJsonSchema("review", "blind")).toContain('"clean"');
    expect(reportJsonSchema("review", "final")).toContain('"clean"');
    expect(reportJsonSchema("confirm", "confirm")).toContain('"clean"');
    expect(reportJsonSchema("review", "r2")).not.toContain('"clean"');
  });

  test("no stage's format carries a hold verdict", () => {
    expect(reportJsonSchema("review", "blind")).toContain('"verdict":"approve|request-changes"');
    expect(reportJsonSchema("review", "r2")).not.toContain("hold");
  });
});

describe("the review briefs and the DEC index", () => {
  test("a blind, final, confirm, map or triage spec with no index input renders neither the index nor an impact field (AC-017)", () => {
    const role = parseRoles(ROLES).roles["blind-reviewer"];
    const dir = tmpDir("idd-spec-noindex-");
    for (const stage of ["blind", "final", "confirm", "map", "triage"]) {
      const spec = { role: role.name, worktree: dir, inputs: [], rules: [], focus: [], norms: [], iddNorms: [], commands: {}, report: join(dir, "report"), stage };
      const brief = renderBrief(spec, role);
      expect(brief).not.toContain("existing-decisions");
      expect(brief).not.toContain("intent_impact");
      expect(brief).not.toContain("intent-impact");
    }
  });
});

describe("the judgement's report shape", () => {
  test("the triage format asks for no prior checks, and the review formats ask for the four frequencies (AC-018)", () => {
    const triage = reportJsonSchema("triage", "triage");
    expect(triage).not.toContain('"resolved"');
    expect(triage).not.toContain("一覧の巡・種類つきの ref");
    for (const stage of ["blind", "final", "device"] as const) {
      const schema = reportJsonSchema("review", stage);
      for (const word of ["常時", "条件つき", "まれ", "事実上起きない"]) expect(schema, `${stage}: ${word}`).toContain(word);
    }
  });

  test("the plan run's report shape is the plan's own, not the review's (AC-016)", () => {
    expect(reportJsonSchema("fix_plan")).toContain('"files"');
    expect(reportJsonSchema("fix_plan")).not.toContain('"severity"');
    expect(reportJsonSchema("fix_plan")).not.toContain('"verdict"');
  });
});
