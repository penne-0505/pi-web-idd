import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import type { InitResult } from "../../idd-core/src/init/init.ts";
import { readAgentToken } from "../../idd-lane/src/agent-token.ts";
import { postJsonWithRetry } from "./lane-commands.ts";

const OVERVIEW_ID = "P-1";
const OVERVIEW_ORIGIN = "idd repo init で利用者が渡した repo の概要";

/**
 * Write the overview a registration was given as P-1, through the engine's door and from outside any lane (so the
 * Purpose lands active). The door resolves the repo from config/repos.yaml, so this runs after the registry is
 * written. When the door cannot be reached the registration stands and the result says what was not written and
 * how to write it later. P-1 is the overview's seat, and a person's naming it is the only way a Purpose takes it (a
 * lane's proposal and an unnamed raise start at P-2). A repo whose seat is free (no P-1 in effect and none a Choice
 * points at) takes the given text here. A repo that already has a P-1 keeps it, whatever the registration was given:
 * P-1 is the whole repo's intent and every lane's judgement reads it, so a re-registration does not move it. The
 * registration shows the difference when the given text is not the kept one, and points at the overview proposal a
 * person decides.
 */
const squash = (v: string) => v.replace(/\s+/g, " ").trim();

/** the statement of the P-1 the repo already has, from the read door (no token, nothing written); null when it cannot be read */
async function keptStatement(github: string): Promise<string | null> {
  try {
    const res = await fetch(`${agentBaseUrl()}/api/idd/intent?${new URLSearchParams({ op: "show", repo: github, id: OVERVIEW_ID }).toString()}`);
    const data = await res.json().catch(() => ({})) as { ok?: boolean; record?: { statement?: unknown } };
    return res.ok && data.ok !== false && typeof data.record?.statement === "string" ? data.record.statement : null;
  } catch {
    return null;
  }
}

export async function raiseOverview(res: InitResult, github: string): Promise<void> {
  const overview = res.prerequisites.overview;
  if (overview.state !== "pending" || !overview.statement) return;
  const session = process.env.IDD_SESSION_ID?.trim() || "repo-init";
  const body = { id: OVERVIEW_ID, statement: overview.statement, origin: OVERVIEW_ORIGIN };
  const retry = `登録の結果の statement を {"id":"${OVERVIEW_ID}","statement":"…","origin":"…"} の JSON file に書き、idd intent raise purpose --repo ${github} --session ${session} --file FILE で打つ`;
  const fail = (why: string) => {
    res.prerequisites.overview = { state: "unreachable", statement: overview.statement, note: `P-1 は書けていません（${why}）。${retry}` };
    res.warnings.push(`概要（P-1）を engine の口に書けませんでした（${why}）。repo の登録は済んでいます。${retry}`);
  };
  const token = readAgentToken();
  if (!token) return fail("agent token を読めませんでした");
  const posted = await postJsonWithRetry(`${agentBaseUrl()}/api/idd/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "raise_purpose", session, repo: github, payload: body }),
  });
  if (posted.error !== undefined) return fail(`口を呼べませんでした: ${String(posted.error)}`);
  const { response, data } = posted;
  const refused = typeof data.error === "string" ? data.error : "";
  if ((!response?.ok || data.ok === false) && refused.startsWith(`ID ${OVERVIEW_ID} は既にあります`)) {
    const existing = await keptStatement(github);
    const same = existing !== null && squash(existing) === squash(overview.statement);
    const replace = `置き換えたいなら概要の案を出す（idd intent propose overview --repo ${github} --reason 理由 --file FILE。FILE は {"statement":"…"}。人が承認すると P-1 の statement が変わる）`;
    const note = same
      ? `${OVERVIEW_ID} は既にあり、渡された概要と同じ文です（書き直していません）`
      : `${OVERVIEW_ID} は既にあり、置き換えていません。${existing === null ? "既にある文は読めませんでした（idd intent show P-1 で確かめる）。" : `既にある文: ${existing}。渡された文: ${overview.statement}。`}${replace}`;
    res.prerequisites.overview = { state: "kept", statement: overview.statement, note };
    if (!same) res.warnings.push(`渡された概要は書いていません。${note}`);
    return;
  }
  if (!response?.ok || data.ok === false) return fail(typeof data.error === "string" && data.error ? data.error : `HTTP ${response?.status ?? 0}`);
  res.prerequisites.overview = { state: "raised", statement: overview.statement, note: `${typeof data.id === "string" ? data.id : OVERVIEW_ID} を active で書きました` };
}
