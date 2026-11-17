import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseRoles } from "../src/roles.ts";
import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { candidatesFor, contractOf, failureKindOf, resolveRoute } from "../src/route.ts";

const roles = (yaml: string) => parseRoles(yaml);
const readRole = (yaml: string, name: string) => {
  const file = roles(yaml);
  return { name, file, role: file.roles[name] };
};

/** the model definitions the fixtures below name: one call target, and one with a provider column */
const models = "models:\n  m:\n    model: x/y\n";
const pi = (extra = "") => `    model: m\n    tools: [read]\n    report: review\n${extra}`;

describe("a role's candidate order", () => {
  test("the role itself (one per provider), then its fallbacks (each one per provider), in the order written", () => {
    const { role, file } = readRole(
      `models:\n  m1:\n    model: openrouter/x/m\n    providers: [p1, p2]\n  m2:\n    model: openrouter/y/m\n    providers: [q1]\n  m:\n    model: x/y\nroles:\n  a:\n    model: m1\n    tools: [read]\n    report: review\n    fallback: [b, c]\n  b:\n    model: m2\n    tools: [read]\n    report: review\n    fallback: d\n  c:\n${pi()}  d:\n${pi()}`,
      "a",
    );
    const picked = candidatesFor(role, file);
    expect(picked.map((x) => `${x.origin}:${x.via ?? "-"}:${x.role.name}:${x.provider ?? "-"}`)).toEqual([
      "a:-:a:p1", "a:-:a:p2", "a:b:b:q1", "a:c:c:-",
    ]);
    expect(picked[0].contract).toBe("openrouter");
    // one attempt is pinned to one provider and never handed over to another
    expect(picked[0].role.provider).toEqual({ only: ["p1"], allow_fallbacks: false });
    expect(picked[0].role.routingField).toBe("openRouterRouting");
    // the fallback's own fallback is not followed: a cycle cannot form and one block holds the whole order
    expect(picked.some((x) => x.role.name === "d")).toBe(false);
  });

  test("a single name reads the same as a one-name list", () => {
    const { role, file } = readRole(`${models}roles:\n  a:\n${pi("    fallback: b\n")}  b:\n${pi()}`, "a");
    expect(candidatesFor(role, file).map((x) => x.role.name)).toEqual(["a", "b"]);
  });

  test("the contract is the harness name or the model's provider", () => {
    expect(contractOf(roles(`${models}roles:\n  a:\n${pi()}`).roles.a)).toBe("x");
    expect(contractOf(roles(`roles:\n  a:\n    harness: claude\n    model: opus\n    tools: [read]\n    report: review\n`).roles.a)).toBe("claude");
    expect(contractOf(roles(`models:\n  m:\n    model: ollama-cloud/deepseek-v4.1-flash\nroles:\n  a:\n    model: m\n    tools: [read]\n    report: review\n`).roles.a)).toBe("ollama-cloud");
  });
});

describe("the window a model definition carries", () => {
  test("a provider column and the routing object may not be written together", () => {
    expect(() => roles(`models:\n  m:\n    model: openrouter/x/m\n    providers: [p1]\n    provider: { order: [p1] }\nroles:\n  a:\n    model: m\n    tools: [read]\n    report: review\n`)).toThrow(/providers.*併記/);
  });

  test("the routing object alone is still one candidate", () => {
    const { role, file } = readRole(`models:\n  m:\n    model: openrouter/x/m\n    provider: { order: [p1], allow_fallbacks: false }\nroles:\n  a:\n    model: m\n    tools: [read]\n    report: review\n`, "a");
    expect(candidatesFor(role, file).length).toBe(1);
    expect(candidatesFor(role, file)[0].provider).toBeUndefined();
  });

  test("the role reads the window of the model definition it names", () => {
    const { role } = readRole(`models:\n  m:\n    model: openrouter/x/m\n    provider: { order: [p1], allow_fallbacks: false }\nroles:\n  a:\n    model: m\n    tools: [read]\n    report: review\n`, "a");
    expect(role.model).toBe("openrouter/x/m");
    expect(role.provider).toEqual({ order: ["p1"], allow_fallbacks: false });
  });
});

describe("the failure kinds a run may move on", () => {
  test("a wall-clock cut is a timeout, a provider error is a quota or provider fault, anything else has none", () => {
    expect(failureKindOf({ status: "timeout" })).toBe("timeout");
    expect(failureKindOf({ status: "failed", providerError: "HTTP 402 payment required" })).toBe("quota");
    expect(failureKindOf({ status: "failed", providerError: "402 insufficient_quota" })).toBe("quota");
    expect(failureKindOf({ status: "failed", providerError: "your credit balance is too low" })).toBe("quota");
    expect(failureKindOf({ status: "failed", providerError: "connection reset by peer" })).toBe("provider");
    // an unknown wording falls to a provider fault, and no error at all has no kind
    expect(failureKindOf({ status: "failed", providerError: null })).toBeNull();
    expect(failureKindOf({ status: "failed", spawnError: "binary not found" })).toBeNull();
    expect(failureKindOf({ status: "stopped" })).toBeNull();
    // an attempt that wrote its deliverable is not a failure, whatever the last reply ended with
    expect(failureKindOf({ status: "done", providerError: "HTTP 402 payment required" })).toBeNull();
    expect(failureKindOf({ status: "done", providerError: "connection reset by peer" })).toBeNull();
  });

  test("the kinds are written by defaults.fallback_on and by a role, and an unknown word is refused", () => {
    const file = roles(`defaults:\n  fallback_on: [quota, provider]\n${models}roles:\n  a:\n${pi("    fallback_on: []\n")}  b:\n${pi()}`);
    expect(file.defaults.fallbackOn).toEqual(["quota", "provider"]);
    expect(file.roles.a.fallbackOn).toEqual([]);
    expect(file.roles.b.fallbackOn).toEqual(["quota", "provider"]);
    expect(() => roles(`${models}roles:\n  a:\n${pi("    fallback_on: [nope]\n")}`)).toThrow(/fallback_on.*知らない/);
  });
});

describe("drawing the route", () => {
  const file = roles(`models:\n  m:\n    model: x/y\n  m1:\n    model: x/m\n  m2:\n    model: x/b\n  m3:\n    model: x/c\nroles:\n  a:\n${pi("    fallback: [b, c]\n")}  b:\n    model: m2\n    tools: [read]\n    report: review\n  c:\n    model: m3\n    tools: [read]\n    report: review\n`);

  test("the first candidate that can start runs; the ones after it stay for a mid-run move", () => {
    const route = resolveRoute(file.roles.a, file, { checkStartable: () => {} });
    expect(route.candidate.role.name).toBe("a");
    expect(route.index).toBe(0);
    expect(route.fallback).toBeUndefined();
  });

  test("the role's own first route that cannot start is a failure, as it always was", () => {
    expect(() => resolveRoute(file.roles.a, file, { checkStartable: () => { throw new Error("価格が分からない"); } })).toThrow(/価格が分からない/);
  });

  test("a run that may not change roles draws only its own routes", () => {
    const ok = resolveRoute(file.roles.a, file, { noFallback: true, checkStartable: () => {} });
    expect(ok.candidate.role.name).toBe("a");
    expect(() => resolveRoute(file.roles.a, file, { noFallback: true, checkStartable: () => { throw new Error("価格が分からない"); } })).toThrow(/価格が分からない/);
  });
});

describe("the model definition's 替わり", () => {
  const yaml = `models:\n  main:\n    model: openrouter/x/m\n    fallback: spare\n  spare:\n    model: opencode-go/x/m\nroles:\n  a:\n    model: main\n    tools: [read]\n    report: review\n`;

  test("the 替わり is the next candidate, and it names the model it stands in for", () => {
    const file = roles(yaml);
    const picked = candidatesFor(file.roles.a, file);
    expect(picked.map((c) => `${c.role.model}:${c.modelFallback ?? "-"}`)).toEqual([
      "openrouter/x/m:-", "opencode-go/x/m:main",
    ]);
  });

  test("a main model that cannot start runs on the 替わり", () => {
    const file = roles(yaml);
    const route = resolveRoute(file.roles.a, file, { checkStartable: (role) => { if (role.model.startsWith("openrouter/")) throw new Error("価格が分からない"); } });
    expect(route.candidate.role.model).toBe("opencode-go/x/m");
    expect(route.candidate.modelFallback).toBe("main");
  });

  test("a 替わり that cannot start either is a failure", () => {
    const file = roles(yaml);
    expect(() => resolveRoute(file.roles.a, file, { checkStartable: () => { throw new Error("価格が分からない"); } })).toThrow(/価格が分からない/);
  });
});

describe("the shipped roles files", () => {
  for (const p of ["roles.yaml", "roles.example.yaml"]) {
    shippedConfigTest([p], `${p} reads with the fields the docs describe, and keeps its values`, () => {
      const file = parseRoles(readFileSync(shippedConfig(p), "utf8"));
      expect(file.roles["blind-reviewer-01"]).toBeDefined();
      // every role names a model definition, and the definition holds the call target that runs
      for (const role of Object.values(file.roles)) {
        if (role.harness === "claude") continue;
        expect(role.modelName, `${role.name} は model 定義を名指しする`).toBeTruthy();
        expect(file.models[role.modelName!].model).toBe(role.model);
      }
      expect(file.defaults.fallbackOn).toEqual(["quota", "provider", "timeout"]);
    });
  }
});
