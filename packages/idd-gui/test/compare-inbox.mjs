#!/usr/bin/env node
/**
 * idd-143: the pictures the plan asks for. For each of the eight card kinds the Inbox has a shape for, this lane's
 * built Inbox is shot with a fake engine answering the card's own item, and the prototype (the converged design)
 * is shot holding the same card. Each pair is written under `_docs/qa/pi-web-idd/idd-143/compare/` together with
 * the response the implementation was drawn from.
 *
 * Usage: node packages/idd-gui/test/compare-inbox.mjs
 *
 * Only GETs reach the fake engine, and the prototype is read from `_meta/gui-prototype/` with the patched pages
 * written under `_meta/scratch/` (never beside it).
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
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-143", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-143");
const CHROME = "/usr/bin/google-chrome-stable";
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
  { name: "question", proto: "q", item: question, note: "質問", wait: "未知のキーを見つけたら" },
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

/** the bundle's files, and the fake engine behind them; GET only, so no picture changes a lane */
function serveDist() {
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname === "/api/idd/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(state([current])));
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

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  const responses = { note: "the fake engine's answers at the moment the pictures were taken; GET only", cases: {} };

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
        await client.goto(`file://${pages.get(c.name)}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's frame was never isolated again for ${c.name}`);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-proto.png`));
        console.log(`${c.name}: wrote impl + proto`);
      }
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  writeFileSync(join(OUT, "engine-values.json"), JSON.stringify(responses, null, 2));
}

await main();
