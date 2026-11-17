import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { intentInjectExtensionPath } from "../src/inject.ts";
import registerReportWriter, {
  assertReportWriter,
  needsReportTool,
  reportEnv,
  REPORT_PATH_ENV,
  REPORT_TOOL_NAME,
  reportWriterExtensionPath,
  type PiReportApi,
} from "../src/pi-extensions/report-writer.ts";
import { buildClaudeArgs, buildPiArgs, piSessionArgs, resumeNudge } from "../src/runner.ts";
import { parseRoles, type RolePreset } from "../src/roles.ts";
import { parseSpec, renderBrief } from "../src/spec.ts";
import { tmpDir } from "./helpers/tmp.ts";

/** what the pi extension API needs here: the one tool the extension registers */
class FakeReportPi implements PiReportApi {
  tools: { name: string; parameters: unknown; promptGuidelines?: string[]; execute: (id: string, args: Record<string, unknown>) => Promise<unknown> }[] = [];
  registerTool(tool: never): void {
    this.tools.push(tool);
  }
}

const savedPath = process.env[REPORT_PATH_ENV];
afterEach(() => {
  if (savedPath === undefined) delete process.env[REPORT_PATH_ENV];
  else process.env[REPORT_PATH_ENV] = savedPath;
});

const role = (extra: string) => parseRoles(`models:\n  m:\n    model: x/y\nroles:\n  t:\n${extra}`).roles.t;
/** a role with neither write nor bash: it must leave the deliverable through the extension */
const readOnly = (): RolePreset => role("    model: m\n    tools: [read, grep]\n    report: review\n");
/** a role that writes the two files itself: its tool list must not move */
const withBash = (): RolePreset => role("    model: m\n    tools: [read, bash]\n    report: review\n");
const withWrite = (): RolePreset => role("    model: m\n    tools: [read, write]\n    report: review\n");
const claudeReadOnly = (): RolePreset => role("    harness: claude\n    model: opus\n    tools: [read]\n    report: review\n");
const claudeWithBash = (): RolePreset => role("    harness: claude\n    model: opus\n    tools: [read, bash]\n    report: review\n");

/** a spec the args builders can read: the worktree and report are the only parts they look at */
function spec(stage?: string): ReturnType<typeof parseSpec> {
  const dir = tmpDir("idd-report-tool-");
  return parseSpec(`role: t\nworktree: ${dir}\nreport: ${join(dir, "out", "report")}\n${stage ? `stage: ${stage}\n` : ""}`, dir);
}

const toolOf = (pi: FakeReportPi) => pi.tools.find((t) => t.name === REPORT_TOOL_NAME);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("the deliverable tool the pi extension registers", () => {
  test("AC-002: it writes the run's two files in one call, from the harness's path rather than an argument", async () => {
    const root = tmpDir("idd-report-write-");
    const report = join(root, "out", "report");
    process.env[REPORT_PATH_ENV] = report;
    const pi = new FakeReportPi();
    registerReportWriter(pi);
    const tool = toolOf(pi);
    expect(tool).toBeDefined();
    // the tool takes no write target: only the two bodies, and no other property is accepted
    expect(Object.keys((tool?.parameters as { properties: Record<string, unknown> }).properties).sort()).toEqual(["json", "markdown"]);
    expect((tool?.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
    const result = await tool?.execute("t1", { markdown: "# report", json: '{"findings":[]}' });
    expect(textOf(result)).toContain(`${report}.md`);
    expect(readFileSync(`${report}.md`, "utf8")).toBe("# report");
    expect(JSON.parse(readFileSync(`${report}.json`, "utf8"))).toEqual({ findings: [] });
    // nothing but the two files and their directory appeared
    expect(readdirSync(root)).toEqual(["out"]);
    expect(readdirSync(join(root, "out")).sort()).toEqual(["report.json", "report.md"]);
  });

  test("AC-002: a call whose JSON does not parse leaves no completed deliverable and comes back with the reason", async () => {
    const root = tmpDir("idd-report-bad-");
    const report = join(root, "out", "report");
    process.env[REPORT_PATH_ENV] = report;
    const pi = new FakeReportPi();
    registerReportWriter(pi);
    const result = await toolOf(pi)?.execute("t1", { markdown: "# report", json: "{ not json" });
    expect(textOf(result)).toContain("読めません");
    expect(existsSync(`${report}.md`)).toBe(false);
    expect(existsSync(`${report}.json`)).toBe(false);
  });

  test("AC-002: with no harness path the tool writes nothing", async () => {
    delete process.env[REPORT_PATH_ENV];
    const pi = new FakeReportPi();
    registerReportWriter(pi);
    const result = await toolOf(pi)?.execute("t1", { markdown: "x", json: "{}" });
    expect(textOf(result)).toContain("path が渡されていない");
  });
});

describe("which runs get the deliverable tool", () => {
  test("AC-003: a pi role with neither write nor bash carries the extension and the tool, on the start, a resume and a send alike", () => {
    const r = readOnly();
    expect(needsReportTool(r)).toBe(true);
    expect(reportEnv(r, "/r/report")).toEqual({ [REPORT_PATH_ENV]: "/r/report" });
    for (const args of [buildPiArgs(r, spec(), "/s", "id", "/b.md"), piSessionArgs(r, "/sess", "/msg.md", spec())]) {
      expect(args).toContain(reportWriterExtensionPath());
      expect(args[args.indexOf("--tools") + 1].split(",")).toContain(REPORT_TOOL_NAME);
    }
  });

  test("a pi role written with `tools: []` reads the worktree and has nothing that changes it, next to the deliverable's tool", () => {
    const r = { ...readOnly(), tools: [] as string[] };
    for (const args of [buildPiArgs(r, spec(), "/s", "id", "/b.md"), piSessionArgs(r, "/sess", "/msg.md", spec())]) {
      const tools = args[args.indexOf("--tools") + 1].split(",");
      expect(tools).toContain("read");
      expect(tools).toContain(REPORT_TOOL_NAME);
      for (const t of ["bash", "edit", "write"]) expect(tools).not.toContain(t);
    }
  });

  test("AC-003: the same shape on Claude Code is refused before it starts", () => {
    expect(() => assertReportWriter(claudeReadOnly())).toThrow(/"t".*write も bash も持たない/);
    expect(() => assertReportWriter(claudeWithBash())).not.toThrow();
  });

  test("AC-005: a role that already writes the two files keeps its tool list and gets no report extension", () => {
    for (const r of [withBash(), withWrite()]) {
      expect(needsReportTool(r)).toBe(false);
      expect(reportEnv(r, "/r/report")).toEqual({});
      const args = buildPiArgs(r, spec(), "/s", "id", "/b.md");
      expect(args).not.toContain(reportWriterExtensionPath());
      expect(args[args.indexOf("--tools") + 1]).toBe(r.tools.join(","));
    }
    // an injected read-and-bash role is exactly as before: the injection's extension and tool, nothing more
    const injected = buildPiArgs(withBash(), spec("triage"), "/s", "id", "/b.md");
    expect(injected).toContain(intentInjectExtensionPath());
    expect(injected).not.toContain(reportWriterExtensionPath());
    expect(injected[injected.indexOf("--tools") + 1]).toBe("read,bash,intent_lookup");
  });

  test("AC-005: a Claude Code role that writes keeps its mapped tool list", () => {
    const args = buildClaudeArgs(claudeWithBash(), "00000000-0000-4000-8000-000000000000", "brief");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Bash");
  });
});

describe("what the brief and the resume tell the agent", () => {
  test("AC-004: a role that needs the tool is told to call it; a role that writes itself is unchanged", () => {
    const needing = renderBrief(spec(), readOnly());
    expect(needing).toContain(REPORT_TOOL_NAME);
    expect(needing).toContain("<deliverables>");
    const selfWriting = renderBrief(spec(), withBash());
    expect(selfWriting).not.toContain(REPORT_TOOL_NAME);
    expect(selfWriting).toContain("次の 2 ファイルのみを書く。書けなかった場合に限り、理由を");
  });

  test("AC-004: the resume nudge names the tool for a role that needs it, and is unchanged otherwise", () => {
    expect(resumeNudge("/r/out", REPORT_TOOL_NAME)).toContain(REPORT_TOOL_NAME);
    expect(resumeNudge("/r/out")).toContain("/r/out.json");
    expect(resumeNudge("/r/out")).not.toContain(REPORT_TOOL_NAME);
    expect(resumeNudge("/r/out")).toContain("2 ファイルを書いてから終了してください");
  });
});

describe("the extension's path", () => {
  test("it names the file pi loads, next to the injection's own extension", () => {
    expect(reportWriterExtensionPath()).toEndWith("pi-extensions/report-writer.ts");
    expect(existsSync(reportWriterExtensionPath())).toBe(true);
    expect(intentInjectExtensionPath()).not.toBe(reportWriterExtensionPath());
  });
});
