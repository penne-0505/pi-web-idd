import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { decisionOf } = await jiti.import("../../../idd-engine/src/server/card-decision.ts");

/**
 * The cards the screen's tests use, shaped like the engine's state and carrying the prototype's G-section words, each
 * carrying the engine's own answer (`decision`), made by the same function the engine builds its state with. A spread
 * of another card (`{ ...go, depth: "deep" }`) is answered again from its final fields, so no card carries an answer
 * that belongs to the one it was copied from.
 */
export const decorate = (item) => ({ ...item, decision: decisionOf(item) });
export const NOW = Date.parse("2026-10-05T12:00:00Z");
const APPEARED = "2026-10-05T11:30:00Z";

const gh = (label, url) => ({ kind: "github", label, url });

export const question = decorate({
  kind: "question",
  iddId: "#142",
  laneTitle: "新 GUI の設定画面（providers・skills・projects・passkeys・voice・storage）を engine につなぐ",
  batchId: "b1",
  askedTotal: 3,
  answeredCount: 1,
  source: gh("GH #142", "https://example.test/142"),
  appearedAt: APPEARED,
  open: [
    {
      questionId: "q1",
      question: "未知のキーを見つけたら、起動を止めますか",
      facts: [
        { label: "利用者", value: "3 人中 2 人の設定に、廃止キー window.legacy が残っている" },
        { label: "CHANGELOG", value: "v0.12 で 4 キーを廃止した" },
      ],
      options: [
        { index: 1, label: "警告だけ出して続ける", description: "古い設定でも起動できる", recommendation: "recommended", rationale: "受け入れ条件 01 と 02 が変わる。" },
        { index: 2, label: "起動を止める", description: "打ち間違いにすぐ気づける", recommendation: "acceptable" },
        { index: 3, label: "黙って無視する", recommendation: "not_recommended" },
      ],
    },
  ],
});

export const go = decorate({
  kind: "go",
  iddId: "#142",
  laneTitle: "新 GUI の Inbox と会話を engine につなぐ: React の code を正として部品に props を足す",
  title: "新 GUI の Inbox と会話を engine につなぐ: React の code を正として部品に props を足す",
  source: gh("GH #142", "https://example.test/142"),
  appearedAt: APPEARED,
  summary: {
    situation: "未知のキーで起動が落ちる。",
    action: "読み込み時にスキーマで検証し、未知のキーは警告にする。",
    outcome: "古い設定でも起動し、打ち間違いは行番号つきで分かる。",
  },
  riskTable: [{ kind: "data_loss", label: "データ喪失", touches: false, reason: "触れない" }],
  decisions: [
    { id: "01", text: "スキーマは自前で書く", why: "依存を増やさない。", source: "方針 · CONTRIBUTING.md" },
    { id: "02", text: "未知のキーは警告にする", why: "廃止キーが残っている。" },
  ],
  criteria: [
    { id: "AC-01", text: "未知のキーで起動が止まらない" },
    { id: "AC-02", text: "未知のキーは警告に行番号を含む" },
  ],
  planReview: { state: "reviewed", must: 0, should: 2, nit: 1, findings: [{ severity: "should", claim: "Plan review の指摘", path: "plan.md" }] },
});

/** the 336 form: the same GO, but its decisions carry no Why or source */
export const goWithoutWhy = decorate({
  ...go,
  decisions: [{ id: "01", text: "スキーマは自前で書く" }],
});

export const goEmptyDecisions = decorate({ ...go, decisions: [] });

/** a GO whose lane also proposed Purposes: the GO press confirms exactly these */
export const goWithPurposes = decorate({
  ...go,
  purposeProposals: [
    { id: "P-2", statement: "夜でも文字が読める", origin: "質問 Q-1 の回答", name: "夜間の可読性" },
    { id: "P-3", statement: "OS の設定に追従する", origin: "planner の案" },
  ],
});

export const goWithoutContract = decorate({ ...go, intentPath: "_docs/intent/pi-web-idd/idd-081/decision.md" });

/** a deep lane's GO: the depth word alone, with no reason the engine handed it to a person */
export const goDeep = decorate({ ...go, depth: "deep" });

/** a shallow lane the engine left to a person: the depth word and the reason */
export const goNotAuto = decorate({ ...go, depth: "shallow", notAuto: "いまの計画の査読が済んでいない" });

export const stuckLimit = decorate({
  kind: "stuck",
  iddId: "#147",
  laneTitle: "記録の検査をレビュー収束の直後（S3 の前）に 1 回走らせ、取り込み card の差し戻しを減らす",
  title: "記録の検査をレビュー収束の直後（S3 の前）に 1 回走らせ、取り込み card の差し戻しを減らす",
  reason: "Review の巡の上限（3）に達しました",
  source: gh("GH #147", "https://example.test/147"),
  appearedAt: APPEARED,
  open: [
    { severity: "must", claim: "差分の上限を超えると黙って切り捨てる", path: "diff.ts:71" },
    { severity: "should", claim: "圧縮の失敗を握りつぶしている", path: "store.ts:22" },
  ],
  escalated: [],
  oscillations: [],
  rejected: [{ claim: "zod に置き換える", reason: "依存を増やさない" }],
  fixRounds: 9,
});

export const stuckBudget = decorate({ ...stuckLimit, reason: "予算を超えました", budget: { cost: 12, limit: 10, parts: [], subscription: [] }, fixRounds: 3, open: [] });

/** a budget stop that left musts: the last fix's own findings and the refs the judgement did not confirm */
export const stuckHistory = decorate({
  ...stuckBudget,
  history: { sideFindings: ["別の lane の前提を崩した"], unresolved: ["1-blind/F-2"] },
});
export const stuckStall = decorate({ ...stuckLimit, reason: "エージェントの応答がありません", stall: { role: "executor", reason: "timeout" }, fixRounds: 2, open: [] });
export const stuckOscillation = decorate({
  ...stuckLimit,
  reason: "往復した指摘があります",
  oscillations: [{ ref: "F-1", claim: "同じ指摘", priorRef: "F-0", prior: "直した", current: "戻した" }],
});

/** a stop the engine found and handed to penne: it answers with やり直す / 差し戻す / 閉じる */
export const stuckHalt = decorate({
  ...stuckLimit,
  reason: "engine の番のまま進んでいない",
  fixRounds: 0,
  open: [],
  rejected: [],
  halt: {
    stage: "提出の準備中",
    since: "2026-10-05T10:00:00Z",
    lastEvent: { name: "順番待ちの上限を超えた", at: "2026-10-05T11:00:00Z" },
    reason: "engine の番のまま進んでいない",
    causes: [],
    canSendBack: true,
  },
});

/** the same stop on a lane with no executor session to send back */
export const stuckHaltNoBack = decorate({ ...stuckHalt, halt: { ...stuckHalt.halt, canSendBack: false } });

export const duplicate = decorate({
  kind: "duplicate",
  iddId: "#163",
  reviewId: "RV-1",
  source: gh("GH #163", "https://example.test/163"),
  appearedAt: APPEARED,
  incoming: { title: "#163 設定の typo で起動しない: 廃止した window.legacy が残る古い設定で落ちる", ref: gh("GH #163", "https://example.test/163") },
  existing: { title: "#142 設定ファイルの検証: 未知のキーを行番号つきの警告にして起動を続ける", ref: gh("GH #142", "https://example.test/142") },
  similarity: 0.82,
  reason: "どちらも、設定のキーの誤りで起動が落ちる件。",
  shared: ["症状", "原因の箇所"],
});

export const requeue = decorate({
  kind: "requeue",
  iddId: "#118",
  laneTitle: "Electron の自動更新: Windows で署名の検証が失敗するとの報告を受けての取り込み直し",
  source: gh("GH #118", "https://example.test/118"),
  appearedAt: APPEARED,
  title: "Electron の自動更新: Windows で署名の検証が失敗するとの報告を受けての取り込み直し",
  from: "#118",
  closed: { outcome: "取り込みで閉じた", reason: "PR #131 を作成", at: "2026-10-02T00:00:00Z" },
  context: "署名の検証が Windows で失敗するとの報告",
});

export const unsupportedShip = decorate({
  kind: "ship",
  iddId: "#142",
  laneTitle: "設定ファイルの検証",
  appearedAt: APPEARED,
  title: "設定ファイルの検証",
  branch: { from: "lane/142", to: "main", repo: "penne-0505/propter" },
  pr: { title: "config: validate unknown keys", body: [], commits: [] },
  checks: [{ label: "typecheck", ok: true }],
});

export const unsupportedOutbound = decorate({ kind: "outbound", iddId: "#200", appearedAt: APPEARED, outKind: "gh-issue", targetLabel: "GitHub Issue", title: "投稿", draft: "d", proposed: "p", createdAt: APPEARED });
export const unsupportedReview = decorate({ kind: "review", iddId: "#300", appearedAt: APPEARED, target: { title: "他の PR", ref: gh("PR #9", "https://example.test/9") }, criteria: [] });
export const unsupportedFuture = decorate({ kind: "cosmic", iddId: "#999", appearedAt: APPEARED });

export const allUnsupported = [unsupportedShip, unsupportedOutbound, unsupportedReview, unsupportedFuture];
export const allSupported = [question, go, stuckLimit, duplicate, requeue];

/* ---- proposal: one card per open proposal, answered on its own ---- */

export const proposalOverview = decorate({
  kind: "proposal",
  proposalId: "PROP-1",
  proposalKind: "overview",
  repo: "penne-0505/propter",
  iddId: "#142",
  laneTitle: "設定ファイルの検証",
  appearedAt: APPEARED,
  handle: "概要を変える案",
  reason: "利用者の言葉が古くなっている",
  before: [{ label: "今の概要", value: "古い概要" }],
  after: [{ label: "案の概要", value: "新しい概要" }],
  from: { lane: "#142", at: APPEARED },
  effect: "on_merge",
});

export const proposalHarm = decorate({
  kind: "proposal",
  proposalId: "PROP-2",
  proposalKind: "harm_example",
  repo: "penne-0505/propter",
  appearedAt: APPEARED,
  handle: "戻せない削除",
  reason: "同じ lane で見つけた",
  before: [],
  after: [
    { label: "害の例", value: "戻せない削除" },
    { label: "重さ", value: "3" },
    { label: "must", value: "はい" },
  ],
  from: { session: "s1", at: APPEARED },
  effect: "now",
});

export const proposalSupersede = decorate({
  kind: "proposal",
  proposalId: "PROP-3",
  proposalKind: "root_supersede",
  repo: "penne-0505/propter",
  iddId: "#142",
  appearedAt: APPEARED,
  handle: "スキーマは自前で書く",
  reason: "依存を増やさないため",
  before: [
    { label: "今の DEC-1", value: "zod を使う" },
    { label: "Grounds", value: "依存を増やさない" },
  ],
  after: [
    { label: "後継", value: "スキーマは自前で書く" },
    { label: "Why", value: "依存を増やさない" },
    { label: "Anchored", value: "設定の読み込み" },
    { label: "Place", value: "src/config/load.ts（file）" },
  ],
  from: { lane: "#142", at: APPEARED },
  effect: "on_merge",
});

export const proposalReanchor = decorate({
  ...proposalSupersede,
  proposalId: "PROP-4",
  proposalKind: "root_reanchor",
  handle: "設定の読み込み",
  before: [{ label: "今の Place", value: "src/config/load.ts（file）" }, { label: "今の Anchored", value: "読み込み" }],
  after: [{ label: "案の Place", value: "src/config/（dir）" }, { label: "案の Anchored", value: "設定の全体" }],
});

export const v3 = (items) => items;

/** the low-space card: tied to no lane, carrying the free space, the next candidates and the held lanes */
export const storage = decorate({
  kind: "storage",
  cleanup: false,
  minFreeGb: 10,
  freeBytes: 13 * 1024 ** 3,
  totalBytes: 252 * 1024 ** 3,
  topPlaces: [{ label: "役の実行の記録", bytes: 6.2 * 1024 ** 3 }],
  candidateCount: 3,
  candidateBytes: 2.1 * 1024 ** 3,
  heldLanes: ["IDD-1", "IDD-2"],
});

/* ---- G3: 提出 / 取り込み ---- */

const FAR = "2035-01-01T00:00:00Z";

export const shipNewPr = decorate({
  kind: "ship",
  iddId: "#142",
  laneTitle: "新 GUI の Inbox と会話を engine につなぐ: React の code を正として部品に props を足す",
  title: "新 GUI の Inbox と会話を engine につなぐ: React の code を正として部品に props を足す",
  source: gh("GH #142", "https://example.test/142"),
  appearedAt: APPEARED,
  head: "a41c9e2",
  branch: { from: "lane/142", to: "main", repo: "propter" },
  pr: {
    title: "config: validate unknown keys on load",
    body: [{ text: "起動時にスキーマで検証する" }, { text: "Closes #142", issue: true }],
    commits: ["3f8a1c0 config: add schema for all keys", "a41c9e2 config: warn on unknown keys once"],
    vocabAllow: [],
  },
  checks: [
    { label: "typecheck", ok: true },
    { label: "lint", ok: true },
    { label: "record", ok: true },
    { label: "e2e", ok: false },
  ],
  proposal: {
    mode: "publish",
    blocking: 0,
    pr: { title: "config: validate unknown keys on load", body: "## 何を変えたか\n- 起動時にスキーマで検証する\n- 未知のキーは警告にする" },
    token: "tok-1",
    head: "a41c9e2",
    expiresAt: FAR,
    commitMessage: "config: validate unknown keys on load (#142)",
    checks: [
      { name: "typecheck", status: "pass", severity: "blocking", detail: "$ pnpm typecheck" },
      { name: "lint", status: "pass", severity: "blocking", detail: "$ pnpm lint" },
      { name: "record", status: "pass", severity: "blocking", detail: "$ propter record check" },
      { name: "e2e", status: "fail", severity: "blocking", detail: "config-reload.spec.ts が timeout" },
    ],
    publish: ["src/config/load.ts"],
    held: [],
    destination: { fingerprint: "fp", label: "propter" },
    branch: "lane/142",
  },
  review: {
    fixRounds: 3,
    closedBy: "loop",
    leftovers: [{ severity: "should", claim: "Schema のエラー文を i18n に", path: "load.ts:88" }],
    rejected: [{ claim: "zod に置き換える", reason: "依存を増やさない" }],
    followups: [{ severity: "nit", claim: "テストの名前", path: "load.test.ts:31" }],
    conflicts: ["src/config/load.ts"],
    r2: { must: 0, should: 2, nit: 1, findings: [] },
  },
  commit: { draft: "config: validate unknown keys on load (#142)" },
});

/** the API returns no per-round counts and no criteria: those lines and tabs stay away */
export const shipNoRounds = decorate({ ...shipNewPr, review: { ...shipNewPr.review, fixRounds: 0 } });

/** still checking: no proposal and no land */
export const shipNoCheck = decorate({
  kind: "ship",
  iddId: "#143",
  laneTitle: "まだ検査していない提出",
  title: "まだ検査していない提出",
  appearedAt: APPEARED,
  head: "b0b0b0b",
  branch: { from: "lane/143", to: "main", repo: "propter" },
  pr: { title: "wip", body: [], commits: [], vocabAllow: [] },
  checks: [],
});

/** this repo does not publish: the card approves the landing into the work side's mainline */
export const shipLand = decorate({
  kind: "ship",
  iddId: "#144",
  laneTitle: "取り込みの lane",
  title: "取り込みの lane",
  appearedAt: APPEARED,
  head: "c0c0c0c",
  branch: { from: "lane/144", to: "work", repo: "propter" },
  pr: { title: "", body: [], commits: [], vocabAllow: [] },
  checks: [{ label: "typecheck", ok: true }],
  land: {
    iddId: "#144",
    branch: "lane/144",
    head: "c0c0c0c",
    workBase: "work",
    mainTip: "d0d0d0d",
    mergeCommit: "e0e0e0e",
    checks: [{ name: "typecheck", status: "pass", severity: "blocking" }],
    blocking: 0,
    token: "land-1",
    expiresAt: FAR,
    configKey: "cfg",
    status: "prepared",
    close: { repo: "penne-0505/propter", issue: 142, comment: "取り込みました" },
  },
});

export const shipLandPending = decorate({ ...shipLand, landPending: { hold: "本流が動きました" } });
export const shipLandConflict = decorate({ ...shipLand, land: { ...shipLand.land, conflict: ["src/config/load.ts"] } });
/** a submit item that still carries the R2 gate field a card built before R2 was removed (2026-10-22) had */
export const shipR2Gate = decorate({ ...shipNewPr, r2Gate: { must: 1, should: 3 } });

/* ---- G4: 対外の投稿 ---- */

export const outboundReplies = decorate({
  kind: "outbound",
  iddId: "#139",
  laneTitle: "検索の置き場所: インデックスを repo の外に置いて worktree ごとに作り直さない",
  appearedAt: APPEARED,
  outKind: "gh-pr-replies",
  targetLabel: "Review への返信",
  title: "",
  draft: "下書き",
  proposed: "",
  createdAt: APPEARED,
  replies: [
    { ref: "store.ts:12", label: "reviewer-a", quote: "インデックスを repo の外に置く理由は？", url: "https://example.test/1", thread: true, draft: "~/.propter に置くと…", proposed: "~/.propter に置くと worktree ごとに作り直さずに済むためです。", resolve: true, posted: false },
    { ref: "fts.ts:40", label: "reviewer-a", quote: "trigram で日本語は大丈夫？", url: "https://example.test/2", thread: true, draft: "3 文字未満の語は…", proposed: "3 文字未満の語は LIKE に落とします。", resolve: true, posted: false },
  ],
});

export const outboundRepliesOnePosted = decorate({
  ...outboundReplies,
  replies: [outboundReplies.replies[0], { ...outboundReplies.replies[1], posted: true }],
});

export const outboundIssue = decorate({
  kind: "outbound",
  iddId: "#201",
  appearedAt: APPEARED,
  outKind: "gh-issue",
  targetLabel: "GitHub Issue · penne-0505/propter",
  title: "設定の検証を足す: 未知のキーを行番号つきの警告にして、古い設定でも起動できるようにする",
  draft: "d",
  proposed: "未知のキーは警告にする。",
  createdAt: APPEARED,
});

export const outboundReview = decorate({
  kind: "outbound",
  iddId: "#158",
  laneTitle: "設定の再読み込み: 保存中に読み込むと古い値が残るとの報告への対応",
  appearedAt: APPEARED,
  outKind: "gh-pr-review",
  targetLabel: "PR #158",
  title: "",
  draft: "",
  proposed: "保存中の読み込みを直してください。",
  createdAt: APPEARED,
  event: "comment",
  labelRules: { comment: { remove: ["needs-review"], add: ["reviewed"] }, approve: { remove: [], add: ["approved"] } },
});

export const outboundReviewApprove = decorate({ ...outboundReview, event: "approve", proposed: "" });

export const outboundBody = decorate({
  kind: "outbound",
  iddId: "#160",
  appearedAt: APPEARED,
  outKind: "gh-pr-body",
  targetLabel: "PR #160",
  title: "今の題",
  baseTitle: "今の題",
  baseBody: "一行目\n二行目",
  draft: "d",
  proposed: "一行目\n二行目",
  createdAt: APPEARED,
});

/** a GO card whose lane waits on a dependency not landed: the engine refuses the GO, so the card offers only あとで */
export const goBlocked = decorate({
  ...go,
  iddId: "#143",
  blockedBy: {
    reason: "blocker が本流に着地していません（#174）",
    items: [{ ref: "#174", title: "設定の読み口を一本にする", url: "https://example.test/174", state: "open", lane: "IDD-172" }],
  },
});
