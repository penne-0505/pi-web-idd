#!/usr/bin/env node
/**
 * idd-139: the pictures the plan asks for. The Work screen is served from this lane's built bundle and every
 * `/api/idd/…` answer is taken from a fixed fixture, so the mini map is shot in the states this lane judges:
 * the five repos engine returned when IDD-130 judged the overlap, the same five as a fake engine value, and
 * the prototype's own three repos as a sample with the prototype's names and lane counts. Each impl picture is
 * paired with the prototype held in the same state (no lane selected), under `_docs/qa/pi-web-idd/idd-139/compare/`.
 *
 * Usage: node packages/idd-gui/test/compare-139.mjs   (build first: bun run --cwd packages/idd-gui build)
 *
 * Only GETs reach the live engine, and only to read the five-repo state; the replay and the sample never touch
 * it. The prototype is read from `_meta/gui-prototype/` and the patched copies are written under `_meta/scratch/`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist");
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-139", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-139");
const STORED = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-130", "compare", "engine-values.json");

const ENGINE = (process.env.IDD_ENGINE_URL ?? "http://127.0.0.1:30144").replace(/\/$/, "");
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

// ------------------------------------------------------------------ the fixtures
/** one door's answer, GET only; a failure stops the run before any picture is taken */
async function engineGet(path) {
  const answer = await fetch(`${ENGINE}${path}`, { method: "GET" });
  if (!answer.ok) throw new Error(`the engine answered ${answer.status} for ${path}`);
  return answer.json();
}

/** the five repos IDD-130 judged, replayed so the picture matches the judgement whatever the live engine answers */
function fiveReplay() {
  const stored = JSON.parse(readFileSync(STORED, "utf8")).responses;
  return {
    name: "5-replay",
    label: "5 件の engine の値（IDD-130 が保存した応答の再生）",
    doors: { "/api/idd/work": stored["/api/idd/work"], "/api/idd/forecast": stored["/api/idd/forecast"] },
    wait: "pi-web-idd",
  };
}

/** the same five repos as the live engine returns them, read with GET only and only when it holds exactly five */
async function fiveLive() {
  const work = await engineGet("/api/idd/work");
  if ((work.repos ?? []).length !== 5) return null;
  const forecast = await engineGet("/api/idd/forecast");
  return {
    name: "5-live",
    label: "5 件の engine の値（手元の engine の今の応答）",
    doors: { "/api/idd/work": work, "/api/idd/forecast": forecast },
    wait: work.repos[0].name,
  };
}

const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const ref = (label) => ({ kind: "github", label, url: `https://example.test/${label}` });
const lane = (id, repo, label, title, bundle, spans) => ({
  kind: "issue",
  id,
  repo,
  ref: ref(label),
  title,
  bundle,
  turn: bundle === "running" ? "go" : undefined,
  spans,
  waitsFor: [],
});
const span = (key, label, startMin, endMin) => ({ key, label, owner: "machine", start: at(startMin), ...(endMin === undefined ? {} : { end: at(endMin) }) });

/**
 * The prototype's own three repos as an engine answer: the same names and the same lane counts (propter six,
 * medo two, meltly two), so the sample picture can be read beside the prototype's picture.
 */
function threeSample() {
  const lanes = [
    lane("P1", "penne-0505/propter", "P#138", "passkey 署名の失効処理", "running", [span("impl", "実装", -120)]),
    lane("P2", "penne-0505/propter", "P#142", "セッション一覧の全文検索", "running", [span("impl", "実装", -60, -5)]),
    lane("P3", "penne-0505/propter", "P#151", "設定ファイルの検証", "next", [span("plan", "計画", -240, -180)]),
    lane("P4", "penne-0505/propter", "P#160", "通知のまとめ送り", "next", [span("plan", "計画", -300, -240)]),
    lane("P5", "penne-0505/propter", "P#161", "失効した鍵での再署名の案内", "next", [span("plan", "計画", -360, -300)]),
    lane("P6", "penne-0505/propter", "P#163", "phone の接続断の表示", "next", [span("plan", "計画", -420, -360)]),
    lane("M1", "meltly/medo", "M#31", "同期の再試行", "running", [span("impl", "実装", -90, -10)]),
    lane("M2", "meltly/medo", "M#33", "競合の解決", "next", [span("plan", "計画", -180, -120)]),
    lane("L1", "linear/meltly", "LIN-212", "Linear の Issue を読む", "running", [span("impl", "実装", -80, -20)]),
    lane("L2", "linear/meltly", "LIN-215", "Linear の通知を受ける", "next", [span("plan", "計画", -150, -90)]),
  ];
  return {
    name: "3-sample",
    label: "3 件の見本（prototype と同じ名前と lane の数）",
    doors: {
      "/api/idd/work": {
        now: NOW,
        repos: [
          { id: "penne-0505/propter", name: "propter", running: 2, waiting: 4, attention: true },
          { id: "meltly/medo", name: "medo", running: 1, waiting: 1, attention: false },
          { id: "linear/meltly", name: "meltly", running: 1, waiting: 1, attention: false },
        ],
        lanes,
        done: [],
        holds: [],
      },
      "/api/idd/forecast": { ok: true, generatedAt: NOW, usual: [], lanes: [] },
    },
    wait: "propter",
  };
}

// ------------------------------------------------------------------ the static server
/** the bundle's files, with every `/api/idd/…` answer taken from the fixture; GET only, so nothing is ever written */
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
/** one Chrome, driven over its debugging protocol; the port is left to Chrome, so two lanes never collide */
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
      /** poll a page expression until it is true; used for mounts and reads that finish after `readyState` */
      async waitFor(expression, timeoutMs = 8000) {
        const until = Date.now() + timeoutMs;
        for (;;) {
          if (await client.evaluate(expression)) return true;
          if (Date.now() > until) return false;
          await sleep(100);
        }
      },
      /** fonts, the frame's reflow and the entry animations all rest before a picture */
      async settle() {
        await client.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
        await client.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
        await sleep(250);
      },
      async screenshot(out, clip) {
        const shot = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
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

/** the mini map's outer box in either page: impl and prototype both carry the same title */
const MINI_BOX = `(function () {
  const el = [...document.querySelectorAll('[title="全体を広げる"]')].find((e) => e.getBoundingClientRect().width > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
})()`;

const HAS_TEXT = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

/**
 * What the picture should show, read out of the live DOM: every repo name's box, whether any two names
 * overlap, whether any name reaches into the 49px frame the band starts after, and whether two drawn names read
 * the same. The names are the spans the mini map draws at 9px; the same read works on the impl page and the
 * prototype page.
 */
const MEASURE = `(function () {
  const box = document.querySelector('[title="全体を広げる"]');
  if (!box) return null;
  const spans = [...box.querySelectorAll('span')];
  const labelEls = spans.filter((e) => getComputedStyle(e).fontSize === '9px');
  const seenAt = new Set();
  const labels = labelEls
    .map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent, title: e.getAttribute('title'), top: r.top, bottom: r.bottom, right: r.right };
    })
    // the prototype draws each label twice (its list hint and the real list), the two on the same line: keep one
    .filter((l) => { const k = Math.round(l.top) + '|' + l.text; if (seenAt.has(k)) return false; seenAt.add(k); return true; })
    .sort((a, b) => a.top - b.top);
  const overlaps = [];
  for (let i = 1; i < labels.length; i += 1) if (labels[i].top < labels[i - 1].bottom - 0.5) overlaps.push([labels[i - 1].text, labels[i].text]);
  // the names live in the relative map div, and the lane frame starts 49px into it; the outer box adds its padding
  const base = labelEls.length ? labelEls[0].offsetParent : box;
  const frame = base.getBoundingClientRect().left + 49;
  const intrude = labels.filter((l) => l.right > frame + 0.5).map((l) => l.text);
  const rightGap = labels.length ? Math.round((frame - Math.max(...labels.map((l) => l.right))) * 10) / 10 : null;
  const drawn = labels.map((l) => l.text);
  const twins = drawn.filter((t, i) => drawn.indexOf(t) !== i);
  return { names: drawn, titles: labels.map((l) => l.title), gaps: labels.slice(1).map((l, i) => Math.round((l.top - labels[i].top) * 10) / 10), overlaps, intrude, rightGap, twins };
})()`;

// ------------------------------------------------------------------ the prototype page
/**
 * The prototype's page, forced onto one screen and the Work view with no lane selected, written to the scratch
 * place with `support.js` beside it. The script that finds the 1440×900 app frame and hides the canvas chrome
 * around it is injected after the page's own script, so a picture is of the app frame alone.
 */
function protoPage(name) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  html = html.replace("this.props.startView ?? 'inbox'", "'lanes'");
  html = html.replace("cardDir: 'r' }", "cardDir: 'r', wsel: 'null' }");
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

// ------------------------------------------------------------------ the run
/** the mini map's own reading: no two names overlap, no name reaches the lane frame, and no two read the same */
function verify(name, seen) {
  if (!seen) throw new Error(`${name}: the mini map's names could not be read`);
  console.log(`${name}: ${JSON.stringify(seen)}`);
  if (!seen.names.length) throw new Error(`${name}: the mini map drew no name`);
  if (seen.overlaps.length) throw new Error(`${name}: names overlap: ${JSON.stringify(seen.overlaps)}`);
  if (seen.intrude.length) throw new Error(`${name}: names reach into the band: ${JSON.stringify(seen.intrude)}`);
  if (seen.twins.length) throw new Error(`${name}: two names read the same, so the list cannot be told apart: ${JSON.stringify(seen.twins)}`);
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");

  const fixtures = [fiveReplay(), threeSample()];
  const live = await fiveLive().catch((err) => {
    console.log(`live engine not read: ${err.message}`);
    return null;
  });
  if (live) fixtures.unshift(live);
  else console.log("the live engine does not hold five repos right now: the replay stands in for it");

  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(OUT, "fixtures.json"),
    JSON.stringify(
      {
        note: "the engine values each picture was shot with; the live one was read with GET only",
        pictures: fixtures.map((f) => ({ label: f.label, doors: Object.keys(f.doors) })),
        live: live ? live.doors["/api/idd/work"] : null,
        replay: fiveReplay().doors["/api/idd/work"],
        sample: threeSample().doors["/api/idd/work"],
      },
      null,
      2,
    ),
  );
  console.log(`fixtures: ${fixtures.map((f) => f.label).join(" / ")}`);

  await withChrome(async (client) => {
    for (const fixture of fixtures) {
      const server = serveDist(fixture.doors);
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const port = server.address().port;
      try {
        await client.viewport(FRAME.width, FRAME.height);
        await client.goto(`http://127.0.0.1:${port}/gui/?view=lanes`);
        if (!(await client.waitFor(HAS_TEXT(fixture.wait)))) throw new Error(`${fixture.label}: the screen never showed the fixture's values`);
        if (!(await client.waitFor(`!!(${MINI_BOX})`))) throw new Error(`${fixture.label}: the mini map was never drawn`);
        await client.settle();
        const box = await client.evaluate(MINI_BOX);
        const seen = await client.evaluate(MEASURE);
        verify(fixture.name, seen);
        const clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 };
        await client.screenshot(join(OUT, `work-${fixture.name}-impl.png`));
        await client.screenshot(join(OUT, `minimap-${fixture.name}-impl.png`), clip);
        console.log(`${fixture.name}: wrote work-${fixture.name}-impl.png and minimap-${fixture.name}-impl.png  ${JSON.stringify(box)}`);
      } finally {
        server.close();
        server.closeAllConnections?.();
      }
    }

    // the prototype held in the same state: the Work view, no lane selected, three repos
    await client.viewport(FRAME.width, FRAME.height);
    const page = protoPage("mini");
    await client.goto(`file://${page}`);
    if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error("the prototype's app frame was never isolated");
    await client.settle();
    const box = await client.evaluate(MINI_BOX);
    if (!box) throw new Error("the prototype's mini map was never drawn");
    verify("3-proto", await client.evaluate(MEASURE));
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 };
    await client.screenshot(join(OUT, "work-3-proto.png"));
    await client.screenshot(join(OUT, "minimap-3-proto.png"), clip);
    console.log(`prototype: wrote work-3-proto.png and minimap-3-proto.png  ${JSON.stringify(box)}`);
  });
}

await main();
