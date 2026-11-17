import { describe, expect, test } from "bun:test";

import { parseRoles, resolveRole, resolveRoleModel, stageRuns } from "../src/roles.ts";
import { candidatesFor, contractOf, resolveRoute } from "../src/route.ts";

/**
 * The shape of roles.yaml after the model definitions left the roles: a role names a model definition, a stage
 * declares the models it runs, and nothing rewrites the call target that is written down.
 */
const NEW = `models:
  flash:
    model: openrouter/z-ai/glm-5.3-flash
    provider: { order: [relace, z-ai/fp8], allow_fallbacks: false }
  luna:
    model: openai-codex/gpt-6-luna
roles:
  reviewer:
    model: flash
    thinking: high
    tools: [read]
    report: review
pipeline:
  plan_review:
    role: reviewer
    models:
      - model: flash
        thinking: high
      - model: luna
        thinking: xhigh
`;

describe("the model definitions and the roles that name them", () => {
  test("the call target written in the definition is the one the role runs", () => {
    const file = parseRoles(NEW);
    expect(file.roles.reviewer.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(file.roles.reviewer.modelName).toBe("flash");
    // the window the definition carries rides with the role
    expect(file.roles.reviewer.provider).toEqual({ order: ["relace", "z-ai/fp8"], allow_fallbacks: false });
    // the recorded contract is the window of the call target that ran
    expect(contractOf(file.roles.reviewer)).toBe("openrouter");
  });

  test("a stage that names two models makes two runs, each with its own thinking", () => {
    const file = parseRoles(NEW);
    expect(stageRuns(file.pipeline.plan_review, file)).toEqual([
      { role: "reviewer", model: "flash", thinking: "high" },
      { role: "reviewer", model: "luna", thinking: "xhigh" },
    ]);
    // the pair's thinking is the stage's, and the model definition holds no thinking of its own
    expect(resolveRoleModel("reviewer", "luna", file, "xhigh").thinking).toBe("xhigh");
    expect(resolveRoleModel("reviewer", "luna", file).thinking).toBe("high");
  });

  test("the same model in another stage runs with that stage's thinking", () => {
    const file = parseRoles(`models:\n  flash:\n    model: openrouter/z-ai/glm-5.3-flash\nroles:\n  reviewer:\n    model: flash\n    thinking: high\n    tools: [read]\n    report: review\npipeline:\n  one:\n    role: reviewer\n    models: [flash]\n  two:\n    role: reviewer\n    models:\n      - model: flash\n        thinking: low\n`);
    expect(stageRuns(file.pipeline.one, file)[0].thinking).toBe("high");
    expect(stageRuns(file.pipeline.two, file)[0].thinking).toBe("low");
  });

  test("a model definition's call target reaches every stage that uses it", () => {
    const before = parseRoles(NEW);
    const after = parseRoles(NEW.replace("openrouter/z-ai/glm-5.3-flash", "opencode-go/glm-5.3-flash"));
    expect(before.roles.reviewer.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(after.roles.reviewer.model).toBe("opencode-go/glm-5.3-flash");
    expect(stageRuns(after.pipeline.plan_review, after)[0].model).toBe("flash");
  });

  test("a model definition's 替わり runs when the main model's qualification is missing, and the record says which model ran", () => {
    const file = parseRoles(`models:\n  main:\n    model: openrouter/x/m\n    fallback: spare\n  spare:\n    model: opencode-go/x/m\nroles:\n  r:\n    model: main\n    tools: [read]\n    report: review\n`);
    const route = resolveRoute(file.roles.r, file, { checkStartable: (role) => { if (role.model.startsWith("openrouter/")) throw new Error("価格が分からない"); } });
    expect(route.candidate.role.model).toBe("opencode-go/x/m");
    expect(route.candidate.modelName).toBe("spare");
    expect(route.candidate.modelFallback).toBe("main");
  });

  test("the old shape is refused, and the message names the item that is old", () => {
    // a role that writes the call target itself
    expect(() => parseRoles("roles:\n  r:\n    model: openrouter/x/m\n")).toThrow(/roles\.r\.model: 旧形式/);
    // a role that names the window itself
    expect(() => parseRoles("models:\n  m:\n    model: openrouter/x/m\nroles:\n  r:\n    model: m\n    provider: { order: [a] }\n")).toThrow(/roles\.r\.provider: 旧形式/);
    expect(() => parseRoles("models:\n  m:\n    model: openrouter/x/m\nroles:\n  r:\n    model: m\n    providers: [a]\n")).toThrow(/roles\.r\.providers: 旧形式/);
    // the whole-window switch
    expect(() => parseRoles("defaults:\n  gateway: commandcode\nroles:\n  r:\n    model: openrouter/x/m\n")).toThrow(/defaults\.gateway: 旧形式/);
    // a role that names a model definition nobody wrote
    expect(() => parseRoles("models:\n  m:\n    model: openrouter/x/m\nroles:\n  r:\n    model: nope\n")).toThrow(/roles\.r\.model: 未定義の model 定義 "nope"/);
  });

  test("the candidates of a role are its own model, then its 替わり, then the roles it falls back to", () => {
    const file = parseRoles(`models:\n  main:\n    model: openrouter/x/m\n    fallback: spare\n  spare:\n    model: opencode-go/x/m\nroles:\n  r:\n    model: main\n    tools: [read]\n    report: review\n    fallback: other\n  other:\n    model: main\n    tools: [read]\n    report: review\n`);
    const picked = candidatesFor(resolveRole("r", file), file);
    expect(picked.map((c) => `${c.role.model}:${c.modelFallback ?? "-"}:${c.via ?? "-"}`)).toEqual([
      "openrouter/x/m:-:-",
      "opencode-go/x/m:main:-",
      "openrouter/x/m:-:other",
    ]);
  });
});
