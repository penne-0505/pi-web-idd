import { describeSection } from "../config/conventions.ts";
import type { ConventionKind } from "../config/conventions.ts";
import { branchNameCheck, type LaneRecord, type NamePattern } from "../config/lane-names.ts";
import { sectionChanged, type ConventionReading } from "../overlay/conventions-read.ts";
import { describeCommitConvention, matchesCommitConvention, type CommitConvention } from "./vocab.ts";

/** a line of the submit card's checks: shown to the person who signs, never read by the approval */
export interface CardLine { label: string; ok: boolean; reason: string }

const KIND_NAME: Record<ConventionKind, string> = { commit: "commit message", pr: "PR の題と本文", issue: "起票" };

/** what the repo declares in its registration, set beside a section that moved so the person can judge the two together */
export interface DeclaredValues {
  convention?: CommitConvention;
  /** the branch rule for this lane's source, as the repo wrote it */
  branchRule?: string;
  language?: string;
}

function describeValues(v: DeclaredValues): string {
  const out = [
    v.convention ? `commit の型: ${describeCommitConvention(v.convention)}` : "",
    v.branchRule ? `branch 名の型: ${v.branchRule}` : "",
    v.language ? `公開側の言語: ${v.language}` : "",
  ].filter(Boolean);
  return out.length ? out.join(" / ") : "設定に宣言している値はありません";
}

/**
 * The card's lines on the sections the repo points at. A pointer whose file or section the public base does not have
 * is a failing line that names it (the draft was made without that section; the approval is not stopped). A section
 * whose text moved since the earlier draft is a further line that sets the section beside the values the repo declares:
 * whether the two still agree is the repo's rule to read, so the machine only puts them side by side. A section that has not
 * moved gives a line that names the file and the section the draft followed and no more (not the text, not the hash):
 * a card that shows nothing of a found section would leave the person unable to tell which rule the text follows.
 */
export function conventionLines(readings: readonly ConventionReading[] | undefined, declared: DeclaredValues, base: string): CardLine[] {
  const out: CardLine[] = [];
  for (const r of readings ?? []) {
    const where = describeSection(r);
    if (!r.found) {
      const gap = r.missing === "file" ? "ありません（file が無い）" : r.missing === "body" ? "ありますが、見出しだけで本文がありません" : "ありません（file はあるが、その見出しの節が無い）";
      out.push({
        label: r.missing === "body" ? `規約の節に本文が無い（${KIND_NAME[r.kind]}）` : `規約の節が公開側に無い（${KIND_NAME[r.kind]}）`,
        ok: false,
        reason: `${where} が公開側の ${base} に${gap}。下書きはこの節を使わずに作られています。設定を直すか、そのまま承認するか決めてください`,
      });
    } else {
      out.push({
        label: `下書きが従う規約の節（${KIND_NAME[r.kind]}）`,
        ok: true,
        reason: `${where}（公開側の ${base} から読みました）`,
      });
      if (sectionChanged(r)) {
        out.push({
          label: `規約の節が前回の下書きから変わった（${KIND_NAME[r.kind]}）`,
          ok: false,
          reason: `${where} の文が前回の下書きのときから変わっています。宣言している値と矛盾しないか確かめてください。宣言: ${describeValues(declared)}`,
        });
      }
    }
  }
  return out;
}

/**
 * The card's line on the recent merged PRs' titles against the repo's declared commit form: how many do not follow it,
 * and one of them. Whether the declaration or the team's practice is right is a person's to decide, so the draft is
 * not made to follow the practice and the line does not say which wins. None apart: no line. No title to compare
 * (`titles` empty): an informing line, so that it does not read as "all follow". When GitHub could not be
 * asked (`unread`) the line says the practice was not checked, so a card without the line never hides that. Only a repo
 * that points at a commit section (`pointed`) is told its draft followed the rule's section: any other draft was written
 * from the repo's rules and recent commits, and the line does not say more than that.
 */
export function mergedTitleLine(convention: CommitConvention | undefined, titles: readonly string[] | undefined, unread = false, pointed = false): CardLine | null {
  if (!convention) return null;
  if (unread && !titles) {
    return {
      label: "直近に merge された PR の題を読めず、確かめられなかった",
      ok: false,
      reason: "GitHub から直近に merge された PR を取れなかったので、題が宣言の形に沿うか確かめていません。承認は止まりません。必要なら取れる状態にして確認し直してください",
    };
  }
  if (!titles) return null;
  if (!titles.length) {
    return {
      label: "比べられる merge 済みの PR の題が無い",
      ok: true,
      reason: "GitHub から読めた merge 済みの PR に題が無く、宣言の形に沿うか比べていません。承認は止まりません",
    };
  }
  const apart = titles.filter((t) => !matchesCommitConvention(convention, t));
  if (!apart.length) return null;
  return {
    label: "直近に merge された PR の題が宣言の形から外れている",
    ok: false,
    reason: `直近に merge された PR ${titles.length} 件のうち ${apart.length} 件の題は宣言の形（${describeCommitConvention(convention)}）に沿っていません（例: 「${apart[0]}」）。${pointed ? "下書きは規約の節に従っています。" : "下書きは repo の規則と直近の commit に従って書かれています。"}宣言と実際のやり方のどちらに合わせるか決めてください`,
  };
}

/** the card's line on the branch name that goes out against the repo's declared rule; none when the repo declares no rule for the lane */
export function branchLine(pattern: NamePattern | undefined, iddId: string, rec: LaneRecord | undefined, branch: string): CardLine | null {
  const verdict = branchNameCheck(pattern, iddId, rec, branch);
  if (!verdict.rule) return null;
  if (verdict.ok) return { label: "branch 名が宣言の型のとおり", ok: true, reason: `${branch}（型: ${verdict.rule}）` };
  return {
    label: "branch 名が宣言の型から外れている",
    ok: false,
    reason: `${verdict.expected ? `${branch} は型 ${verdict.rule} がこの lane に与える名前（${verdict.expected}）と違います` : `${branch}: 型 ${verdict.rule} をこの lane では組めません`}。branch 名は作った後に変えないので、承認するとこの名前で出ます`,
  };
}
