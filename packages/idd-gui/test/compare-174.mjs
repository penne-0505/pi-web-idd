#!/usr/bin/env bun
/**
 * idd-174: the pictures the plan asks for (AC-006). The conversation screen's switch for the engine settings —
 * skills, web search and MCP — is shot with the fake engine's answers, beside the prototype's settings sheet
 * Skills section (`propter 収束版.dc.html` line 671), which is the only place the prototype draws a switch. A
 * second shot holds a conversation whose open door said nothing about its pi, so the screen has to draw 今 不明.
 * A third shot is the real engine, started in this process on a temporary state, with the lane's build served by
 * its own `/gui/`: its answers ride beside the picture in `real-engine-values.json`.
 *
 * Usage: bun run packages/idd-gui/test/compare-174.mjs
 *
 * Only GETs and the doors the screen itself presses reach the fake engine. The real engine runs on a temporary
 * state, a temporary `HOME`, and the engine tests' stand-in for `pi`, so the user's own pi settings, `~/.pi` and
 * `~/.agents` are never read or written, and nothing is billed. The prototype is read from `_meta/gui-prototype/`
 * with the patched pages under `_meta/scratch/`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FAKE_PI } from "../../idd-engine/test/helpers/pi-stand-in.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const ROOT = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist");
const OUT = join(ROOT, "_docs", "qa", "pi-web-idd", "idd-174", "compare");
const PROTO = join(ROOT, "_meta", "gui-prototype", "2026-10-07");
const PROTO_FILE = "propter 収束版.dc.html";
const SCRATCH = join(ROOT, "_meta", "scratch", "gui-cmp-174");
const CHROME = "/usr/bin/google-chrome-stable";
const FRAME = { width: 1440, height: 900 };
const ENGINE_SERVER = join(ROOT, "packages", "idd-engine", "src", "server.ts");

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

const CWD = "/home/penne/text/chat";
const USER_ROOT = "/home/penne/.agents/skills";
const WS_ROOT = `${CWD}/.agents/skills`;
const PROJ_ROOT = "/home/penne/dev/active/work/pi-web-idd/.agents/skills";
const OTHER_ROOT = "/home/penne/text/ideas/.agents/skills";

const SETTINGS_SKILLS = [`${USER_ROOT}/ja-style`, `${USER_ROOT}/diagram`, `${OTHER_ROOT}/idea-one`];

const SETTINGS_ANSWER = {
  ok: true,
  settings: { skills: SETTINGS_SKILLS, webSearch: true, webSearchTools: ["web_search", "fetch_content", "get_search_content", "source_check"], mcp: false },
  candidates: [
    { path: `${USER_ROOT}/ja-style`, name: "ja-style", description: "日本語の書き方の決まり", origin: "user", enabled: true },
    { path: `${USER_ROOT}/diagram`, name: "diagram", description: "図を描く", origin: "user", enabled: true },
    { path: `${WS_ROOT}/chat-notes`, name: "chat-notes", description: "会話の下書きを整える", origin: "workspace", enabled: false },
    { path: `${PROJ_ROOT}/idd-review`, name: "idd-review", description: "review の観点", origin: "repo", enabled: false },
  ],
  path: "/home/penne/dev/active/work/pi-web-idd/state/pipeline/conversation-settings.json",
};

const MODEL_LIST = { ok: true, models: [
  { id: "anthropic/claude-opus-4-5", name: "Opus 4.5", provider: "anthropic", contextWindow: 200000, capabilities: ["image", "reasoning"] },
] };

const ENTRY_USER = { id: "e1", parentId: null, type: "message", timestamp: "2026-10-14T01:00:00Z", message: { role: "user", content: "FTS5 で日本語の部分一致はどこまで実用になる？" } };
const ENTRY_ASSISTANT = { id: "e2", parentId: "e1", type: "message", timestamp: "2026-10-14T01:01:00Z", message: { role: "assistant", timestamp: "2026-10-14T01:01:00Z", content: [{ type: "text", text: "2,300 件なら実用になります。`trigram` を使えば辞書なしで部分一致が引けます。" }] } };

/** the running pi was started with the settings off and no skills: every row is a change that waits for the next pi */
const OPEN_C1 = {
  ok: true, id: "c1", mode: "chat", cwd: CWD,
  streaming: false, promptPending: false, compacting: false,
  entries: [ENTRY_USER, ENTRY_ASSISTANT], leafId: "e2",
  queue: [], cost: 0.12, model: "anthropic/claude-opus-4-5", effort: "high", efforts: ["low", "high", "max"],
  contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
  notices: [], features: { webSearch: false, mcp: false, skills: [] }, type: "chat",
};

/** an older open door that carried no features at all: the screen must say it does not know, not that they are off */
const OPEN_C2 = { ...OPEN_C1, id: "c2", features: undefined, entries: [], leafId: null, contextUsage: null };

const GROUPS = { ok: true, group: "date", conversations: [], groups: [
  { key: "today", label: "今日", conversations: [
    { id: "c1", mode: "chat", cwd: CWD, name: "SQLite FTS5 の制約", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: true, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
    { id: "c2", mode: "chat", cwd: CWD, name: "古い engine の会話", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T01:00:00Z", cost: 0, open: false, running: false, tools: [], pinned: false, archived: false, bookmarks: [], workdir: "", type: "chat" },
  ] },
] };

const streams = new Map();

function sse(res, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": open\n\n");
  const list = streams.get(id) ?? [];
  list.push(res);
  streams.set(id, list);
  res.on("close", () => streams.set(id, (streams.get(id) ?? []).filter((entry) => entry !== res)));
  setTimeout(() => {
    streams.set(id, (streams.get(id) ?? []).filter((entry) => entry !== res));
    res.end();
  }, 2500).unref?.();
}

function serve() {
  return createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://127.0.0.1");
    if (process.env.CMP_LOG) console.log("REQ", req.method, req.url);
    const json = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (pathname === "/api/idd/state") return json({ source: "state", stateDir: "/home/penne/.propter", cron: null, sections: [], lanes: [], items: [], undelivered: { total: 0, failed: 0 }, ignores: [], holds: [] });
    if (pathname === "/api/idd/modes") return json({ ok: true, modes: [{ name: "chat", types: { chat: { label: "chat" }, idea: { label: "idea" } } }] });
    if (pathname === "/api/idd/passkey/register") return json({ ok: true, registered: [], rpId: "127.0.0.1" });
    if (pathname === "/api/quota") return json({ ok: true, providers: [] });
    if (pathname === "/api/conversations/workspaces") return json({ ok: true, workspaces: [{ mode: "chat", label: "chat", workspace: CWD }] });
    if (/^\/api\/conversations\/workspaces\/[^/]+\/(spaces|bookmarks)$/.test(pathname)) return json({ ok: true, spaces: [], bookmarks: [] });
    if (pathname === "/api/conversations" && req.method === "GET") return json(GROUPS);
    if (pathname === "/api/conversation-settings") {
      if (process.env.CMP_LOG) console.log("SETTINGS-CWD", searchParams.get("cwd"));
      return json(SETTINGS_ANSWER);
    }
    if (pathname.endsWith("/models")) return json(MODEL_LIST);
    if (pathname === "/api/conversations/c1/idea" || pathname === "/api/conversations/c2/idea") return json({ ok: false, reason: "idea の型ではありません" });
    if (pathname === "/api/conversations/c1") return json(OPEN_C1);
    if (pathname === "/api/conversations/c2") return json(OPEN_C2);
    if (pathname.endsWith("/events")) return sse(res, pathname.split("/")[3]);
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
  // the profile is the scratch's, and the environment is the one this process was started with: the real-engine
  // case moves `HOME` only after this browser is up, so the browser keeps the machine's own home
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${join(SCRATCH, "chrome-profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
 * The prototype's page, forced onto the settings sheet's Skills section. The dc page's state is patched the same
 * way `compare-chat.mjs` patches it for the popovers; the frame is then found by its own style and moved to (0,0).
 */
function protoPage(name, { settings = false, sec, view = "chat" }) {
  let html = readFileSync(join(PROTO, PROTO_FILE), "utf8");
  html = html.replaceAll("this.props.startView ?? 'inbox'", `'${view}'`);
  html = html.replace("state = { view:", `state = { settings: ${settings}, sec: '${sec}', view:`);
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

const FRAME_ISOLATED = `(function () {
  const frame = [...document.querySelectorAll('div')].find((el) => (el.getAttribute('style') || '').startsWith('position: fixed; left: 0px'));
  if (!frame) return false;
  const r = frame.getBoundingClientRect();
  return Math.round(r.left) === 0 && Math.round(r.top) === 0 && Math.round(r.width) === 1440 && Math.round(r.height) === 900;
})()`;

/** the cases: the conversation opened, the Context control pressed, and the prototype page that pairs with it */
const ALL_CASES = [
  {
    name: "features",
    note: "会話の画面の Context のポップオーバーの中の切り替え（行は engine が返した候補と値、効いている値は開いた状態の features）",
    pressNote: "一覧の会話を押して開き、Context を押す",
    row: "c1",
    wait: "SQLite FTS5 の制約",
    proto: { settings: true, sec: "skills", view: "chat" },
    async press(client) {
      await client.click('[data-part="context-button"]');
      if (!(await client.waitFor("document.querySelector('[data-part=context-settings]') !== null"))) throw new Error("the settings section never opened");
      if (!(await client.waitFor("document.body.innerText.includes('日本語の書き方の決まり')"))) throw new Error("the skill rows never appeared");
      if (!(await client.waitFor("document.body.innerText.includes('次の pi から ON')"))) throw new Error("the differing rows never showed the next pi's value");
    },
  },
  {
    name: "features-unknown",
    note: "開いた状態が features を返さない会話: 効いている値の欄は推測せず 今 不明 を出す",
    pressNote: "一覧の古い会話を押して開き、Context を押す",
    row: "c2",
    wait: "古い engine の会話",
    proto: { settings: true, sec: "skills", view: "chat" },
    async press(client) {
      await client.click('[data-part="context-button"]');
      if (!(await client.waitFor("document.querySelector('[data-part=context-settings]') !== null"))) throw new Error("the settings section never opened");
      if (!(await client.waitFor("document.body.innerText.includes('日本語の書き方の決まり')"))) throw new Error("the skill rows never appeared");
      if (!(await client.waitFor("document.body.innerText.includes('今 不明')"))) throw new Error("the unknown mark never showed");
    },
  },
];

const CASES = process.env.CMP_ONLY ? ALL_CASES.filter((c) => c.name === process.env.CMP_ONLY) : ALL_CASES;

// ---- the real engine, on a temporary state: the picture AC-006 asks for beside the answers it drew ----

/**
 * The engine reads `HOME` for the user's skill places and its settings file for every conversation, so the case
 * moves both to a temporary place. Only these variables are touched, and every one of them is put back.
 */
const REAL_ENGINE_ENV = [
  "HOME", "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR",
  "FAKE_PI_LOG", "IDD_CONVERSATION_IDLE_MS",
];

const REAL_NAME = "engine の設定を切り替える会話";

/** a skill the engine discovers: its frontmatter is what the screen draws, so it is written as a real one */
function writeSkill(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
  return dir;
}

async function waitUntil(check, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * Start the engine in this process on a temporary state, open a conversation whose pi is handed nothing, write
 * the settings on afterwards, and shoot what the screen draws. The values it fills into `out` are the engine's
 * own answers, so the picture can be read beside them.
 */
async function realEngineCase(client, out) {
  const saved = Object.fromEntries(REAL_ENGINE_ENV.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(SCRATCH, "engine-"));
  const state = join(root, "state");
  const repo = join(root, "repo");
  const cwd = join(repo, "chat");
  const userAgent = join(root, "user-agent");
  const agentHome = join(root, "home");
  const settingsPath = join(state, "pipeline", "conversation-settings.json");
  let server = null;
  let id = null;
  let base = "";
  try {
    // a picture from an older run must not sit beside a note that says this one was not taken
    rmSync(join(OUT, "features-engine-impl.png"), { force: true });
    for (const dir of [state, join(state, "pipeline"), cwd, userAgent, join(agentHome, ".agents", "skills")]) mkdirSync(dir, { recursive: true });
    // the repository's mark; the engine finds a project's skills by the nearest ancestor holding `.git`
    mkdirSync(join(repo, ".git"), { recursive: true });
    const userSkill = writeSkill(join(agentHome, ".agents", "skills", "ja-style"), "ja-style", "日本語の書き方の決まり");
    writeSkill(join(userAgent, "skills", "diagram"), "diagram", "図を描く");
    const wsSkill = writeSkill(join(cwd, ".agents", "skills", "chat-notes"), "chat-notes", "会話の下書きを整える");
    writeSkill(join(repo, ".agents", "skills", "idd-review"), "idd-review", "review の観点");
    const fakePi = join(root, "pi");
    writeFileSync(fakePi, FAKE_PI);
    chmodSync(fakePi, 0o755);
    writeFileSync(join(root, "roles.yaml"), [
      "defaults:",
      "  title_context_turns: 3",
      "roles:",
      "  chat: { model: openrouter/z-ai/glm-5.3, thinking: high, tools: [read, bash] }",
      "  titler: { model: openrouter/z-ai/glm-5.3-flash, thinking: low, tools: [read] }",
    ].join("\n") + "\n");
    writeFileSync(join(root, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${cwd} }\n`);
    writeFileSync(join(root, "repos.yaml"), "storage:\n  min_free_gb: 0\nrepos: {}\n");
    // everything off before the pi starts: the conversation's pi is handed no skill and no web-search tool
    writeFileSync(settingsPath, `${JSON.stringify({ skills: [], webSearch: false, mcp: false }, null, 2)}\n`);
    Object.assign(process.env, {
      HOME: agentHome,
      IDD_STATE_DIR: state,
      IDD_ROLES_FILE: join(root, "roles.yaml"),
      IDD_MODES_FILE: join(root, "modes.yaml"),
      IDD_REPOS_FILE: join(root, "repos.yaml"),
      IDD_PI_BIN: fakePi,
      IDD_PI_USER_AGENT_DIR: userAgent,
      FAKE_PI_LOG: join(root, "pi.log"),
      IDD_CONVERSATION_IDLE_MS: "600000",
    });

    const { startEngine } = await import(ENGINE_SERVER);
    server = startEngine({ port: 0, passkeyCount: () => 0 });
    base = `http://127.0.0.1:${server.port}`;
    const ask = async (path, init) => (await fetch(`${base}${path}`, init)).json();
    const post = (path, body) => ask(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const settingsQuery = `/api/conversation-settings?cwd=${encodeURIComponent(cwd)}`;

    out.stateDir = state;
    out.home = agentHome;
    out.cwd = cwd;
    out.settingsPath = settingsPath;
    out.initial = await ask(settingsQuery);

    const created = await post("/api/conversations", { mode: "chat" });
    if (!created || created.ok !== true || typeof created.id !== "string") throw new Error(`the engine did not create a conversation: ${JSON.stringify(created)}`);
    id = created.id;
    out.conversation = id;
    const named = await post(`/api/conversations/${id}/command`, { type: "set_session_name", name: REAL_NAME });
    if (!named || named.ok !== true) throw new Error(`the engine did not name the conversation: ${JSON.stringify(named)}`);
    // the list reads the session file, so the row exists only after the stand-in wrote the name into it
    await waitUntil(async () => {
      const list = await ask("/api/conversations?group=date&archive=include");
      return (list.conversations ?? []).some((entry) => entry.id === id && entry.name === REAL_NAME);
    }, 20_000, "the conversation list to hold the name the stand-in wrote");

    // the change lands after the pi is up: the open door keeps what the pi was started with
    writeFileSync(settingsPath, `${JSON.stringify({ skills: [userSkill, wsSkill], webSearch: true, mcp: false }, null, 2)}\n`);
    out.settings = await ask(settingsQuery);
    out.open = await ask(`/api/conversations/${id}`);
    const starts = readFileSync(join(root, "pi.log.starts"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    out.pi = starts[0] ?? null;

    await client.viewport(FRAME.width, FRAME.height);
    await client.goto(`${base}/gui/?view=chat`);
    if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(REAL_NAME)})`, 20_000))) throw new Error("the list never showed the conversation the engine holds");
    await client.click(`[data-row="${id}"]`);
    if (!(await client.waitFor("document.querySelector('[data-part=\"context-button\"]') !== null", 20_000))) throw new Error("the conversation never opened");
    await client.click('[data-part="context-button"]');
    if (!(await client.waitFor("document.querySelector('[data-part=context-settings]') !== null", 20_000))) throw new Error("the settings section never opened");
    for (const text of ["日本語の書き方の決まり", "図を描く", "会話の下書きを整える", "review の観点", "今 OFF · 次の pi から ON", `設定: ${settingsPath}`]) {
      if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, 20_000))) throw new Error(`the screen never drew the engine's answer: ${text}`);
    }
    await client.settle();
    await client.screenshot(join(OUT, "features-engine-impl.png"));
    out.picture = "features-engine-impl.png";
    // the rows as the screen drew them, so the picture's values can be read against the engine's answers
    out.drawn = await client.evaluate(`[...document.querySelectorAll('[data-part=settings-skill],[data-part=settings-feature]')].map((el) => ({ part: el.dataset.part, id: el.dataset.skill ?? el.dataset.feature, on: el.dataset.on, effective: el.dataset.effective, text: el.innerText }))`);
    out.pressed = "一覧の会話を押して開き、Context を押す";
    console.log("features-engine: wrote impl");
    return { ok: true };
  } catch (err) {
    out.error = String(err instanceof Error ? err.message : err);
    throw err;
  } finally {
    if (server) {
      if (id) await fetch(`${base}/api/conversations/${id}/close`, { method: "POST" }).catch(() => undefined);
      server.stop(true);
    }
    for (const key of REAL_ENGINE_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    out.root = root;
  }
}

const differences = [
  "- prototype の切り替えは設定画面（sheet）の中にあり、実装はその会話の画面の Context のポップオーバーの中に置いた（同じ行の形: 名前（mono）・説明・右端のトグル）。",
  "- prototype の群の見出しは置き場の path（`~/.propter/skills`・`Project · propter/.agents/skills`）で、実装は engine が返す置き場の種類（利用者・workspace・リポジトリ）を出す。engine は候補の path ごとに種類を返し、置き場のルートは返さない。",
  "- prototype の MCP は server ごとの行（`github · 12 個の道具`）と `File access scope` の行を持つが、engine の MCP は 1 つの on/off しか持たないので、実装は 1 行（MCP）だけを出す。",
  "- prototype の切り替えの行に「今効いている値」は無い。実装は各行に、開いた会話の pi が起動時に受け取った値（今 ON / 今 OFF / 今 不明）を、設定の値（トグル）と混ぜずに出す。",
  "- 実装は「別の場所で ON」の群を持つ。engine の設定は全会話で 1 つなので、別の cwd で ON の skill もこの一覧に出す（この会話の cwd では使われないことを行に書く）。prototype にはこの群が無い。",
  "- prototype の節名は無い（設定画面の Skills の節）。実装の節名は `Skills · Web search · MCP` で、「切り替えは全会話の次の pi から効きます」の 1 行と、engine が読んだ設定ファイルの path を添える。",
  "- 一時の state の engine の絵（`features-engine-impl.png`）も同じ行の形で、値だけがその engine の答えである。候補の path と設定ファイルの path は一時の state に作った repo と `HOME` のもので、penne の機械のものではない。",
];

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build the screen first: bun run --cwd packages/idd-gui build");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  const server = serve();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const values = { note: "the fake engine's answers at the moment the pictures were taken", settings: SETTINGS_ANSWER, open: { c1: OPEN_C1, c2: OPEN_C2 }, cases: {} };
  const real = { note: "the answers of an engine started on a temporary state, at the moment features-engine-impl.png was taken" };
  try {
    await withChrome(async (client) => {
      await client.viewport(FRAME.width, FRAME.height);
      const pages = new Map();
      for (const c of CASES) {
        const key = c.proto.sec;
        if (!pages.has(key)) {
          const page = protoPage(`settings-${key}`, c.proto);
          await client.goto(`file://${page}`);
          if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error("the prototype's app frame was never isolated");
          await client.settle();
          pages.set(key, page);
        }
      }
      for (const c of CASES) {
        values.cases[c.name] = { note: c.note, url: `/gui/?view=chat`, press: c.pressNote };
        await client.viewport(FRAME.width, FRAME.height);
        await client.goto(`http://127.0.0.1:${port}/gui/?view=chat`);
        if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify(c.wait)})`))) throw new Error(`${c.name}: the list never showed the engine's answer`);
        await client.click(`[data-row="${c.row}"]`);
        if (!(await client.waitFor(`document.body.innerText.includes(${JSON.stringify("2,300 件なら実用になります")})`)) && c.row === "c1") throw new Error("the conversation's body never appeared");
        await client.settle();
        await c.press(client);
        await client.settle();
        await client.screenshot(join(OUT, `${c.name}-impl.png`));

        if (c.proto) {
          const page = pages.get(c.proto.sec);
          await client.goto(`file://${page}`);
          if (!(await client.waitFor(FRAME_ISOLATED))) throw new Error(`the prototype's frame was never isolated again for ${c.name}`);
          await client.settle();
          await client.screenshot(join(OUT, `${c.name}-proto.png`));
        }
        console.log(`${c.name}: wrote impl${c.proto ? " + proto" : ""}`);
      }
      if (!process.env.CMP_SKIP_ENGINE) {
        try {
          await realEngineCase(client, real);
        } catch (err) {
          real.error = String(err instanceof Error ? err.message : err);
          console.error(`features-engine: the real engine's picture was not taken: ${real.error}`);
          process.exitCode = 1;
        }
      }
      if (client.errors.length) throw new Error(`the screen logged errors:\n${client.errors.join("\n")}`);
    });
  } finally {
    for (const list of streams.values()) for (const res of list) res.end();
    server.close();
    server.closeAllConnections?.();
  }
  values.differences = differences;
  const realPictures = real.picture ? `\`${real.picture}\`` : "（撮れていない）";
  writeFileSync(join(OUT, "engine-values.json"), JSON.stringify(values, null, 2));
  writeFileSync(join(OUT, "real-engine-values.json"), JSON.stringify(real, null, 2));
  writeFileSync(join(OUT, "differences.txt"), `${differences.join("\n")}\n`);
  writeFileSync(join(OUT, "README.txt"), [
    "判定の絵（IDD-174）",
    "",
    "`bun run --cwd packages/idd-gui build && bun run packages/idd-gui/test/compare-174.mjs` で撮り直せる。絵は 2 種類",
    "ある。偽の engine の上で動かした実装の絵と、一時の state で起こした本物の engine に同じ build を当てた絵で、",
    "prototype は `_meta/gui-prototype/2026-10-07/propter 収束版.dc.html` を設定画面の Skills の節（671 行）に固定し、",
    "アプリの枠だけを 1440×900 に切り出して撮る。撮ったときに engine が返した値は `engine-values.json`（偽の engine）",
    "と `real-engine-values.json`（一時の state の engine）に、prototype と見比べて挙げた違いは `differences.txt` にある。",
    "",
    "偽の engine の絵",
    "",
    "| 組 | 何を撮ったか | 押した操作 | engine の応答 |",
    "| --- | --- | --- | --- |",
    "| `features-impl.png` / `features-proto.png` | 会話の画面の Context のポップオーバーの中の切り替え（設定の値は ON、開いた pi は OFF で、行が食い違う） | 一覧の会話を押して開き、Context を押す | `engine-values.json` の `settings`・`open.c1` |",
    "| `features-unknown-impl.png` / `features-unknown-proto.png` | 開いた状態が `features` を返さない会話を開いたとき（行は `今 不明`） | 一覧の古い会話を押して開き、Context を押す | `engine-values.json` の `open.c2` |",
    "",
    "一時の state の engine の絵",
    "",
    "| 組 | 何を撮ったか | 押した操作 | engine の応答 |",
    "| --- | --- | --- | --- |",
    `| ${realPictures} | 本物の engine を一時の state で起こし、lane の build をその engine の \`/gui/\` から開いた絵。会話を設定 OFF のまま開いて pi を起こし、その後に設定を ON に書き換えてあるので、行は \`今 OFF · 次の pi から ON\` になる | 一覧の会話を押して開き、Context を押す（PATCH は押さない） | \`real-engine-values.json\` の \`initial\`・\`settings\`・\`open\`・\`pi\`・\`drawn\` |`,
    "",
    real.drawn?.length
      ? "一時の state の engine の絵の値は、すべてその engine の答えである。候補は一時の `HOME/.agents/skills`・一時の pi の dir の `skills`・一時の repo の `.agents/skills` に書いた本物の `SKILL.md` を engine に読ませ、設定は同じ state の `pipeline/conversation-settings.json` を engine の口で読ませている。`real-engine-values.json` の `drawn` は撮ったときに画面が描いていた行そのもので、`settings`・`open`・`pi` の答えと突き合わせられる。候補の path と題は一時の state のもので、penne の機械のものではない。"
      : `一時の state の engine の絵は撮れていない${real.picture ? "（この組の途中で止まった）" : ""}。理由: ${real.error ?? "不明"}。${real.picture ? "置いた絵はあるが、行の値は確かめられていない。" : "この場所にある実装の絵は偽の engine のものだけである。"}`,
    "",
    "prototype の絵は設定画面の Skills の節で、切り替えの形はここにしか無い（会話の画面の Context のポップオーバーと",
    "見出しの ◇ には切り替えが無い）。会話の画面の実装の絵に対して、切り替えの行の形（名前（mono）・説明・右端の",
    "トグル）を見比べるための組である。",
    "",
    "この絵について確かめたこと",
    "",
    "- 実装の絵は、engine が返した値だけを描いた状態で撮っている。撮る前に、engine の値が画面に出ていること",
    "  （会話の名・本文・設定の節・`次の pi から ON`・`今 不明`・候補の名前・設定ファイルの path）を script 自身が待って",
    "  確かめ、確かめられなければそこで止まる。",
    "- 一時の state の engine の絵は、`pi` に engine の test の代役を置き、`HOME` と state を一時の dir にして撮っている。",
    "  利用者の `~/.pi`・`~/.agents` と手元の engine の設定には触れていない。engine と代役は script が閉じる。",
    "- 撮っている間に画面が console へ error を出したら、そこで止まる（出なかった）。",
    "- 実装役は画像を見られない model なので、**この絵を目で見てはいない**。偽の engine の絵も一時の state の engine の",
    "  絵も同様で、見比べての判定は人（AC-006 の判定者）に残っている。",
    "",
  ].join("\n"));
  if (real.error) console.error(`the real engine's answer is in real-engine-values.json: ${real.error}`);
  console.log(`wrote ${OUT}`);
}

await main();
