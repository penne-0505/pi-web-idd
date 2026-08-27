// intent: DEC-603 — pipeline が動く前に UI を完成させるための fixture

import type { CronRun, InboxItem, LaneDetailView, LaneRow, LaneSection, UndeliveredCount } from "./types";

// intent: DEC-665 — fixture でも失敗分が区別できる状態を再現する
export const MOCK_UNDELIVERED: UndeliveredCount = { total: 2, failed: 1 };

export const MOCK_CRON: CronRun = {
  startedAt: "05:30",
  finishedAt: "05:58",
  failures: [],
  breakdown: { intake: 10, duplicates: 2, newLanes: 3 },
};

export const MOCK_CRON_FAILED: CronRun = {
  startedAt: "05:30",
  finishedAt: "06:12",
  failures: [
    { iddId: "IDD-046", reason: "下調べ中に model が応答しなくなった" },
    { iddId: "IDD-047", reason: "worktree を作れなかった (branch が既に存在)" },
  ],
};

export const MOCK_INBOX: InboxItem[] = [
  {
    kind: "duplicate",
    iddId: "REV-007",
    reviewId: "REV-007",
    incoming: { title: "ダークモード対応", ref: { kind: "linear", label: "linear APP-1712" } },
    existing: { title: "ダークモード基礎対応", ref: { kind: "lane", label: "IDD-020" }, stage: { done: 2, current: 2 } },
    similarity: 0.87,
    reason: "両者とも SettingsPanel のトグル追加を扱っている",
    shared: ["SettingsPanel.tsx", "theme toggle", "area: settings"],
  },
  {
    kind: "question",
    iddId: "IDD-044",
    laneTitle: "テーマ切替の追加",
    source: { kind: "github", label: "gh medo#88" },
    batchId: "B-001",
    askedTotal: 2,
    answeredCount: 0,
    primaryRef: { kind: "file", label: "SettingsPanel.tsx" },
    open: [
      {
        questionId: "Q-001",
        question: "ダークモードのトグルはどこに配置しますか?",
        facts: [
          { label: "設定パネル", value: "3 tab", ref: { kind: "file", label: "SettingsPanel.tsx" } },
          { label: "テーマ切替", value: "未実装" },
          { label: "theme key", value: "参照あり", ref: { kind: "file", label: "ThemeInitializer.ts" } },
        ],
        options: [
          { index: 1, label: "既存の設定パネル内に追加する" },
          { index: 2, label: "header の右上に独立配置する" },
          { index: 3, label: "既存パネルを再構成してから追加する" },
        ],
      },
      {
        questionId: "Q-002",
        question: "切替の既定値は何にしますか?",
        facts: [{ label: "OS 設定", value: "追従なし" }],
        options: [
          { index: 1, label: "OS 設定に追従する" },
          { index: 2, label: "常に light で始める" },
        ],
      },
    ],
  },
  {
    kind: "go",
    iddId: "IDD-042",
    title: "ダークモード対応 (可視性 QA を含む)",
    source: { kind: "linear", label: "linear APP-1712" },
    priorityTop: true,
    decisions: [
      { id: "DEC-1", text: "既存の設定パネルを再構成してからトグルを追加する" },
      { id: "DEC-2", text: "theme key は 'theme.v2' として並存させ、既存 key は壊さない" },
      { id: "DEC-3", text: "OS の外観設定の変更に listener で追従する" },
    ],
    criteria: [
      { id: "QA-1", text: "切替が 3 秒以内に反映される" },
      { id: "QA-2", text: "再読み込み後も選択が保持される" },
      { id: "QA-3", text: "既存 theme key を読む 2 箇所が壊れない" },
      { id: "QA-4", text: "コントラストが WCAG AA を満たす" },
    ],
  },
  {
    kind: "review",
    iddId: "IDD-039",
    handoffNote: "integrator が判断を委ねた",
    target: { title: "テーマ設定の永続化", ref: { kind: "linear", label: "linear APP-1698" } },
    conflictWith: { title: "ダークモード対応", ref: { kind: "lane", label: "IDD-042" } },
    diff: {
      file: "lib/theme/provider.ts",
      fileIndex: 1,
      fileTotal: 2,
      before: [
        { marker: null, code: "export function ThemeProvider() {", lineNo: "11" },
        { marker: "-", code: "const KEY = 'theme'", lineNo: "12" },
        { marker: null, code: "localStorage.setItem(KEY, mode)", lineNo: "13" },
        { marker: null, code: "", lineNo: "14" },
      ],
      after: [
        { marker: null, code: "export function ThemeProvider() {", lineNo: "11" },
        { marker: "+", code: "const KEY = 'theme.v2'", lineNo: "12" },
        { marker: null, code: "localStorage.setItem(KEY, mode)", lineNo: "13" },
        { marker: "+", code: "migrateLegacyTheme()", lineNo: "14" },
      ],
    },
    criteria: [
      { id: "QA-1", text: "既存の theme key を読む 2 箇所が壊れない", state: "done" },
      { id: "QA-2", text: "再読み込み後も選択が保持される", state: "done" },
      { id: "QA-3", text: "移行処理が 1 度だけ走る", state: "todo" },
      { id: "QA-4", text: "既定値が OS 設定に追従する", state: "done" },
    ],
  },
  {
    kind: "ship",
    iddId: "IDD-036",
    title: "課金ダイヤ表示の修正",
    source: { kind: "linear", label: "linear APP-1690" },
    handoffNote: "verifier が判断を委ねた",
    branch: { from: "idd/IDD-036", to: "feat/app-1690-billing-gem-display", repo: "Dayseum/daysai-flutter" },
    pr: {
      title: "fix(billing): ダイヤ表示の崩れを修正",
      body: [
        { text: "切替時の再描画を改善", flagged: { original: "「3 秒以内に収める」" } },
        { text: "QA で検証したテストを追加" },
      ],
      commits: [
        "fix(billing): ダイヤ表示の崩れを修正",
        "fix(billing): 端末幅による折り返しを調整",
        "test(billing): 表示崩れの回帰テストを追加",
        "chore(billing): 未使用の定数を削除",
      ],
    },
    checks: [
      { label: "IDD の語彙が残っていない", ok: true },
      { label: "書き換えで意味が失われていない", ok: false },
      { label: "PR body と commit が一致している", ok: true },
      { label: "書式が area の規約に沿っている", ok: true },
    ],
  },
];

export const MOCK_SECTIONS: LaneSection[] = [
  { group: "judge", label: "判断待ち", count: 4 },
  { group: "prep", label: "下調べ中", count: 1, cap: 5 },
  { group: "impl", label: "実装中", count: 2, cap: 3 },
  { group: "waiting", label: "待機中", count: 1 },
  { group: "closed", label: "終端 (直近)", count: 2, collapsed: true },
];

export const MOCK_LANES: LaneRow[] = [
  { iddId: "REV-007", title: "ダークモード対応", group: "judge", decision: "duplicate", stageDone: 0, stageCurrent: 0, elapsed: "3h", source: { kind: "linear", label: "APP-1712" } },
  { iddId: "IDD-042", title: "ダークモード対応 (可視性 QA)", group: "judge", decision: "go", stageDone: 2, stageCurrent: null, elapsed: "1h", source: { kind: "linear", label: "APP-1712" }, priorityTop: true },
  { iddId: "IDD-044", title: "テーマ切替の追加", group: "judge", decision: "question", stageDone: 1, stageCurrent: 1, elapsed: "6h", source: { kind: "github", label: "medo#88" } },
  { iddId: "IDD-039", title: "テーマ設定の永続化", group: "judge", decision: "review", stageDone: 3, stageCurrent: 3, elapsed: "20m", source: { kind: "linear", label: "APP-1698" } },
  { iddId: "IDD-047", title: "検索フィルタの保存", group: "prep", stageDone: 1, stageCurrent: 1, elapsed: "4m", source: { kind: "linear", label: "APP-1720" } },
  { iddId: "IDD-043", title: "予約多重送信の修正", group: "impl", stageDone: 2, stageCurrent: 2, elapsed: "3h", source: { kind: "linear", label: "APP-1715" } },
  { iddId: "IDD-036", title: "課金ダイヤ表示の修正", group: "impl", stageDone: 4, stageCurrent: 4, elapsed: "12m", source: { kind: "linear", label: "APP-1690" } },
  { iddId: "IDD-045", title: "lane detail の SSE 化", group: "waiting", stageDone: 2, stageCurrent: 2, elapsed: "5h", blockedBy: "IDD-043" },
  { iddId: "IDD-031", title: "設定パネル再構成", group: "closed", stageDone: 5, stageCurrent: null, elapsed: "昨日", source: { kind: "linear", label: "APP-1671" }, faded: true },
  { iddId: "IDD-028", title: "スコープ過大のため保留", group: "closed", stageDone: 2, stageCurrent: null, elapsed: "3d", source: { kind: "github", label: "medo#71" }, faded: true },
];

export const MOCK_LANE_DETAIL: Record<string, LaneDetailView> = {
  "IDD-043": {
    iddId: "IDD-043",
    title: "予約多重送信の修正",
    group: "impl",
    phaseLabel: "実装中",
    source: { kind: "linear", label: "linear APP-1715" },
    branch: "idd/IDD-043",
    area: "dayseum-app",
    since: "開始 3h 前",
    undelivered: MOCK_UNDELIVERED,
    contract: {
      decisions: [
        { id: "DEC-1", text: "同一 intent の予約は 1 度だけ送信する (client 側で重複を排除)" },
        { id: "DEC-2", text: "送信中は確認 dialog の再表示を抑止する" },
        { id: "DEC-3", text: "失敗時は再送可能な状態へ戻す" },
      ],
      criteria: [
        { id: "QA-1", text: "同一 intent で 2 度送信されない", state: "done" },
        { id: "QA-2", text: "送信中は dialog が再表示されない", state: "done" },
        { id: "QA-3", text: "失敗後に再送できる", state: "doing" },
        { id: "QA-4", text: "既存の予約 flow が壊れない", state: "todo" },
        { id: "QA-5", text: "通信断からの復帰で二重送信が起きない", state: "todo" },
      ],
    },
    work: {
      files: [
        { path: "lib/features/reservation/reservation_controller.dart", delta: "+42 −8" },
        { path: "lib/features/reservation/widgets/confirm_dialog.dart", delta: "+11 −3" },
        { path: "test/features/reservation/dedupe_test.dart", delta: "+96 −0" },
      ],
      stream: [
        { time: "14:31", kind: "read", body: "lib/features/reservation/reservation_controller.dart" },
        { time: "14:32", kind: "edit", body: "test/features/reservation/dedupe_test.dart" },
        { time: "14:32", kind: "run", body: "fvm flutter test test/features/reservation/dedupe_test.dart" },
        { time: "14:33", kind: "…", body: "通信断からの復帰 case を追加しています", live: true },
      ],
    },
    timeline: [
      { time: "05:30", title: "起票", detail: "cron · Linear から取り込み", kind: "agent" },
      { time: "07:52", title: "下調べ完了", detail: "DEC 3 · QA 5", kind: "agent" },
      { time: "08:04", title: "GO", detail: "自分の判断", kind: "user" },
      { time: "08:05", title: "実装開始", detail: "opencode go v4flash", kind: "agent" },
      { time: "10:41", title: "model を切り替え", detail: "→ ollama cloud v4flash", kind: "warn" },
    ],
    agents: [
      { role: "下調べ", sessionId: "pi-session-abc123", state: "終了" },
      { role: "実装", sessionId: "pi-session-def456", state: "稼働中" },
    ],
  },
  "IDD-042": {
    iddId: "IDD-042",
    title: "ダークモード対応 (可視性 QA を含む)",
    group: "judge",
    phaseLabel: "GO 待ち",
    source: { kind: "linear", label: "linear APP-1712" },
    branch: "idd/IDD-042",
    area: "dayseum-app",
    since: "下調べ完了 1h 前",
    undelivered: { total: 0, failed: 0 },
    priorityTop: true,
    pending: "go",
    contract: {
      decisions: [
        { id: "DEC-1", text: "既存の設定パネルを再構成してからトグルを追加する" },
        { id: "DEC-2", text: "theme key は 'theme.v2' として並存させ、既存 key は壊さない" },
        { id: "DEC-3", text: "OS の外観設定の変更に listener で追従する" },
      ],
      criteria: [
        { id: "QA-1", text: "切替が 3 秒以内に反映される", state: "todo" },
        { id: "QA-2", text: "再読み込み後も選択が保持される", state: "todo" },
        { id: "QA-3", text: "既存 theme key を読む 2 箇所が壊れない", state: "todo" },
        { id: "QA-4", text: "コントラストが WCAG AA を満たす", state: "todo" },
      ],
      invariants: [
        { id: "INV-1", text: "既存の theme key を読む code の挙動を変えない" },
        { id: "INV-2", text: "設定パネルの既存 3 tab の並びを保つ" },
      ],
    },
    references: [
      { path: "lib/theme/provider.ts", why: "theme key の書き込み箇所" },
      { path: "components/SettingsPanel.tsx", why: "3 tab 構成、4 つ目の追加先" },
      { path: "ThemeInitializer.ts", why: "起動時に theme key を読む" },
    ],
    timeline: [
      { time: "05:30", title: "起票", detail: "cron · Linear から取り込み", kind: "agent" },
      { time: "05:34", title: "質問 2 件", detail: "planner が回答待ちに入った", kind: "agent" },
      { time: "07:25", title: "回答を送信", detail: "自分の判断", kind: "user" },
      { time: "07:52", title: "下調べ完了", detail: "DEC 3 · INV 2 · QA 4 · 参照 6", kind: "agent" },
    ],
    agents: [{ role: "下調べ", sessionId: "pi-session-abc123", state: "稼働中" }],
  },
};
