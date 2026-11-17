import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { shippedConfig, shippedConfigTest } from "./helpers/shipped-config.ts";
import { parseRoles } from "../src/roles.ts";

const block = (extra = ""): string => `models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y, tools: [read] }\nstt:\n  provider: gemini\n  model: gemini-3.5-transcribe\n${extra}`;

describe("the stt block", () => {
  test("reads provider, model, key env, limit and base URL, with the defaults filled in", () => {
    const roles = parseRoles(block(`  api_key_env: MY_KEY\n  max_bytes: 1024\n  base_url: http://127.0.0.1:9\n`));
    expect(roles.stt).toEqual({ provider: "gemini", model: "gemini-3.5-transcribe", apiKeyEnv: "MY_KEY", maxBytes: 1024, baseUrl: "http://127.0.0.1:9" });
  });

  test("omitting the base URL and the key env falls back to the provider's public URL and GEMINI_API_KEY", () => {
    const roles = parseRoles(block());
    expect(roles.stt?.baseUrl).toBe("https://generativelanguage.googleapis.com");
    expect(roles.stt?.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(roles.stt?.maxBytes).toBe(20 * 1024 * 1024);
  });

  test("refuses an unknown provider and a missing model at read time", () => {
    expect(() => parseRoles(block().replace("gemini\n  model", "nope\n  model"))).toThrow(/知らない provider/);
    expect(() => parseRoles(block().replace("  model: gemini-3.5-transcribe\n", ""))).toThrow(/stt\.model/);
  });

  test("a file without the block still parses as before", () => {
    const roles = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  p: { model: x-y, tools: [read] }\n");
    expect(roles.stt).toBeUndefined();
  });

  for (const file of ["roles.yaml", "roles.example.yaml"]) {
    // card-writer may be left out of an overlay's roles.yaml (the card then shows its raw fields); only the tracked example must carry it
    shippedConfigTest([file], `the shipped ${file} reads and holds titler${file.includes(".example.") ? ", card-writer" : ""} and stt`, () => {
      const roles = parseRoles(readFileSync(shippedConfig(file), "utf8"));
      expect(roles.roles.titler, file).toBeDefined();
      if (file.includes(".example.")) expect(roles.roles["card-writer"], file).toBeDefined();
      expect(roles.stt?.provider, file).toBe("gemini");
      expect(roles.defaults.titleContextTurns, file).toBe(3);
    });
  }
});
