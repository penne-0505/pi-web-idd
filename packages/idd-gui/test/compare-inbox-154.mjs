#!/usr/bin/env node
/**
 * IDD-154: the pictures the plan asks for (AC-008). For each of the eight card kinds the Inbox has a shape for,
 * this lane's built Inbox is shot with a fake engine answering the card's own item, and the prototype (the
 * converged design) is shot holding the same card. The frames carry the left sidebar and the right panel. Each
 * pair is written under `_docs/qa/pi-web-idd/idd-154/compare/` together with the response the implementation was
 * drawn from. One more picture is taken from the running engine's own `/api/idd/state` snapshot (GET only).
 *
 * Usage: node packages/idd-gui/test/compare-inbox-154.mjs
 *
 * Only GETs reach the engine, whose snapshot is read once and served from this script's own fake engine. The
 * prototype is read from `_meta/gui-prototype/` with the patched pages written under `_meta/scratch/`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { question, go, goWithPurposes, stuckLimit, duplicate, requeue, shipNewPr, outboundIssue, outboundReview, storage } from "./fixtures/items.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist");
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-154", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-154");
const CHROME = "/usr/bin/google-chrome-stable";
const LIVE_STATE = "http://127.0.0.1:30144/api/idd/state";
const FRAME = { width: 1440, height: 900 };

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
const state = (items, extra = {}) => ({ source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items, undelivered: { total: 0, failed: 0 }, shouldFix: { total: 0, lanes: [] }, ignores: [], holds: [], answered: [], progress: { done: 1, open: items.length }, ...extra });

/** one item per card kind the screen has a shape for */
const CASES = [
  { name: "question", proto: "q", item: question, note: "質問（推奨を選んだ状態・右パネルの入力行）", wait: "未知のキーを見つけたら" },
  { name: "go", proto: "go", item: go, note: "着手の承認", wait: "この計画で実装を始めますか" },
  { name: "submit", proto: "sub", item: shipNewPr, note: "提出 / 取り込み", wait: "config: validate unknown keys on load" },
  { name: "post", proto: "post", item: outboundIssue, note: "対外の投稿", wait: "設定の検証を足す" },
  { name: "review", proto: "pr", item: outboundReview, note: "他人の PR のレビュー（下書きの段だけ・DEC-9508）", wait: "PR #158 にレビューを投稿しますか" },
  { name: "stuck", proto: "stuck", item: stuckLimit, note: "行き詰まり（巡の上限）", wait: "Review の巡の上限" },
  { name: "duplicate", proto: "dup", item: duplicate, note: "重複の疑い", wait: "設定の typo で起動しない" },
  { name: "requeue", proto: "re", item: requeue, note: "取り込み直し", wait: "Electron の自動更新" },
];

/** the kinds with no shape of their own: the same item, drawn as the screen's own "cannot handle" card */
const UNSUPPORTED = [
  { name: "go-purposes", proto: "go", item: goWithPurposes, note: "Purpose の案のある GO", wait: "この画面ではまだ扱えない" },
  { name: "storage", proto: "dup", item: storage, note: "空きの不足（後でだけ engine に送る）", wait: "この画面ではまだ扱えない" },
];

let current = CASES[0].item;
/** the running engine's own snapshot, served only for the live picture */
let liveSnapshot = null;
let servingLive = false;

/** the bundle's files, and the fake engine behind them; GET only, so no picture changes a lane */
function serveDist() {
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname === "/api/idd/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(servingLive && liveSnapshot ? liveSnapshot : state([current])));
      return;
    }
    if (pathname === "/api/idd/passkey/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, registered: [{ id: "k1", name: "key" }], rpId: "127.0.0.1" }));
      return;
    }
    if (pathname.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

async function withChrome(run) {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
      async viewport(width, height) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      },
      async goto(url, timeoutMs = 20_000) {
        await send("Page.navigate", { url });
        const until = Date.now() + timeoutMs;
        for (;;) {
          if (await client.evaluate("document.readyState === 'complete'")) return;
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

/** the prototype's page, forced onto one card in the Inbox and isolated to the 1440×900 app frame */
function protoPage(name, card) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  html = html.replaceAll("this.props.startView ?? 'inbox'", "'inbox'");
  html = html.replaceAll("this.props.inboxCard ?? 'go'", `'${card}'`);
  const find = `(function () {
    const els = [...document.querySelectorAll('div')];
    return els.find((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) === 1440 && Math.round(r.height) === 900; }) || null;
  })()`;
  const isolate = `(function () {
    const f = ${find};
    if (!f) return false;
    const p = f.parentElement;
    [...p.children].forEach((c) => { if (c !== f) c.style.display = 'none'; });
    p.style.cssText = 'display:block;margin:0;padding:0;width:1440px;height:900px;gap:0';
    document.body.style.margin = '0';
    window.scrollTo(0, 0);
    return true;
  })()`;
  const script = `<script>window.addEventListener('load', function () { setTimeout(function () { ${isolate}; }, 300); });</script>`;
  copyFileSync(join(PROTO, "support.js"), join(SCRATCH, "support.js"));
  const page = join(SCRATCH, `${name}-proto.html`);
  writeFileSync(page, html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script);
  return page;
}

const FRAME_ISOLATED = `(function () {
  const els = [...document.querySelectorAll('div')];
  const f = els.find((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) === 1440 && Math.round(r.height) === 900; });
  if (!f) return false;
  const r = f.getBoundingClientRect();
  return Math.round(r.left) === 0 && Math.round(r.top) === 0;
})()`;

/**
 * Measure what the long titles do in the drawn page: every sidebar row's title must stay on one line (height of
 * one line) with ellipsis, the rows must not overlap, the card's heading must be one line, and the card's source
 * link must not wrap (AC-009).
 */
async function layoutProbe(client) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-sidebar-title]')].map((el) => {
      const r = el.getBoundingClientRect();
      const row = el.closest('div');
      const rr = row ? row.getBoundingClientRect() : r;
      const cs = getComputedStyle(el);
      return { text: el.textContent, height: Math.round(r.height), whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow, overflow: cs.overflow, clipped: el.scrollWidth > el.clientWidth + 1, rowTop: Math.round(rr.top), rowBottom: Math.round(rr.bottom) };
    });
    const sorted = [...rows].sort((a, b) => a.rowTop - b.rowTop);
    let overlap = false;
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i].rowTop < sorted[i - 1].rowBottom - 1) overlap = true;
    const heading = document.querySelector('[data-card-heading]');
    const hcs = heading ? getComputedStyle(heading) : null;
    const links = [...document.querySelectorAll('a')].map((a) => ({ text: a.textContent, height: Math.round(a.getBoundingClientRect().height), whiteSpace: getComputedStyle(a).whiteSpace }));
    const selectedChoice = document.querySelector('[data-choice-selected="true"]');
    return {
      rows,
      overlap,
      heading: heading ? { text: heading.textContent, height: Math.round(heading.getBoundingClientRect().height), whiteSpace: hcs.whiteSpace, textOverflow: hcs.textOverflow, clipped: heading.scrollWidth > heading.clientWidth + 1 } : null,
      links,
      selectedChoice: selectedChoice ? selectedChoice.textContent : null,
      panelInput: Boolean(document.querySelector('[data-panel-note-input]')),
    };
  })()`);
}

/** the drawn measurement as one line per case: a wrap or an overlap is written out in full */
function layoutLine(name, probe) {
  const wrapped = probe.rows.filter((r) => r.height > 20);
  const bad = probe.rows.filter((r) => r.whiteSpace !== 'nowrap' || r.textOverflow !== 'ellipsis');
  const headingBad = probe.heading && (probe.heading.height > 20 || probe.heading.whiteSpace !== 'nowrap' || probe.heading.textOverflow !== 'ellipsis');
  const linkBad = probe.links.filter((l) => l.whiteSpace !== 'nowrap');
  return `${name}: rows(1行でない) ${wrapped.length} / ellipsisでない ${bad.length} / 行の重なり ${probe.overlap ? 'あり' : 'なし'} / 見出し ${probe.heading ? `${probe.heading.height}px` : 'なし'}${headingBad ? '（1行でない）' : ''} / 折れるリンク ${linkBad.length} / 選んだ選択肢 ${probe.selectedChoice ? JSON.stringify(probe.selectedChoice.slice(0, 24)) : 'なし'} / パネルの入力行 ${probe.panelInput ? 'あり' : 'なし'}`;
}

/** the running engine's snapshot, read once with GET; a slow or absent engine leaves this null */
async function readLiveSnapshot() {
  try {
    const answer = await fetch(LIVE_STATE, { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) return { error: `state door answered ${answer.status}` };
    const body = await answer.json();
    if (!body || typeof body !== "object" || !Array.isArray(body.items)) return { error: "state door answered no items" };
    return { body };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const DIFFERENCES = `---
title: "idd-154 比較: 実装と prototype の違い"
status: active
created_at: 2026-10-17
updated_at: 2026-10-17
---

# idd-154 比較: 実装と prototype の違い

\`_docs/qa/pi-web-idd/idd-154/compare/\` の絵は、偽の engine（\`test/compare-inbox-154.mjs\` の \`serveDist\`）が返した
1 件の項目を、この lane の build した Inbox に描かせたもの（\`*-impl.png\`）と、同じ card を \`propter 収束版.dc.html\`
に持たせたもの（\`*-proto.png\`）の組である。撮影は 1440×900 で、左サイドバーと右パネルを含む。
渡した応答は \`engine-values.json\`、走っている engine から GET で取った今日の snapshot は \`live-snapshot.json\`
（絵は \`live-impl.png\`）にある。見本の題は実在の Issue の長さ（50〜90 字）に差し替えてある（AC-008）。

## 本物の題で値の側に収めた所（C-154-8）

- **card の見出し**: 題は 1 行で末尾を … にし、GH のリンクと経過時間は折れない。prototype の題は 10 字前後で、
  折り返しの形は無い。
- **左サイドバーの行**: 「次に来るもの」「後で」「依存待ち」「外した」「Running lanes」「今日答えたもの」の題は
  1 行で末尾を … にする。印の隣に短い識別子（由来の Issue 番号 \`#167\`、無ければ lane の id）を出す。
  全文は hover の title で読める。行の高さは prototype のまま（34・30・28px）。
- **「戻す」「外す」**: 折れない幅にしてある。
- **次に来るものの待ち時間**: prototype の 28×3px の棒をそのまま出す。engine が待ちの notice を返した card は
  埋まり（その時刻が来ていれば朱）、返していない card は空で出る（DEC-103-2）。寝かせた card が起きる時刻の
  来たものは、待ちが済んだものとして埋める。

## prototype と違う所

- **署名の前の確認の段**: prototype の PC には形が無い（phone の署名シートだけ）。提出・対外の投稿の → は
  1 度目で確認の段を開き、2 度目で署名を求める（DEC-9503）。\`confirm-*\` の絵は無く、\`submit-impl.png\` /
  \`post-impl.png\` は確認を開く前の絵。
- **署名の印**: 藍の地と輪は、主操作が署名へ進む card（提出・対外の投稿・PR のレビューの下書き）だけに付く。
  検査のやり直しの提出、質問・GO・行き詰まり・重複・取り込み直しの主操作は濃色（\`--ink\`）で輪を持たない。
  無効の主操作も輪を持たない（C-154-1）。
- **行き詰まりの「自分で直す」**: prototype の操作の行に場所が無いので、→ の側を二分割して足した。主操作
  （もう 1 巡 = →）が前、キーの無い側（自分で直す ⇧→）が後ろに並ぶ（q5 / DEC-9188 / AC-007）。
- **行き詰まりの操作の語と、自由入力の行**: 「今のまま受け入れる」は prototype の語のまま。GO / 行き詰まり /
  提出の入力行は prototype の素の 1 行（「続ける前に一言（任意）」の形）にし、質問 card の札と助けの文は
  質問 card だけが持つ。助けの文は card と右パネルのどちらでも 1 行に収める（AC-003）。
- **質問 card の入力行の札**: prototype は 1 を選んだ状態の絵なので「1 の理由」を出す。実装は推奨がちょうど
  1 つの質問をその選択肢を選んだ状態で開き（C-154-2）、推奨が無いか 2 つ以上の質問は何も選ばず「自由な答え」
  を出す。penne が外すか替えた選択は state の読み直しで戻らない。
- **左サイドバーの節**: prototype の収束版の左サイドバーには Running lanes しか無い。engine の応答から節を
  足したが、行が無い節は見出しごと出さない（C-154-9）。IDD-143 の「なし」の見出しは無い。
- **右パネルの質問のタブ**: prototype の Q1/Q2/Q3 は、答えた質問の文と答えを持つ。engine が返すのは未回答の
  質問（\`open\`）だけなので、タブは未回答の数だけ立ち、答えた質問のタブは出ない（DEC-9186 / DEC-103-2）。
- **PR のレビュー（\`gh-pr-review\`）は下書きの段だけ**: 指摘の行とコード片に当たる値は engine の API に無いので
  出さない（DEC-9508）。\`review-impl.png\` は本文と種類だけである。
- **形の無い種類は共通の「扱えない」card**: proposal・granularity・reload・storage・知らない種類・Purpose の案の
  ある GO・行き詰まりの 5 形は、「この画面ではまだ扱えない種類の card です」と今の GUI への入口を出す
  （DEC-9184、AC-002）。loopback 以外で開いたときは入口の代わりに「別の端末からは今の GUI の入口が
  分かりません」を出す（AC-007）。空きの card だけは「後で」を engine の後送りに送る。
`;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  const responses = { note: "the fake engine's answers at the moment the pictures were taken; GET only", cases: {} };
  const layouts = {};
  const live = await readLiveSnapshot();
  if (live.body) {
    liveSnapshot = live.body;
    writeFileSync(join(OUT, "live-snapshot.json"), JSON.stringify(live.body, null, 2));
  } else {
    writeFileSync(join(OUT, "live-snapshot.error.txt"), `${live.error}\n`);
  }

  const server = serveDist();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);
      const all = [...CASES, ...UNSUPPORTED];
      // write every prototype page and check its frame first, so a missing frame stops the run
      const pages = new Map();
      for (const c of all) {
        const page = protoPage(c.name, c.proto);
        await client.goto(`file://${page}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's app frame was never isolated for ${c.name}`);
        await client.settle();
        pages.set(c.name, page);
      }
      for (const c of all) {
        current = c.item;
        responses.cases[c.name] = { note: c.note, item: c.item };
        await client.viewport(FRAME.width, FRAME.height);
        await client.goto(`http://127.0.0.1:${port}/gui/?view=inbox`);
        if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(c.wait)})`))) throw new Error(`${c.name}: the screen never showed the engine's card`);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-impl.png`));
        layouts[c.name] = await layoutProbe(client);
        await client.goto(`file://${pages.get(c.name)}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's frame was never isolated again for ${c.name}`);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-proto.png`));
        console.log(`${c.name}: wrote impl + proto`);
      }
      // the running engine's own snapshot, served to this lane's build
      if (liveSnapshot) {
        servingLive = true;
        await client.viewport(FRAME.width, FRAME.height);
        await client.goto(`http://127.0.0.1:${port}/gui/?view=inbox`);
        if (!(await client.waitFor(`Boolean(document.querySelector('div[title="Inbox"]'))`))) throw new Error("the live snapshot never drew the screen");
        await client.settle();
        await client.screenshot(join(OUT, "live-impl.png"));
        layouts.live = await layoutProbe(client);
        console.log("live: wrote impl from the engine's snapshot");
      } else {
        console.log(`live: skipped (${live.error})`);
      }
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  writeFileSync(join(OUT, "engine-values.json"), JSON.stringify(responses, null, 2));
  writeFileSync(join(OUT, "differences.txt"), DIFFERENCES);
  writeFileSync(join(OUT, "layout-check.json"), JSON.stringify(layouts, null, 2));
  writeFileSync(join(OUT, "layout-check.txt"), Object.entries(layouts).map(([name, probe]) => layoutLine(name, probe)).join("\n") + "\n");
  for (const [name, probe] of Object.entries(layouts)) console.log(layoutLine(name, probe));
}

await main();
