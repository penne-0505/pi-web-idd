/**
 * A stand-in for `pi --mode rpc`, shared by the engine tests that need one. It mirrors the fake in
 * `conversations.test.ts` so the consult tests can run a real door against a real child process.
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const listMs = Number(process.env.FAKE_PI_LIST_MODELS_MS || "0");
if (args.includes("--list-models")) {
  const q = String(at("--list-models") || "openrouter/z-ai/glm-5.3");
  const parts = q.split("/");
  setTimeout(() => { process.stdout.write(parts[0] + " " + parts.slice(1).join("/") + "\\n"); process.exit(0); }, listMs);
} else if (args.includes("-p") || args.includes("--print")) {
  const log = process.env.FAKE_PI_LOG;
  const model = at("--model");
  const message = args[args.length - 1];
  fs.appendFileSync(log + ".oneshots", JSON.stringify({
    model, message, argv: args.join(" "), cwd: process.cwd(), pid: process.pid,
    noTools: args.includes("--no-tools"), noSkills: args.includes("--no-skills"), noExtensions: args.includes("--no-extensions"),
    noContext: args.includes("--no-context-files"), noSession: args.includes("--no-session"), mode: at("--mode"),
  }) + "\\n");
  const done = () => {
    if (process.env.FAKE_PI_ONESHOT_FAIL === "1") process.exit(1);
    const title = process.env.FAKE_PI_TITLE || "自動タイトル";
    const usage = { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: Number(process.env.FAKE_PI_TITLE_COST || "0.01") } };
    process.stdout.write(JSON.stringify({ type: "session", version: 3, id: "oneshot", timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: title }], usage } }) + "\\n");
    process.exit(0);
  };
  const ms = Number(process.env.FAKE_PI_ONESHOT_MS || "0");
  if (ms > 0) setTimeout(done, ms); else done();
} else {
  if (process.env.FAKE_PI_FAIL_START === "1") process.exit(1);
  const log = process.env.FAKE_PI_LOG;
  const sessionId = at("--session-id");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.cwd();
  const safe = "--" + cwd.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
  const sessionDirArg = at("--session-dir");
  const dir = sessionDirArg || path.join(agentDir, "sessions", safe);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, "2026-03-01T00-00-00-000Z_" + sessionId + ".jsonl");
  if (!fs.existsSync(file) && fs.existsSync(dir)) { const found = fs.readdirSync(dir).find((n) => n.endsWith("_" + sessionId + ".jsonl")); if (found) file = path.join(dir, found); }
  const writeHeader = () => { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\\n"); };
  // real pi writes the session file only once a run commits; a stand-in for that holds the header until then
  if (process.env.FAKE_PI_RECORD_AT_PROMPT !== "1") writeHeader();
  const entries = [];
  let recordedModel;
  let sessionName = process.env.FAKE_PI_SESSION_NAME || undefined;
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split("\\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "message") entries.push(e);
    else if (e.type !== "session" && e.id) entries.push(e);
    if (e.type === "model_change") recordedModel = e.provider + "/" + e.modelId;
    if (e.type === "session_info" && e.name) sessionName = e.name;
  }
  fs.appendFileSync(log + ".starts", JSON.stringify({
    session: sessionId, model: at("--model"), thinking: at("--thinking"), tools: at("--tools"), cwd, agentDir,
    argv: args.join(" "), pid: process.pid, lane: process.env.IDD_LANE_ID, port: process.env.PORT, linear: process.env.LINEAR_API_KEY,
    noContext: args.includes("--no-context-files"), approve: args.includes("--approve"), modeRpc: args.join(" ").includes("--mode rpc"), start: Date.now(),
    sessionDir: sessionDirArg, entryIds: entries.map((e) => e.id),
  }) + "\\n");
  process.on("exit", () => { try { fs.appendFileSync(log + ".exits", JSON.stringify({ session: sessionId, pid: process.pid, at: Date.now() }) + "\\n"); } catch {} });
  const rec = (o) => fs.appendFileSync(log, JSON.stringify({ ...o, at: Date.now() }) + "\\n");
  const outQueue = [];
  let flushing = false;
  const flush = () => {
    if (flushing) return;
    flushing = true;
    const step = () => {
      const item = outQueue.shift();
      if (item === undefined) { flushing = false; return; }
      if (process.env.FAKE_PI_SPLIT === "1" && item.length > 4) {
        const mid = Math.floor(item.length / 2);
        process.stdout.write(item.slice(0, mid));
        setTimeout(() => { process.stdout.write(item.slice(mid) + "\\n"); setTimeout(step, 1); }, 1);
      } else {
        process.stdout.write(item + "\\n");
        setTimeout(step, 1);
      }
    };
    step();
  };
  const out = (o) => { outQueue.push(JSON.stringify(o)); flush(); };
  const respond = (id, command, success, data, error) => out({ ...(id ? { id } : {}), type: "response", command, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
  let model = at("--model") || recordedModel;
  let effort = at("--thinking");
  const levelOrder = ["off","minimal","low","medium","high","xhigh","max"];
  const fakeLevels = () => {
    if (process.env.FAKE_PI_LEVELS) {
      try {
        const parsed = JSON.parse(process.env.FAKE_PI_LEVELS);
        if (Array.isArray(parsed) && parsed.length) return parsed;
        if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed[model])) return parsed[model];
          if (Array.isArray(parsed["*"])) return parsed["*"];
        }
      } catch (e) {}
    }
    return ["off","minimal","low","medium","high"];
  };
  const clampLevel = (want) => {
    const levels = fakeLevels();
    if (levels.indexOf(want) >= 0) return want;
    const i = levelOrder.indexOf(want);
    if (i < 0) return levels[levels.length - 1];
    for (let k = i; k >= 0; k -= 1) { if (levels.indexOf(levelOrder[k]) >= 0) return levelOrder[k]; }
    return levels[0];
  };
  const applyEffort = (want) => {
    if (typeof want !== "string" || !want) return;
    const clamped = clampLevel(want);
    if (clamped !== effort) { effort = clamped; out({ type: "thinking_level_changed", level: clamped }); }
  };
  let currentSession = sessionId;
  let streaming = false, timer = null, pendingAbort = null;
  let promptBusy = false, handledOnce = false;
  const stopReason = () => process.env.FAKE_PI_STOP || "stop";
  const emitRun = (message) => {
    const text = process.env.FAKE_PI_TEXT || "answered";
    if (process.env.FAKE_PI_COMPACTION === "1") out({ type: "compaction_start", reason: "threshold" });
    out({ type: "agent_start" });
    out({ type: "message_start", message: { role: "user", content: message } });
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: Number(process.env.FAKE_PI_COST || "0.25") } };
    const rest = () => {
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think ", contentIndex: 0 } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 1 } });
    if (process.env.FAKE_PI_TOOLCALL === "1") {
      const partial = (content) => ({ content });
      out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: partial([{ type: "text", text }, { type: "text", text }, { type: "toolCall", id: "call_1", name: "read" }]) } });
      out({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: partial([{ type: "text", text }, { type: "text", text }, { type: "toolCall", id: "call_1", name: "read" }]) } });
    }
    if (process.env.FAKE_PI_PROGRESS === "1") {
      out({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "ls" } });
      out({ type: "tool_execution_update", toolCallId: "call_2", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } });
    }
    if (process.env.FAKE_PI_TOOL === "1") {
      out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
      out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    }
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: stopReason() } });
    if (process.env.FAKE_PI_COMPACTION === "1") out({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 10, estimatedTokensAfter: 5, usage }, aborted: false, willRetry: false });
    out({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: stopReason() }, toolResults: [] });
    out({ type: "agent_end", messages: [], willRetry: Boolean(process.env.FAKE_PI_RETRY) });
    if (process.env.FAKE_PI_RETRY === "1") out({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5, errorMessage: "x" });
    if (process.env.FAKE_PI_EXTENSION === "1") out({ type: "extension_ui_request", id: "ext-1", method: "confirm", title: "allow?" });
    out({ type: "agent_settled" });
    rec({ cmd: "settled", message });
    };
    const hold = Number(process.env.FAKE_PI_STREAM_HOLD_MS || "0");
    if (hold > 0) setTimeout(rest, hold); else rest();
    const ts = new Date().toISOString();
    const uid = "u" + (entries.length + 1), aid = "a" + (entries.length + 2);
    writeHeader();
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: uid, parentId: null, timestamp: ts, message: { role: "user", content: message } }) + "\\n");
    fs.appendFileSync(file, JSON.stringify({ type: "message", id: aid, parentId: uid, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: stopReason() } }) + "\\n");
    entries.push({ type: "message", id: uid, parentId: null, message: { role: "user", content: message } });
    entries.push({ type: "message", id: aid, parentId: uid, message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason: stopReason() } });
    streaming = false;
    if (pendingAbort) { const abortId = pendingAbort; pendingAbort = null; respond(abortId, "abort", true); }
  };
  const onPrompt = (id, message, images) => {
    // the engine's type instruction arrives as an extension command: pi adds a hidden entry and answers handled
    if (typeof message === "string" && message.startsWith("/idd-context ")) {
      let payload = {};
      try { payload = JSON.parse(message.slice("/idd-context ".length)); } catch { payload = {}; }
      rec({ cmd: "type-prompt", type: payload.type, kind: payload.kind, message: payload.content, streaming, promptBusy });
      if (process.env.FAKE_PI_TYPE_FAIL === "1") { respond(id, "prompt", false, undefined, "type instruction refused"); return; }
      const ts = new Date().toISOString();
      const nid = "t" + (entries.length + 1);
      const pid = entries.length ? entries[entries.length - 1].id : null;
      const line = JSON.stringify({ type: "custom_message", customType: "idd.conversation-type", content: payload.content, display: false, details: { type: payload.type, kind: payload.kind }, id: nid, parentId: pid, timestamp: ts });
      writeHeader();
      fs.appendFileSync(file, line + "\\n");
      entries.push({ type: "custom_message", customType: "idd.conversation-type", content: payload.content, display: false, details: { type: payload.type, kind: payload.kind }, id: nid, parentId: pid, timestamp: ts });
      const typeMs = Number(process.env.FAKE_PI_TYPE_MS || "0");
      if (typeMs > 0) { promptBusy = true; setTimeout(() => { promptBusy = false; respond(id, "prompt", true, { disposition: "handled" }); }, typeMs); return; }
      respond(id, "prompt", true, { disposition: "handled" });
      return;
    }
    rec({ cmd: "prompt", message, model, effort, images, streaming, promptBusy });
    if (streaming || promptBusy) rec({ cmd: "prompt-overlap", message });
    let disposition = process.env.FAKE_PI_DISPOSITION || "started";
    if (process.env.FAKE_PI_HANDLED_ONCE === "1" && !handledOnce) { disposition = "handled"; handledOnce = true; }
    const respondPrompt = () => {
      if (process.env.FAKE_PI_SETTLE_WITH_RESPONSE === "1") {
        // pi's answer and the run's whole report in one chunk: the engine sees them in the same read
        const sr = stopReason();
        const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
        process.stdout.write([
          JSON.stringify({ id, type: "response", command: "prompt", success: true, data: { disposition } }),
          JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.env.FAKE_PI_TEXT || "answered" }], usage, stopReason: sr } }),
          JSON.stringify({ type: "agent_settled" }),
        ].join("\\n") + "\\n");
        streaming = false;
        return;
      }
      respond(id, "prompt", true, { disposition });
      if (disposition === "handled") return;
      streaming = true;
      if (process.env.FAKE_PI_EXIT_AFTER_PROMPT === "1") { setTimeout(() => process.exit(1), 30); return; }
      timer = setTimeout(() => { timer = null; emitRun(message); }, Number(process.env.FAKE_PI_MS || "40"));
    };
    const promptMs = Number(process.env.FAKE_PI_PROMPT_MS || "0");
    if (promptMs > 0) { promptBusy = true; setTimeout(() => { promptBusy = false; respondPrompt(); }, promptMs); return; }
    respondPrompt();
  };
  const finishAbort = (id) => {
    if (process.env.FAKE_PI_ABORT_NATURAL === "1") { pendingAbort = id; return; }
    if (timer) { clearTimeout(timer); timer = null; }
    if (streaming) {
      const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
      const abortedByTool = process.env.FAKE_PI_ABORT_ERROR === "1";
      out({ type: "message_end", message: { role: "assistant", content: [], usage, stopReason: abortedByTool ? "error" : "aborted", errorMessage: abortedByTool ? "This operation was aborted" : undefined } });
      out({ type: "agent_settled" });
      streaming = false;
    }
    respond(id, "abort", true);
  };
  const onAbort = (id) => {
    rec({ cmd: "abort" });
    const abortMs = Number(process.env.FAKE_PI_ABORT_MS || "0");
    if (abortMs > 0) { setTimeout(() => finishAbort(id), abortMs); return; }
    finishAbort(id);
  };
  const handle = (cmd) => {
    switch (cmd.type) {
      case "get_state":
        if (process.env.FAKE_PI_GET_STATE_ERROR === "1") { respond(cmd.id, "get_state", false, undefined, "no state"); break; }
        respond(cmd.id, "get_state", true, { model: model ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") } : undefined, thinkingLevel: effort, isStreaming: streaming, sessionId: currentSession, sessionFile: file, sessionName });
        break;
      case "get_entries":
        respond(cmd.id, "get_entries", true, { entries, leafId: entries.length ? entries[entries.length - 1].id : null });
        break;
      case "prompt": onPrompt(cmd.id, cmd.message, cmd.images); break;
      case "steer": rec({ cmd: "steer", message: cmd.message, images: cmd.images }); respond(cmd.id, "steer", true, { disposition: "queued" }); break;
      case "follow_up": rec({ cmd: "follow_up", message: cmd.message }); respond(cmd.id, "follow_up", true, { disposition: "queued" }); break;
      case "abort": onAbort(cmd.id); break;
      case "set_model": {
        const want = String(cmd.provider) + "/" + String(cmd.modelId);
        const deny = process.env.FAKE_PI_DENY_MODEL;
        rec({ cmd: "set_model", provider: cmd.provider, modelId: cmd.modelId });
        setTimeout(() => {
          // an extension starts a run before pi answers for the model, so the engine meets runStarted mid-switch
          if (process.env.FAKE_PI_RUN_ON_SET_MODEL === "1") out({ type: "agent_start" });
          if (deny && want === deny) { respond(cmd.id, "set_model", false, undefined, "Model not found: " + want); return; }
          model = want; applyEffort(effort); rec({ cmd: "set_model:done", model: want }); respond(cmd.id, "set_model", true, { provider: cmd.provider, id: cmd.modelId });
        }, Number(process.env.FAKE_PI_SET_MODEL_MS || "0"));
        break;
      }
      case "set_thinking_level":
        rec({ cmd: "set_thinking_level", level: cmd.level });
        applyEffort(cmd.level);
        rec({ cmd: "set_thinking_level:done", level: effort });
        respond(cmd.id, "set_thinking_level", true);
        break;
      case "get_available_thinking_levels":
        respond(cmd.id, "get_available_thinking_levels", true, { levels: fakeLevels() });
        break;
      case "get_available_models": {
        let models = [];
        if (process.env.FAKE_PI_MODELS) { try { const m = JSON.parse(process.env.FAKE_PI_MODELS); if (Array.isArray(m)) models = m.slice(); } catch (e) {} }
        if (model && !models.some((m) => m.provider + "/" + m.id === model)) { const parts = model.split("/"); models.push({ provider: parts[0], id: parts.slice(1).join("/"), name: parts.slice(1).join("/"), contextWindow: 200000, input: ["text"], reasoning: true }); }
        respond(cmd.id, "get_available_models", true, { models });
        break;
      }
      case "get_session_stats":
        rec({ cmd: "get_session_stats" });
        if (process.env.FAKE_PI_STATS_SILENT === "1") break;
        if (process.env.FAKE_PI_STATS_ERROR === "1") { respond(cmd.id, "get_session_stats", false, undefined, "no stats"); break; }
        if (process.env.FAKE_PI_STATS_NULL === "1") { respond(cmd.id, "get_session_stats", true, { sessionId: currentSession }); break; }
        if (process.env.FAKE_PI_STATS_PARTIAL === "1") { respond(cmd.id, "get_session_stats", true, { sessionId: currentSession, contextUsage: { tokens: null, contextWindow: 1000, percent: null } }); break; }
        respond(cmd.id, "get_session_stats", true, { sessionId: currentSession, contextUsage: { tokens: 100, contextWindow: 1000, percent: Number(process.env.FAKE_PI_STATS_PERCENT || "10") } });
        break;
      case "compact":
        rec({ cmd: "compact", instructions: cmd.customInstructions });
        respond(cmd.id, "compact", true, { tokensBefore: 100, estimatedTokensAfter: 50 });
        break;
      case "get_last_assistant_text":
        respond(cmd.id, "get_last_assistant_text", true, { text: "last answer" });
        break;
      case "get_commands":
        respond(cmd.id, "get_commands", true, { commands: [{ name: "compact" }] });
        break;
      case "get_fork_messages":
        respond(cmd.id, "get_fork_messages", true, { messages: [{ entryId: "u1", text: "hello" }] });
        break;
      case "set_session_name":
        rec({ cmd: "set_session_name", name: cmd.name });
        sessionName = cmd.name;
        { const nid = "n" + (entries.length + 1); const line = JSON.stringify({ type: "session_info", id: nid, parentId: entries.length ? entries[entries.length - 1].id : null, name: cmd.name }); fs.appendFileSync(file, line + "\\n"); entries.push({ type: "session_info", id: nid, parentId: entries.length ? entries[entries.length - 1].id : null, name: cmd.name }); }
        respond(cmd.id, "set_session_name", true, { name: cmd.name });
        break;
      case "fork":
        rec({ cmd: "fork", entryId: cmd.entryId });
        if (process.env.FAKE_PI_FORK_ID) currentSession = process.env.FAKE_PI_FORK_ID;
        respond(cmd.id, "fork", true, { text: "hello", cancelled: false, sessionId: currentSession });
        break;
      default:
        respond(cmd.id, cmd.type, true, {});
    }
  };
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      const i = buf.indexOf("\\n");
      if (i < 0) break;
      let line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let cmd; try { cmd = JSON.parse(line); } catch { continue; }
      if (cmd.type === "extension_ui_response") { rec({ cmd: "extension_ui_response", id: cmd.id, cancelled: cmd.cancelled }); continue; }
      handle(cmd);
    }
  });
  process.stdin.on("end", () => { if (process.env.FAKE_PI_IGNORE_STDIN_END === "1") return; const ms = Number(process.env.FAKE_PI_EXIT_DELAY_MS || "0"); if (ms > 0) setTimeout(() => process.exit(0), ms); else process.exit(0); });
  if (process.env.FAKE_PI_IGNORE_STDIN_END === "1") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
}
`;

export { FAKE_PI };
