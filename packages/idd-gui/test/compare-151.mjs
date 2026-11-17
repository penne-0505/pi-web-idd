#!/usr/bin/env node
/**
 * idd-151: the pictures the plan asks for (AC-007). The Work screen is served from this lane's built bundle and
 * every `/api/idd/…` answer is a fixed fixture written beside the pictures, so each picture can be read against the
 * response it was drawn from. The fixture is built to hold the states this lane judges: a lane waiting on an
 * answer, two lanes sharing one ref label, a lane past its usual with the engine's anomaly, a lane with a dropped
 * finding beside open ones, and a lane whose stage runs far past any column.
 *
 * Usage: node packages/idd-gui/test/compare-151.mjs   (build first: bun run --cwd packages/idd-gui build)
 *
 * Only GETs are served and the fixture answers them; the live engine is never read and never written.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist");
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-151", "compare");
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-151");

const CHROME = "/usr/bin/google-chrome-stable";
const FRAME = { width: 1440, height: 900 };
const NOW = "2026-10-16T04:00:00+09:00";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------ the fixture
const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const ref = (label) => ({ kind: "github", label, url: `https://example.test/${label}` });
const span = (key, label, startMin, endMin, owner = "machine") => ({ key, label, owner, start: at(startMin), ...(endMin === undefined ? {} : { end: at(endMin) }) });
const stat = (median, p75, threshold) => ({ median, p75, threshold, samples: 7, basis: "repo" });

const PROJECTS = [
  { id: "penne-0505/propter", name: "propter", running: 5, waiting: 0, attention: true },
  { id: "meltly/medo", name: "medo", running: 0, waiting: 1, attention: false },
];

const LANES = [
  {
    kind: "issue",
    id: "LR",
    repo: "penne-0505/propter",
    ref: ref("propter#11"),
    title: "レビュー以降で異常の lane",
    bundle: "running",
    spans: [span("impl", "実装", -520, -500), span("review_round", "レビューの巡", -470)],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LQ",
    repo: "penne-0505/propter",
    ref: ref("propter#151"),
    title: "質問を待っている lane",
    bundle: "running",
    turn: "question",
    spans: [span("impl", "実装", -40)],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LA",
    repo: "penne-0505/propter",
    ref: ref("propter#7"),
    title: "同じ label の 1 本目",
    bundle: "running",
    turn: "go",
    spans: [span("impl", "実装", -30)],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LB",
    repo: "penne-0505/propter",
    ref: ref("propter#7"),
    title: "同じ label の 2 本目",
    bundle: "running",
    spans: [span("plan_review", "計画の査読", -20)],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LL",
    repo: "penne-0505/propter",
    ref: ref("propter#12"),
    title: "非常に長い段の lane",
    bundle: "running",
    spans: [span("impl", "実装", -5200, -5000), span("review_round", "レビューの巡", -470)],
    waitsFor: [],
  },
  {
    kind: "issue",
    id: "LW",
    repo: "meltly/medo",
    ref: ref("medo#33"),
    title: "medo の待ち lane",
    bundle: "next",
    spans: [],
    waitsFor: [],
  },
];

const DONE = [{ id: "LD", repo: "penne-0505/propter", ref: ref("propter#3"), title: "済みの lane", closedAt: at(-120), outcome: "local", decisions: 1 }];

/**
 * The forecast's own answer: the usual table per area and each open lane's `now`. `LR` is past its threshold and
 * so anomalous; `LQ` is at the question gate, which is where the question mark comes from; `LL` is inside its usual
 * but its stage runs far past any column.
 */
const USUAL = {
  "penne-0505/propter": {
    plan: stat(10, 15, 30),
    plan_review: stat(20, 30, 60),
    impl: stat(40, 60, 120),
    review: stat(500, 600, 1200),
    fix: stat(200, 220, 440),
    r2: stat(8, 12, 24),
    land: stat(30, 45, 90),
  },
  "meltly/medo": {
    plan: stat(12, 18, 36),
    plan_review: stat(22, 33, 66),
    impl: stat(45, 68, 136),
    review: stat(80, 120, 240),
    fix: stat(25, 38, 76),
    r2: stat(9, 14, 28),
    land: stat(35, 53, 106),
  },
};

const FORECAST_LANES = [
  { iddId: "LR", area: "penne-0505/propter", now: { kind: "stage", stage: "fix", since: at(-470), elapsedMin: 470 }, anomaly: true, eta: { at: at(120), stopsAt: "sign", remaining: [{ stage: "r2", minutes: 8 }] } },
  { iddId: "LQ", area: "penne-0505/propter", now: { kind: "gate", gate: "question", since: at(-40), elapsedMin: 40 }, anomaly: false, eta: { at: null, stopsAt: "go", remaining: [] } },
  { iddId: "LA", area: "penne-0505/propter", now: { kind: "stage", stage: "impl", since: at(-30), elapsedMin: 30 }, anomaly: false, eta: { at: at(90), stopsAt: "sign", remaining: [{ stage: "impl", minutes: 10 }] } },
  { iddId: "LB", area: "penne-0505/propter", now: { kind: "stage", stage: "plan_review", since: at(-20), elapsedMin: 20 }, anomaly: false, eta: { at: at(40), stopsAt: "go", remaining: [{ stage: "plan_review", minutes: 0 }] } },
  { iddId: "LL", area: "penne-0505/propter", now: { kind: "stage", stage: "review", since: at(-470), elapsedMin: 470 }, anomaly: false, eta: { at: at(60), stopsAt: "sign", remaining: [{ stage: "review", minutes: 30 }] } },
];

const DETAIL = {
  iddId: "LR",
  title: "レビュー以降で異常の lane",
  group: "impl",
  phaseLabel: "レビュー",
  branch: "idd/IDD-151",
  area: "penne-0505/propter",
  since: at(-470),
  undelivered: { total: 0, failed: 0 },
  contract: { decisions: [], criteria: [] },
  timeline: [],
  agents: [],
  cost: { total: 3.21, parts: [], subscription: [] },
  reviewRounds: [
    { round: 1, kind: "blind", must: 1, should: 2, nit: 1, open: 2 },
    { round: 2, kind: "blind", must: 0, should: 1, nit: 0, open: 1 },
  ],
};

const DECISIONS = {
  lane: "LR",
  own: [
    { id: "C-151-4", title: "直した数は巡の判定から数える", place: "packages/idd-gui/src/work/viewmodel.ts", why: "却下や位置喪失は直したことではない。", whyNot: [], anchored: [], free: "数え方の式は自由。", hasPlace: true },
  ],
  existing: [],
  dropped: 0,
  paths: [],
};

const RECORD = {
  lane: "LR",
  acceptance: [
    { id: "AC-001", statement: "段のふだんと朱は engine の今の段の値だけで出る", status: "verified" },
    { id: "AC-002", statement: "欄の欠けた応答でも Work は描ける", status: "verified" },
    { id: "AC-003", statement: "同じ label の lane もそれぞれ自分の行で出る", status: "planned" },
  ],
  log: [],
  findings: {
    placed: [
      { id: "F-151-1", lane: "LR", round: 1, path: "src/work/viewmodel.ts", lines: [430, 445], commit: "c0ffee", severity: "must", claim: "今の段の行にだけふだんを出す", status: "open" },
      { id: "F-151-2", lane: "LR", round: 2, path: "src/work/viewmodel.ts", lines: [500, 520], commit: "c0ffee", severity: "should", claim: "巡の行に残りを二重に数えない", status: "dropped", reason: "ファイルが本流に無い" },
      { id: "F-151-3", lane: "LR", round: 2, path: "src/components/work/WorkFindings.tsx", lines: [8, 26], commit: "c0ffee", severity: "should", claim: "dropped の指摘をどの区分にも出さない", status: "open" },
    ],
    // what was handed to this lane: F-151-1 is its own finding, so it stays on the place side and is never drawn twice
    delivered: [
      { id: "F-151-1", lane: "LR", round: 1, path: "src/work/viewmodel.ts", lines: [430, 445], commit: "c0ffee", severity: "must", claim: "今の段の行にだけふだんを出す", status: "open" },
      { id: "F-151-4", lane: "IDD-140", round: 1, path: "src/work/viewmodel.ts", lines: [96, 96], commit: "beef", severity: "should", claim: "渡されたまま直っていない指摘", status: "open" },
    ],
    disposals: [],
  },
};

/** every door the screen reads, one fixed answer each (GET only) */
const DOORS = {
  "/api/idd/work": { now: NOW, repos: PROJECTS, lanes: LANES, done: DONE, holds: [] },
  "/api/idd/forecast": { ok: true, generatedAt: NOW, usual: Object.entries(USUAL).map(([area, stages]) => ({ area, lanes: 3, stages })), lanes: FORECAST_LANES },
  "/api/idd/work/consumption": { rows: [], summary: { cost: 12.34, units: 5, buckets: [], failures: {} } },
  "/api/idd/lane/LR": DETAIL,
  "/api/idd/work/lanes/LR/decisions": DECISIONS,
  "/api/idd/work/lanes/LR/record": RECORD,
};

// ------------------------------------------------------------------ the static server
function serveDist(doors) {
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname.startsWith("/api/idd/")) {
      const body = doors[pathname];
      if (body === undefined) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not in fixture" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      return;
    }
    const file = pathname === "/gui/" || pathname === "/gui" ? "index.html" : pathname.replace(/^\/gui\//, "");
    const full = join(DIST, file);
    if (!full.startsWith(DIST) || !existsSync(full)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(full));
  });
}

// ------------------------------------------------------------------ the browser
async function withChrome(run) {
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=0", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const ws = new WebSocket(await cdpPageUrl(chrome));
    await new Promise((done, fail) => {
      ws.addEventListener("open", done);
      ws.addEventListener("error", fail);
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((done) => {
        id += 1;
        pending.set(id, done);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const client = {
      send,
      async viewport(width, height) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      },
      async goto(url, timeoutMs = 20_000) {
        await send("Page.navigate", { url });
        const until = Date.now() + timeoutMs;
        for (;;) {
          const ready = await client.evaluate("document.readyState === 'complete'");
          if (ready) return;
          if (Date.now() > until) throw new Error(`page did not finish loading: ${url}`);
          await sleep(100);
        }
      },
      async evaluate(expression) {
        const answer = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        return answer.result?.result?.value;
      },
      async waitFor(expression, timeoutMs = 8000) {
        const until = Date.now() + timeoutMs;
        for (;;) {
          if (await client.evaluate(expression)) return true;
          if (Date.now() > until) return false;
          await sleep(100);
        }
      },
      async settle() {
        await client.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
        await client.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
        await sleep(250);
      },
      async screenshot(out) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(out, Buffer.from(shot.result.data, "base64"));
      },
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await run(client);
    ws.close();
  } finally {
    chrome.kill("SIGKILL");
  }
}

/** the debugging websocket Chrome printed to its stderr, so the port is the one it chose */
async function cdpPageUrl(chrome) {
  const port = await new Promise((done, fail) => {
    let buffer = "";
    const until = setTimeout(() => fail(new Error("chrome opened no debugging port")), 15_000);
    chrome.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buffer);
      if (m) {
        clearTimeout(until);
        done(Number(m[1]));
      }
    });
    chrome.on("exit", () => {
      clearTimeout(until);
      fail(new Error("chrome exited before it opened a debugging port"));
    });
  });
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("chrome opened no debugging page");
}

const HAS_TEXT = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const CLICK = (text) =>
  `(function () { const el = [...document.querySelectorAll('span')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true; })()`;

/** the text of the drawn screen, with every run of whitespace folded to one space */
const FLAT_TEXT = `document.body.innerText.replace(/\\s+/g, ' ').trim()`;
/** the same text with every gap dropped: the prototype's parts are flex rows, so innerText adds gaps inside a label */
const TIGHT_TEXT = `document.body.innerText.replace(/\\s+/g, '')`;

/** the stage table's rows: each bar's, usual tick's and usual label's right edge beside its column's (AC-006) */
const MEASURE_STAGE = `(function () {
  const grid = [...document.querySelectorAll('div')].find((el) => {
    const s = getComputedStyle(el);
    return s.display === 'grid' && s.gridTemplateColumns.startsWith('72px');
  });
  if (!grid) return null;
  const cells = [...grid.children];
  const right = (el) => (el ? Math.round(el.getBoundingClientRect().right * 10) / 10 : null);
  const rows = [];
  for (let i = 0; i + 2 < cells.length; i += 3) {
    const mid = cells[i + 1];
    rows.push({
      name: cells[i].textContent.trim(),
      time: cells[i + 2].textContent.trim(),
      columnRight: right(mid),
      barRight: right(mid.children[0]),
      barWidth: mid.children[0] ? Math.round(mid.children[0].getBoundingClientRect().width * 10) / 10 : null,
      usualRight: right(mid.children[1]),
      usualLabelRight: right(mid.children[2]),
    });
  }
  return { rows };
})()`;

/** the round rows of the findings tab, read from their own three cells (AC-004) */
const MEASURE_ROUNDS = `(function () {
  const grid = [...document.querySelectorAll('div')].find((el) => {
    const s = getComputedStyle(el);
    return s.display === 'grid' && s.gridTemplateColumns.startsWith('28px');
  });
  if (!grid) return null;
  const cells = [...grid.children];
  const rounds = [];
  for (let i = 0; i + 2 < cells.length; i += 3) rounds.push({ r: cells[i].textContent.trim(), n: cells[i + 2].textContent.trim(), segs: cells[i + 1].children.length });
  return { rounds };
})()`;

/** the question mark the attention list draws, counted with its own shape (AC-005) */
const MEASURE_QUESTION = `(function () {
  // the screen carries one other ? at 16px; this mark is the 10px one the attention list's column holds
  const marks = [...document.querySelectorAll('span')].filter((e) => e.textContent.trim() === '?' && e.getBoundingClientRect().width > 0 && getComputedStyle(e).fontSize === '10px');
  return {
    count: marks.length,
    shapes: marks.map((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, bg: s.backgroundColor, font: s.font };
    }),
  };
})()`;

// ------------------------------------------------------------------ the run
/** every check the picture is read for, printed either way and thrown on the first that does not hold */
function verify(label, checks) {
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${label}: ${c.what}${c.ok ? "" : ` — ${JSON.stringify(c.seen)}`}`);
  if (failed.length) throw new Error(`${label}: ${failed.map((c) => c.what).join(" / ")}`);
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  // the responses the pictures are drawn from, beside them so the two can be read together
  const written = join(OUT, "engine-responses.json");
  writeFileSync(
    written,
    JSON.stringify(
      {
        note: "the fixed `/api/idd/…` answers every picture in this place was drawn from (AC-007). No live engine was read.",
        at: NOW,
        window: FRAME,
        doors: DOORS,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${written}`);

  const server = serveDist(DOORS);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const url = (hash, nonce = "") => `http://127.0.0.1:${port}/gui/?view=lanes${nonce}${hash}`;
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);

      // ---- no lane selected: the lane list and the 「気にすること」 the repo summary draws
      await client.goto(url("", "&step=1"));
      if (!(await client.waitFor(HAS_TEXT("質問を待っている lane")))) throw new Error("the lane column never showed the fixture's lanes");
      await client.settle();
      const none = await client.evaluate(FLAT_TEXT);
      const question = await client.evaluate(MEASURE_QUESTION);
      await client.screenshot(join(OUT, "work-none.png"));
      verify("none", [
        { what: "the two lanes that share a ref label are drawn as their own rows", ok: none.includes("同じ label の 1 本目") && none.includes("同じ label の 2 本目"), seen: none.slice(0, 400) },
        { what: "the question lane takes the ? mark", ok: question.count === 1, seen: question },
        { what: "the ? keeps the prototype's shape", ok: question.shapes[0]?.radius === "4px" && question.shapes[0]?.w > 15 && question.shapes[0]?.w < 26, seen: question.shapes },
        { what: "the anomaly lane's finish is drawn red", ok: none.includes("レビュー以降で異常の lane"), seen: none.slice(0, 400) },
      ]);

      // ---- the anomalous lane selected: the 状況 tab with the stage table (AC-001, AC-006)
      // a different query as well, so the fragment change really reloads the screen and its state machine
      await client.goto(url("#work/LR", "&step=2"));
      if (!(await client.waitFor(HAS_TEXT("段ごとの時間")))) throw new Error("the stage table was never drawn for LR");
      await client.settle();
      const stage = await client.evaluate(MEASURE_STAGE);
      const stageText = await client.evaluate(FLAT_TEXT);
      await client.screenshot(join(OUT, "work-stage.png"));
      if (!stage) throw new Error("the stage table could not be read");
      const inside = (r) => [r.barRight, r.usualRight, r.usualLabelRight].every((x) => x === null || x <= r.columnRight + 0.5);
      verify("stage", [
        { what: "the very long band and its usual mark stay inside their column", ok: stage.rows.every(inside), seen: stage.rows },
        { what: "the time text still shows the row's real length", ok: stageText.includes("7h50m") && stageText.includes("20m"), seen: stageText.slice(0, 400) },
        { what: "the usual mark is drawn on the running row alone", ok: stage.rows.filter((r) => r.usualRight !== null).length === 1, seen: stage.rows },
        { what: "the running row's name keeps the band's own label", ok: stage.rows.some((r) => r.name === "レビューの巡"), seen: stage.rows.map((r) => r.name) },
      ]);

      // ---- the same lane on the 指摘 tab (AC-004)
      if (!(await client.evaluate(CLICK("指摘")))) throw new Error("the 指摘 tab could not be pressed");
      if (!(await client.waitFor(HAS_TEXT("直した")))) throw new Error("the findings tab was never drawn");
      await client.settle();
      const rounds = await client.evaluate(MEASURE_ROUNDS);
      const findings = await client.evaluate(TIGHT_TEXT);
      await client.screenshot(join(OUT, "work-findings.png"));
      if (!rounds) throw new Error("the round rows could not be read");
      verify("findings", [
        { what: "each round's count is the judgement's accepted number", ok: rounds.rounds.map((r) => `${r.r}=${r.n}`).join(",") === "R1=4,R2=1", seen: rounds.rounds },
        { what: "the accepted bar still paints the open part", ok: rounds.rounds[0]?.segs === 6 && rounds.rounds[1]?.segs === 2, seen: rounds.rounds },
        { what: "直した counts what the rounds confirmed fixed", ok: findings.includes("直した2"), seen: findings.slice(0, 600) },
        { what: "the dropped finding is drawn nowhere", ok: !findings.includes("巡の行に残りを二重に数えない"), seen: findings.slice(0, 600) },
        { what: "残っている shows the finding handed to the lane", ok: findings.includes("残っている1") && findings.includes("渡されたまま直っていない指摘"), seen: findings.slice(0, 600) },
        { what: "場所に付けた shows every open finding the lane placed", ok: findings.includes("場所に付けた") && findings.includes("今の段の行にだけふだんを出す") && findings.includes("droppedの指摘をどの区分にも出さない"), seen: findings.slice(0, 600) },
        { what: "a finding the lane placed is never drawn on the remaining side", ok: !findings.includes("残っている2"), seen: findings.slice(0, 600) },
        { what: "the tab counts only the findings it draws", ok: findings.includes("指摘3"), seen: findings.slice(0, 200) },
      ]);
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

await main();
