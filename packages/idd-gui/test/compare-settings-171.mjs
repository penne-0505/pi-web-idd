#!/usr/bin/env node
/**
 * IDD-171: the pictures the plan asks for (AC-006). The settings sheet's four wired sections and one section
 * that says it cannot be handled yet are shot twice: once as this lane's built screen (the settings sheet opened
 * at that section, drawn from responses the running engine answered with GET), and once as the prototype
 * (`propter 収束版.dc.html`) opened at the same section. The engine's own answers are written beside the pictures
 * (`engine-values.json`), so the picture can be read against the response it was drawn from.
 *
 * Usage: node packages/idd-gui/test/compare-settings-171.mjs
 *
 * Only GETs reach the engine, whose answers are read once and served from this script's own fake engine. The
 * prototype is read from `_meta/gui-prototype/` with the patched page written under `_meta/scratch/`.
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
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-171", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-171");
const CHROME = "/usr/bin/google-chrome-stable";
const ENGINE = "http://127.0.0.1:30144";
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

/** the sections the plan names: four wired, and one that says it cannot be handled yet */
const CASES = [
  { name: "skills", nav: "Skills · MCP · Search", title: "Skills · MCP · Search" },
  { name: "spaces", nav: "Spaces", title: "Spaces" },
  { name: "storage", nav: "Storage", title: "Storage" },
  { name: "appearance", nav: "Appearance", title: "Appearance" },
  { name: "not-yet", nav: "Providers & Models", title: "Providers & Models" },
];

/** the running engine's own answers, read once with GET and served from the fake engine */
const live = { state: null, conversation: null, workspaces: null, spaces: null, storage: null, errors: {} };

async function readLive() {
  const get = async (path, timeoutMs) => {
    try {
      const answer = await fetch(`${ENGINE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!answer.ok) {
        live.errors[path] = `status ${answer.status}`;
        return null;
      }
      return await answer.json();
    } catch (error) {
      live.errors[path] = String(error?.message ?? error);
      return null;
    }
  };
  live.conversation = await get("/api/conversation-settings", 30_000);
  live.workspaces = await get("/api/conversations/workspaces", 30_000);
  const mode = live.workspaces?.workspaces?.[0]?.mode;
  if (mode) live.spaces = await get(`/api/conversations/workspaces/${encodeURIComponent(mode)}/spaces`, 30_000);
  live.state = await get("/api/idd/state", 60_000);
  live.storage = await get("/api/idd/storage", 240_000);
  for (const [path, reason] of Object.entries(live.errors)) console.log(`engine did not answer ${path}: ${reason}`);
}

function jsonOr(entry, fallback) {
  return entry === null || entry === undefined ? fallback : entry;
}

/** the bundle's files, and the fake engine behind them; GET only, so no picture changes a lane */
function serveDist() {
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    const send = (body, type = "application/json; charset=utf-8") => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (pathname === "/api/conversation-settings") return send(jsonOr(live.conversation, { ok: true, settings: { skills: [], webSearch: true, webSearchTools: [], mcp: false }, candidates: [], path: "" }));
    if (pathname === "/api/conversations/workspaces") return send(jsonOr(live.workspaces, { workspaces: [] }));
    if (pathname === "/api/idd/state") return send(jsonOr(live.state, { source: "state", items: [], undelivered: { total: 0, failed: 0 }, ignores: [], holds: [] }));
    if (pathname === "/api/idd/storage") return send(jsonOr(live.storage, { ok: true, measuredAt: "", cleanup: false, minFreeGb: 10, archive: null, filesystems: [], places: [], candidates: [], kept: [], lastSweep: null, heldLanes: [] }));
    if (pathname === "/api/conversations/workspaces/chat/spaces" || /^\/api\/conversations\/workspaces\/[^/]+\/spaces$/.test(pathname)) return send(jsonOr(live.spaces, { ok: true, spaces: [] }));
    if (pathname === "/api/idd/passkey/register") return send({ ok: true, registered: [], rpId: "127.0.0.1" });
    if (pathname.startsWith("/api/")) return send({ ok: true });
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

/** open the settings sheet in the built screen and choose one section, so the picture shows that section */
async function openSection(client, nav) {
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('div.hv2')].find((el) => el.textContent.includes('Settings'));
    if (button) button.click();
    return Boolean(button);
  })()`);
  const clicked = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('span')].find((el) => el.textContent.trim() === ${JSON.stringify(nav)});
    if (item) item.click();
    return Boolean(item);
  })()`);
  return clicked;
}

/** the prototype's page, opened on the settings sheet at one section and isolated to the 1440×900 app frame */
function protoPage(name, section) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  // the sheet's own state lives in the class's initial state; forcing it there opens the sheet on that section
  const before = "state = { view: this.props.startView ?? 'inbox', tab: 'plan', open: { '138': true }, left: true, right: true, mode: 'chat', card: 'idle', cardDir: 'r' };";
  const after = `state = { view: this.props.startView ?? 'inbox', tab: 'plan', open: { '138': true }, left: true, right: true, mode: 'chat', card: 'idle', cardDir: 'r', settings: true, sec: '${section}' };`;
  if (!html.includes(before)) throw new Error("the prototype's initial state moved; the settings sheet cannot be forced open");
  html = html.replace(before, after);
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

/** the section names the prototype knows, keyed by the nav label this script uses */
const SEC_OF = { "Skills · MCP · Search": "skills", Spaces: "spaces", Storage: "conv", Appearance: "view", "Providers & Models": "prov" };

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  await readLive();
  // the engine's answers, bounded: the storage door's own answer is 3.6 MB (12,949 candidates), so the rows
  // the sheet drew are kept whole and the candidates are kept as the per-place totals plus a sample. The note
  // says so, and every number the picture drew is in the file.
  const storageBounded = live.storage
    ? (() => {
        const candidates = Array.isArray(live.storage.candidates) ? live.storage.candidates : [];
        const byPlace = new Map();
        for (const candidate of candidates) {
          const entry = byPlace.get(candidate.place) ?? { place: candidate.place, count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += candidate.bytes;
          byPlace.set(candidate.place, entry);
        }
        return {
          ...live.storage,
          candidates: {
            total: candidates.length,
            bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
            byPlace: [...byPlace.values()],
            sample: candidates.slice(0, 20),
            note: "候補 12,949 件は 3.6 MB のため、置き場ごとの集計と先頭 20 件だけを載せる。全体は engine の /api/idd/storage から GET で取れる。",
          },
        };
      })()
    : null;
  writeFileSync(
    join(OUT, "engine-values.json"),
    `${JSON.stringify(
      {
        note: "手元の engine (http://127.0.0.1:30144) へ GET だけを送って取った応答。この偽の engine が絵に渡したものである。state は背景の Inbox のためだけに使ったので、件数だけを載せる。",
        conversationSettings: live.conversation,
        workspaces: live.workspaces,
        spaces: live.spaces,
        storage: storageBounded,
        state: live.state ? { items: Array.isArray(live.state.items) ? live.state.items.length : null } : null,
        errors: live.errors,
      },
      null,
      2,
    )}\n`,
  );
  const shots = [];
  const probes = [];
  const appearanceProbe = {};
  const server = serveDist();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);
      for (const item of CASES) {
        // the built screen
        await client.goto(`http://127.0.0.1:${port}/gui/`);
        await client.settle();
        const opened = await openSection(client, item.nav);
        await client.settle();
        // the storage door is slow; wait for the section to stop measuring before the picture
        if (item.name === "storage") await client.waitFor("[...document.querySelectorAll('span')].some((el) => el.textContent.includes('片づけは') || el.textContent.includes('測れませんでした'))", 280_000);
        await client.settle();
        const hasSheet = await client.evaluate("document.body.textContent.includes('Esc')");
        const found = await client.evaluate(`(() => {
          const text = document.body.textContent;
          return {
            title: document.body.textContent.includes(${JSON.stringify(item.title)}),
            toggles: document.querySelectorAll('[role=switch]').length,
            notYet: text.split(${JSON.stringify("まだ扱えない")}).length - 1,
            error: Boolean(document.querySelector('[data-settings-error]')),
            measuring: Boolean(document.querySelector('[data-settings-storage-measuring]')),
          };
        })()`);
        await client.screenshot(join(OUT, `${item.name}-impl.png`));
        shots.push({ name: item.name, opened, hasSheet, found });
        // AC-004 in the built screen: the Font size slider and the Reduce motion toggle take effect, and the
        // same browser reads the value back after a reload
        if (item.name === "appearance") {
          appearanceProbe.before = await client.evaluate(`(async () => {
            const root = document.getElementById('root');
            const range = document.querySelector('input[type=range]');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(range, '16');
            range.dispatchEvent(new Event('input', { bubbles: true }));
            const toggle = [...document.querySelectorAll('[data-appearance-toggle]')].find((el) => el.getAttribute('data-appearance-toggle') === 'Reduce motion');
            toggle.click();
            await new Promise((done) => setTimeout(done, 80));
            return { zoom: root.style.zoom, width: root.style.width, motion: root.dataset.reduceMotion ?? '', stored: localStorage.getItem('propter.appearance') };
          })()`);
          await client.goto(`http://127.0.0.1:${port}/gui/`);
          await client.settle();
          appearanceProbe.after = await client.evaluate("(() => { const root = document.getElementById('root'); return { zoom: root.style.zoom, motion: root.dataset.reduceMotion ?? '', stored: localStorage.getItem('propter.appearance') }; })()");
        }
        // the prototype
        const page = protoPage(item.name, SEC_OF[item.nav]);
        await client.goto(`file://${page}`);
        await client.waitFor("(function(){const els=[...document.querySelectorAll('div')];return els.some((el)=>{const r=el.getBoundingClientRect();return Math.round(r.width)===1440&&Math.round(r.height)===900;});})()", 15_000);
        await client.settle();
        const protoTitle = await client.evaluate(`document.body.textContent.includes(${JSON.stringify(item.title)})`);
        await client.screenshot(join(OUT, `${item.name}-proto.png`));
        probes.push(`${item.name}: 見出し=${protoTitle ? "あり" : "なし"}`);
      }
    });
  } finally {
    server.close();
  }
  console.log("wrote", OUT);
  for (const shot of shots) console.log(`  ${shot.name}: section opened=${shot.opened} sheet=${shot.hasSheet} ${JSON.stringify(shot.found)}`);
  for (const line of probes) console.log(`  proto ${line}`);
  console.log("  appearance: " + JSON.stringify(appearanceProbe));
  writeFileSync(join(OUT, "appearance-probe.txt"), `Font size 16px と Reduce motion を押した直後: ${JSON.stringify(appearanceProbe.before)}\n同じ browser で読み直した後: ${JSON.stringify(appearanceProbe.after)}\n`);
}

await main();
