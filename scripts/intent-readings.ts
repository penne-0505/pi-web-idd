// 記録検査が Anchors と置き換え先の欄を読むための読み方。索引 (packages/idd-core) は
// 同じ書式を自前のコードで読む。2 つの読みがずれないよう、`_meta/validator-fixtures/intent/readings.json`
// の見本の表を双方のテストが通る (DEC-9226)。validator は packages/ を読めないので、読み方を共有せず
// 見本を共有する。

import { existsSync } from "node:fs";
import { join } from "node:path";

/** バッククォートの語を repo 相対の置き場に読む。索引の `placeOf` と同じ結果になる読み方 */
export function placeOf(token: string, root?: string): string | null {
  // 行・範囲・シンボル (`a.ts:10`, `a.ts:3-9`, `a.ts#L4-L9`, `a.ts#runTick`) は同じファイルを指す
  let t = token.trim().replace(/^\.\//, "").replace(/#.*$/, "").replace(
    /:\d+(?:-\d+)?$/,
    "",
  );
  if (!t || /\s/.test(t) || t.startsWith("/") || t.split("/").includes("..")) {
    return null;
  }
  const glob = t.search(/[*?{]/);
  if (glob >= 0) {
    const cut = t.slice(0, glob);
    const dir = cut.slice(0, cut.lastIndexOf("/") + 1);
    return dir || null;
  }
  if (!/^[\w.@+~[\]-]+(\/[\w.@+~[\]-]*)*$/.test(t)) return null;
  t = t.replace(/\/{2,}/g, "/");
  if (t.includes("/")) return t;
  return root !== undefined && /\.[A-Za-z0-9]+$/.test(t) &&
      existsSync(join(root, t))
    ? t
    : null;
}

/** Why の先頭の文。`。` が無ければ全体 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const i = t.indexOf("。");
  return i >= 0 ? t.slice(0, i + 1) : t;
}

/** one whole DEC identifier in any of the three forms, at the head of a value */
const RECORD_AT_HEAD =
  /^(DEC-(?:\d+(?:-[1-9]\d*)?|[A-Za-z][A-Za-z0-9_-]*-[1-9]\d*))(?![\w.-])/;

/**
 * `Superseded by` の値の先頭が名指す DEC の ID。`、` か `,` で並べる。3 つの形（`DEC-701`・`DEC-088-1`・
 * `DEC-IddCore-2`）をどれも 1 つの語として読み、短い ID を長い ID の先頭から読まない。番号でない語で読みを
 * 止めるので、説明・空の値・壊れた番号はどれも「置き換え先なし」になる。読めない欄で DEC を落とすと、今も
 * 効く契約を黙って失うため、索引はその DEC を外さない (INV-2321)。
 */
export function supersededIdsOf(value: string): string[] {
  const out: string[] = [];
  let rest = value.trim();
  for (;;) {
    const m = RECORD_AT_HEAD.exec(rest);
    if (!m) break;
    out.push(m[1]);
    rest = rest.slice(m[0].length).replace(/^[、,]\s*/, "");
  }
  return out;
}

/** Anchors の値が明示の `None`（DEC が統治するファイルを持たない）か。理由を括弧に添えてよい */
export function anchorsNoneOf(value: string): boolean {
  const head = value.replace(/（[^）]*）|\([^)]*\)/g, "").replace(/\s+/g, " ")
    .trim();
  return /^(None|なし|N\/A)$/i.test(head);
}

/** 1 つの DEC 本文から読んだ欄 */
export interface DecisionFields {
  /** Anchors の欄があるか */
  hasAnchors: boolean;
  /** Anchors が明示の None か */
  anchorsNone: boolean;
  /** Anchors が読めた置き場 */
  places: string[];
  /** Superseded by の欄があるか */
  hasSupersededField: boolean;
  /** Superseded by の先頭が名指す番号 */
  supersededBy: string[];
  /** Why の先頭の文 */
  why: string;
}

/**
 * 1 つの DEC の本文（見出しの次から次の見出しまで）を読む。索引の `parseDecisionDoc` と同じ形を読む:
 * Anchors は同じ行か、続く字下げした並び。
 */
export function readDecisionFields(
  body: string,
  root?: string,
): DecisionFields {
  const out: DecisionFields = {
    hasAnchors: false,
    anchorsNone: false,
    places: [],
    hasSupersededField: false,
    supersededBy: [],
    why: "",
  };
  let inAnchors = false;
  const addPlaces = (text: string): void => {
    for (const m of text.matchAll(/`([^`]+)`/g)) {
      const p = placeOf(m[1], root);
      if (p) out.places.push(p);
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#{1,6}\s/.test(line)) {
      inAnchors = false;
      continue;
    }
    const anchors = /^-\s+\*\*Anchors\*\*:\s*(.*)$/.exec(line);
    if (anchors) {
      out.hasAnchors = true;
      inAnchors = true;
      if (anchorsNoneOf(anchors[1])) out.anchorsNone = true;
      addPlaces(anchors[1]);
      continue;
    }
    const superseded = /^-\s+\*\*Superseded by\*\*:\s*(.*)$/.exec(line);
    if (superseded) {
      out.hasSupersededField = true;
      if (!out.supersededBy.length) {
        out.supersededBy = supersededIdsOf(superseded[1]);
      }
      inAnchors = false;
      continue;
    }
    const why = /^-\s+\*\*Why\*\*:\s*(.*)$/.exec(line);
    if (why) {
      if (!out.why) out.why = firstSentence(why[1]);
      inAnchors = false;
      continue;
    }
    // Anchors を字下げした並びで書いた形は、見出しの位置に戻るまで続く
    if (inAnchors && /^\s+\S/.test(line)) {
      addPlaces(line);
      continue;
    }
    inAnchors = false;
  }
  return out;
}
