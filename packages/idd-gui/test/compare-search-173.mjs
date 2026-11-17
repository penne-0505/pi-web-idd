#!/usr/bin/env node
/**
 * idd-173: the pictures the plan asks for (AC-006). The find field's states — opened with nothing typed, a title
 * stage with candidates, the title stage with nothing (the prototype A4's empty state), the body stage's results,
 * and the conversation a row opened — are each shot from this lane's built screen, and the empty state is shot
 * beside the prototype's own A4 figure. The answers the fake engine gave are written under
 * `_docs/qa/pi-web-idd/idd-173/compare/` with the pictures.
 *
 * Usage: node packages/idd-gui/test/compare-search-173.mjs
 *
 * Only GETs reach the fake engine (the field's list read and search read, plus the conversation screen's own
 * reads). A real send is never pressed, and no real conversation's text is placed: the sample titles are real
 * Issue titles of this repo and the excerpts are made-up samples of the same length. The prototype is read from
 * `_meta/gui-prototype/` with the patched page written under `_meta/scratch/`.
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
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-173", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 空とエラー.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-173");
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

// ---- the answers the fake engine gives, all in the engine's own shapes ----
// The titles are real Issue titles of this repo (50〜90 字); the excerpts are made-up samples of the same length.
// No real conversation's body is placed here.

const TITLE_A = "engine が台帳の写し（projection）を持ち、状態の口が畳み直さずに答える — #172 の子 1";
const TITLE_B = "通常の会話から card と lane を mention して文脈を共有し、会話の agent に propter CLI の読み取り系を渡す";
const TITLE_C = "署名の要る card を passkey のほかに PIN でも 1 枚ずつ通せるようにする（CLI からも）";
const TITLE_OTHER = "新 GUI の設定画面の passkeys で鍵の一覧・登録・保留の承認をする — #167 の子 2";

const EXCERPT_A = "この会話では、台帳の写しを memory に持って増分だけを更新する案と、いまの畳み直しを残す案を比べました。写しを持つと状態の口は速くなります。";
const EXCERPT_B = "mention の文脈は会話の記録とは別に持ち、読み取り系の CLI だけを会話の agent に渡す形にすると、書き込みの口を増やさずに済みます。";

const WORKSPACES = [
  { mode: "chat", label: "chat", workspace: "/home/penne/text/chat" },
  { mode: "idea", label: "idea", workspace: "/home/penne/text/ideas" },
];

const MODEL_LIST = {
  ok: true,
  models: [
    { id: "anthropic/claude-opus-4-5", name: "Opus 4.5", provider: "anthropic", contextWindow: 200000, capabilities: ["image", "reasoning"] },
    { id: "anthropic/claude-sonnet-4-5", name: "Sonnet 4.5", provider: "anthropic", contextWindow: 1000000, capabilities: ["image", "reasoning"] },
  ],
};

/** the chat list's own workspace view: only this workspace, archive excluded */
const GROUPS = {
  ok: true,
  group: "date",
  conversations: [
    { id: "c1", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_A, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
    { id: "c2", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_B, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:30:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
  ],
  groups: [
    {
      key: "today",
      label: "今日",
      conversations: [
        { id: "c1", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_A, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
        { id: "c2", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_B, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:30:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
      ],
    },
  ],
};

/** the field's own title stage: every workspace, the archived included (C-173-2) */
const CANDIDATES = {
  ok: true,
  conversations: [
    { id: "c1", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_A, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
    { id: "c2", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_B, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:30:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
    { id: "c3", mode: "chat", cwd: "/home/penne/text/chat", name: TITLE_C, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: true, bookmarks: [], workdir: "", type: "chat" },
    { id: "other", mode: "idea", cwd: "/home/penne/text/ideas", name: TITLE_OTHER, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: true, bookmarks: [], workdir: "", type: "idea" },
  ],
  groups: [],
};

const SEARCH = {
  ok: true,
  query: "poll",
  truncated: false,
  scannedSessions: 42,
  results: [
    { sessionId: "c1", mode: "chat", name: TITLE_A, hits: [{ entryId: "e1", role: "user", excerpt: `…${EXCERPT_A}…` }], truncated: false },
    { sessionId: "c2", mode: "chat", name: TITLE_B, hits: [{ entryId: "e2", role: "assistant", excerpt: `…${EXCERPT_B}…` }], truncated: false },
  ],
};

const OPEN_OTHER = {
  ok: true,
  id: "other",
  mode: "idea",
  cwd: "/home/penne/text/ideas",
  streaming: false,
  promptPending: false,
  compacting: false,
  entries: [
    { id: "o1", parentId: null, type: "message", timestamp: "2026-10-16T01:00:00Z", message: { role: "user", content: "設定画面の passkeys をどう並べる？" } },
    { id: "o2", parentId: "o1", type: "message", timestamp: "2026-10-16T01:01:00Z", message: { role: "assistant", timestamp: "2026-10-16T01:01:00Z", content: [{ type: "text", text: "一覧の行に鍵の名前と最後に使った日を出し、保留の承認は同じ行の下に畳みます。" }] } },
  ],
  leafId: "o2",
  queue: [],
  cost: 0.12,
  model: "anthropic/claude-opus-4-5",
  effort: "high",
  efforts: ["low", "high", "max"],
  contextUsage: { tokens: 4200, contextWindow: 200000, percent: 2 },
  notices: [],
  features: { webSearch: false, mcp: false },
  type: "idea",
};

/** the Inbox state door's own answer, so the rail's badge is the engine's count and not zero */
const INBOX_STATE = () => ({
  source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items: [], undelivered: { total: 0, failed: 0 },
  shouldFix: { total: 0, lanes: [] }, ignores: [], holds: [], answered: [], progress: { done: 0, open: 0 },
});

function serve() {
  let posts = [];
  const server = createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET") posts.push(`${req.method} ${pathname}`);
    const json = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (pathname === "/api/idd/state") return json(INBOX_STATE());
    if (pathname === "/api/idd/modes") return json({ ok: true, modes: [{ name: "chat", types: { chat: { label: "chat" }, idea: { label: "idea" } } }, { name: "idea", types: { idea: { label: "idea" } } }] });
    if (pathname === "/api/idd/passkey/register") return json({ ok: true, registered: [], rpId: "127.0.0.1" });
    if (pathname === "/api/quota") return json({ ok: true, providers: [] });
    if (pathname === "/api/conversations/workspaces") return json({ ok: true, workspaces: WORKSPACES });
    if (/^\/api\/conversations\/workspaces\/[^/]+\/(spaces|bookmarks)$/.test(pathname)) return json({ ok: true, spaces: [], bookmarks: [] });

    if (pathname === "/api/conversations" && req.method === "GET") {
      // the field's read omits mode and includes the archive; the list's read names its mode
      const all = !searchParams.has("mode");
      return json(all ? CANDIDATES : GROUPS);
    }
    if (pathname === "/api/conversation-search") return json(SEARCH);
    if (pathname === "/api/conversations" && req.method === "POST") return json({ ok: true, id: "new1" });
    if (pathname === "/api/conversations/other/idea") return json({ ok: false, reason: "idea の型ではありません" });
    if (pathname === "/api/conversations/new1/idea") return json({ ok: false, reason: "idea の型ではありません" });
    if (pathname.endsWith("/models")) return json(MODEL_LIST);
    if (pathname === "/api/conversations/other") return json(OPEN_OTHER);
    if (pathname === "/api/conversations/new1") return json({ ...OPEN_OTHER, id: "new1", entries: [], leafId: null });

    if (pathname.startsWith("/api/")) return json({ ok: true });

    const file = pathname === "/gui/" || pathname === "/gui" ? "index.html" : pathname.replace(/^\/gui\//, "");
    const full = join(DIST, file);
    if (!full.startsWith(DIST) || !existsSync(full)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(full));
  });
  return { server, posts };
}

// ---- the prototype's A4 figure, extracted and shown on its own page ----

/** the balanced `<div id="A4" …>…</div>` of the prototype's 空とエラー page */
function a4Figure() {
  const html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  const start = html.indexOf('<div id="A4"');
  if (start < 0) throw new Error("the prototype has no A4 figure");
  let depth = 0;
  let at = start;
  while (at < html.length) {
    const open = html.indexOf("<div", at);
    const close = html.indexOf("</div>", at);
    if (close < 0) break;
    if (open >= 0 && open < close) { depth += 1; at = open + 4; }
    else { depth -= 1; at = close + 6; if (depth === 0) return html.slice(start, at); }
  }
  throw new Error("the A4 figure never closed");
}

function protoPage() {
  mkdirSync(SCRATCH, { recursive: true });
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"><style>body{margin:0;width:1440px;height:900px;background:#f5f4f0;padding:30px;box-sizing:border-box;font-family:"IBM Plex Sans JP",system-ui,sans-serif;color:#1c1b19}</style></head><body>${a4Figure()}</body></html>`;
  const file = join(SCRATCH, "a4-proto.html");
  writeFileSync(file, page);
  return file;
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
    const consoleErrors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") consoleErrors.push(message.params.args?.map((a) => a.value ?? a.description).join(" "));
      if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? "exception");
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
      errors: consoleErrors,
      async viewport(width, height) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      },
      async goto(url, timeoutMs = 20_000) {
        await client.evaluate("window.__cmpNav = true").catch(() => undefined);
        await send("Page.navigate", { url });
        const until = Date.now() + timeoutMs;
        for (;;) {
          const fresh = await client.evaluate("typeof window.__cmpNav === 'undefined' && document.readyState === 'complete'").catch(() => false);
          if (fresh) {
            await client.evaluate("new Promise((done) => requestAnimationFrame(() => done(true)))").catch(() => undefined);
            return;
          }
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
      async click(selector) {
        const clicked = await client.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
        if (!clicked) throw new Error(`no element to click: ${selector}`);
      },
      /** write into an input the way a person does, so React's onChange runs */
      async type(selector, text) {
        const set = await client.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`);
        if (!set) throw new Error(`no input to type into: ${selector}`);
      },
      async press(selector, key) {
        const pressed = await client.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));
          return true;
        })()`);
        if (!pressed) throw new Error(`nothing to press into: ${selector}`);
      },
      async settle() {
        await client.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
        await client.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
        await sleep(300);
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

/**
 * The cases: what is opened and pressed, what must be on the picture before it is shot, and whether the prototype
 * A4 is shot beside it. Every case starts on the conversation screen, so the field is shown over its own sidebar
 * as the prototype's A4 draws it.
 */
const CASES = [
  {
    name: "open",
    note: "開いた直後: 空の語で、全 workspace の会話（archive 込み）が並ぶ",
    async press(client) {
      await client.click('[data-part="search-trigger"]');
      if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(TITLE_C)})`))) throw new Error("the opened field never listed the candidates");
    },
    wait: TITLE_A,
  },
  {
    name: "title",
    note: "題の候補: 打った語が題に当たった会話だけが並ぶ",
    async press(client) {
      await client.click('[data-part="search-trigger"]');
      await client.type('[data-part="search-input"]', "PIN");
      if (!(await client.waitFor(`document.querySelector('[data-part=search-row][data-search-row="c3"]') !== null`))) throw new Error("the title stage never found the candidate");
    },
    wait: TITLE_A,
  },
  {
    name: "notfound",
    note: "題で 0 件: prototype A4 の空の状態（本文まで探す ↵ / この言葉で New chat）",
    proto: true,
    async press(client) {
      await client.click('[data-part="search-trigger"]');
      await client.type('[data-part="search-input"]', "trigram tokenizer");
      if (!(await client.waitFor("document.querySelector('[data-part=search-not-found]') !== null"))) throw new Error("the A4 empty state never appeared");
    },
    wait: TITLE_A,
  },
  {
    name: "body",
    note: "全文検索の結果: 題と抜粋（engine の応答をそのまま）",
    async press(client) {
      await client.click('[data-part="search-trigger"]');
      await client.type('[data-part="search-input"]', "poll");
      if (!(await client.waitFor("document.querySelector('[data-part=search-not-found]') !== null"))) throw new Error("the title stage never reached the empty state");
      await client.click('[data-part="search-body-button"]');
      if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(EXCERPT_A.slice(0, 24))})`))) throw new Error("the body stage never showed its excerpt");
    },
    wait: TITLE_A,
  },
  {
    name: "opened",
    note: "欄から開いた会話: 一覧に無い会話でも見出しにその会話の名前が出る",
    async press(client) {
      await client.click('[data-part="search-trigger"]');
      await client.type('[data-part="search-input"]', "passkeys");
      if (!(await client.waitFor(`document.querySelector('[data-part=search-row][data-search-row="other"]') !== null`))) throw new Error("the other workspace's conversation was not offered");
      await client.click('[data-part="search-row"][data-search-row="other"]');
      if (!(await client.waitFor(`document.querySelector('[data-part=chat-title]') && document.querySelector('[data-part=chat-title]').innerText.includes(${JSON.stringify(TITLE_OTHER)})`))) throw new Error("the header never showed the opened conversation's own name");
    },
    wait: TITLE_A,
  },
];

const values = {
  note: "the fake engine's answers at the moment the pictures were taken; only the field's two reads and the conversation screen's own reads",
  titleStageRead: "/api/conversations?group=none&archive=include",
  bodyStageRead: "/api/conversation-search?q=<語>",
  candidates: CANDIDATES.conversations.map((c) => ({ id: c.id, name: c.name, mode: c.mode, archived: c.archived })),
  listShown: GROUPS.conversations.map((c) => c.name),
  search: SEARCH,
  cases: {},
};

/** the checks the pictures cannot carry: ⌘K from every screen, and New chat's draft */
const checks = {};

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  const proto = protoPage();

  const { server, posts } = serve();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);
      for (const c of CASES) {
        values.cases[c.name] = { note: c.note, url: "/gui/?view=chat", press: c.name };
        await client.goto(`http://127.0.0.1:${port}/gui/?view=chat`);
        if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(c.wait)})`))) throw new Error(`${c.name}: the conversation screen never showed the list`);
        await c.press(client);
        await client.settle();
        await client.screenshot(join(OUT, `search-${c.name}-impl.png`));
        if (c.proto) {
          await client.goto(`file://${proto}`);
          await client.settle();
          await client.screenshot(join(OUT, `search-${c.name}-proto.png`));
        }
        console.log(`${c.name}: wrote impl${c.proto ? " + proto" : ""}`);
      }

      // ---- the checks the pictures cannot carry: ⌘K from every screen, and New chat's draft
      const metaK = {};
      for (const view of ["inbox", "work", "chat"]) {
        await client.goto(`http://127.0.0.1:${port}/gui/?view=${view}`);
        await client.waitFor("document.querySelector('[data-part=search-trigger]') !== null");
        await client.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))");
        const opened = await client.waitFor("document.querySelector('[data-part=search-panel]') !== null");
        await client.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        const closed = await client.waitFor("document.querySelector('[data-part=search-panel]') === null");
        metaK[view] = { opened, closed };
      }
      checks.metaK = metaK;

      // the field's two visible controls: the top bar's own field, and the conversation list's magnifier
      await client.goto(`http://127.0.0.1:${port}/gui/?view=chat`);
      await client.waitFor(`document.body.innerText.includes(${JSON.stringify(TITLE_A)})`);
      const triggers = {};
      for (const part of ["search-trigger", "chat-search"]) {
        await client.click(`[data-part="${part}"]`);
        triggers[part] = await client.waitFor("document.querySelector('[data-part=search-panel]') !== null");
        await client.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        await client.waitFor("document.querySelector('[data-part=search-panel]') === null");
      }
      checks.triggers = triggers;
      await client.goto(`http://127.0.0.1:${port}/gui/?view=chat`);
      await client.waitFor(`document.body.innerText.includes(${JSON.stringify(TITLE_A)})`);
      await client.click('[data-part="search-trigger"]');
      await client.type('[data-part="search-input"]', "この語で新しい会話");
      if (!(await client.waitFor("document.querySelector('[data-part=search-not-found]') !== null"))) throw new Error("New chat's empty state never appeared");
      await client.click('[data-part="search-new-chat"]');
      const draft = await client.waitFor("document.querySelector('[data-part=composer-input]') !== null && document.querySelector('[data-part=composer-input]').value === 'この語で新しい会話'");
      const composerValue = await client.evaluate("(() => { const el = document.querySelector('[data-part=composer-input]'); return el ? el.value : null; })()");
      checks.newChat = { draftInComposer: draft, composerValue, messagesPosted: posts.filter((path) => path.endsWith("/messages")).length, posts };
      console.log(`checks: ⌘K ${JSON.stringify(metaK)}, New chat ${JSON.stringify(checks.newChat)}`);

      if (client.errors.length) throw new Error(`the screen logged errors:\n${client.errors.join("\n")}`);
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const differences = existsSync(join(OUT, "differences.txt"))
    ? readFileSync(join(OUT, "differences.txt"), "utf8").split("\n").filter((line) => line.startsWith("- "))
    : [];
  writeFileSync(join(OUT, "engine-values.json"), JSON.stringify({ ...values, checks, differences }, null, 2));
  console.log(`wrote ${OUT}`);
}

await main();
