import { classifyComment, extractComments } from "./validate-comments.ts";

Deno.test("overlay mode rejects governance pointers while allowing product strings", () => {
  const config = {
    mode: "overlay" as const,
    exclude: [],
    allowDocComments: false,
    allowPatterns: [],
  };
  const text =
    'const example = "// intent: DEC-100";\n// normal explanation\n// intent: DEC-100 — reason\n/** API documentation */';
  const result = extractComments(text).map((c) =>
    classifyComment(c, config).allowed
  );
  if (JSON.stringify(result) !== JSON.stringify([true, false, true])) {
    throw new Error(JSON.stringify(result));
  }
});
