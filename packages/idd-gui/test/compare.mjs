#!/usr/bin/env node
/**
 * idd-130: the pictures the plan asks for. The Work screen is served from this lane's built bundle with the engine's
 * live values proxied behind it, and is shot in five states: no lane selected, a lane selected on each of the three
 * tabs, and the full band. Each state is paired with the prototype (`propter 収束版.dc.html`) held in the same
 * state, under `_docs/qa/pi-web-idd/idd-130/compare/`, and the engine's answers taken at that moment are written
 * beside them.
 *
 * Usage: node packages/idd-gui/test/compare.mjs
 *
 * Only GETs reach the engine (DEC-103-4), and the engine URL is the loopback one the plan names; the prototype is
 * read from `_meta/gui-prototype/` and the patched copies are written under `_meta/scratch/` (never beside it).
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
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-130", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-130");

const ENGINE = (process.env.IDD_ENGINE_URL ?? "http://127.0.0.1:30144").replace(/\/$/, "");
const CHROME = "/usr/bin/google-chrome-stable";
const PROTO_FRAME = { width: 1440, height: 900 };

/** the two window sizes the plan names */
const WINDOWS = [
  { name: "1500x1000", width: 1500, height: 1000 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

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

/** read one door of the engine, GET only; a failure stops the run before any picture is taken */
async function engineGet(path) {
  const answer = await fetch(`${ENGINE}${path}`, { method: "GET" });
  if (!answer.ok) throw new Error(`the engine answered ${answer.status} for ${path}`);
  return answer.json();
}

/** the lane the detail pictures open: the first running Issue lane the engine returned */
function firstIssueLane(work) {
  const lane = (work.lanes ?? []).find((l) => l.bundle === "running" && l.kind === "issue");
  if (!lane) throw new Error("the engine returned no running Issue lane to open");
  return { id: lane.id, title: lane.title };
}

/** the bundle's files, and the engine's doors proxied behind them; GET only, so a picture never changes a lane */
function serveDist() {
  return createServer(async (req, res) => {
    const { pathname, search } = new URL(req.url, "http://127.0.0.1");
    if (pathname.startsWith("/api/idd/")) {
      try {
        const answer = await fetch(`${ENGINE}${pathname}${search}`, { method: "GET" });
        const body = Buffer.from(await answer.arrayBuffer());
        res.writeHead(answer.status, {
          "content-type": answer.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
        res.end(body);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
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

/** one Chrome, driven over its debugging protocol; the debugging port is left to Chrome, so two lanes never collide */
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
      /** fonts, the frame's reflow and the entry animations all rest before a picture (F-128-6) */
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

/**
 * The prototype's page, forced onto one screen and one Work state and written to the scratch place with
 * `support.js` beside it. The script that finds the 1440×900 app frame inside the design canvas and hides the
 * canvas chrome around it is injected after the page's own script, so a picture is of the app frame alone.
 */
function protoPage(name, startView, state) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  html = html.replace("this.props.startView ?? 'inbox'", `'${startView}'`);
  if (startView === "inbox") html = html.replace("this.props.inboxCard ?? 'go'", "'go'");
  const extra = Object.entries(state)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  if (extra) html = html.replace("cardDir: 'r' }", `cardDir: 'r', ${extra} }`);
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

/** the prototype's app frame, once the page's own script has isolated it at the design canvas' top-left corner */
const FRAME_ISOLATED = `(function () {
  const els = [...document.querySelectorAll('div')];
  const f = els.find((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width) === 1440 && Math.round(r.height) === 900; });
  if (!f) return false;
  const r = f.getBoundingClientRect();
  return Math.round(r.left) === 0 && Math.round(r.top) === 0;
})()`;

const HAS_TEXT = (texts) => `(${JSON.stringify(texts)}).some((t) => document.body.innerText.includes(t))`;
const CAN_CLICK = (text) =>
  `[...document.querySelectorAll('span')].some((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0)`;
const CLICK = (text) =>
  `(function () { const el = [...document.querySelectorAll('span')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true; })()`;

/** the frame and the columns whose widths the prototype fixed, read back out of the live DOM */
async function measure(client, label) {
  const box = await client.evaluate(`(function () {
    const frame = [...document.querySelectorAll('div')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.top < 2 && r.left < 2 && Math.round(r.width) === window.innerWidth && Math.round(r.height) === window.innerHeight && getComputedStyle(el).flexDirection === 'column';
    });
    if (!frame) return null;
    const row = frame.children[1];
    const kids = row ? [...row.children] : [];
    const widths = kids.map((el) => Math.round(el.getBoundingClientRect().width));
    const grid = [...frame.querySelectorAll('div')].find((el) => getComputedStyle(el).display === 'grid' && getComputedStyle(el).gridTemplateColumns.includes('380px'));
    const gridLeft = grid ? Math.round(grid.children[0].getBoundingClientRect().width) : null;
    return { frame: [Math.round(frame.getBoundingClientRect().width), Math.round(frame.getBoundingClientRect().height)], viewport: [window.innerWidth, window.innerHeight], rowWidths: widths, gridLeft };
  })()`);
  console.log(`${label}: ${JSON.stringify(box)}`);
}

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");

  // the engine's answers at this moment: read before anything is shot, and again after, so the picture matches
  const work = await engineGet("/api/idd/work");
  const forecast = await engineGet("/api/idd/forecast");
  const lane = firstIssueLane(work);
  const [laneView, laneDecisions, laneRecord] = await Promise.all([
    engineGet(`/api/idd/lane/${encodeURIComponent(lane.id)}`),
    engineGet(`/api/idd/work/lanes/${encodeURIComponent(lane.id)}/decisions`),
    engineGet(`/api/idd/work/lanes/${encodeURIComponent(lane.id)}/record`),
  ]);
  const fetchedAt = new Date().toISOString();
  const repoName = (work.repos?.[0]?.name) ?? "";

  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(
    join(OUT, "engine-values.json"),
    JSON.stringify(
      {
        fetchedAt,
        engine: ENGINE,
        note: "the engine's answers at the moment the pictures were taken; GET only",
        selectedLane: lane.id,
        responses: { "/api/idd/work": work, "/api/idd/forecast": forecast, [`/api/idd/lane/${lane.id}`]: laneView, [`/api/idd/work/lanes/${lane.id}/decisions`]: laneDecisions, [`/api/idd/work/lanes/${lane.id}/record`]: laneRecord },
      },
      null,
      2,
    ),
  );

  /** the five Work states the plan asks for: the port's query, the prototype's own state, and what proves the read landed */
  const states = [
    { name: "lanes-none", query: "?view=lanes", proto: { wsel: "null" }, wait: ["気にすること"] },
    { name: "lanes-st", query: `?view=lanes#work/${encodeURIComponent(lane.id)}`, proto: {}, wait: ["状況"] },
    { name: "lanes-dec", query: `?view=lanes#work/${encodeURIComponent(lane.id)}`, proto: { wtab: "'dec'" }, click: "DEC", wait: ["状況"], after: ["Anchors"] },
    { name: "lanes-fd", query: `?view=lanes#work/${encodeURIComponent(lane.id)}`, proto: { wtab: "'fd'" }, click: "指摘", wait: ["状況"], after: ["巡ごと", "まだ Review に入っていない"] },
    { name: "lanes-all", query: "?view=lanes#work/all", proto: { wopen: "true" }, wait: ["縮める"] },
  ];

  const server = serveDist();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    await withChrome(async (client) => {
      // every prototype page is written and its app frame checked before any picture is taken: a missing frame
      // then stops the run instead of leaving a set that mixes this run's pictures with an earlier run's
      const pages = new Map();
      await client.viewport(PROTO_FRAME.width, PROTO_FRAME.height);
      for (const state of states) {
        const page = protoPage(state.name, "lanes", state.proto);
        await client.goto(`file://${page}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's app frame was never isolated for ${state.name}`);
        await client.settle();
        pages.set(state.name, page);
      }

      for (const state of states) {
        for (const size of WINDOWS) {
          const out = join(OUT, `${state.name}-${size.name}-impl.png`);
          await client.viewport(size.width, size.height);
          await client.goto(`http://127.0.0.1:${port}/gui/${state.query}`);
          if (!(await client.waitFor(HAS_TEXT(state.wait)))) throw new Error(`${state.name}: the screen never showed the engine's values`);
          if (state.click) {
            if (!(await client.waitFor(CAN_CLICK(state.click)))) throw new Error(`${state.name}: the ${state.click} tab was never there to press`);
            await client.evaluate(CLICK(state.click));
            if (!(await client.waitFor(HAS_TEXT(state.after ?? state.wait)))) throw new Error(`${state.name}: the tab's values never arrived`);
          }
          await client.settle();
          await measure(client, `impl ${state.name} ${size.name}`);
          await client.screenshot(out);
          console.log(`${state.name} ${size.name}: wrote ${out.replace(ROOT + "/", "")}  (repo ${repoName})`);
        }
        await client.viewport(PROTO_FRAME.width, PROTO_FRAME.height);
        await client.goto(`file://${pages.get(state.name)}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's frame was never isolated again for ${state.name}`);
        await client.settle();
        await client.screenshot(join(OUT, `${state.name}-proto.png`));
        console.log(`${state.name}: wrote the prototype picture`);
      }
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

await main();
