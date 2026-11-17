import { describe, expect, test } from "bun:test";

import { buildLandConflictArgs, parseLandConflict } from "../src/land-conflict.ts";
import { parseRoles } from "../src/roles.ts";

const files = [{ path: "a.ts", base: "x\n", ours: "x\nif (a < b) {}\n", theirs: "x\ny\n", marked: "<<<<<<<\n" }];

describe("landing conflict judge", () => {
  test("the role is given the three sides, git's marked text and what each side decided, with no tools", () => {
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  land-resolver: { model: x-y, thinking: high }").roles["land-resolver"];
    const args = buildLandConflictArgs(role, {
      files,
      incoming: { lane: "IDD-2", title: "二つ目", decided: [{ path: "_docs/archives/plan/p/idd-2/plan.md", text: "# plan two" }] },
      earlier: [{ lane: "IDD-1", title: "一つ目", decided: [] }],
    });
    expect(args).toContain("--no-tools");
    const message = args[args.length - 1]!;
    for (const part of ["if (a &lt; b) {}", "# plan two", '<incoming lane="IDD-2"', '<earlier lane="IDD-1"', '<decided absent="true"/>']) expect(message).toContain(part);
  });

  test("a failed rebuild is given as its own element beside the files, and a prompt without one has none", () => {
    const role = parseRoles("models:\n  x-y:\n    model: x/y\nroles:\n  land-resolver: { model: x-y, thinking: high }").roles["land-resolver"];
    const input = { files, incoming: { lane: "IDD-2", title: "二つ目", decided: [] }, earlier: [] };
    const plain = buildLandConflictArgs(role, input);
    expect(plain[plain.length - 1]).not.toContain("<rebuild-failure");
    const told = buildLandConflictArgs(role, { ...input, rebuildFailure: { cause: "environment", paths: ["dist/a.js"], reason: "moon が見つかりません" } });
    const message = told[told.length - 1]!;
    expect(message).toContain('<rebuild-failure cause="environment" paths="dist/a.js">');
    expect(message).toContain("moon が見つかりません");
    // it is not one of the files the judge resolves
    expect(message.indexOf("</files>")).toBeLessThan(message.indexOf("<rebuild-failure"));
  });

  test("a keeps answer gives the text of each file with its ground, and the file's last newline", () => {
    const answer = parseLandConflict([
      "<decision>keeps</decision>",
      "<rationale>別の行を足すだけ</rationale>",
      '<file path="a.ts">',
      "<why>足す行が別</why>",
      "<content>",
      "x",
      "if (a < b) {}",
      "y",
      "</content>",
      "</file>",
    ].join("\n"), files);
    expect(answer).toEqual({ decision: "keeps", rationale: "別の行を足すだけ", files: [{ path: "a.ts", content: "x\nif (a < b) {}\ny\n", why: "足す行が別" }] });
  });

  test("a content that already ends with the file's last newline gets no second one, and one that is the file's last line gets it once", () => {
    const answer = (content: string, source = files) => parseLandConflict(`<decision>keeps</decision>\n<rationale>残す</rationale>\n<file path="a.ts">\n<why>ok</why>\n<content>\n${content}</content>\n</file>`, source);
    const text = (a: ReturnType<typeof answer>) => (a.decision === "keeps" ? a.files[0]!.content : "");
    expect(text(answer("x\ny\n\n"))).toBe("x\ny\n");
    expect(text(answer("x\ny\n"))).toBe("x\ny\n");
    expect(text(answer("x\ny\n", [{ ...files[0]!, ours: "x\ny" }]))).toBe("x\ny");
  });

  test("two answers for one file are an error", () => {
    const one = '<file path="a.ts">\n<why>ok</why>\n<content>\nx\n</content>\n</file>';
    expect(() => parseLandConflict(`<decision>keeps</decision>\n<rationale>残す</rationale>\n${one}\n${one}`, files)).toThrow(/複数/);
  });

  test("a content that itself holds a closing tag is read up to the last one of its block", () => {
    const answer = parseLandConflict('<decision>keeps</decision>\n<rationale>残す</rationale>\n<file path="a.ts">\n<why>ok</why>\n<content>\nconst t = "</content>";\n</content>\n</file>', files);
    expect(answer.decision === "keeps" && answer.files[0]!.content).toBe('const t = "</content>";\n');
  });

  test("a changes answer carries its reason", () => {
    expect(parseLandConflict("<decision>changes</decision>\n<reason>同じ行に別の値を決めている</reason>", files)).toEqual({ decision: "changes", reason: "同じ行に別の値を決めている" });
  });

  test("an answer that cannot be read throws, so the lane is left out", () => {
    for (const unreadable of ["残せます", "<decision>keeps</decision>\n<rationale>残す</rationale>"]) expect(() => parseLandConflict(unreadable, files)).toThrow();
    expect(() => parseLandConflict('<decision>keeps</decision>\n<rationale>r</rationale>\n<file path="b.ts">\n<why>w</why>\n<content>\nx\n</content>\n</file>', files)).toThrow(/衝突していない/);
    expect(() => parseLandConflict('<decision>keeps</decision>\n<rationale>r</rationale>\n<file path="a.ts">\n<content>\nx\n</content>\n</file>', files)).toThrow(/why/);
    expect(() => parseLandConflict('<decision>keeps</decision>\n<rationale>r</rationale>\n<file path="a.ts">\n<why>w</why>\n<content>\nif (a &lt; b) {}\n</content>\n</file>', [{ ...files[0]!, ours: "x\n" }])).toThrow(/escape/);
  });
});
