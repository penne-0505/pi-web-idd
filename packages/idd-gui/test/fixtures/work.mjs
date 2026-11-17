/**
 * The Work screen's sample answers, shaped like the engine's doors and carrying the 3e prototype's values (the
 * reference's table: #138 stopped on the review cap, #142 implementing, #151 waiting on GO, #31 waiting on a
 * signature, LIN-212 failed its check). The compare script serves these; the app is never given a real engine.
 */

const NOW = "2026-10-13T05:00:00Z";
const at = (h, m = 0) => `2026-10-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const span = (key, label, start, end, owner) => ({ key, label, start, end, owner });
const ref = (label, url) => ({ kind: "github", label, url });

const LANES = [
  {
    kind: "issue",
    id: "#138",
    repo: "penne-0505/pi-web-idd",
    ref: ref("pi-web-idd#138", "https://github.com/penne-0505/pi-web-idd/issues/138"),
    title: "キャッシュの失効順",
    bundle: "running",
    turn: "stuck",
    activity: "live",
    note: "レビューの巡の上限",
    eta: "2026-10-13T07:30:00Z",
    anomaly: true,
    spans: [
      span("plan", "計画", at(0), at(1), "machine"),
      span("go", "GO 待ち", at(1), at(1, 22), "person"),
      span("impl", "実装", at(1, 22), at(2, 25), "machine"),
      span("review_round", "レビューの巡", at(2, 25), undefined, "machine"),
    ],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "#142",
    repo: "penne-0505/pi-web-idd",
    ref: ref("pi-web-idd#142", "https://github.com/penne-0505/pi-web-idd/issues/142"),
    title: "設定ファイルの検証",
    bundle: "running",
    activity: "live",
    eta: "2026-10-13T06:30:00Z",
    spans: [
      span("plan", "計画", at(0, 20), at(1, 15), "machine"),
      span("go", "GO 待ち", at(1, 15), at(1, 30), "person"),
      span("impl", "実装", at(1, 30), undefined, "machine"),
    ],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "#151",
    repo: "penne-0505/pi-web-idd",
    ref: ref("pi-web-idd#151", "https://github.com/penne-0505/pi-web-idd/issues/151"),
    title: "署名の検証",
    bundle: "running",
    turn: "go",
    activity: "stalled",
    spans: [
      span("plan", "計画", at(0, 10), at(1, 5), "machine"),
      span("plan_review", "計画の査読", at(1, 5), at(1, 20), "machine"),
      span("go", "GO 待ち", at(1, 20), undefined, "person"),
    ],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "#31",
    repo: "penne-0505/pi-web-idd",
    ref: ref("pi-web-idd#31", "https://github.com/penne-0505/pi-web-idd/issues/31"),
    title: "提出の署名",
    bundle: "running",
    turn: "ship",
    activity: "live",
    eta: "2026-10-13T06:00:00Z",
    spans: [
      span("impl", "実装", at(0, 30), at(2, 0), "machine"),
      span("review_round", "レビューの巡", at(2, 0), at(2, 30), "machine"),
      span("checks", "検査", at(2, 30), at(2, 40), "machine"),
      span("sign", "署名待ち", at(2, 40), undefined, "person"),
    ],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LIN-212",
    repo: "meltly/app",
    ref: { kind: "linear", label: "APP-212", url: "https://linear.app/meltly/issue/APP-212" },
    title: "Linear の型定義",
    bundle: "running",
    turn: "stuck",
    activity: "stalled",
    note: "engine が進められない: lint が型定義を読めない",
    spans: [span("impl", "実装", at(1, 0), undefined, "machine")],
    waitsFor: [],
  },
  {
    kind: "review",
    id: "REV-20261013T030000-abcd",
    repo: "penne-0505/pi-web-idd",
    ref: { kind: "pr", label: "pi-web-idd#45", url: "https://github.com/penne-0505/pi-web-idd/pull/45" },
    title: "PR レビュー: スクロールを追従させる",
    bundle: "running",
    turn: "review",
    activity: "live",
    spans: [
      span("pr_review", "PR レビュー中", at(3, 0), at(4, 0), "machine"),
      span("pr_review_penne", "投稿カードの確認待ち", at(4, 0), undefined, "person"),
    ],
    waitsFor: [],
  },
  {
    kind: "hold",
    id: "hold:github:#160",
    repo: "penne-0505/pi-web-idd",
    ref: ref("#160", "https://github.com/penne-0505/pi-web-idd/issues/160"),
    title: "待たれている Issue",
    bundle: "next",
    note: "blocker が開いている",
    spans: [],
    waitsFor: [{ ref: ref("#161", "https://github.com/penne-0505/pi-web-idd/issues/161"), title: "先の Issue" }],
  },
];

const DONE = [
  { id: "#120", repo: "penne-0505/pi-web-idd", ref: ref("pi-web-idd#120", ""), title: "古い修正", closedAt: at(3, 0), outcome: "landed", decisions: 2 },
  { id: "#131", repo: "penne-0505/pi-web-idd", ref: ref("pi-web-idd#131", ""), title: "見送った修正", closedAt: at(1, 0), outcome: "discarded", decisions: 1 },
];

export const WORK_STATE = {
  inbox: { source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items: [], undelivered: { total: 0, failed: 0 }, ignores: [], holds: [] },
  work: {
    now: NOW,
    repos: [
      { id: "penne-0505/pi-web-idd", name: "pi-web-idd", running: 5, waiting: 2, attention: true },
      { id: "meltly/app", name: "app", running: 1, waiting: 1, attention: true },
    ],
    lanes: LANES,
    done: DONE,
    holds: [
      { source: "github", area: "penne-0505/pi-web-idd", ref: "#160", title: "待たれている Issue", url: "https://github.com/penne-0505/pi-web-idd/issues/160", reason: "blocker が開いている", blockers: [{ ref: "#161", title: "先の Issue", url: "https://github.com/penne-0505/pi-web-idd/issues/161", state: "open", scope: "penne-0505/pi-web-idd", outOfScope: false }] },
    ],
  },
};

export const WORK_LANE_DETAIL = {
  iddId: "#138",
  title: "キャッシュの失効順",
  group: "impl",
  phaseLabel: "要判断",
  source: ref("pi-web-idd#138", "https://github.com/penne-0505/pi-web-idd/issues/138"),
  branch: "idd/IDD-138",
  area: "penne-0505/pi-web-idd",
  since: "3h",
  summary: {
    situation: "キャッシュの捨てる順が、実際の使われ方と合っていない。",
    action: "使われ方の記録から順番を決め直す。",
    outcome: "よく使うものが残り、捨てた後の読み直しが減る。",
  },
  contract: {
    decisions: [],
    criteria: [
      { id: "AC-001", text: "順番の決め方が記録から読める", state: "done" },
      { id: "AC-002", text: "捨てた後の読み直しが減る", state: "doing" },
    ],
    invariants: [],
  },
  timeline: [],
  agents: [],
  undelivered: { total: 0, failed: 0 },
  reviewRounds: [
    { round: 1, kind: "blind", must: 2, should: 1, nit: 3, open: 1 },
    { round: 2, kind: "final", must: 1, should: 0, nit: 2, open: 0 },
  ],
  slotWait: { label: "レビュー", cap: 2, minutes: 12 },
};

export const WORK_DECISIONS = {
  lane: "#138",
  own: [
    {
      id: "DEC-138-1",
      title: "失効の順は使われ方の記録から決める",
      place: "`packages/idd-core/src/cache.ts`",
      why: "捨てる順を固定すると、使われ方が変わった日に読み直しが増える。",
      whyNot: [{ form: "アクセス時刻だけを見る", reason: "書き込みの多い経路が古いまま残る" }],
      anchored: [{ id: "INV-138-1", text: "順番は記録から導き、手で並べない。" }],
      free: "記録の持ち方と重みの付け方は自由。",
      hasPlace: true,
    },
  ],
  existing: [
    {
      id: "DEC-1201",
      title: "記録は書き込みの下に置く",
      place: "`packages/idd-core/src/cache.ts`",
      why: "読み手が 2 つあると、どちらが正しいかを確かめられない。",
      whyNot: [],
      anchored: [],
      free: "",
      hasPlace: true,
    },
  ],
  dropped: 1,
  paths: ["packages/idd-core/src/cache.ts"],
};
