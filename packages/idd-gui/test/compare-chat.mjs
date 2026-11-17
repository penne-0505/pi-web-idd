#!/usr/bin/env node
/**
 * idd-153: the pictures the plan asks for (AC-006). This lane's built conversation screen — the list, the body,
 * the input's row with its chips, the BTW right panel, the Model / Effort / Context popovers — and the question
 * card's consultation in the Inbox's right panel are each shot beside the prototype holding the same state, and
 * the answers the fake engine gave are written under `_docs/qa/pi-web-idd/idd-153/compare/` with the pairs.
 *
 * Usage: node packages/idd-gui/test/compare-chat.mjs
 *
 * Only GETs and the doors the screen itself presses reach the fake engine (there is no real engine here), and the
 * prototype is read from `_meta/gui-prototype/` with the patched pages written under `_meta/scratch/`.
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
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-153", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-153");
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

const MODEL_LIST = { ok: true, models: [
  { id: "anthropic/claude-opus-4-5", name: "Opus 4.5", provider: "anthropic", contextWindow: 200000, capabilities: ["image", "reasoning"] },
  { id: "anthropic/claude-sonnet-4-5", name: "Sonnet 4.5", provider: "anthropic", contextWindow: 1000000, capabilities: ["image", "reasoning"] },
  { id: "openai/gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400000, capabilities: ["reasoning"] },
] };

const ENTRY_USER = { id: "e1", parentId: null, type: "message", timestamp: "2026-10-14T01:00:00Z", message: { role: "user", content: "FTS5 で日本語の部分一致はどこまで実用になる？ 会話は 2,300 件くらい。" } };
const ENTRY_TOOLS = { id: "e2", parentId: "e1", type: "message", timestamp: "2026-10-14T01:00:30Z", message: { role: "toolResult", toolCallId: "t1", toolName: "grep", content: "3 files", isError: false } };
const ENTRY_ASSISTANT = { id: "e3", parentId: "e2", type: "message", timestamp: "2026-10-14T01:01:00Z", message: { role: "assistant", timestamp: "2026-10-14T01:01:00Z", content: [
  { type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "tokenize" } },
  { type: "text", text: "2,300 件なら実用になります。鍵は tokenizer で、`trigram` を使えば辞書なしで部分一致が引けます。\n\n```sql\nCREATE VIRTUAL TABLE msg_fts USING fts5(\n  body, tokenize = 'trigram'\n);\n```\n\n索引の大きさは本文の約 3 倍です。" },
] } };
const ENTRY_ASK = { id: "e4", parentId: "e3", type: "message", timestamp: "2026-10-14T01:02:00Z", message: { role: "user", content: "2 文字の語はどうする？" } };
const ENTRY_FOLLOW = { id: "e5", parentId: "e4", type: "message", timestamp: "2026-10-14T01:02:30Z", message: { role: "assistant", timestamp: "2026-10-14T01:02:30Z", content: [{ type: "text", text: "短い語だけ `LIKE` に落とします。" }] } };

const OPEN_C1 = {
  ok: true, id: "c1", mode: "chat", cwd: "/home/penne/text/chat",
  streaming: false, promptPending: false, compacting: false,
  entries: [ENTRY_USER, ENTRY_TOOLS, ENTRY_ASSISTANT, ENTRY_ASK, ENTRY_FOLLOW], leafId: "e5",
  queue: [{ id: "q1", text: "trigram の誤検出はどれくらい？" }, { id: "q2", text: "最後に表にまとめて" }],
  cost: 0.84, model: "anthropic/claude-opus-4-5", effort: "high", efforts: ["low", "high", "max"],
  contextUsage: { tokens: 136000, contextWindow: 200000, percent: 68 },
  notices: [{ kind: "quota", provider: "anthropic", window: "five_hour", label: "5 時間の枠", utilization: 0.41 }],
  features: { webSearch: false, mcp: false }, type: "chat",
};

const GROUPS = { ok: true, group: "date", conversations: [], groups: [
  { key: "pinned", label: "ピン留め", conversations: [{ id: "c1", mode: "chat", cwd: "/home/penne/text/chat", name: "SQLite FTS5 の制約", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: true, running: false, tools: [], pinned: true, archived: false, bookmarks: ["plan"], workdir: "", type: "chat" }] },
  { key: "today", label: "今日", conversations: [
    { id: "c1", mode: "chat", cwd: "/home/penne/text/chat", name: "SQLite FTS5 の制約", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: true, running: true, tools: [], pinned: true, archived: false, bookmarks: ["plan"], workdir: "", type: "chat" },
    { id: "c2", mode: "chat", cwd: "/home/penne/text/ideas", name: "出先で card に答える", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "idea" },
    { id: "c3", mode: "chat", cwd: "/home/penne/text/chat", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
  ] },
  { key: "yesterday", label: "昨日", conversations: [{ id: "c4", mode: "chat", cwd: "/home/penne/text/chat", name: "propter を配布する", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" }] },
] };

const QUESTION_ITEM = {
  kind: "question", iddId: "IDD-142", batchId: "batch-142", laneTitle: "設定の検証", appearedAt: "2026-10-14T00:30:00Z",
  open: [{
    questionId: "q1", question: "未知のキーを見つけたら、起動を止めますか",
    facts: [{ label: "利用者", value: "3 人中 2 人の設定に、廃止キー window.legacy が残っている" }, { label: "v0.12", value: "4 キーを廃止した" }],
    options: [
      { index: 1, label: "警告だけ出して続ける", description: "古い設定でも起動できる", rationale: "打ち間違いを見落とす余地が残る", recommendation: "recommended" },
      { index: 2, label: "起動を止める", description: "打ち間違いにすぐ気づける", rationale: "更新のたびに手で直す", recommendation: "acceptable" },
    ],
  }],
  askedTotal: 3, answeredCount: 0,
};

const ASK_LINE = "起動ログと右上の通知に 1 回だけ（Q1 の答えに合わせた）。";

/** the state door's own answer, so the rail's badge is the engine's count and not zero */
const INBOX_STATE = () => ({
  source: "state", stateDir: "/home/penne/.propter", cron: null,
  sections: [], lanes: [], items: [QUESTION_ITEM], undelivered: { total: 0, failed: 0 },
  shouldFix: { total: 0, lanes: [] }, ignores: [], holds: [], answered: [],
  progress: { done: 1, open: 1 }, today: { total: 6.12, byLane: [] },
});

/** the SSE connections the page opened, so a door can push the answer the screen should draw */
const streams = new Map();
let pushed = 0;

function sse(res, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": open\n\n");
  const list = streams.get(id) ?? [];
  list.push(res);
  streams.set(id, list);
  res.on("close", () => streams.set(id, (streams.get(id) ?? []).filter((entry) => entry !== res)));
  // A browser holds one connection open per live SSE stream, and a page that has been left behind holds its own
  // until it is torn down. The fake engine ends each stream after a few seconds so a run of pages never runs the
  // browser out of connections; the screen reconnects with the number it holds, as it does against the real engine.
  setTimeout(() => {
    streams.set(id, (streams.get(id) ?? []).filter((entry) => entry !== res));
    res.end();
  }, 2500).unref?.();
}

/** one delta the engine would have streamed for a message penne just sent */
function pushAnswer(id, text) {
  pushed += 1;
  const frame = { seq: pushed, type: "text", delta: text, contentIndex: 0 };
  for (const res of streams.get(id) ?? []) res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function serve() {
  return createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://127.0.0.1");
    if (process.env.CMP_LOG) console.log("REQ", req.method, pathname);
    const json = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      let text = "";
      for await (const chunk of req) text += chunk;
      try { return JSON.parse(text); } catch { return {}; }
    };

    if (pathname === "/api/idd/state") return json(INBOX_STATE());
    if (pathname === "/api/idd/modes") return json({ ok: true, modes: [{ name: "chat", types: { chat: { label: "chat" }, idea: { label: "idea" } } }] });
    if (pathname === "/api/idd/passkey/register") return json({ ok: true, registered: [], rpId: "127.0.0.1" });
    if (pathname === "/api/quota") return json({ ok: true, providers: [{ provider: "anthropic", windows: [{ name: "five_hour", label: "5 時間の枠", utilization: 0.41, resets: "2:10" }, { name: "weekly", label: "週の枠", utilization: 0.72 }], observed: "10/15 12:00" }] });
    if (pathname === "/api/conversations/workspaces") return json({ ok: true, workspaces: [{ mode: "chat", label: "chat", workspace: "/home/penne/text/chat" }, { mode: "idea", label: "idea", workspace: "/home/penne/text/ideas" }] });
    if (/^\/api\/conversations\/workspaces\/[^/]+\/(spaces|bookmarks)$/.test(pathname)) return json({ ok: true, spaces: [], bookmarks: [] });
    if (pathname === "/api/conversations" && req.method === "GET") return json(GROUPS);

    if (pathname === "/api/conversations/c1/idea" || pathname === "/api/conversations/b1/idea" || pathname === "/api/conversations/s1/idea") return json({ ok: false, reason: "idea の型ではありません" });
    if (pathname.endsWith("/models")) return json(MODEL_LIST);
    if (pathname === "/api/conversations/c1") return json(OPEN_C1);
    if (pathname === "/api/conversations/b1") return json({ ok: true, id: "b1", mode: "chat", cwd: "/home/penne/text/chat", streaming: false, promptPending: false, compacting: false, entries: [ENTRY_USER, { ...ENTRY_ASSISTANT, id: "b1e2", parentId: "e1" }], leafId: "b1e2", queue: [], cost: 0.02, model: "anthropic/claude-opus-4-5", effort: "high", efforts: ["low", "high", "max"], contextUsage: { tokens: 5200, contextWindow: 200000, percent: 3 }, notices: [], features: { webSearch: false, mcp: false } });
    if (pathname === "/api/conversations/s1") return json({ ok: true, id: "s1", mode: "chat", cwd: "/tmp/consult", streaming: false, promptPending: false, compacting: false, entries: [], leafId: null, queue: [], cost: 0.01, model: "anthropic/claude-opus-4-5", effort: "high", efforts: ["low", "high", "max"], contextUsage: null, notices: [], features: { webSearch: false, mcp: false } });
    if (pathname.endsWith("/events")) return sse(res, pathname.split("/")[3]);

    if (pathname === "/api/conversations/c1/ephemeral") return json({ ok: true, id: "b1", mode: "chat", cwd: "/home/penne/text/chat", role: "chat", tools: ["read"], parent: "c1", at: (await readBody()).at ?? "e5" });
    if (pathname === "/api/conversations/b1/messages") {
      await readBody();
      setTimeout(() => pushAnswer("b1", "文字列を 3 文字ずつ重ねて切り出す分け方です。辞書が要らない代わりに、2 文字の語は引けません。"), 120);
      return json({ ok: true, streaming: true, queue: [] });
    }
    if (pathname === "/api/idd/consult") return json({ ok: true, id: "s1", created: true, mode: "chat", role: "chat", cwd: "/tmp/consult", tools: ["read"] });
    if (pathname === "/api/conversations/s1/messages") {
      await readBody();
      setTimeout(() => pushAnswer("s1", ASK_LINE), 120);
      return json({ ok: true, streaming: true, queue: [] });
    }

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
        // mark the page that is up now, so the wait cannot read the old document (the same URL would reload and
        // the old page is still 'complete' until the navigation commits)
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
 * The prototype's page, forced onto one screen and state and isolated to the app frame itself. The dc page wraps
 * the frame in a caption band and 28/24px padding, and the runtime gives the whole stage one 1440×900 element
 * too, so the frame is found by its own style and then moved to (0,0) with its own ancestors' padding dropped.
 * The frame is drawn at the screen's own 1440×900 border-box, so a pair shows the same view of the same screen.
 */
function protoPage(name, { view, pop }) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  html = html.replaceAll("this.props.startView ?? 'inbox'", `'${view}'`);
  if (pop) html = html.replace("state = { view:", `state = { pop: '${pop}', view:`);
  const isolate = `(function () {
    const frame = [...document.querySelectorAll('div')].find((el) => (el.getAttribute('style') || '').startsWith('position: relative; width: 1440px; height: 900px'));
    if (!frame) return false;
    const chain = [];
    for (let n = frame; n && n !== document.documentElement; n = n.parentElement) chain.push(n);
    for (const el of chain) {
      if (el === frame) continue;
      for (const child of [...el.children]) if (!chain.includes(child)) child.style.display = 'none';
      el.style.cssText = 'display:block;margin:0;padding:0;gap:0;width:1440px;height:900px;overflow:visible';
    }
    frame.style.cssText = 'position:fixed;left:0;top:0;margin:0;box-sizing:border-box;width:1440px;height:900px;display:flex;flex-direction:column;overflow:hidden';
    document.body.style.cssText = 'margin:0;padding:0;width:1440px;height:900px;background:#fff';
    document.documentElement.style.cssText = 'margin:0;padding:0;width:1440px;height:900px;background:#fff';
    window.scrollTo(0, 0);
    return true;
  })()`;
  const script = `<script>window.addEventListener('load', function () { setTimeout(function () { ${isolate}; }, 300); });</script>`;
  copyFileSync(join(PROTO, "support.js"), join(SCRATCH, "support.js"));
  const page = join(SCRATCH, `${name}-proto.html`);
  writeFileSync(page, html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : html + script);
  return page;
}

/** the app frame itself fills the picture: the frame's own content is what a pair compares */
const FRAME_ISOLATED = `(function () {
  const frame = [...document.querySelectorAll('div')].find((el) => (el.getAttribute('style') || '').startsWith('position: fixed; left: 0px'));
  if (!frame) return false;
  const r = frame.getBoundingClientRect();
  return Math.round(r.left) === 0 && Math.round(r.top) === 0 && Math.round(r.width) === 1440 && Math.round(r.height) === 900;
})()`;

/**
 * The cases: the screen the implementation is opened on, what is pressed there, what the prototype is patched
 * to, and the words that must be on the implementation's picture before it is shot.
 */
const ALL_CASES = [
  {
    name: "chat",
    note: "会話の画面（一覧・本文・入力欄と順番待ちの札・右パネルの BTW）",
    pressNote: "一覧の会話を押して開く",
    view: "chat",
    proto: { view: "chat" },
    wait: "SQLite FTS5 の制約",
    async press(client) {
      await client.click('[data-row="c1"]');
      if (!(await client.waitFor("document.body.innerText.includes('2,300 件なら実用になります')"))) throw new Error("the conversation's body never appeared");
    },
  },
  {
    name: "btw",
    note: "会話の右パネルの BTW（開いた会話から枝を切り、その枝で話す）",
    pressNote: "会話を押して開き、BTW の入力に書いて送る",
    view: "chat",
    proto: { view: "chat" },
    wait: "SQLite FTS5 の制約",
    async press(client) {
      await client.click('[data-row="c1"]');
      if (!(await client.waitFor("document.body.innerText.includes('2,300 件なら実用になります')"))) throw new Error("the conversation's body never appeared");
      await client.type('[data-part="btw-input"]', "trigram とは");
      await client.click('[data-part="btw-send"]');
      if (!(await client.waitFor("document.body.innerText.includes('3 文字ずつ')"))) throw new Error("the BTW frame never showed the branch's answer");
    },
  },
  {
    name: "model",
    note: "入力欄の下の行の Model のポップオーバー",
    pressNote: "会話を押して開き、Model を押す",
    view: "chat",
    proto: { view: "chat", pop: "model" },
    wait: "SQLite FTS5 の制約",
    async press(client) {
      await client.click('[data-row="c1"]');
      if (!(await client.waitFor("document.body.innerText.includes('2,300 件なら実用になります')"))) throw new Error("the conversation's body never appeared");
      await client.click('[data-part="model-button"]');
      if (!(await client.waitFor("document.querySelector('[data-part=model-popover]') !== null"))) throw new Error("the model popover never opened");
    },
  },
  {
    name: "effort",
    note: "入力欄の下の行の Effort のポップオーバー",
    pressNote: "会話を押して開き、Effort を押す",
    view: "chat",
    proto: { view: "chat", pop: "effort" },
    wait: "SQLite FTS5 の制約",
    async press(client) {
      await client.click('[data-row="c1"]');
      if (!(await client.waitFor("document.body.innerText.includes('2,300 件なら実用になります')"))) throw new Error("the conversation's body never appeared");
      await client.click('[data-part="effort-button"]');
      if (!(await client.waitFor("document.querySelector('[data-part=effort-popover]') !== null"))) throw new Error("the effort popover never opened");
    },
  },
  {
    name: "ctx",
    note: "入力欄の下の行の Context のポップオーバー",
    pressNote: "会話を押して開き、Context を押す",
    view: "chat",
    proto: { view: "chat", pop: "ctx" },
    wait: "SQLite FTS5 の制約",
    async press(client) {
      await client.click('[data-row="c1"]');
      if (!(await client.waitFor("document.body.innerText.includes('2,300 件なら実用になります')"))) throw new Error("the conversation's body never appeared");
      await client.click('[data-part="context-button"]');
      if (!(await client.waitFor("document.querySelector('[data-part=context-popover]') !== null"))) throw new Error("the context popover never opened");
    },
  },
  {
    name: "consult",
    note: "質問 card の右パネルの相談",
    pressNote: "「この card について聞く」を押し、相談の入力に書いて Enter で送る",
    view: "inbox",
    proto: { view: "inbox" },
    wait: "未知のキーを見つけたら、起動を止めますか",
    async press(client) {
      await client.click('[data-part="ask-row"]');
      if (!(await client.waitFor("document.querySelector('[data-panel-note-input]') !== null"))) throw new Error("the consultation input never opened");
      await client.type('[data-panel-note-input]', "警告はどこに出る？");
      await client.evaluate(`(() => {
        const el = document.querySelector('[data-panel-note-input]');
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`);
      if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify("起動ログと右上の通知")})`))) throw new Error("the consult's answer never reached the panel");
    },
  },
];

/** the answers the implementation was drawn from, written beside the pairs */
const values = {
  note: "the fake engine's answers at the moment the pictures were taken; GETs and the doors the screen itself presses",
  cases: {},
};

const CASES = process.env.CMP_ONLY ? ALL_CASES.filter((c) => c.name === process.env.CMP_ONLY) : ALL_CASES;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  const server = serve();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);
      // write every prototype page and check its frame first, so a missing frame stops the run
      const pages = new Map();
      for (const c of CASES) {
        const page = protoPage(c.name, c.proto);
        await client.goto(`file://${page}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's app frame was never isolated for ${c.name}`);
        await client.settle();
        pages.set(c.name, page);
      }
      for (const c of CASES) {
        values.cases[c.name] = {
          note: c.note,
          url: `/gui/?view=${c.view}`,
          press: c.pressNote ?? null,
          answers: c.name === "consult" ? { consult: { ok: true, id: "s1" }, item: QUESTION_ITEM, answer: ASK_LINE }
            : c.name === "btw" ? { ephemeral: { ok: true, id: "b1", at: "e5" }, answer: "文字列を 3 文字ずつ重ねて切り出す分け方です。" }
              : { list: GROUPS.groups.map((g) => ({ label: g.label, rows: g.conversations.map((r) => r.name ?? "(無題)") })), open: { queue: OPEN_C1.queue, model: OPEN_C1.model, effort: OPEN_C1.effort, contextUsage: OPEN_C1.contextUsage, notices: OPEN_C1.notices }, models: MODEL_LIST.models },
        };
        await client.viewport(FRAME.width, FRAME.height);
        await client.goto(`http://127.0.0.1:${port}/gui/?view=${c.view}&cmp=${c.name}`);
        if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(c.wait)})`))) throw new Error(`${c.name}: the screen never showed the engine's answer`);
        if (c.press) await c.press(client);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-impl.png`));

        await client.goto(`file://${pages.get(c.name)}`);
        if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's frame was never isolated again for ${c.name}`);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-proto.png`));
        console.log(`${c.name}: wrote impl + proto`);
      }
      if (client.errors.length) throw new Error(`the screen logged errors:\n${client.errors.join("\n")}`);
    });
  } finally {
    for (const list of streams.values()) for (const res of list) res.end();
    server.close();
    server.closeAllConnections?.();
  }
  values.differences = readFileSync(join(OUT, "differences.txt"), "utf8").split("\n").filter((line) => line.startsWith("- "));
  writeFileSync(join(OUT, "engine-values.json"), JSON.stringify(values, null, 2));
  console.log (`wrote ${OUT}`);
}

await main();
