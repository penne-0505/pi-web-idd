import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseModes, planModeStart } from "../src/modes.ts";
import { parseRoles } from "../src/roles.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { tmpDir } from "./helpers/tmp.ts";

describe("session modes", () => {
  test("parses modes against the roles file and rejects unknown roles", () => {
    const roles = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash] }");
    const modes = parseModes("modes:\n  chat: { label: チャット, role: chat, workspace: ~/text/chat }", roles);
    expect(modes.chat.workspace.endsWith("/text/chat")).toBe(true);
    expect(modes.chat.cwd).toBe(modes.chat.workspace);
    expect(modes.chat.label).toBe("チャット");
    expect(() => parseModes("modes:\n  x: { role: nope, workspace: /tmp }", roles)).toThrow(/未定義の role/);
    expect(() => parseModes("modes:\n  x: { role: chat }", roles)).toThrow(/workspace/);
  });

  test("keeps protocol text out of the mode definition: keys other than label / role / workspace / description are rejected", () => {
    const roles = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read] }");
    for (const key of ["system_prompt", "prompt", "policy", "model"]) {
      expect(() => parseModes(`modes:\n  x: { role: chat, workspace: /tmp, ${key}: "..." }`, roles)).toThrow(new RegExp(key));
    }
    // the old key is refused with a rewrite prompt, never read as a second name for the workspace
    expect(() => parseModes("modes:\n  x: { role: chat, cwd: /tmp }", roles)).toThrow(/workspace に書き換え/);
  });

  test("plans a start with the role's tools, model, thinking and a prepared agent dir", () => {
    const dir = tmpDir("idd-modes-");
    const cwd = tmpDir("idd-mode-cwd-");
    writeFileSync(join(dir, "roles.yaml"), "models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash, write] }\n  c: { harness: claude, model: opus }");
    writeFileSync(join(dir, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${cwd} }\n  bad: { role: c, workspace: ${cwd} }`);
    process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
    process.env.IDD_MODES_FILE = join(dir, "modes.yaml");
    const plan = planModeStart("chat", { prepareAgentDir: (r) => `/agent/${r.name}` });
    expect(plan.toolNames).toEqual(["read", "bash", "write"]);
    expect(plan.initialModel).toEqual({ provider: "openrouter", modelId: "z-ai/glm-5.3" });
    expect(plan.thinkingLevel).toBe("high");
    expect(plan.agentDir).toBe("/agent/chat");
    expect(() => planModeStart("bad", { prepareAgentDir: () => "/x" })).toThrow(/harness claude/);
    expect(() => planModeStart("none", { prepareAgentDir: () => "/x" })).toThrow(/modes.yaml/);
    delete process.env.IDD_ROLES_FILE; delete process.env.IDD_MODES_FILE;
  });
});

describe("the workspace key", () => {
  test("AC-001 / AC-003: a mode reads a workspace, refuses the old cwd, and needs a workspace", () => {
    const roles = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read] }");
    const modes = parseModes("modes:\n  chat: { role: chat, workspace: ~/text/chat }", roles);
    expect(modes.chat.workspace.endsWith("/text/chat")).toBe(true);
    expect(modes.chat.cwd).toBe(modes.chat.workspace);
    expect(() => parseModes("modes:\n  chat: { role: chat, cwd: /tmp }", roles)).toThrow(/workspace に書き換え/);
    expect(() => parseModes("modes:\n  chat: { role: chat }", roles)).toThrow(/workspace が必要/);
  });

  shippedConfigTest(["roles.yaml", "modes.yaml"], "AC-002: the shipped modes point at the current chat and idea dirs", () => {
    const roles = parseRoles(readFileSync(shippedConfig("roles.yaml"), "utf8"));
    const modes = parseModes(readFileSync(shippedConfig("modes.yaml"), "utf8"), roles);
    expect(modes.chat.workspace.endsWith("/text/chat")).toBe(true);
    expect(modes.idea.workspace.endsWith("/text/ideas")).toBe(true);
  });

  test("AC-002: the shipped modes.example.yaml reads with the roles.example.yaml (install copies it as the default)", () => {
    const roles = parseRoles(readFileSync(shippedConfig("roles.example.yaml"), "utf8"));
    const example = readFileSync(shippedConfig("modes.example.yaml"), "utf8");
    // the example is what install writes on a fresh machine, so the old key there would break every mode read
    expect(example).not.toMatch(/^\s*cwd:/m);
    const modes = parseModes(example, roles);
    expect(modes.chat.workspace.endsWith("/text/chat")).toBe(true);
    expect(modes.idea.workspace.endsWith("/text/ideas")).toBe(true);
    for (const mode of Object.values(modes)) expect(mode.workspace).toBe(mode.cwd);
  });

  test("AC-001: the mode plan carries the workspace and returns it as the cwd", () => {
    const dir = tmpDir("idd-modes-ws-");
    const workspace = tmpDir("idd-mode-ws-cwd-");
    writeFileSync(join(dir, "roles.yaml"), "models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read] }");
    writeFileSync(join(dir, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${workspace} }`);
    process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
    process.env.IDD_MODES_FILE = join(dir, "modes.yaml");
    const plan = planModeStart("chat", { prepareAgentDir: (r) => `/agent/${r.name}` });
    expect(plan.mode.workspace).toBe(workspace);
    expect(plan.mode.cwd).toBe(workspace);
    expect(plan.cwd).toBe(workspace);
    delete process.env.IDD_ROLES_FILE; delete process.env.IDD_MODES_FILE;
  });
});

describe("conversation types", () => {
  const roles = parseRoles("models:\n  openrouter-z-ai-glm-5.3:\n    model: openrouter/z-ai/glm-5.3\nroles:\n  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read] }");

  test("AC-001 / AC-003: a type reads label, dir, operations and template, and defaults operations from a written dir", () => {
    const modes = parseModes([
      "modes:",
      "  chat:",
      "    role: chat",
      "    workspace: /ws",
      "    types:",
      "      chat:",
      "        label: チャット",
      "      idea:",
      "        label: アイデア",
      "        dir: ideas",
      "        template: _template.md",
    ].join("\n"), roles);
    expect(modes.chat.defaultType).toBe("chat");
    const chat = modes.chat.types?.chat as { label: string; dir: string; hasDir: boolean; operations?: string; template?: string };
    expect(chat.label).toBe("チャット");
    expect(chat.dir).toBe("/ws");
    expect(chat.hasDir).toBe(false);
    expect(chat.operations).toBeUndefined();
    expect(chat.template).toBeUndefined();
    const idea = modes.chat.types?.idea as { dir: string; hasDir: boolean; operations?: string; template?: string };
    expect(idea.dir).toBe(join("/ws", "ideas"));
    expect(idea.hasDir).toBe(true);
    expect(idea.operations).toBe(join("/ws", "ideas", "AGENTS.md"));
    expect(idea.template).toBe(join("/ws", "ideas", "_template.md"));
  });

  test("AC-003: an absolute or ~ dir is kept, and memory defaults to <workspace>/memory", () => {
    const home = process.env.HOME ?? "";
    const modes = parseModes([
      "modes:",
      "  chat:",
      "    role: chat",
      "    workspace: /ws",
      "    types:",
      "      a: { dir: /abs/docs }",
      "      b: { dir: ~/text/ideas }",
      "      c: { dir: docs, operations: OPS.md }",
    ].join("\n"), roles);
    expect(modes.chat.defaultType).toBe("a");
    expect(modes.chat.types?.a.dir).toBe("/abs/docs");
    expect(modes.chat.types?.a.operations).toBe("/abs/docs/AGENTS.md");
    expect(modes.chat.types?.b.dir).toBe(join(home, "text/ideas"));
    expect(modes.chat.types?.c.operations).toBe(join("/ws", "docs", "OPS.md"));
    expect(modes.chat.memory).toBe(join("/ws", "memory"));

    const withMemory = parseModes("modes:\n  chat: { role: chat, workspace: /ws, memory: ~/mem }\n", roles);
    expect(withMemory.chat.memory).toBe(join(home, "mem"));
  });

  test("AC-001: a type definition refuses an unknown key, an empty table, and a mode without types has none", () => {
    expect(() => parseModes("modes:\n  chat: { role: chat, workspace: /ws, types: { a: { nope: 1 } } }", roles)).toThrow(/nope/);
    expect(() => parseModes("modes:\n  chat: { role: chat, workspace: /ws, types: {} }", roles)).toThrow(/1 つも/);
    const plain = parseModes("modes:\n  chat: { role: chat, workspace: /ws }", roles);
    expect(plain.chat.types).toBeUndefined();
    expect(plain.chat.defaultType).toBeUndefined();
  });
});
