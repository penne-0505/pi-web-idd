import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { mergeFindings, readFindings, renderDraft, splitComments, type Finding } from "../src/report.ts";
import { tmpDir } from "./helpers/tmp.ts";

const f = (severity: Finding["severity"], path: string, claim: string, line: number | null = null): Finding => ({ severity, path, line, claim, evidence: "", is_guess: false });

describe("readFindings", () => {
  test("reads the whole-diff review's how beside a finding, and an older report without it as before", () => {
    const dir = tmpDir("idd-report-how-");
    writeFileSync(join(dir, "with.json"), JSON.stringify({ findings: [{ severity: "must", path: "a.ts", claim: "購読が残る", evidence: "e", how: "dispose を finally に置く" }] }));
    writeFileSync(join(dir, "without.json"), JSON.stringify({ findings: [{ severity: "must", path: "a.ts", claim: "購読が残る", evidence: "e" }] }));
    expect(readFindings(join(dir, "with.json"))[0].how).toBe("dispose を finally に置く");
    const older = readFindings(join(dir, "without.json"))[0];
    expect(older.claim).toBe("購読が残る");
    expect(older.how).toBeUndefined();
  });
});

describe("mergeFindings", () => {
  test("collapses the same claim from two lanes and keeps the stronger severity", () => {
    const a = [f("should", "lib/x.dart", "contentPadding が vertical 0 のため拡大時に文字が上下端へ密着する", 10)];
    const b = [f("must", "lib/x.dart", "contentPadding の vertical 0 で拡大時に文字が上下端に密着する", 12)];
    const r = mergeFindings([a, b]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("must");
  });

  test("folds the same Japanese claim worded differently by four lanes (APP-1837 data)", () => {
    const g = "lib/features/gallery/presentation/pages/gallery.dart";
    const h = "lib/features/gallery/presentation/pages/home_v1.dart";
    const rv1 = [f("should", g, "TabBarView children の並びは layout 正本から導かれず手書きのままで、children を入れ替えてもテストが1つも落ちない", 775), f("should", h, "フォロー0のユーザーにも「フォロー中」タブが出る挙動変化があり（旧タブバーは follow>0 で非表示）、意図確認が必要", 48)];
    const rv2 = [f("should", g, "TabBarView children の並びが正本から導出されておらず、following/newArrivals の children を入れ替えても全テストが緑のまま", 775), f("nit", h, "`DefaultTabController(length: 2)` の固定タブ数が正本化の対象から漏れたまま残っている。", 124), f("nit", h, "HomeV1 の useTabController は keys を渡しておらず、length が変化しても controller が再生成されない", 69)];
    const esc = [f("should", g, "TabBarView children は可視条件だけを layout から取り、並び順は手書きのままの第2の正本として残っている。", 727), f("should", h, "DefaultTabController(length: 2) のハードコードが残り、同じ build 内の tabLayout.length（2 または 3）と矛盾している。", 124)];
    const hy4 = [f("should", g, "TabBarView の children は layout から導かれておらず、並びが手書きのままで本数・順序のズレを検知できない", 499), f("nit", h, "ハードコードされた DefaultTabController(length: 2) が残置し、タブ本数の記述がもう1箇所ある", 124)];
    const r = mergeFindings([rv1, rv2, esc, hy4]);
    const claims = r.findings.map((x) => x.claim.slice(0, 12));
    expect(r.findings).toHaveLength(4);
    expect(claims.filter((c) => c.startsWith("TabBarView"))).toHaveLength(1);
    expect(r.findings.find((x) => x.line === 124)?.severity).toBe("should");
    expect(r.findings.some((x) => x.line === 69)).toBe(true);
  });

  test("marks findings already raised in existing comments as duplicates", () => {
    const lanes = [[f("should", "lib/x.dart", "iOS の Dynamic Type が主対象なのに実機確認は Android のみ")]];
    const existing = splitComments([{ author: "claude", body: "### MUST\n\n**2. 実端末での確認が未完了**\n\niOS の Dynamic Type アクセシビリティサイズで1枚でも撮って添付してください。Android のみでは主対象を見ていません。`lib/x.dart`" }]);
    const r = mergeFindings(lanes, existing);
    expect(r.duplicates).toBe(1);
    expect(r.findings[0].duplicate_of).toMatch(/^claude:/);
    expect(r.by_severity.should).toBe(0);
  });

  test("never folds two findings of the same lane, even alike ones on one path", () => {
    const d = "_docs/intent/Demo/t/decision.md";
    const one = [f("should", d, "DEC-001 の Anchors に lib/a.ts の購読解除が無い"), f("should", d, "DEC-002 の Anchors に lib/b.ts の購読解除が無い")];
    expect(mergeFindings([one]).findings).toHaveLength(2);
    // a second lane raising one of them folds into it
    expect(mergeFindings([one, [one[0]]]).findings).toHaveLength(2);
    // a finding already joined by a lane takes no second one from that lane
    const x = f("should", "a.ts", "購読が取り残される");
    expect(mergeFindings([[x], [x, x]]).findings).toHaveLength(2);
  });

  test("joins sources by name, so a role whose name contains another's is not taken for it", () => {
    const s = (source: string) => [{ ...f("must", "a.ts", "購読が取り残される"), source }];
    expect(mergeFindings([s("plan-reviewer-flash"), s("plan-reviewer")]).findings[0].source).toBe("plan-reviewer-flash,plan-reviewer");
    expect(mergeFindings([s("plan-reviewer"), s("plan-reviewer-flash")]).findings[0].source).toBe("plan-reviewer,plan-reviewer-flash");
    expect(mergeFindings([s("a"), s("a")]).findings[0].source).toBe("a");
  });

  test("renders severity labels, folds nits, and hides duplicates by default", () => {
    const r = mergeFindings([[f("must", "lib/a.dart", "A が壊れる", 1), f("nit", "lib/b.dart", "命名が揺れる", 2), f("nit", "", "本文の数字がずれる")]]);
    const draft = renderDraft(r, { intro: "次の点だけご確認お願いします。" });
    expect(draft.startsWith("次の点だけご確認お願いします。\n\n**[must]** A が壊れる `lib/a.dart:1`")).toBe(true);
    expect(draft.match(/\*\*\[nit\]\*\*/g)).toHaveLength(1);
    expect(draft).toContain("命名が揺れる（`lib/b.dart:2`）");
  });
});

describe("readFindings", () => {
  test("keeps the recommended handling and the frequency when the report carries them, and drops a malformed action", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { readFindings } = await import("../src/report.ts");
    const dir = tmpDir("idd-report-");
    const p = join(dir, "r.json");
    writeFileSync(p, JSON.stringify({
      findings: [
        { severity: "should", path: "a.ts", claim: "c1", evidence: "", action: "followup", frequency: "まれ（機能が未使用のときだけ）" },
        { severity: "nit", path: "b.ts", claim: "c2", evidence: "", action: "later" },
      ],
    }));
    const got = readFindings(p);
    expect(got[0].action).toBe("followup");
    expect(got[0].frequency).toBe("まれ（機能が未使用のときだけ）");
    expect(got[1].action).toBeUndefined();
  });
});
