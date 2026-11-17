import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { claudeQuotaPath, piSessionDir, readRoles } from "@idd/lane";
import { runChecks } from "../../idd-core/src/overlay/gate.ts";
import { holdPipes, IGNORE_SIGTERM_AND_STAY } from "../../idd-lane/test/helpers/oneshot-scripts.ts";

import {
  openConversations, openConversation, ephemeralSweepMs, sweepEphemeralBranches, droppedQueue, startEphemeralSweeper, stopEphemeralSweeper,
  CONVERSATION_EVENT_TYPES, CONVERSATION_PHASES, ConversationRefused, emptyConversationMachine, reduceConversation,
  type ConversationMachine, type ConversationMailEvent, type ConversationPhase,
} from "../src/server/conversations.ts";
import { ConversationLog, conversationCostOf, conversationCostPath } from "../src/server/conversation-events.ts";
import { conversationSettingsPath } from "../src/server/conversation-settings.ts";
import { ephemeralDir, ephemeralRecordPath, ephemeralRetentionMs, ephemeralSessionFile, readEphemeralRecord } from "../src/server/ephemeral.ts";
import { setOneShotLimits } from "../src/server/conversation-title.ts";
import { createFetchHandler } from "../src/server.ts";
import { readLedger } from "../../idd-core/src/instruction/ledger.ts";
import { createRegistrationOptions, finishRegistration } from "../../idd-core/src/passkey.ts";
import { softwareAuthenticator } from "../../idd-core/test/passkey-fixture.mjs";
import { matchRoute, routes } from "../src/routes.ts";

/**
 * A stand-in for `pi --mode rpc`: it records every command it receives, answers `get_state` / `get_entries`,
 * streams the events of a run, writes pi's session record where pi keeps it, and answers `--list-models`
 * (the role's agent dir is prepared through it). Its shape follows pi 1.0.0's RPC docs.
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
    if (process.env.FAKE_PI_ONESHOT_HANG === "1") { ${IGNORE_SIGTERM_AND_STAY} return; }
    // a grandchild keeps the pipes open for a while after this process has answered and exited
    if (process.env.FAKE_PI_ONESHOT_GRANDCHILD === "1") ${holdPipes()}
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
    argv: args.join(" "), argvList: args, pid: process.pid, iddId: process.env.IDD_ID, runLane: process.env.IDD_RUN_LANE, iddSession: process.env.IDD_SESSION_ID, iddSessionToken: process.env.IDD_SESSION_TOKEN, lane: process.env.IDD_LANE_ID, port: process.env.PORT, linear: process.env.LINEAR_API_KEY,
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

const ENV_KEYS = [
  "IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_MODES_FILE", "IDD_REPOS_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR",
  "IDD_CONVERSATION_IDLE_MS", "IDD_EPHEMERAL_RETENTION_MS", "IDD_EPHEMERAL_SWEEP_MS", "IDD_PROMOTE_EXIT_TIMEOUT_MS", "IDD_CLOSE_EXIT_TIMEOUT_MS", "FAKE_PI_LOG", "FAKE_PI_MS", "FAKE_PI_COST", "FAKE_PI_TEXT", "FAKE_PI_TOOL", "FAKE_PI_RETRY",
  "FAKE_PI_EXTENSION", "FAKE_PI_DISPOSITION", "FAKE_PI_ABORT_NATURAL", "FAKE_PI_EXIT_AFTER_PROMPT", "FAKE_PI_SET_MODEL_MS",
  "FAKE_PI_DENY_MODEL", "FAKE_PI_SPLIT", "FAKE_PI_LIST_MODELS_MS", "FAKE_PI_STOP", "FAKE_PI_ABORT_ERROR", "FAKE_PI_ABORT_MS",
  "FAKE_PI_PROMPT_MS", "FAKE_PI_HANDLED_ONCE", "FAKE_PI_EXIT_DELAY_MS", "FAKE_PI_FAIL_START", "FAKE_PI_RECORD_AT_PROMPT",
  "FAKE_PI_IGNORE_STDIN_END", "FAKE_PI_TOOLCALL", "FAKE_PI_PROGRESS", "FAKE_PI_COMPACTION", "FAKE_PI_FORK_ID", "FAKE_PI_STREAM_HOLD_MS",
  "FAKE_PI_TITLE", "FAKE_PI_TITLE_COST", "FAKE_PI_ONESHOT_FAIL", "FAKE_PI_ONESHOT_MS", "FAKE_PI_ONESHOT_HANG", "FAKE_PI_ONESHOT_GRANDCHILD", "FAKE_PI_SESSION_NAME",
  "FAKE_PI_STATS_ERROR", "FAKE_PI_STATS_SILENT", "FAKE_PI_STATS_NULL", "FAKE_PI_STATS_PARTIAL", "FAKE_PI_GET_STATE_ERROR",
  "FAKE_PI_SETTLE_WITH_RESPONSE", "FAKE_PI_RUN_ON_SET_MODEL", "FAKE_PI_TYPE_FAIL", "FAKE_PI_TYPE_MS",
  "FAKE_PI_MODELS", "FAKE_PI_LEVELS", "FAKE_PI_STATS_PERCENT", "IDD_INSTRUCTIONS_DIR", "IDD_AGENT_TOKEN", "IDD_ID", "IDD_RUN_LANE",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];

afterEach(async () => {
  setOneShotLimits(null);
  for (const conv of openConversations()) await conv.close();
  await new Promise((r) => setTimeout(r, 50));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string; state: string; cwd: string; ideaCwd: string; userAgent: string; fake: string; log: string;
  handler: (req: Request) => Promise<Response>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "idd-conv-"));
  roots.push(root);
  const state = join(root, "state");
  const cwd = join(root, "chat");
  const ideaCwd = join(root, "ideas");
  const userAgent = join(root, "user-agent");
  for (const d of [state, cwd, ideaCwd, userAgent]) mkdirSync(d, { recursive: true });
  const fake = join(root, "pi");
  writeFileSync(fake, FAKE_PI);
  chmodSync(fake, 0o755);
  writeFileSync(join(root, "roles.yaml"), [
    "defaults:",
    "  title_context_turns: 3",
    "models:",
    "  openrouter-z-ai-glm-5.3:",
    "    model: openrouter/z-ai/glm-5.3",
    "  openrouter-z-ai-glm-5.3-flash:",
    "    model: openrouter/z-ai/glm-5.3-flash",
    "roles:",
    "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash] }",
    "  ideas: { model: openrouter-z-ai-glm-5.3, thinking: low, tools: [read] }",
    "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
  ].join("\n") + "\n");
  writeFileSync(join(root, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${cwd} }\n  idea: { role: ideas, workspace: ${ideaCwd} }\n`);
  writeFileSync(join(root, "repos.yaml"), "repos: {}\n");
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    IDD_STATE_DIR: state, IDD_ROLES_FILE: join(root, "roles.yaml"), IDD_MODES_FILE: join(root, "modes.yaml"), IDD_REPOS_FILE: join(root, "repos.yaml"),
    IDD_PI_BIN: fake, IDD_PI_USER_AGENT_DIR: userAgent, FAKE_PI_LOG: join(root, "pi.log"),
  });
  return { root, state, cwd, ideaCwd, userAgent, fake, log: join(root, "pi.log"), handler: createFetchHandler() };
}

function api(fx: Fixture, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", host: "127.0.0.1:30144", ...(headers ?? {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fx.handler(new Request(`http://127.0.0.1:30144${path}`, init));
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json() as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

interface Command { cmd: string; [k: string]: unknown }
const commands = (fx: Fixture): Command[] => existsSync(fx.log) ? readFileSync(fx.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Command) : [];
/**
 * A start's argv as one string, without the appendix every conversation carries about the user's instructions (the
 * text that tells how to put a proposal down). The tests that read the other appendices ask whether those are absent
 * or present, and that one is always there.
 */
const argvWithoutInstructions = (start: Record<string, unknown> | undefined): string => {
  const list = [...((start?.argvList ?? []) as string[])];
  const at = list.findIndex((value, k) => list[k - 1] === "--append-system-prompt" && value.includes("instruction propose"));
  if (at > 0) list.splice(at - 1, 2);
  return list.join(" ");
};
const starts = (fx: Fixture): Record<string, unknown>[] => existsSync(`${fx.log}.starts`) ? readFileSync(`${fx.log}.starts`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const exits = (fx: Fixture): Record<string, unknown>[] => existsSync(`${fx.log}.exits`) ? readFileSync(`${fx.log}.exits`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const oneshots = (fx: Fixture): Record<string, unknown>[] => existsSync(`${fx.log}.oneshots`) ? readFileSync(`${fx.log}.oneshots`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const count = (fx: Fixture, cmd: string): number => commands(fx).filter((c) => c.cmd === cmd).length;

function agentDir(fx: Fixture, role: string): string {
  return join(fx.state, "pipeline", "agent", role);
}

function sessionDirOf(fx: Fixture, role: string, cwd: string): string {
  return piSessionDir(cwd, agentDir(fx, role));
}

function sessionFileOf(fx: Fixture, id: string): string | undefined {
  const dir = sessionDirOf(fx, "chat", fx.cwd);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.endsWith(`_${id}.jsonl`));
  return name ? join(dir, name) : undefined;
}

function placeSession(dir: string, id: string, cwd: string, entries: unknown[] = []): string {
  return placeSessionAt(dir, id, cwd, "2026-02-01T00:00:00.000Z", undefined, entries);
}

/** a pi record with a chosen header timestamp and mtime, for the sorting and date grouping checks */
function placeSessionAt(dir: string, id: string, cwd: string, timestamp: string, mtime?: Date, entries: unknown[] = []): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-02-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })];
  for (const e of entries) lines.push(JSON.stringify(e));
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

function placeSpaceFile(fx: Fixture, id: string, front: string, body = ""): string {
  const dir = join(fx.cwd, "spaces", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "space.md");
  writeFileSync(file, `---\n${front}${front ? "\n" : ""}---\n${body ? `${body}\n` : ""}`);
  return file;
}

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  constructor(res: Response) {
    this.reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }
  private readNext(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!this.pending) {
      const p = this.reader.read();
      this.pending = p;
      void p.finally(() => { if (this.pending === p) this.pending = null; });
    }
    return this.pending;
  }
  private async readFrame(timeoutMs: number): Promise<{ id: string | null; data: Record<string, unknown> | null }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.buf.indexOf("\n\n");
      if (at >= 0) {
        const chunk = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + 2);
        let id: string | null = null;
        let data: Record<string, unknown> | null = null;
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        return { id, data };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out reading SSE");
      const result = await Promise.race([
        this.readNext(),
        new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), remaining); t.unref?.(); }),
      ]);
      if (result === null) throw new Error("timed out reading SSE");
      if (result.done) throw new Error("SSE closed");
      this.buf += this.decoder.decode(result.value, { stream: true });
    }
  }
  /** one raw frame, including an `id:`-only frame that carries no data */
  async nextFrame(timeoutMs = 5000): Promise<{ id: string | null; data: Record<string, unknown> | null }> {
    return await this.readFrame(timeoutMs);
  }
  async next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.readFrame(Math.max(1, deadline - Date.now()));
      if (frame.data) return frame.data;
    }
  }
  async tryNext(timeoutMs = 300): Promise<Record<string, unknown> | null> {
    try { return await this.next(timeoutMs); } catch { return null; }
  }
  async close(): Promise<void> {
    try { await this.reader.cancel(); } catch { /* already closed */ }
  }
}

async function readUntil(reader: SseReader, predicate: (e: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await reader.next(deadline - Date.now());
    out.push(event);
    if (predicate(event)) return out;
  }
  throw new Error("timed out waiting for event");
}

describe("creating a conversation", () => {
  test("wakes pi in rpc mode and answers with an id, mode, cwd, model and effort", async () => {
    const fx = fixture();
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat" });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; mode: string; cwd: string; model: string; effort: string }>(res);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.mode).toBe("chat");
    expect(body.cwd).toBe(fx.cwd);
    expect(body.model).toBe("openrouter/z-ai/glm-5.3");
    expect(body.effort).toBe("high");
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].modeRpc).toBe(true);
    expect(starts(fx)[0].session).toBe(body.id);
  });

  test("refuses an unknown mode without waking pi", async () => {
    const fx = fixture();
    const res = await api(fx, "POST", "/api/conversations", { mode: "nope" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(starts(fx)).toEqual([]);
  });
});

describe("listing conversations", () => {
  test("reads pi's own records for the mode's cwd and never starts pi", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "sess-a", fx.cwd, [{ type: "session_info", id: "n1", parentId: null, name: "first" }]);
    placeSession(dir, "sess-b", fx.cwd, []);
    placeSession(dir, "sess-wrong", join(fx.root, "elsewhere"), []);
    const other = sessionDirOf(fx, "ideas", fx.ideaCwd);
    placeSession(other, "sess-idea", fx.ideaCwd, []);
    const res = await api(fx, "GET", "/api/conversations");
    expect(res.status).toBe(200);
    const body = await json<{ conversations: { id: string; mode: string; name?: string; createdAt: string; updatedAt: string; cost: number }[] }>(res);
    const ids = body.conversations.map((c) => c.id).sort();
    expect(ids).toEqual(["sess-a", "sess-b", "sess-idea"]);
    const a = body.conversations.find((c) => c.id === "sess-a") as { id: string; mode: string; name?: string };
    expect(a.mode).toBe("chat");
    expect(a.name).toBe("first");
    expect(starts(fx)).toEqual([]);
  });

  test("carries a conversation made but not yet sent to, while the engine is up", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const body = await json<{ conversations: { id: string; open: boolean }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(body.conversations.find((c) => c.id === created.id)?.open).toBe(true);
  });
});

describe("opening a conversation", () => {
  test("returns pi's entries with their parent ids, the live state, and one pi for repeated opens", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "open-1", fx.cwd, [
      { type: "model_change", id: "m1", parentId: null, provider: "openrouter", modelId: "z-ai/glm-5.3" },
      { type: "message", id: "u1", parentId: "m1", message: { role: "user", content: "hi" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "yo" }], stopReason: "stop" } },
    ]);
    const first = await json<{ ok: boolean; entries: { id: string; parentId: string }[]; leafId: string; model: string; streaming: boolean; queue: unknown[] }>(await api(fx, "GET", "/api/conversations/open-1"));
    expect(first.entries.length).toBeGreaterThanOrEqual(2);
    expect(first.entries[0].id).toBeTruthy();
    expect(first.entries[0].parentId).toBeDefined();
    expect(first.leafId).toBe("a1");
    expect(first.model).toBe("openrouter/z-ai/glm-5.3");
    expect(first.streaming).toBe(false);
    expect(first.queue).toEqual([]);
    await api(fx, "GET", "/api/conversations/open-1");
    expect(starts(fx).length).toBe(1);
  });

  test("answers 404 for a session that is not a mode's", async () => {
    const fx = fixture();
    const res = await api(fx, "GET", "/api/conversations/nobody");
    expect(res.status).toBe(404);
    expect(starts(fx)).toEqual([]);
  });
});

describe("the event stream", () => {
  test("tells text, thinking, tool call, tool result, cost and end apart, and ends once at agent_settled", async () => {
    const fx = fixture();
    process.env.FAKE_PI_TOOL = "1";
    process.env.FAKE_PI_RETRY = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const events = await readUntil(reader, (e) => e.type === "end");
    const kinds = new Set(events.map((e) => e.type));
    for (const kind of ["text", "thinking", "tool_call", "tool_result", "cost", "end"]) expect(kinds.has(kind), kind).toBe(true);
    const toolResult = events.find((e) => e.type === "tool_result") as { toolCallId: string; isError: boolean };
    expect(toolResult.toolCallId).toBe("call_1");
    expect(toolResult.isError).toBe(false);
    const extra: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i += 1) { const e = await reader.tryNext(200); if (e) extra.push(e); }
    expect([...events, ...extra].filter((e) => e.type === "end").length).toBe(1);
    await reader.close();
  });
});

describe("the numbered frames", () => {
  test("writes every event's number as the frame id, the same value the query carries", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    // the head of the connection hands the client the number it now holds, with no event
    const head = await reader.nextFrame();
    expect(head.data).toBeNull();
    expect(head.id).not.toBeNull();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const frames: { id: string | null; data: Record<string, unknown> | null }[] = [];
    for (;;) {
      const frame = await reader.nextFrame();
      if (frame.data) frames.push(frame);
      if (frame.data?.type === "end") break;
    }
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) expect(frame.id).toBe(String(frame.data?.seq));
    const last = frames[frames.length - 1];
    await reader.close();

    const stale = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events?lastEventId=1`));
    const reset = await stale.nextFrame();
    expect(reset.data?.type).toBe("reset");
    expect(reset.data?.seq).toBeUndefined();
    // the reset frame carries the number the log holds at that moment, so a browser does not loop on a stale id
    expect(reset.id).toBe(last.id);
    const afterReset = await stale.nextFrame();
    expect(afterReset.data).toBeNull();
    await stale.close();
  });

  test("resumes from the Last-Event-ID header, which wins over the query", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const seen: Record<string, unknown>[] = [];
    while (seen.length < 3) seen.push(await first.next());
    const third = seen[2].seq as number;
    await first.close();
    const second = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events?lastEventId=1`, undefined, { "last-event-id": String(third) }));
    const next = await second.next();
    expect(next.seq).toBe(third + 1);
    await second.close();
  });

  test("hands the current number at the head, so a break before the first event leaves no gap", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const head = await first.nextFrame();
    expect(head.data).toBeNull();
    const carried = Number(head.id);
    expect(carried).toBeGreaterThan(0);
    await first.close();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const second = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`, undefined, { "last-event-id": String(carried) }));
    const resumed = await second.next();
    expect(resumed.seq).toBe(carried + 1);
    await second.close();
  });

  test("sends the id-only frame after the replayed events, not before", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const head = await first.nextFrame();
    const carried = Number(head.id);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await readUntil(first, (e) => e.type === "end");
    await first.close();
    const second = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`, undefined, { "last-event-id": String(carried) }));
    const frames: { id: string | null; data: Record<string, unknown> | null }[] = [];
    for (let i = 0; i < 50; i += 1) {
      const frame = await second.nextFrame();
      frames.push(frame);
      if (frame.data === null) break;
    }
    const dataFrames = frames.filter((frame) => frame.data);
    expect(dataFrames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1].data).toBeNull();
    for (const frame of dataFrames) expect(frame.id).toBe(String(frame.data?.seq));
    await second.close();
  });

  test("continues live without a reset when an id from a log that emitted nothing is carried back", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const head = await first.nextFrame();
    const carried = head.id as string;
    await first.close();
    const again = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`, undefined, { "last-event-id": carried }));
    const frame = await again.nextFrame();
    expect(frame.data).toBeNull();
    expect(frame.id).toBe(carried);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const live = await again.next();
    expect(live.seq).toBe(Number(carried) + 1);
    await again.close();
  });

  test("gives a reopened log numbers beyond the old ones, and reopens an old id even with an empty buffer", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const before = await readUntil(first, (e) => e.type === "end");
    const firstSeq = before[0].seq as number;
    const lastSeq = before[before.length - 1].seq as number;
    await first.close();
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    // reopen: a fresh log with an empty buffer, whose numbers must all be beyond the old log's
    await api(fx, "GET", `/api/conversations/${created.id}`);
    const stale = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events?lastEventId=${firstSeq}`));
    const reset = await stale.nextFrame();
    expect(reset.data?.type).toBe("reset");
    await stale.close();

    const second = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    const again = await readUntil(second, (e) => e.type === "end");
    for (const event of again) expect(event.seq as number).toBeGreaterThan(lastSeq);
    await second.close();
  });

  test("never numbers a new log inside an earlier log's numbers", () => {
    const a = new ConversationLog(1000);
    a.emit("text", { delta: "x" });
    a.emit("text", { delta: "y" });
    const b = new ConversationLog(1000);
    const first = b.emit("text", { delta: "z" });
    expect(first.seq).toBeGreaterThan(a.lastSeq);
  });
});

describe("closing and deleting", () => {
  test("close ends pi but keeps the record; delete removes the record and the spawn record", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => sessionFileOf(fx, created.id) !== undefined);
    const file = sessionFileOf(fx, created.id) as string;
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    expect(existsSync(file)).toBe(true);
    await api(fx, "GET", `/api/conversations/${created.id}`);
    expect(starts(fx).length).toBe(2);
    expect(existsSync(join(fx.state, "pipeline", "sessions", `${created.id}.json`))).toBe(true);
    await api(fx, "DELETE", `/api/conversations/${created.id}`);
    await until(() => !existsSync(file));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(fx.state, "pipeline", "sessions", `${created.id}.json`))).toBe(false);
    const list = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.some((c) => c.id === created.id)).toBe(false);
  });
});

describe("closing while the same id is opened again", () => {
  test("waits for the first pi to stop before starting pi again for the same id", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    process.env.FAKE_PI_EXIT_DELAY_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    const closing = api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => openConversations().some((c) => c.sessionId === created.id && c.isClosed));
    // open the same id while the close is still waiting for the old pi to go
    const reopened = await api(fx, "GET", `/api/conversations/${created.id}`);
    expect(reopened.status).toBe(200);
    await closing;
    expect(openConversations().some((c) => c.sessionId === created.id && !c.isClosed)).toBe(true);
    expect(starts(fx).length).toBe(2);
    // one session, one engine pi: the second pi starts only after the first one is gone
    const gone = exits(fx);
    expect(gone.length).toBeGreaterThanOrEqual(1);
    expect(starts(fx)[1].start as number).toBeGreaterThanOrEqual(gone[0].at as number);
  });

  test("waits for a slowly exiting pi before starting the next one", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    // the stand-in lingers after stdin ends, so a close that does not wait would let the next pi start too early
    process.env.FAKE_PI_EXIT_DELAY_MS = "700";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    const closing = api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => openConversations().some((c) => c.sessionId === created.id && c.isClosed));
    const reopened = await api(fx, "GET", `/api/conversations/${created.id}`);
    expect(reopened.status).toBe(200);
    await closing;
    expect(starts(fx).length).toBe(2);
    const gone = exits(fx);
    expect(gone.length).toBeGreaterThanOrEqual(1);
    expect(starts(fx)[1].start as number).toBeGreaterThanOrEqual(gone[0].at as number);
  });
});

describe("deleting while the same id is opened again", () => {
  test("leaves no conversation open and does not remove a record a reopened pi would use", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    process.env.FAKE_PI_EXIT_DELAY_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => sessionFileOf(fx, created.id) !== undefined);
    const file = sessionFileOf(fx, created.id) as string;
    const removing = api(fx, "DELETE", `/api/conversations/${created.id}`);
    await until(() => openConversations().some((c) => c.sessionId === created.id && c.isClosed));
    // open the same id while the delete is still waiting for the old pi to go
    const reopened = await api(fx, "GET", `/api/conversations/${created.id}`);
    await removing;
    expect(reopened.status).toBe(404);
    expect(openConversations().some((c) => c.sessionId === created.id)).toBe(false);
    expect(starts(fx).length).toBe(1);
    expect(existsSync(file)).toBe(false);
    const list = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.some((c) => c.id === created.id)).toBe(false);
  });
});

describe("the engine's queue", () => {
  test("sends one at a time, never uses follow_up, and only after agent_settled", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "300";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "three" });
    await sleep(100);
    expect(count(fx, "prompt")).toBe(1);
    await until(() => count(fx, "prompt") === 2, 5000);
    await until(() => count(fx, "prompt") === 3, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two", "three"]);
    expect(count(fx, "follow_up")).toBe(0);
  });
});

describe("editing and cancelling queued items", () => {
  test("edits a queued item before it is sent and cancels another", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    const two = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" }));
    const three = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "three" }));
    await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${two.item.id}`, { text: "two-edited" });
    await api(fx, "DELETE", `/api/conversations/${created.id}/queue/${three.item.id}`);
    await until(() => count(fx, "prompt") === 2, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two-edited"]);
    // the fake pi's own record is written before the engine takes the item out of the queue, and an edit of an item
    // being sent is refused with 409: wait for the state the test is about (the item gone), not another process's log
    await untilAsync(async () => {
      const state = await json<{ queue: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
      return !state.queue.some((q) => q.id === two.item.id);
    });
    const refused = await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${two.item.id}`, { text: "nope" });
    expect(refused.status).toBe(404);
  });
});

describe("cancelling an item while it is being sent", () => {
  test("refuses the cancel and sends that item, not the one behind it", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "500";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const one = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4" }));
    await until(() => count(fx, "set_model") === 1);
    const two = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" }));
    const refused = await api(fx, "DELETE", `/api/conversations/${created.id}/queue/${one.item.id}`);
    expect(refused.status).toBe(409);
    await until(() => count(fx, "prompt") === 1, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one"]);
    const state = await json<{ queue: { id: string; text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.map((q) => q.id)).toContain(two.item.id);
    await until(() => count(fx, "prompt") === 2, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two"]);
  });
});

describe("editing an item while it is being sent", () => {
  test("refuses the edit with 409 and keeps the original text", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "500";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const one = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4" }));
    await until(() => count(fx, "set_model") === 1);
    const refused = await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${one.item.id}`, { text: "changed" });
    expect(refused.status).toBe(409);
    await until(() => count(fx, "prompt") === 1, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one"]);
  });
});

describe("steering", () => {
  test("delivers a steer sent during an item's model switch to pi's steer, before the next item", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "500";
    process.env.FAKE_PI_MS = "200";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4" });
    await until(() => count(fx, "set_model") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    await until(() => count(fx, "steer") === 1, 5000);
    await until(() => count(fx, "prompt") === 2, 5000);
    expect(count(fx, "prompt-overlap")).toBe(0);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two"]);
    expect(commands(fx).filter((c) => c.cmd === "steer").map((c) => c.message)).toEqual(["interrupt"]);
    const settled = commands(fx).find((c) => c.cmd === "settled" && c.message === "one") as { at: number };
    const two = commands(fx).find((c) => c.cmd === "prompt" && c.message === "two") as { at: number };
    expect(settled).toBeDefined();
    expect(two.at).toBeGreaterThanOrEqual(settled.at);
  });

  test("prompts an interrupt that lands while an item is being handled, after the queue it met", async () => {
    const fx = fixture();
    process.env.FAKE_PI_HANDLED_ONCE = "1";
    process.env.FAKE_PI_PROMPT_MS = "300";
    process.env.FAKE_PI_MS = "100";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    await until(() => count(fx, "prompt") === 3, 5000);
    expect(count(fx, "prompt-overlap")).toBe(0);
    // the interrupt was held while the prompt was in flight, so it lands behind the item that was already queued
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two", "interrupt"]);
  });

  test("queues an interrupt sent during a refused item's model switch", async () => {
    const fx = fixture();
    process.env.FAKE_PI_DENY_MODEL = "openrouter/nope/thing";
    process.env.FAKE_PI_SET_MODEL_MS = "400";
    process.env.FAKE_PI_MS = "100";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/nope/thing" });
    await until(() => count(fx, "set_model") === 1);
    const steered = await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    expect(steered.status).toBe(200);
    await readUntil(events, (e) => e.type === "error", 5000);
    // the refused item goes back to the head and the held interrupt joins the tail; nothing is prompted
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual([]);
    const state = await json<{ queue: { text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.map((q) => q.text)).toEqual(["one", "interrupt"]);
    await events.close();
  });

  test("sends a second interrupt to pi's steer when it lands during the first interrupt's prompt", async () => {
    const fx = fixture();
    process.env.FAKE_PI_PROMPT_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const first = api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "a" });
    await until(() => count(fx, "prompt") === 1);
    const second = api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "b" });
    await until(() => count(fx, "steer") === 1, 5000);
    await first;
    await second;
    expect(count(fx, "prompt-overlap")).toBe(0);
    expect(commands(fx).filter((c) => c.cmd === "steer").map((c) => c.message)).toEqual(["b"]);
  });

  test("queues an interrupt sent while pi is starting, and answers it even when pi cannot start", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    process.kill(starts(fx)[0].pid as number, "SIGKILL");
    await sleep(150);
    process.env.FAKE_PI_LIST_MODELS_MS = "600";
    process.env.FAKE_PI_FAIL_START = "1";
    const sending = api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await sleep(50);
    const steered = api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    const [, steerRes] = await Promise.all([sending, steered]);
    // the interrupt was accepted as a queued send even though the pi it was waiting for never started
    expect(steerRes.status).toBe(200);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one"]);
    await sleep(700);
    // the pi that failed to start left both items in the queue and nothing was prompted (INV-1528)
    const held = openConversations().find((c) => c.sessionId === created.id);
    expect(held).toBeDefined();
    expect(held?.queueItems.map((q) => q.text)).toEqual(["two", "interrupt"]);
  });

  test("goes to pi's steer while a run is going, and turns a queued item into a steer", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "500";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    await until(() => count(fx, "steer") === 1);
    const item = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "queued" }));
    await api(fx, "POST", `/api/conversations/${created.id}/queue/${item.item.id}/steer`);
    await until(() => count(fx, "steer") === 2, 5000);
    expect(commands(fx).filter((c) => c.cmd === "steer").map((c) => c.message)).toEqual(["interrupt", "queued"]);
    expect(count(fx, "follow_up")).toBe(0);
    const state = await json<{ queue: unknown[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue).toEqual([]);
  });
});

describe("stopping", () => {
  test("aborts the run, ends as stopped, and leaves the queue for the next send", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    // the deadline waits for the stopped run's end on a loaded machine, where the abort takes longer than 5 s
    const all = await readUntil(events, (e) => e.type === "end", 20_000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("stopped");
    expect(count(fx, "abort")).toBe(1);
    await sleep(300);
    expect(count(fx, "prompt")).toBe(1);
    const state = await json<{ queue: { text: string }[]; streaming: boolean }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.streaming).toBe(false);
    expect(state.queue.map((q) => q.text)).toEqual(["two"]);
    // opening the conversation again without sending starts nothing
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await sleep(200);
    expect(count(fx, "prompt")).toBe(1);
    // the next send runs the leftover item first, then the new one
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "three" });
    await until(() => count(fx, "prompt") === 3, 20_000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two", "three"]);
    await events.close();
  });

  test("ends as stopped even when the run had already finished before abort", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "200";
    process.env.FAKE_PI_ABORT_NATURAL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("stopped");
    await sleep(300);
    expect(count(fx, "prompt")).toBe(1);
    await events.close();
  });

  test("F-2: an interrupt sent after a stop is answered and waits in the queue", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "400";
    process.env.FAKE_PI_ABORT_NATURAL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "queued" });
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "stopping", 5000);
    // the request must not be left unanswered while the stopped run finishes
    const steered = await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    expect(steered.status).toBe(200);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "idle", 5000);
    const state = await json<{ queue: { text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.map((q) => q.text)).toEqual(["queued", "interrupt"]);
    // the stopped run was never steered, and the queue did not move by itself
    expect(count(fx, "steer")).toBe(0);
    expect(count(fx, "prompt")).toBe(1);
  });

  test("treats an abort during a tool call as a stop, the way real pi reports it", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    process.env.FAKE_PI_ABORT_ERROR = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("stopped");
    await sleep(300);
    expect(count(fx, "prompt")).toBe(1);
    const state = await json<{ queue: { text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.map((q) => q.text)).toEqual(["two"]);
    await events.close();
  });

  test("ends as stopped when a stop request meets a run pi ended at its own cap", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "200";
    process.env.FAKE_PI_ABORT_NATURAL = "1";
    process.env.FAKE_PI_STOP = "length";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("stopped");
    await sleep(300);
    expect(count(fx, "prompt")).toBe(1);
    await events.close();
  });

  test("reports an error without a stop request as failed", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "100";
    process.env.FAKE_PI_STOP = "error";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("failed");
    expect(count(fx, "abort")).toBe(0);
    await events.close();
  });
});

describe("model and effort", () => {
  test("applies a message's model and effort before the prompt, in that order", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4", effort: "max" });
    await until(() => count(fx, "prompt") === 1);
    const order = commands(fx).filter((c) => ["set_model", "set_thinking_level", "prompt"].includes(c.cmd)).map((c) => c.cmd);
    expect(order).toEqual(["set_model", "set_thinking_level", "prompt"]);
  });

  test("waits for set_model's response before asking for the effort", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "150";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4", effort: "max" });
    await until(() => count(fx, "prompt") === 1);
    const done = commands(fx).find((c) => c.cmd === "set_model:done") as Command;
    const effort = commands(fx).find((c) => c.cmd === "set_thinking_level") as Command;
    expect(effort.at as number).toBeGreaterThanOrEqual(done.at as number);
  });

  test("sends an unspecified message on the session's current values", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => count(fx, "prompt") === 2);
    expect(count(fx, "set_model")).toBe(1);
  });

  test("defers a model change made during a run until the next prompt", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.4" });
    await sleep(100);
    expect(count(fx, "set_model")).toBe(0);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => count(fx, "set_model") === 1, 5000);
  });

  test("keeps a model change made while the in-flight item applies its own for the next prompt", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "400";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4" });
    await until(() => count(fx, "set_model") === 1);
    // the change lands while drain is still waiting for the first item's set_model to answer
    const changed = await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.5" });
    expect(changed.status).toBe(200);
    await until(() => count(fx, "prompt") === 1, 5000);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => count(fx, "prompt") === 2, 5000);
    const models = commands(fx).filter((c) => c.cmd === "set_model").map((c) => `${c.provider}/${c.modelId}`);
    expect(models).toEqual(["openrouter/z-ai/glm-5.4", "openrouter/z-ai/glm-5.5"]);
  });

  test("F-1: an Idle model switch answers, and a send before its answer waits for it", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "300";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "warm" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "idle", 5000);
    // change the model, then send while set_model is still unanswered: the answer must not be stranded
    const changed = api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.4" });
    await until(() => count(fx, "set_model") === 1);
    const sent = api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const [changedRes, sentRes] = await Promise.all([changed, sent]);
    expect(changedRes.status).toBe(200);
    expect(sentRes.status).toBe(200);
    await until(() => count(fx, "prompt") === 2, 5000);
    const done = commands(fx).find((c) => c.cmd === "set_model:done") as Command;
    const one = commands(fx).filter((c) => c.cmd === "prompt").at(-1) as Command;
    expect(one.message).toBe("one");
    expect(one.at as number).toBeGreaterThanOrEqual(done.at as number);
    expect(count(fx, "prompt-overlap")).toBe(0);
  });

  test("lets an explicit model on the next message supersede a deferred change", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "300";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.4" });
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two", model: "openrouter/z-ai/glm-5.5" });
    await until(() => count(fx, "prompt") === 2, 5000);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "three" });
    await until(() => count(fx, "prompt") === 3, 5000);
    const models = commands(fx).filter((c) => c.cmd === "set_model").map((c) => `${c.provider}/${c.modelId}`);
    expect(models).toEqual(["openrouter/z-ai/glm-5.5"]);
  });

  test("keeps a denied model's item at the head and reports the failure", async () => {
    const fx = fixture();
    process.env.FAKE_PI_DENY_MODEL = "openrouter/nope/thing";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/nope/thing" });
    const all = await readUntil(events, (e) => e.type === "error", 5000);
    expect(all.some((e) => e.type === "error")).toBe(true);
    expect(count(fx, "prompt")).toBe(0);
    const state = await json<{ queue: unknown[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.length).toBe(1);
    await events.close();
  });
});

describe("starting like the mode", () => {
  test("a new conversation starts on the role's model and effort", async () => {
    const fx = fixture();
    await api(fx, "POST", "/api/conversations", { mode: "idea" });
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].model).toBe("openrouter/z-ai/glm-5.3");
    expect(starts(fx)[0].thinking).toBe("low");
  });

  test("an existing session opens with no model, so pi resumes its own", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "existing-1", fx.cwd, [{ type: "model_change", id: "m1", parentId: null, provider: "openrouter", modelId: "z-ai/glm-5.4", thinkingLevel: "max" }]);
    await api(fx, "GET", "/api/conversations/existing-1");
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].model).toBeUndefined();
    expect(starts(fx)[0].thinking).toBeUndefined();
  });

  test("runs with the mode's cwd, role agent dir and tools, without the engine's credentials", async () => {
    const fx = fixture();
    process.env.PORT = "9999";
    process.env.LINEAR_API_KEY = "secret";
    try {
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      await until(() => starts(fx).length === 1);
      const start = starts(fx)[0];
      expect(start.cwd).toBe(fx.cwd);
      expect(start.agentDir).toBe(agentDir(fx, "chat"));
      // the default settings put web search on, so its four tools ride along with the role's own; the chat
      // conversation also carries the read-only door onto propter's records (C-167-2)
      expect(start.tools).toBe("read,bash,web_search,fetch_content,get_search_content,source_check,propter_read");
      expect(start.noContext).toBe(false);
      expect(start.port).toBeUndefined();
      expect(start.linear).toBeUndefined();
    } finally {
      delete process.env.PORT;
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("writes the spawn record the existing GUI reads", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const rec = JSON.parse(readFileSync(join(fx.state, "pipeline", "sessions", `${created.id}.json`), "utf8")) as { slot: string; role: string; agent_dir: string };
    expect(rec.slot).toBe("mode:chat");
    expect(rec.role).toBe("chat");
    expect(rec.agent_dir).toBe(agentDir(fx, "chat"));
  });

  test("restarts on pi's record, without a model, once the session file exists", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one", model: "openrouter/z-ai/glm-5.4", effort: "max" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => sessionFileOf(fx, created.id) !== undefined);
    process.kill(starts(fx)[0].pid as number, "SIGKILL");
    await sleep(150);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => starts(fx).length === 2, 5000);
    expect(starts(fx)[1].model).toBeUndefined();
    expect(starts(fx)[1].thinking).toBeUndefined();
  });

  test("restarts a recordless conversation on the model and effort the user switched to", async () => {
    const fx = fixture();
    process.env.FAKE_PI_RECORD_AT_PROMPT = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.5", effort: "low" });
    await until(() => count(fx, "set_thinking_level") === 1);
    process.kill(starts(fx)[0].pid as number, "SIGKILL");
    await sleep(150);
    expect(sessionFileOf(fx, created.id)).toBeUndefined();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => starts(fx).length === 2, 5000);
    expect(starts(fx)[1].model).toBe("openrouter/z-ai/glm-5.5");
    expect(starts(fx)[1].thinking).toBe("low");
  });

  test("finds the record outside the chat role's agent dir and starts without a model", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "ideas", fx.cwd);
    placeSession(dir, "outside-1", fx.cwd, []);
    await api(fx, "GET", "/api/conversations/outside-1");
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].model).toBeUndefined();
    expect(starts(fx)[0].thinking).toBeUndefined();
    process.kill(starts(fx)[0].pid as number, "SIGKILL");
    await sleep(150);
    await api(fx, "POST", "/api/conversations/outside-1/messages", { text: "hi" });
    await until(() => starts(fx).length === 2, 5000);
    expect(starts(fx)[1].model).toBeUndefined();
  });
});

describe("the conversation namespace", () => {
  test("keeps the conversation, the lane and the screen routes in their own namespaces", () => {
    const conversationPatterns = routes.map((r) => r.pattern).filter((p) => p.includes("conversations"));
    expect(conversationPatterns.length).toBeGreaterThan(0);
    for (const pattern of conversationPatterns) expect(pattern.startsWith("/api/conversations")).toBe(true);
    // the conversation side features (search / settings / quota / transcription) share the namespace too
    const conversationSide = (p: string) => p.startsWith("/api/conversation") || p === "/api/quota" || p === "/api/transcriptions";
    // the new screen is served from the same port under its own prefix (/gui), not under the lane's /api/idd/
    const screen = (p: string) => p === "/gui" || p.startsWith("/gui/");
    for (const r of routes) {
      if (conversationSide(r.pattern) || screen(r.pattern)) continue;
      expect(r.pattern.startsWith("/api/idd/"), r.pattern).toBe(true);
    }
    expect(matchRoute("/api/conversations/:id", "/api/conversations/abc")).toEqual({ id: "abc" });
    expect(matchRoute("/api/conversations/:id/queue/:itemId", "/api/conversations/abc/queue/q1")).toEqual({ id: "abc", itemId: "q1" });
  });
});

describe("the cost record", () => {
  test("adds one line per reported response, keeps it after a delete, and stays out of the lane budget", async () => {
    const fx = fixture();
    // the title run is not what this test counts: fail it so only the conversation's own lines land
    process.env.FAKE_PI_ONESHOT_FAIL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => existsSync(conversationCostPath()));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => count(fx, "prompt") === 2);
    await until(() => readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).length >= 2);
    const lines = readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sessionId: string; mode: string; model: string; cost: number });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0].sessionId).toBe(created.id);
    expect(lines[0].mode).toBe("chat");
    expect(lines[0].cost).toBe(0.25);
    const before = lines.length;
    await api(fx, "DELETE", `/api/conversations/${created.id}`);
    await sleep(100);
    expect(readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).length).toBe(before);
    const { laneCost } = await import("@idd/core");
    const cost = await laneCost("IDD-NOPE", []);
    expect(cost.total).toBe(0);
  });
});

describe("the engine's own records", () => {
  test("adds only the cost file, the spawn record and the role's agent dir under state", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => existsSync(conversationCostPath()));
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    expect(readdirSync(fx.state).sort()).toEqual(["lanes", "pipeline"]);
    expect(readdirSync(join(fx.state, "pipeline")).sort()).toEqual(["agent", "conversation-cost.jsonl", "sessions"]);
  });
});

describe("an existing chat session", () => {
  test("opens from pi's own place and continues in the same session and cwd", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "cont-1", fx.cwd, [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } }]);
    const opened = await json<{ ok: boolean }>(await api(fx, "GET", "/api/conversations/cont-1"));
    expect(opened.ok).toBe(true);
    await api(fx, "POST", `/api/conversations/cont-1/messages`, { text: "more" });
    await until(() => count(fx, "prompt") === 1);
    expect(starts(fx)[0].session).toBe("cont-1");
    expect(starts(fx)[0].cwd).toBe(fx.cwd);
    expect(String(starts(fx)[0].argv)).not.toContain("--session-dir");
  });
});

describe("the guard around lane sessions", () => {
  test("refuses a pipeline session and a path-like id, and never starts pi for them", async () => {
    const fx = fixture();
    mkdirSync(join(fx.state, "pipeline", "sessions"), { recursive: true });
    writeFileSync(join(fx.state, "pipeline", "sessions", "planner-1.json"), JSON.stringify({
      session_id: "planner-1", slot: "planner", role: "chat", model: "openrouter/z-ai/glm-5.3", agent_dir: "", thinking: "high", spawned_at: "2026-01-01T00:00:00.000Z",
    }));
    const pipeline = await api(fx, "GET", "/api/conversations/planner-1");
    expect(pipeline.status).toBe(409);
    const bad = await api(fx, "GET", "/api/conversations/..%2Fescape");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(starts(fx)).toEqual([]);
  });

  test("answers the ownership question while it holds the session, and stops after close", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const owned = await json<{ engineOwned: boolean }>(await api(fx, "GET", `/api/idd/session/${created.id}`));
    expect(owned.engineOwned).toBe(true);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    const after = await json<{ engineOwned: boolean }>(await api(fx, "GET", `/api/idd/session/${created.id}`));
    expect(after.engineOwned).toBe(false);
    expect(existsSync(join(fx.state, "pipeline", "conversations", created.id))).toBe(false);
  });
});

describe("an extension's question", () => {
  test("is cancelled at once and reported as an event", async () => {
    const fx = fixture();
    process.env.FAKE_PI_EXTENSION = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const all = await readUntil(events, (e) => e.type === "extension", 5000);
    expect(all.some((e) => e.type === "extension")).toBe(true);
    await until(() => count(fx, "extension_ui_response") === 1);
    const reply = commands(fx).find((c) => c.cmd === "extension_ui_response") as Command;
    expect(reply.cancelled).toBe(true);
    await events.close();
  });
});

describe("a handled prompt", () => {
  test("does not set the conversation streaming and lets the next item go without waiting for a settle", async () => {
    const fx = fixture();
    process.env.FAKE_PI_DISPOSITION = "handled";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "cmd" });
    await until(() => count(fx, "prompt") === 1);
    const state = await json<{ streaming: boolean }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.streaming).toBe(false);
  });
});

describe("opening the same session at once", () => {
  test("starts pi only once and succeeds for every caller", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "race-1", fx.cwd, [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } }]);
    const results = await Promise.all([
      api(fx, "GET", "/api/conversations/race-1"),
      api(fx, "GET", "/api/conversations/race-1"),
      api(fx, "GET", "/api/conversations/race-1"),
      api(fx, "GET", "/api/conversations/race-1"),
      api(fx, "GET", "/api/conversations/race-1"),
      api(fx, "POST", "/api/conversations/race-1/messages", { text: "hi" }),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    expect(starts(fx).length).toBe(1);
  });
});

describe("JSONL framing", () => {
  test("keeps U+2028 / U+2029 inside a text delta and a record split across writes whole", async () => {
    const fx = fixture();
    process.env.FAKE_PI_TEXT = "a\u2028b\u2029c";
    process.env.FAKE_PI_SPLIT = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    const text = all.filter((e) => e.type === "text").map((e) => e.delta).join("");
    expect(text).toBe("a\u2028b\u2029c");
    await events.close();
  });
});

describe("a pi that goes away", () => {
  test("AC-011: ends the run as failed, leaves the queue, and the next send starts from its head", async () => {
    const fx = fixture();
    process.env.FAKE_PI_EXIT_AFTER_PROMPT = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("failed");
    expect(count(fx, "prompt")).toBe(1);
    delete process.env.FAKE_PI_EXIT_AFTER_PROMPT;
    // opening the conversation again wakes pi but does not run the queue by itself
    const state = await json<{ streaming: boolean; queue: { text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.streaming).toBe(false);
    expect(state.queue.map((q) => q.text)).toEqual(["two"]);
    await sleep(200);
    expect(count(fx, "prompt")).toBe(1);
    // the next send runs the leftover item first
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "three" });
    await until(() => count(fx, "prompt") === 3, 8000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two", "three"]);
    await events.close();
  });

  test("answers the create with a 5xx and leaves no conversation when pi cannot start", async () => {
    const fx = fixture();
    process.env.IDD_PI_BIN = join(fx.root, "does-not-exist");
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const list = await json<{ conversations: unknown[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations).toEqual([]);
  });

  test("F-4: a readiness failure closes the pi it started", async () => {
    const fx = fixture();
    process.env.FAKE_PI_GET_STATE_ERROR = "1";
    // keep pi's record unwritten, so this failure leaves nothing behind but the process to close
    process.env.FAKE_PI_RECORD_AT_PROMPT = "1";
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // the pi that was spawned for the failed start must be gone, not left alive with an open stdin
    const pid = (starts(fx)[0] as { pid: number }).pid;
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
    const list = await json<{ conversations: unknown[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations).toEqual([]);
  });
});

describe("closing an idle conversation", () => {
  test("closes one with no reader and no queue, but not one that is being read", async () => {
    const fx = fixture();
    process.env.IDD_CONVERSATION_IDLE_MS = "300";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await sleep(900);
    expect(openConversations().some((c) => c.sessionId === created.id)).toBe(true);
    await reader.close();
    expect(openConversations().find((c) => c.sessionId === created.id)?.readerCount).toBe(0);
    await until(() => !openConversations().some((c) => c.sessionId === created.id), 5000);
  });
});

describe("the engine's event loop", () => {
  test("answers the lane's state while a conversation's agent dir is being prepared", async () => {
    const fx = fixture();
    process.env.FAKE_PI_LIST_MODELS_MS = "3000";
    const creating = api(fx, "POST", "/api/conversations", { mode: "chat" });
    await sleep(400);
    const t0 = Date.now();
    const state = await api(fx, "GET", "/api/idd/state");
    const elapsed = Date.now() - t0;
    expect(state.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const created = await json<{ id: string }>(await creating);
    expect(created.id).toBeTruthy();
  });
});

// ---- ephemeral branches ----

const userEntry = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: text } });
const assistantEntry = (id: string, parentId: string | null, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra },
});
const toolCallEntry = (id: string, parentId: string | null, callId: string, name: string, path: string) => ({
  type: "message", id, parentId, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: { path } }], stopReason: "toolUse" },
});
const toolResultEntry = (id: string, parentId: string | null, callId: string, isError = false) => ({
  type: "message", id, parentId, message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text: "ok" }] },
});

function placeChatParent(fx: Fixture, id: string, entries: unknown[]): string {
  return placeSession(sessionDirOf(fx, "chat", fx.cwd), id, fx.cwd, entries);
}

function branchEntryLines(id: string): Record<string, unknown>[] {
  const file = ephemeralSessionFile(id);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const branchHeader = (id: string): Record<string, unknown> => branchEntryLines(id).find((e) => e.type === "session") as Record<string, unknown>;
const branchEntries = (id: string): Record<string, unknown>[] => branchEntryLines(id).filter((e) => e.type !== "session");
const branchIds = (id: string): unknown[] => branchEntries(id).map((e) => e.id);

async function fork(fx: Fixture, parent: string, body: Record<string, unknown>): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await api(fx, "POST", `/api/conversations/${parent}/ephemeral`, body);
  return { res, body: await json<Record<string, unknown>>(res) };
}

describe("cutting an ephemeral branch", () => {
  test("AC-001: returns the branch id, starts its pi in the branch dir, and copies the parent's path", async () => {
    const fx = fixture();
    const parentFile = placeChatParent(fx, "fork-a", [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer"),
    ]);
    const before = starts(fx).length;
    // a by-the-way branch is a mode's conversation, so the mode's memory index rides along
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "branch index\n");
    const { res, body } = await fork(fx, "fork-a", { at: "a1" });
    expect(res.status).toBe(200);
    expect(body.parent).toBe("fork-a");
    const id = body.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => starts(fx).length === before + 1);

    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.session).toBe(id);
    expect(start.sessionDir).toBe(ephemeralDir());
    expect(String(start.argv)).toContain("--session-dir");
    expect(String(start.argv)).toContain(join(fx.cwd, "memory", "MEMORY.md"));

    const header = branchHeader(id);
    expect(header.id).toBe(id);
    expect(header.cwd).toBe(fx.cwd);
    expect(header.parentSession).toBe(parentFile);
    expect(branchIds(id)).toEqual(["u1", "a1"]);
    expect(readEphemeralRecord(id)?.parentSessionId).toBe("fork-a");
    expect(existsSync(ephemeralRecordPath(id))).toBe(true);
    expect(ephemeralRecordPath(id).endsWith(".jsonl")).toBe(false);
    // the branch's record is not in the mode's place
    const modeDir = sessionDirOf(fx, "chat", fx.cwd);
    expect(readdirSync(modeDir).filter((n) => n.endsWith(`_${id}.jsonl`))).toEqual([]);
  });

  test("AC-002: a user message forks before it and returns its text; the first one makes an empty branch", async () => {
    const fx = fixture();
    placeChatParent(fx, "fork-b", [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "one"),
      userEntry("u2", "a1", "second"),
      assistantEntry("a2", "u2", "two"),
    ]);
    const { res, body } = await fork(fx, "fork-b", { at: "u2" });
    expect(res.status).toBe(200);
    expect(body.text).toBe("second");
    expect(branchIds(body.id as string)).toEqual(["u1", "a1"]);
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.entryIds).toEqual(["u1", "a1"]);

    const empty = await fork(fx, "fork-b", { at: "u1" });
    expect(empty.res.status).toBe(200);
    expect(empty.body.text).toBe("first");
    expect(branchEntries(empty.body.id as string)).toEqual([]);
    const opened = await api(fx, "GET", `/api/conversations/${empty.body.id}`);
    expect(opened.status).toBe(200);
  });

  test("AC-003: an assistant turn is a fork point, a tool call and every other entry kind are refused", async () => {
    const fx = fixture();
    placeChatParent(fx, "fork-c", [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "one"),
      { type: "model_change", id: "m1", parentId: "a1", provider: "openrouter", modelId: "z-ai/glm-5.3" },
      userEntry("u2", "a1", "second"),
      assistantEntry("a2", "u2", "two", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], stopReason: "toolUse" }),
      { type: "message", id: "t1", parentId: "a2", message: { role: "toolResult", toolCallId: "c1", content: [] } },
      assistantEntry("a3", "u2", "three", { content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }], stopReason: "length" }),
      assistantEntry("a4", "u2", "discarded"),
      userEntry("u3", "a1", "third"),
      assistantEntry("a5", "u3", "four"),
    ]);
    const begins = starts(fx).length;
    const ok = await fork(fx, "fork-c", { at: "a1" });
    expect(ok.res.status).toBe(200);
    expect(branchIds(ok.body.id as string)).toEqual(["u1", "a1"]);
    // a turn outside the current leaf's path (u3 -> a5) can still be the fork point
    const discarded = await fork(fx, "fork-c", { at: "a4" });
    expect(discarded.res.status).toBe(200);
    expect(branchIds(discarded.body.id as string)).toEqual(["u1", "a1", "u2", "a4"]);
    for (const at of ["a2", "a3", "t1", "m1", "zzz"]) {
      const refused = await fork(fx, "fork-c", { at });
      expect(refused.res.status, at).toBeGreaterThanOrEqual(400);
      expect(refused.res.status, at).toBeLessThan(500);
    }
    expect(starts(fx).length).toBe(begins + 2);
  });

  test("AC-004: the envelope is a hidden context entry written before pi starts and raises no run", async () => {
    const fx = fixture();
    placeChatParent(fx, "fork-d", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { res, body } = await fork(fx, "fork-d", { at: "a1", envelope: "CONTEXT-SECRET" });
    expect(res.status).toBe(200);
    const id = body.id as string;
    await until(() => starts(fx).length === 1);
    const entries = branchEntries(id);
    const last = entries.at(-1) as Record<string, unknown>;
    expect(last.type).toBe("custom_message");
    expect(last.customType).toBe("idd.engine");
    expect(last.content).toBe("CONTEXT-SECRET");
    expect(last.display).toBe(false);
    expect(last.parentId).toBe("a1");
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect((start.entryIds as string[]).at(-1)).toBe(last.id);
    expect(commands(fx).filter((c) => c.cmd === "prompt")).toEqual([]);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "hi" });
    await until(() => count(fx, "prompt") === 1);
    const noEnvelope = await fork(fx, "fork-d", { at: "a1" });
    expect(branchIds(noEnvelope.body.id as string)).toEqual(["u1", "a1"]);
    expect(branchEntries(noEnvelope.body.id as string).some((e) => e.type === "custom_message")).toBe(false);
  });

  test("AC-005: role, cwd and tools default to the parent and can be replaced", async () => {
    const fx = fixture();
    placeChatParent(fx, "fork-e", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const plain = await fork(fx, "fork-e", { at: "a1" });
    expect(plain.res.status).toBe(200);
    await until(() => starts(fx).length === 1);
    const plainStart = starts(fx).at(-1) as Record<string, unknown>;
    expect(plainStart.cwd).toBe(fx.cwd);
    expect(plainStart.tools).toBe("read,bash");
    expect(plainStart.agentDir).toBe(agentDir(fx, "chat"));
    expect(plainStart.model).toBeUndefined();

    const changed = await fork(fx, "fork-e", { at: "a1", role: "ideas", cwd: fx.ideaCwd, tools: ["read"] });
    expect(changed.res.status).toBe(200);
    const changedStart = starts(fx).at(-1) as Record<string, unknown>;
    expect(changedStart.cwd).toBe(fx.ideaCwd);
    expect(changedStart.tools).toBe("read");
    expect(changedStart.agentDir).toBe(agentDir(fx, "ideas"));
    expect(changedStart.model).toBe("openrouter/z-ai/glm-5.3");
    expect(changedStart.thinking).toBe("low");

    const badCwd = await fork(fx, "fork-e", { at: "a1", cwd: join(fx.root, "nope") });
    expect(badCwd.res.status).toBeGreaterThanOrEqual(400);
    expect(badCwd.res.status).toBeLessThan(500);
    const badRole = await fork(fx, "fork-e", { at: "a1", role: "nope" });
    expect(badRole.res.status).toBeGreaterThanOrEqual(400);
    expect(badRole.res.status).toBeLessThan(500);

    // a branch of a branch inherits what it did not replace
    const ofBranch = await fork(fx, changed.body.id as string, { at: "a1" });
    const grandStart = starts(fx).at(-1) as Record<string, unknown>;
    expect(grandStart.cwd).toBe(fx.ideaCwd);
    expect(grandStart.tools).toBe("read");
    expect(grandStart.agentDir).toBe(agentDir(fx, "ideas"));
    expect(ofBranch.res.status).toBe(200);
  });

  test("AC-006: the parent's record never changes, its pi is never woken, and a torn last line is tolerated", async () => {
    const fx = fixture();
    const parentFile = placeChatParent(fx, "fork-f", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const before = readFileSync(parentFile, "utf8");
    const { body } = await fork(fx, "fork-f", { at: "a1" });
    expect(readFileSync(parentFile, "utf8")).toBe(before);
    // only the branch's pi started
    expect(starts(fx).length).toBe(1);
    await api(fx, "POST", `/api/conversations/${body.id}/messages`, { text: "hi" });
    await until(() => count(fx, "prompt") === 1);
    expect(readFileSync(parentFile, "utf8")).toBe(before);
    // a write in progress leaves a torn line; the fork still reads the whole entries before it
    appendFileSync(parentFile, "{\"type\":\"message\",\"id\":\"torn");
    const torn = await fork(fx, "fork-f", { at: "a1" });
    expect(torn.res.status).toBe(200);
    expect(branchIds(torn.body.id as string)).toEqual(["u1", "a1"]);
  });

  test("AC-006 / AC-012: a fork does not disturb a parent mid-run, and an unopened branch is a parent", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "3000";
    placeChatParent(fx, "fork-g", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const opened = await api(fx, "GET", "/api/conversations/fork-g");
    expect(opened.status).toBe(200);
    await api(fx, "POST", "/api/conversations/fork-g/messages", { text: "run" });
    await until(() => count(fx, "prompt") === 1);
    const forked = await fork(fx, "fork-g", { at: "a1" });
    expect(forked.res.status).toBe(200);
    // the parent keeps running: its process was not restarted
    expect(starts(fx).length).toBe(2);
    await api(fx, "POST", `/api/conversations/${forked.body.id}/close`);
    const fromBranch = await fork(fx, forked.body.id as string, { at: "a1" });
    expect(fromBranch.res.status).toBe(200);
    expect(branchHeader(fromBranch.body.id as string).parentSession).toBe(ephemeralSessionFile(forked.body.id as string));
  });
});

describe("an ephemeral branch stays out of the list", () => {
  test("AC-007: neither an open nor a closed branch appears, while the parent does", async () => {
    const fx = fixture();
    placeChatParent(fx, "list-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "list-parent", { at: "a1" });
    const id = body.id as string;
    const open = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(open.conversations.some((c) => c.id === id)).toBe(false);
    expect(open.conversations.some((c) => c.id === "list-parent")).toBe(true);
    await api(fx, "POST", `/api/conversations/${id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === id));
    const closed = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(closed.conversations.some((c) => c.id === id)).toBe(false);
  });
});

describe("deleting an ephemeral branch", () => {
  test("AC-008: a streaming branch is closed, both records go, and the parent still opens", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    placeChatParent(fx, "del-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "del-parent", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "run" });
    await until(() => count(fx, "prompt") === 1);
    const deleted = await api(fx, "DELETE", `/api/conversations/${id}`);
    expect(deleted.status).toBe(200);
    await until(() => !existsSync(ephemeralRecordPath(id)));
    expect(ephemeralSessionFile(id)).toBeUndefined();
    const reopened = await api(fx, "GET", `/api/conversations/${id}`);
    expect(reopened.status).toBe(404);
    const parent = await api(fx, "GET", "/api/conversations/del-parent");
    expect(parent.status).toBe(200);
  });
});

describe("sweeping old branches", () => {
  test("AC-009 / AC-013: an old closed branch goes, an open one stays, and the sweep is asynchronous", async () => {
    const fx = fixture();
    placeChatParent(fx, "sweep-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const old = (await fork(fx, "sweep-parent", { at: "a1" })).body.id as string;
    const open = (await fork(fx, "sweep-parent", { at: "a1" })).body.id as string;
    delete process.env.IDD_EPHEMERAL_RETENTION_MS;
    expect(ephemeralRetentionMs()).toBe(7 * 24 * 60 * 60 * 1000);
    process.env.IDD_EPHEMERAL_RETENTION_MS = "1";
    // an open branch is never swept, however stale its record
    expect(await sweepEphemeralBranches(Date.now() + 1000)).not.toContain(open);
    expect(ephemeralSessionFile(open)).toBeDefined();
    await api(fx, "POST", `/api/conversations/${old}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === old));
    const removed = await sweepEphemeralBranches(Date.now() + 1000);
    expect(removed).toContain(old);
    expect(existsSync(ephemeralRecordPath(old))).toBe(false);
    expect(ephemeralSessionFile(open)).toBeDefined();
  });

  test("AC-017 / INV-1767: the sweeper runs once at engine start without waiting for the interval", async () => {
    const fx = fixture();
    placeChatParent(fx, "start-sweep", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const branch = (await fork(fx, "start-sweep", { at: "a1" })).body.id as string;
    await api(fx, "POST", `/api/conversations/${branch}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === branch));
    delete process.env.IDD_EPHEMERAL_SWEEP_MS;
    // make the record and its session old enough for a one-millisecond retention
    const record = JSON.parse(readFileSync(ephemeralRecordPath(branch), "utf8")) as { updatedAt?: string };
    record.updatedAt = new Date(0).toISOString();
    writeFileSync(ephemeralRecordPath(branch), JSON.stringify(record));
    const file = ephemeralSessionFile(branch);
    if (file) utimesSync(file, new Date(0), new Date(0));
    process.env.IDD_EPHEMERAL_RETENTION_MS = "1";
    try {
      // the call returns at once: the first sweep is started, not awaited
      expect(startEphemeralSweeper()).toBeUndefined();
      await until(() => !existsSync(ephemeralRecordPath(branch)), 5000);
    } finally {
      stopEphemeralSweeper();
      delete process.env.IDD_EPHEMERAL_RETENTION_MS;
    }
  });

  test("AC-018 / INV-1767: a branch the sweep removed is refused afterwards", async () => {
    const fx = fixture();
    placeChatParent(fx, "gate-sweep", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const branch = (await fork(fx, "gate-sweep", { at: "a1" })).body.id as string;
    await api(fx, "POST", `/api/conversations/${branch}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === branch));
    process.env.IDD_EPHEMERAL_RETENTION_MS = "1";
    const before = starts(fx).length;
    try {
      const removed = await sweepEphemeralBranches(Date.now() + 1000);
      expect(removed).toContain(branch);
      const reopened = await api(fx, "GET", `/api/conversations/${branch}`);
      expect(reopened.status).toBe(404);
      // no pi was started for a record the sweep took
      expect(starts(fx).length).toBe(before);
    } finally {
      delete process.env.IDD_EPHEMERAL_RETENTION_MS;
    }
  });

  test("AC-018 / INV-1767: a branch that is still opening is not swept", async () => {
    const fx = fixture();
    placeChatParent(fx, "starting-sweep", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const branch = (await fork(fx, "starting-sweep", { at: "a1" })).body.id as string;
    await api(fx, "POST", `/api/conversations/${branch}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === branch));
    process.env.IDD_EPHEMERAL_RETENTION_MS = "1";
    try {
      // the open is in flight, so the branch is in `starting` and the sweep must leave it alone
      const opening = openConversation(branch);
      const removed = await sweepEphemeralBranches(Date.now() + 1000);
      expect(removed).not.toContain(branch);
      const conv = await opening;
      expect(conv.sessionId).toBe(branch);
      await conv.close();
    } finally {
      delete process.env.IDD_EPHEMERAL_RETENTION_MS;
    }
  });

  test("AC-013: the sweep interval is configurable and importing the module starts no timer", () => {
    delete process.env.IDD_EPHEMERAL_SWEEP_MS;
    expect(ephemeralSweepMs()).toBe(60 * 60 * 1000);
    process.env.IDD_EPHEMERAL_SWEEP_MS = "1234";
    expect(ephemeralSweepMs()).toBe(1234);
  });
});

describe("reopening an ephemeral branch", () => {
  test("AC-010: keeps the id, dir, tools and role, adds no model, and accepts the conversation doors", async () => {
    const fx = fixture();
    placeChatParent(fx, "reopen-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "reopen-parent", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === id));
    const before = starts(fx).length;
    const opened = await api(fx, "GET", `/api/conversations/${id}`);
    expect(opened.status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.session).toBe(id);
    expect(start.sessionDir).toBe(ephemeralDir());
    expect(start.cwd).toBe(fx.cwd);
    expect(start.tools).toBe("read,bash");
    expect(start.agentDir).toBe(agentDir(fx, "chat"));
    expect(start.model).toBeUndefined();
    expect(start.thinking).toBeUndefined();
    expect(readdirSync(sessionDirOf(fx, "chat", fx.cwd)).filter((n) => n.endsWith(`_${id}.jsonl`))).toEqual([]);
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${id}/events`));
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "two" });
    await until(() => count(fx, "prompt") === 2);
    expect((await api(fx, "POST", `/api/conversations/${id}/stop`)).status).toBe(200);
    await events.close();
  });
});

describe("promoting an ephemeral branch", () => {
  test("AC-011: the mode's session appears in the list under the same id", async () => {
    const fx = fixture();
    placeChatParent(fx, "promo-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "promo-parent", { at: "a1" });
    const id = body.id as string;
    const res = await api(fx, "POST", `/api/conversations/${id}/promote`, {});
    expect(res.status).toBe(200);
    expect((await json<{ id: string }>(res)).id).toBe(id);
    expect(existsSync(ephemeralRecordPath(id))).toBe(false);
    expect(ephemeralSessionFile(id)).toBeUndefined();
    const moved = readdirSync(sessionDirOf(fx, "chat", fx.cwd)).filter((n) => n.endsWith(`_${id}.jsonl`));
    expect(moved.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(fx.state, "pipeline", "sessions", `${id}.json`), "utf8")) as { slot: string };
    expect(rec.slot).toBe("mode:chat");
    const list = await json<{ conversations: { id: string; mode: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.find((c) => c.id === id)?.mode).toBe("chat");
  });

  test("AC-011: a changed cwd and tools become the mode's, and a queued item is returned", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "4000";
    placeChatParent(fx, "promo-b", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "promo-b", { at: "a1", cwd: fx.ideaCwd, tools: ["read"] });
    const id = body.id as string;
    const file = ephemeralSessionFile(id) as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "queued" });
    const res = await api(fx, "POST", `/api/conversations/${id}/promote`, { mode: "chat" });
    expect(res.status).toBe(200);
    expect((await json<{ droppedQueue: { text: string }[] }>(res)).droppedQueue.map((q) => q.text)).toEqual(["queued"]);
    expect(existsSync(file)).toBe(false);
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    const moved = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`)) as string;
    const header = JSON.parse(readFileSync(join(dir, moved), "utf8").split("\n")[0]) as { cwd: string };
    expect(header.cwd).toBe(fx.cwd);
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${id}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    const start = starts(fx).at(-1) as Record<string, unknown>;
    expect(start.cwd).toBe(fx.cwd);
    // promoted to the mode's own session, so the default settings' web-search tools ride along, and so does
    // the read-only door onto propter's records (C-167-2)
    expect(start.tools).toBe("read,bash,web_search,fetch_content,get_search_content,source_check,propter_read");
    expect(start.agentDir).toBe(agentDir(fx, "chat"));
  });

  test("AC-015: a pi that will not exit is forced down, the promotion is refused, and a retry needs no pi", async () => {
    const fx = fixture();
    process.env.FAKE_PI_IGNORE_STDIN_END = "1";
    process.env.IDD_PROMOTE_EXIT_TIMEOUT_MS = "300";
    placeChatParent(fx, "promo-c", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "promo-c", { at: "a1" });
    const id = body.id as string;
    const pid = (starts(fx).at(-1) as { pid: number }).pid;
    const res = await api(fx, "POST", `/api/conversations/${id}/promote`, {});
    expect(res.status).toBe(409);
    // the process is really gone before the refusal is answered
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
    expect(existsSync(ephemeralRecordPath(id))).toBe(true);
    // the retry promotes the branch without waking pi
    const before = starts(fx).length;
    const retry = await api(fx, "POST", `/api/conversations/${id}/promote`, {});
    expect(retry.status).toBe(200);
    expect(starts(fx).length).toBe(before);
    expect(existsSync(ephemeralRecordPath(id))).toBe(false);
  });

  test("AC-015: closing a mode's conversation against a pi that will not exit ends with the pid gone", async () => {
    const fx = fixture();
    process.env.FAKE_PI_IGNORE_STDIN_END = "1";
    process.env.IDD_CLOSE_EXIT_TIMEOUT_MS = "300";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const pid = (starts(fx).at(-1) as { pid: number }).pid;
    const closed = await api(fx, "POST", `/api/conversations/${created.id}/close`);
    expect(closed.status).toBe(200);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 8000);
  });
});

describe("an ephemeral branch's cost", () => {
  test("AC-014: only the branch's own line counts, and a delete keeps it", async () => {
    const fx = fixture();
    placeChatParent(fx, "cost-parent", [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "one", { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } }),
      userEntry("u2", "a1", "second"),
      assistantEntry("a2", "u2", "two", { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } }),
    ]);
    const { body } = await fork(fx, "cost-parent", { at: "a2" });
    const id = body.id as string;
    expect(conversationCostOf(id)).toBe(0);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "ask" });
    await until(() => conversationCostOf(id) === 0.25);
    const lines = readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sessionId: string; ephemeral?: boolean; parentSessionId?: string; cost: number });
    const branchLines = lines.filter((l) => l.sessionId === id);
    expect(branchLines.length).toBe(1);
    expect(branchLines[0].ephemeral).toBe(true);
    expect(branchLines[0].parentSessionId).toBe("cost-parent");
    expect(conversationCostOf("cost-parent")).toBe(0);
    const before = lines.length;
    await api(fx, "DELETE", `/api/conversations/${id}`);
    await sleep(100);
    expect(readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).length).toBe(before);
  });

  test("AC-015: promotion keeps the id, so the cost carries over and grows", async () => {
    const fx = fixture();
    placeChatParent(fx, "cost2-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "cost2-parent", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "ask" });
    await until(() => conversationCostOf(id) === 0.25);
    expect((await api(fx, "POST", `/api/conversations/${id}/promote`, {})).status).toBe(200);
    const list = await json<{ conversations: { id: string; cost: number }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(list.conversations.find((c) => c.id === id)?.cost).toBe(0.25);
    expect((await json<{ cost: number }>(await api(fx, "GET", `/api/conversations/${id}`))).cost).toBe(0.25);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "more" });
    await until(() => conversationCostOf(id) === 0.5);
  });
});

describe("the guards and the shape of the doors", () => {
  test("AC-016: a lane session, a foreign session, a path-like entry id, and the ownership answer", async () => {
    const fx = fixture();
    mkdirSync(join(fx.state, "pipeline", "sessions"), { recursive: true });
    writeFileSync(join(fx.state, "pipeline", "sessions", "planner-x.json"), JSON.stringify({
      session_id: "planner-x", slot: "planner", role: "chat", model: "openrouter/z-ai/glm-5.3", agent_dir: "", thinking: "high", spawned_at: "2026-01-01T00:00:00.000Z",
    }));
    const lane = await fork(fx, "planner-x", { at: "a1" });
    expect(lane.res.status).toBe(409);
    const foreignFork = await fork(fx, "foreign-1", { at: "a1" });
    expect(foreignFork.res.status).toBe(404);
    const badAt = await fork(fx, "planner-x", { at: "../x" });
    expect(badAt.res.status).toBeGreaterThanOrEqual(400);
    expect(badAt.res.status).toBeLessThan(500);
    expect(starts(fx)).toEqual([]);
    // the ownership question answers for a branch while the engine holds it
    placeChatParent(fx, "owner-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "owner-parent", { at: "a1" });
    const owned = await json<{ engineOwned: boolean }>(await api(fx, "GET", `/api/idd/session/${body.id}`));
    expect(owned.engineOwned).toBe(true);
    await api(fx, "POST", `/api/conversations/${body.id}/close`);
    const after = await json<{ engineOwned: boolean }>(await api(fx, "GET", `/api/idd/session/${body.id}`));
    expect(after.engineOwned).toBe(false);
  });

  test("AC-013: the conversation doors are the IDD-048 set plus the fork, the promotion, the title, the context and the idea doors", () => {
    const patterns = routes.map((r) => r.pattern).filter((p) => p.includes("conversations"));
    const extras = patterns.filter((p) => p.includes("ephemeral") || p.includes("promote")).sort();
    expect(extras).toEqual(["/api/conversations/:id/ephemeral", "/api/conversations/:id/promote"]);
    const base = [...new Set(patterns.filter((p) => !extras.includes(p)))].sort();
    expect(base).toEqual([
      "/api/conversations",
      "/api/conversations/:id",
      "/api/conversations/:id/close",
      "/api/conversations/:id/command",
      "/api/conversations/:id/context",
      "/api/conversations/:id/events",
      "/api/conversations/:id/idea",
      "/api/conversations/:id/idea/exits/challenge",
      "/api/conversations/:id/idea/exits/run",
      "/api/conversations/:id/idea/gates",
      "/api/conversations/:id/marks",
      "/api/conversations/:id/messages",
      "/api/conversations/:id/model",
      "/api/conversations/:id/models",
      "/api/conversations/:id/queue/:itemId",
      "/api/conversations/:id/queue/:itemId/steer",
      "/api/conversations/:id/steer",
      "/api/conversations/:id/stop",
      "/api/conversations/:id/title",
      "/api/conversations/:id/type",
      "/api/conversations/workspaces",
      "/api/conversations/workspaces/:mode",
      "/api/conversations/workspaces/:mode/bookmarks",
      "/api/conversations/workspaces/:mode/bookmarks/:id",
      "/api/conversations/workspaces/:mode/spaces",
      "/api/conversations/workspaces/:mode/spaces/:id",
    ]);
    // no door edits, resends or deletes one message or entry
    for (const p of patterns) expect(/entry|message(s)?\/entry|entries/.test(p)).toBe(false);
  });
});

describe("the bridging command door", () => {
  test("passes an allowed pi command and answers with pi's data", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const stats = await json<{ ok: boolean; data?: { contextUsage?: { percent: number } } }>(await api(fx, "POST", `/api/conversations/${created.id}/command`, { type: "get_session_stats" }));
    expect(stats.ok).toBe(true);
    expect(stats.data?.contextUsage?.percent).toBe(10);
    expect(count(fx, "get_session_stats")).toBe(1);

    const named = await json<{ ok: boolean }>(await api(fx, "POST", `/api/conversations/${created.id}/command`, { type: "set_session_name", name: "hello" }));
    expect(named.ok).toBe(true);
    expect(commands(fx).find((c) => c.cmd === "set_session_name")?.name).toBe("hello");
  });

  test("refuses the core operations and everything the door does not carry, without reaching pi", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const refusedOps = ["prompt", "steer", "follow_up", "abort", "set_model", "set_thinking_level", "clear_queue"];
    for (const type of refusedOps) {
      const res = await api(fx, "POST", `/api/conversations/${created.id}/command`, { type });
      expect(res.status, type).toBe(400);
      const body = await json<{ code?: string }>(res);
      expect(body.code, type).toBe("core_operation");
    }
    for (const type of ["bash", "abort_bash", "new_session", "switch_session", "clone", "export_html", "get_state", "nope"]) {
      const res = await api(fx, "POST", `/api/conversations/${created.id}/command`, { type });
      expect(res.status, type).toBe(400);
      expect(count(fx, type), type).toBe(0);
    }
  });

  test("fork re-registers the conversation under pi's new id and keeps one pi", async () => {
    const fx = fixture();
    process.env.FAKE_PI_FORK_ID = "forked-1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const res = await json<{ ok: boolean; newSessionId?: string }>(await api(fx, "POST", `/api/conversations/${created.id}/command`, { type: "fork", entryId: "u1" }));
    expect(res.ok).toBe(true);
    expect(res.newSessionId).toBe("forked-1");

    const list = await json<{ conversations: { id: string; mode: string; running: boolean; open: boolean }[] }>(await api(fx, "GET", "/api/conversations"));
    const forked = list.conversations.find((c) => c.id === "forked-1");
    expect(forked?.mode).toBe("chat");
    expect(forked?.open).toBe(true);
    // the original id's record stays (a fork keeps its source), but the engine no longer holds a pi for it
    expect(list.conversations.find((c) => c.id === created.id)?.open).toBe(false);
    expect(openConversations().some((c) => c.sessionId === "forked-1")).toBe(true);

    const opened = await api(fx, "GET", "/api/conversations/forked-1");
    expect(opened.status).toBe(200);
    expect(starts(fx).length).toBe(1);
  });
});

describe("images", () => {
  test("carries an image to pi's prompt, and to its steer while a run is going", async () => {
    const fx = fixture();
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [image] });
    await until(() => count(fx, "prompt") === 1);
    expect(commands(fx).find((c) => c.cmd === "prompt")?.images).toEqual([image]);

    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "instead", images: [image] });
    await until(() => count(fx, "steer") === 1);
    expect(commands(fx).find((c) => c.cmd === "steer")?.images).toEqual([image]);
    await readUntil(events, (e) => e.type === "end");
    await events.close();
  });

  test("a message with only an image is accepted and queued with its image", async () => {
    const fx = fixture();
    const image = { type: "image", data: "BBBB", mimeType: "image/png" };
    const created = await json<{ id: string; queue?: unknown[] }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const res = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "  ", images: [image] });
    expect(res.status).toBe(200);
    await until(() => count(fx, "prompt") === 1);
    const prompt = commands(fx).find((c) => c.cmd === "prompt");
    expect(prompt?.message).toBe("  ");
    expect(prompt?.images).toEqual([image]);
  });

  test("rejects a message with neither text nor image", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const res = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "   " });
    expect(res.status).toBe(400);
  });
});

describe("the added events", () => {
  test("keeps contentIndex, carries tool call deltas, tool progress, compaction and retry, and one end", async () => {
    const fx = fixture();
    process.env.FAKE_PI_TOOLCALL = "1";
    process.env.FAKE_PI_PROGRESS = "1";
    process.env.FAKE_PI_COMPACTION = "1";
    process.env.FAKE_PI_RETRY = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hi" });
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect(all.some((e) => e.type === "run_start")).toBe(true);
    expect((all.find((e) => e.type === "thinking") as { contentIndex?: number }).contentIndex).toBe(0);
    expect((all.find((e) => e.type === "text") as { contentIndex?: number }).contentIndex).toBe(1);
    const toolStart = all.find((e) => e.type === "tool_call_delta" && e.phase === "start") as { contentIndex?: number; name?: string; toolCallId?: string };
    expect(toolStart?.contentIndex).toBe(2);
    expect(toolStart?.name).toBe("read");
    expect(toolStart?.toolCallId).toBe("call_1");
    const progress = all.find((e) => e.type === "tool_progress") as { toolCallId?: string };
    expect(progress?.toolCallId).toBe("call_2");
    expect(all.some((e) => e.type === "compaction_start")).toBe(true);
    const compactEnd = all.find((e) => e.type === "compaction_end") as { result?: { tokensBefore?: number; estimatedTokensAfter?: number }; aborted?: boolean };
    expect(compactEnd?.result?.tokensBefore).toBe(10);
    expect(compactEnd?.result?.estimatedTokensAfter).toBe(5);
    expect(compactEnd?.aborted).toBe(false);
    const retry = all.find((e) => e.type === "retry_start") as { attempt?: number; maxAttempts?: number; errorMessage?: string };
    expect(retry?.attempt).toBe(1);
    expect(retry?.maxAttempts).toBe(3);
    expect([...all].filter((e) => e.type === "end").length).toBe(1);
    await events.close();
  });
});

describe("the open state and the summary", () => {
  test("reports the run's start number and whether it is running, and the mode's tools", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "200";
    process.env.FAKE_PI_STREAM_HOLD_MS = "1500";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hi" });
    const seen = await readUntil(events, (e) => e.type === "run_start", 5000);
    const runStartSeq = (seen.find((e) => e.type === "run_start") as { seq: number }).seq;

    const state = await json<{ streaming: boolean; promptPending: boolean; compacting: boolean; runStartSeq?: number }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.streaming).toBe(true);
    expect(typeof state.promptPending).toBe("boolean");
    expect(typeof state.compacting).toBe("boolean");
    expect(state.runStartSeq).toBe(runStartSeq);

    const list = await json<{ conversations: { id: string; running: boolean; tools: string[] }[] }>(await api(fx, "GET", "/api/conversations"));
    const summary = list.conversations.find((c) => c.id === created.id);
    expect(summary?.running).toBe(true);
    expect(summary?.tools).toEqual(["read", "bash"]);

    await readUntil(events, (e) => e.type === "end", 5000);
    await events.close();
  });
});

// ---- the workspace, workdirs, spaces and marks (IDD-054) ----

interface Summary {
  id: string; mode: string; cwd: string; name?: string; createdAt: string; updatedAt: string;
  pinned: boolean; archived: boolean; bookmarks: string[]; space?: string; workdir: string;
  open: boolean; running: boolean; tools: string[]; cost: number;
  type?: string; document?: { path: string; status: string | null };
}
interface ListBody { conversations: Summary[]; groups?: { key: string; label: string; conversations: Summary[] }[] }

async function listBody(fx: Fixture, query = ""): Promise<ListBody> {
  const res = await api(fx, "GET", `/api/conversations${query}`);
  return await json<ListBody>(res);
}

async function marks(fx: Fixture, id: string, body: Record<string, unknown>): Promise<Response> {
  return await api(fx, "PATCH", `/api/conversations/${id}/marks`, body);
}

describe("a mode's workspace", () => {
  test("AC-004 / AC-009: a conversation runs in the workspace with pi's context files, without --session-dir", async () => {
    const fx = fixture();
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].cwd).toBe(fx.cwd);
    expect(starts(fx)[0].noContext).toBe(false);
    expect(String(starts(fx)[0].argv)).not.toContain("--session-dir");
  });

  test("AC-029: the workspaces door answers without opening a session", async () => {
    const fx = fixture();
    const list = await json<{ workspaces: { mode: string; workspace: string }[] }>(await api(fx, "GET", "/api/conversations/workspaces"));
    expect(list.workspaces.find((w) => w.mode === "chat")?.workspace).toBe(fx.cwd);
    const one = await json<{ workspace: string; hasAgents: boolean; hasClaude: boolean }>(await api(fx, "GET", "/api/conversations/workspaces/chat"));
    expect(one.workspace).toBe(fx.cwd);
    expect(one.hasAgents).toBe(false);
    writeFileSync(join(fx.cwd, "AGENTS.md"), "norm\n");
    expect((await json<{ hasAgents: boolean }>(await api(fx, "GET", "/api/conversations/workspaces/chat"))).hasAgents).toBe(true);
    expect(starts(fx)).toEqual([]);
  });
});

describe("a conversation's workdir", () => {
  test("AC-005: a relative workdir becomes the cwd and is returned relative to the workspace", async () => {
    const fx = fixture();
    const res = await json<{ id: string; cwd: string; workdir: string; workspace: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", workdir: "notes/a" }));
    expect(res.cwd).toBe(join(fx.cwd, "notes", "a"));
    expect(res.workspace).toBe(fx.cwd);
    expect(res.workdir).toBe("notes/a");
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].cwd).toBe(join(fx.cwd, "notes", "a"));
  });

  test("AC-006: a missing workdir is created, an existing one is kept, and a file in the way is refused", async () => {
    const fx = fixture();
    await api(fx, "POST", "/api/conversations", { mode: "chat", workdir: "notes/a" });
    expect(existsSync(join(fx.cwd, "notes", "a"))).toBe(true);
    writeFileSync(join(fx.cwd, "notes", "a", "keep.txt"), "kept");
    await api(fx, "POST", "/api/conversations", { mode: "chat", workdir: "notes/a" });
    expect(readFileSync(join(fx.cwd, "notes", "a", "keep.txt"), "utf8")).toBe("kept");
    writeFileSync(join(fx.cwd, "blocked"), "file");
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat", workdir: "blocked" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("AC-007: a workdir that would leave the workspace is refused and nothing is created", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, "outside"), { recursive: true });
    symlinkSync(join(fx.root, "outside"), join(fx.cwd, "link"));
    const before = readdirSync(fx.cwd).filter((name) => name !== "link").sort();
    for (const workdir of ["/tmp/x", "../x", "a/../../x", ".propter", "a/.git", "link/inside"]) {
      const res = await api(fx, "POST", "/api/conversations", { mode: "chat", workdir });
      expect(res.status, workdir).toBeGreaterThanOrEqual(400);
      expect(res.status, workdir).toBeLessThan(500);
    }
    expect(starts(fx)).toEqual([]);
    expect(readdirSync(join(fx.root, "outside"))).toEqual([]);
    expect(readdirSync(fx.cwd).filter((name) => name !== "link").sort()).toEqual(before);
  });

  test("AC-008 / AC-034: a workdir session belongs to the deepest workspace, and its record's cwd opens it", async () => {
    const fx = fixture();
    const sub = join(fx.cwd, "sub");
    mkdirSync(join(sub, "x"), { recursive: true });
    writeFileSync(join(fx.root, "modes.yaml"), `modes:\n  chat: { role: chat, workspace: ${fx.cwd} }\n  idea: { role: ideas, workspace: ${fx.ideaCwd} }\n  sub: { role: chat, workspace: ${sub} }\n`);
    const chatDir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(chatDir, "ws-root", fx.cwd, []);
    const subDir = sessionDirOf(fx, "chat", sub);
    placeSession(subDir, "ws-sub", join(sub, "x"), []);
    const ideaDir = sessionDirOf(fx, "ideas", fx.ideaCwd);
    placeSession(ideaDir, "ws-other", fx.ideaCwd, []);

    const body = await listBody(fx);
    const byId = new Map(body.conversations.map((c) => [c.id, c]));
    expect(byId.get("ws-root")?.mode).toBe("chat");
    expect(byId.get("ws-sub")?.mode).toBe("sub");
    expect(byId.get("ws-sub")?.workdir).toBe("x");
    expect(byId.get("ws-other")?.mode).toBe("idea");
    expect(body.conversations.filter((c) => c.id === "ws-sub").length).toBe(1);

    const opened = await json<{ mode: string; cwd: string }>(await api(fx, "GET", "/api/conversations/ws-sub"));
    expect(opened.mode).toBe("sub");
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].cwd).toBe(join(sub, "x"));

    rmSync(join(sub, "x"), { recursive: true, force: true });
    await api(fx, "POST", "/api/conversations/ws-sub/close");
    await until(() => !openConversations().some((c) => c.sessionId === "ws-sub"));
    const gone = await api(fx, "GET", "/api/conversations/ws-sub");
    expect(gone.status).toBeGreaterThanOrEqual(400);
    expect(gone.status).toBeLessThan(500);
  });

  test("AC-031: an unsent workdir conversation keeps its cwd across a restart", async () => {
    const fx = fixture();
    process.env.FAKE_PI_RECORD_AT_PROMPT = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", workdir: "notes/a" }));
    await until(() => starts(fx).length === 1);
    expect(sessionFileOf(fx, created.id)).toBeUndefined();
    const rec = JSON.parse(readFileSync(join(fx.state, "pipeline", "sessions", `${created.id}.json`), "utf8")) as { cwd?: string };
    expect(rec.cwd).toBe(join(fx.cwd, "notes", "a"));
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${created.id}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(starts(fx).at(-1)?.cwd).toBe(join(fx.cwd, "notes", "a"));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    const dir = sessionDirOf(fx, "chat", join(fx.cwd, "notes", "a"));
    await until(() => existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(`_${created.id}.jsonl`)));
  });
});

describe("spaces", () => {
  test("AC-010: spaces are read from the workspace files", async () => {
    const fx = fixture();
    placeSpaceFile(fx, "alpha", "name: Alpha\nmemory: shared\nreferences:\n  - /tmp/one\n  - /tmp/two", "the alpha instruction");
    mkdirSync(join(fx.cwd, "spaces", "empty"), { recursive: true });
    const list = await json<{ spaces: { id: string; name?: string; memory: string; references: string[] }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces"));
    expect(list.spaces.map((p) => p.id)).toEqual(["alpha"]);
    const alpha = list.spaces[0];
    expect(alpha.name).toBe("Alpha");
    expect(alpha.memory).toBe("shared");
    expect(alpha.references).toEqual(["/tmp/one", "/tmp/two"]);
    const one = await json<{ space: { instruction: string } }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces/alpha"));
    expect(one.space.instruction).toBe("the alpha instruction");
  });

  test("AC-011 / AC-013: create and update keep unknown frontmatter; empty spaces work; there is no delete door", async () => {
    const fx = fixture();
    const created = await json<{ space: { id: string } }>(await api(fx, "POST", "/api/conversations/workspaces/chat/spaces", { id: "beta", name: "Beta", memory: "space", references: ["/tmp/x"], instruction: "one" }));
    expect(created.space.id).toBe("beta");
    const file = join(fx.cwd, "spaces", "beta", "space.md");
    expect(existsSync(file)).toBe(true);
    // an unknown frontmatter key another harness wrote must survive an update
    writeFileSync(file, readFileSync(file, "utf8").replace("---\n", "---\nother_tool: keep\n"));
    await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/beta", { instruction: "two", references: ["/tmp/y"] });
    const after = readFileSync(file, "utf8");
    expect(after).toContain("other_tool: keep");
    expect(after).toContain("two");
    expect(after).toContain("/tmp/y");
    const dup = await api(fx, "POST", "/api/conversations/workspaces/chat/spaces", { id: "beta" });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    const bad = await api(fx, "POST", "/api/conversations/workspaces/chat/spaces", { id: "../x" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    placeSpaceFile(fx, "front", "name: Front");
    mkdirSync(join(fx.cwd, "spaces", "bare"), { recursive: true });
    writeFileSync(join(fx.cwd, "spaces", "bare", "space.md"), "");
    const list = await json<{ spaces: { id: string }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces"));
    expect(list.spaces.map((p) => p.id).sort()).toEqual(["bare", "beta", "front"]);
    expect(routes.some((r) => r.method === "DELETE" && r.pattern.includes("/spaces"))).toBe(false);
    // a conversation in a frontmatter-only space still starts
    const conv = await api(fx, "POST", "/api/conversations", { mode: "chat", space: "front" });
    expect(conv.status).toBe(200);
  });

  test("AC-012: a space membership never changes the cwd, and a failed start leaves no mark", async () => {
    const fx = fixture();
    placeSpaceFile(fx, "alpha", "name: Alpha");
    const created = await json<{ id: string; cwd: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" }));
    expect(created.cwd).toBe(fx.cwd);
    await until(() => starts(fx).length === 1);
    const fileBefore = sessionFileOf(fx, created.id);
    const before = starts(fx).length;
    expect((await marks(fx, created.id, { space: "alpha" })).status).toBe(200);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    expect((await api(fx, "GET", `/api/conversations/${created.id}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(starts(fx).at(-1)?.cwd).toBe(fx.cwd);
    expect(sessionFileOf(fx, created.id)).toBe(fileBefore);
    const unknown = await api(fx, "POST", "/api/conversations", { mode: "chat", space: "nope" });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  });

  test("AC-012: a space create whose pi cannot start writes no mark", async () => {
    const fx = fixture();
    placeSpaceFile(fx, "alpha", "name: Alpha");
    process.env.IDD_PI_BIN = join(fx.root, "does-not-exist");
    const res = await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);
  });
});

// a definition and a mark made before the rename: `projects/<id>/project.md` and the mark's `project` field
function placeLegacyProjectFile(fx: Fixture, id: string, front: string, body = ""): string {
  const dir = join(fx.cwd, "projects", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "project.md");
  writeFileSync(file, `---\n${front}${front ? "\n" : ""}---\n${body ? `${body}\n` : ""}`);
  return file;
}

describe("spaces made before the rename", () => {
  test("AC-003: the old definition and mark read as a space, and a read moves nothing", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "old-one", fx.cwd, [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const file = placeLegacyProjectFile(fx, "old", "name: Old\nmemory: project\nreferences:\n  - /tmp/legacy-ref", "LEGACY-INSTRUCTION");
    mkdirSync(join(fx.cwd, "projects", "old", "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "projects", "old", "memory", "MEMORY.md"), "old index\n");
    writeMarksFile(fx.cwd, { "old-one": { project: "old", pinned: true } });
    const before = readFileSync(file, "utf8");
    const marksBefore = readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8");

    const list = await json<{ spaces: { id: string; name?: string; memory: string; references: string[] }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces"));
    expect(list.spaces).toEqual([{ id: "old", name: "Old", memory: "space", references: ["/tmp/legacy-ref"], instruction: "LEGACY-INSTRUCTION" }]);
    const one = await json<{ space: { instruction: string } }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces/old"));
    expect(one.space.instruction).toBe("LEGACY-INSTRUCTION");
    const row = (await listBody(fx)).conversations.find((c) => c.id === "old-one");
    expect(row?.space).toBe("old");
    expect(row?.pinned).toBe(true);
    expect((await listBody(fx, "?space=old")).conversations.map((c) => c.id)).toEqual(["old-one"]);

    expect((await api(fx, "GET", "/api/conversations/old-one")).status).toBe(200);
    await until(() => starts(fx).length === 1);
    const argv = String(starts(fx)[0].argv);
    expect(argv).toContain("# スペース: Old");
    expect(argv).toContain("LEGACY-INSTRUCTION");
    expect(argv).toContain("/tmp/legacy-ref");
    // the memory is still in the old dir until an update folds it, so that is where the context points
    expect(argv).toContain("projects/old/memory");
    expect(argv).not.toContain("spaces/old/memory");

    // none of the reads moved or rewrote what the person owns
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")).toBe(marksBefore);
    expect(existsSync(join(fx.cwd, "spaces"))).toBe(false);
  }, 30_000);

  // open a session that holds the old membership and return the argv pi was started with
  async function openOldSession(fx: Fixture, sessionId: string): Promise<string> {
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, sessionId, fx.cwd, [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    writeMarksFile(fx.cwd, { [sessionId]: { project: "old" } });
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${sessionId}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    return String(starts(fx).at(-1)?.argv);
  }

  test("AC-003: a shared old memory points the index line at the old dir", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: shared");
    mkdirSync(join(fx.cwd, "projects", "old", "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "projects", "old", "memory", "MEMORY.md"), "old index\n");
    const argv = await openOldSession(fx, "has-memory-dir");
    expect(argv).toContain("projects/old/memory/MEMORY.md");
    expect(argv).not.toContain("spaces/old/memory");
    // the read made nothing
    expect(existsSync(join(fx.cwd, "spaces"))).toBe(false);
  }, 30_000);

  test("AC-003: an old definition with no memory dir points at the new place", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: shared");
    const argv = await openOldSession(fx, "no-memory-dir");
    expect(argv).toContain("spaces/old/memory/MEMORY.md");
    expect(argv).not.toContain("projects/old/memory");
    expect(existsSync(join(fx.cwd, "spaces"))).toBe(false);
  }, 30_000);

  test("AC-003: when both memory dirs exist the context writes to the old one and reads both", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: project");
    mkdirSync(join(fx.cwd, "projects", "old", "memory"), { recursive: true });
    mkdirSync(join(fx.cwd, "spaces", "old", "memory"), { recursive: true });
    const argv = await openOldSession(fx, "both-dirs");
    expect(argv).toContain("projects/old/memory");
    expect(argv).toContain("spaces/old/memory");
    expect(argv).toContain("両方を見て");
  }, 30_000);

  test("AC-004: after an update the context points at the new memory dir", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: project");
    mkdirSync(join(fx.cwd, "projects", "old", "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "projects", "old", "memory", "MEMORY.md"), "old index\n");
    const sessionId = "to-be-updated";
    expect(await openOldSession(fx, sessionId)).toContain("projects/old/memory");

    expect((await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/old", { name: "Renamed" })).status).toBe(200);
    await api(fx, "POST", `/api/conversations/${sessionId}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === sessionId));
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${sessionId}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    const argv = String(starts(fx).at(-1)?.argv);
    expect(argv).toContain("spaces/old/memory");
    expect(argv).not.toContain("projects/old/memory");
  }, 30_000);

  test("AC-004: updating an old definition moves it, and its memory dir, to the new place", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: project\nother_tool: keep", "LEGACY-INSTRUCTION");
    mkdirSync(join(fx.cwd, "projects", "old", "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "projects", "old", "memory", "MEMORY.md"), "old index\n");
    placeLegacyProjectFile(fx, "other", "name: Other");

    const res = await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/old", { name: "Renamed" });
    expect(res.status).toBe(200);
    const file = join(fx.cwd, "spaces", "old", "space.md");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("name: Renamed");
    expect(text).toContain("memory: space");
    expect(text).toContain("other_tool: keep");
    expect(text).toContain("LEGACY-INSTRUCTION");
    expect(readFileSync(join(fx.cwd, "spaces", "old", "memory", "MEMORY.md"), "utf8")).toBe("old index\n");
    expect(existsSync(join(fx.cwd, "projects", "old"))).toBe(false);
    // a space nobody updated stays where it was, and both places list
    expect(existsSync(join(fx.cwd, "projects", "other", "project.md"))).toBe(true);
    const list = await json<{ spaces: { id: string }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces"));
    expect(list.spaces.map((s) => s.id)).toEqual(["old", "other"]);
  });

  test("AC-004: an old memory folds into a new memory dir that already has files", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "old", "name: Old\nmemory: project", "LEGACY-INSTRUCTION");
    const oldMemory = join(fx.cwd, "projects", "old", "memory");
    const newMemory = join(fx.cwd, "spaces", "old", "memory");
    mkdirSync(oldMemory, { recursive: true });
    mkdirSync(newMemory, { recursive: true });
    writeFileSync(join(oldMemory, "MEMORY.md"), "old index\n");
    writeFileSync(join(oldMemory, "旧.md"), "old fact\n");
    writeFileSync(join(oldMemory, "same.md"), "same\n");
    writeFileSync(join(newMemory, "MEMORY.md"), "new index\n");
    writeFileSync(join(newMemory, "新.md"), "new fact\n");
    writeFileSync(join(newMemory, "same.md"), "same\n");

    const res = await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/old", { name: "Renamed" });
    expect(res.status).toBe(200);

    expect(existsSync(join(fx.cwd, "projects", "old"))).toBe(false);
    expect(readFileSync(join(newMemory, "MEMORY.md"), "utf8")).toBe("new index\n");
    expect(readFileSync(join(newMemory, "新.md"), "utf8")).toBe("new fact\n");
    expect(readFileSync(join(newMemory, "旧.md"), "utf8")).toBe("old fact\n");
    // the old index survives beside the new one; the identical file leaves a single copy
    expect(readFileSync(join(newMemory, "MEMORY.from-projects.md"), "utf8")).toBe("old index\n");
    expect(readdirSync(newMemory).sort()).toEqual(["MEMORY.from-projects.md", "MEMORY.md", "same.md", "旧.md", "新.md"].sort());
  });

  test("AC-005: a new space and its membership are written under the new names only", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "legacy-mark", fx.cwd, [userEntry("u1", null, "first")]);
    writeMarksFile(fx.cwd, { "legacy-mark": { project: "made-before" } });
    placeLegacyProjectFile(fx, "made-before", "name: Before");

    const made = await api(fx, "POST", "/api/conversations/workspaces/chat/spaces", { id: "fresh", name: "Fresh", memory: "space" });
    expect(made.status).toBe(200);
    expect(existsSync(join(fx.cwd, "spaces", "fresh", "space.md"))).toBe(true);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", space: "fresh" }));
    // any write of a mark stores the old session's membership under the new field too
    expect((await marks(fx, "legacy-mark", { pinned: false })).status).toBe(200);

    expect(existsSync(join(fx.cwd, "projects", "fresh"))).toBe(false);
    const file = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, Record<string, unknown>> };
    expect(file.sessions[created.id]?.space).toBe("fresh");
    expect(file.sessions["legacy-mark"]?.space).toBe("made-before");
    for (const mark of Object.values(file.sessions)) expect("project" in mark).toBe(false);
  });

  test("an id an old definition holds cannot be created again", async () => {
    const fx = fixture();
    placeLegacyProjectFile(fx, "taken", "name: Taken");
    const dup = await api(fx, "POST", "/api/conversations/workspaces/chat/spaces", { id: "taken" });
    expect(dup.status).toBe(409);
    expect(existsSync(join(fx.cwd, "spaces", "taken"))).toBe(false);
  });
});

describe("the space context", () => {
  test("AC-014 / AC-015: the instruction and reference paths ride in --append-system-prompt", async () => {
    const fx = fixture();
    const refFile = join(fx.root, "ref.txt");
    writeFileSync(refFile, "MARKER-IN-FILE");
    placeSpaceFile(fx, "alpha", `name: Alpha\nreferences:\n  - ${refFile}`, "INSTRUCTION-SECRET");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" }));
    await until(() => starts(fx).length === 1);
    const argv = String(starts(fx)[0].argv);
    expect(argv).toContain("--append-system-prompt");
    expect(argv).toContain("INSTRUCTION-SECRET");
    expect(argv).toContain("Alpha");
    expect(argv).toContain(refFile);
    expect(argv).not.toContain("MARKER-IN-FILE");

    // a conversation without a space gets no appendix
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === 2);
    expect(argvWithoutInstructions(starts(fx)[1])).not.toContain("--append-system-prompt");

    // a reopen carries the same appendix, an updated one carries the new text, and a deleted space adds nothing
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 3);
    expect(String(starts(fx)[2].argv)).toContain("INSTRUCTION-SECRET");
    await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/alpha", { instruction: "UPDATED-SECRET" });
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 4);
    expect(String(starts(fx)[3].argv)).toContain("UPDATED-SECRET");
    rmSync(join(fx.cwd, "spaces", "alpha"), { recursive: true, force: true });
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 5);
    expect(argvWithoutInstructions(starts(fx)[4])).not.toContain("--append-system-prompt");
  });

  test("AC-016 / AC-017: the memory handling decides the text, and the engine writes no memory file", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "index before\n");
    placeSpaceFile(fx, "none", "name: None\nmemory: none", "i");
    placeSpaceFile(fx, "inside", "name: Inside\nmemory: space", "i");
    placeSpaceFile(fx, "shared", "name: Shared\nmemory: shared", "i");
    for (const id of ["none", "inside", "shared"]) {
      await api(fx, "POST", "/api/conversations", { mode: "chat", space: id });
    }
    await until(() => starts(fx).length === 3);
    expect(String(starts(fx)[0].argv)).not.toContain("spaces/none/memory");
    expect(String(starts(fx)[1].argv)).toContain("spaces/inside/memory");
    // an inside space's memory keeps its own index and is never added to the top-level index
    expect(String(starts(fx)[1].argv)).toContain("全体の索引には足さない");
    expect(String(starts(fx)[1].argv)).not.toContain("を指す領域の 1 行を足す");
    // a shared space's memory is added to the top-level index as one region
    expect(String(starts(fx)[2].argv)).toContain("spaces/shared/memory/MEMORY.md");
    expect(String(starts(fx)[2].argv)).toContain("を指す領域の 1 行を足す");
    expect(existsSync(join(fx.cwd, "memory", "MEMORY.md"))).toBe(true);
    for (const space of ["none", "inside", "shared"]) expect(existsSync(join(fx.cwd, "spaces", space, "memory"))).toBe(false);
    expect(readFileSync(join(fx.cwd, "memory", "MEMORY.md"), "utf8")).toBe("index before\n");
  });

  test("F-2: a membership change through the marks door is what the next pi start uses", async () => {
    const fx = fixture();
    placeSpaceFile(fx, "alpha", "name: Alpha", "ALPHA-CONTEXT");
    placeSpaceFile(fx, "beta", "name: Beta", "BETA-CONTEXT");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" }));
    await until(() => starts(fx).length === 1);
    expect(String(starts(fx)[0].argv)).toContain("ALPHA-CONTEXT");

    // the mark is changed while the conversation is open: a restart in the same conversation must use it
    expect((await marks(fx, created.id, { space: "beta" })).status).toBe(200);
    process.kill(starts(fx)[0].pid as number, "SIGKILL");
    await sleep(150);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => starts(fx).length === 2, 5000);
    await until(() => count(fx, "settled") >= 1, 5000);
    expect(String(starts(fx)[1].argv)).toContain("BETA-CONTEXT");
    expect(String(starts(fx)[1].argv)).not.toContain("ALPHA-CONTEXT");

    // removing the membership takes effect the same way
    expect((await marks(fx, created.id, { space: null })).status).toBe(200);
    process.kill(starts(fx)[1].pid as number, "SIGKILL");
    await sleep(150);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => starts(fx).length === 3, 5000);
    expect(argvWithoutInstructions(starts(fx)[2])).not.toContain("--append-system-prompt");
  });
});

// ---- the memory context ----

describe("the memory context", () => {
  test("AC-001: the top-level index rides as a path at every start, and its rewrite reaches the next pi", async () => {
    const fx = fixture();
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "FIRST-INDEX\n");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    const argv = String(starts(fx)[0].argv);
    expect(argv).toContain("--append-system-prompt");
    expect(argv).toContain(join(fx.cwd, "memory"));
    expect(argv).toContain(join(fx.cwd, "memory", "MEMORY.md"));
    // the engine never holds the index's text: pi reads the path at start
    expect(argv).not.toContain("FIRST-INDEX");

    // a rewrite of the index reaches the next start, and a reopen takes the same path
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "SECOND-INDEX\n");
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 2);
    const reopened = String(starts(fx)[1].argv);
    expect(reopened).toContain(join(fx.cwd, "memory", "MEMORY.md"));
    expect(reopened).not.toContain("FIRST-INDEX");
    expect(reopened).not.toContain("SECOND-INDEX");
  });

  test("AC-002: only the top level is appended, and the type instruction carries no memory location", async () => {
    const fx = fixture();
    typedModes(fx);
    mkdirSync(join(fx.cwd, "memory", "region"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "- [region](region/MEMORY.md) REGION-LINE\n");
    writeFileSync(join(fx.cwd, "memory", "region", "MEMORY.md"), "REGION-INDEX\n");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);

    const instruction = commands(fx).find((c) => c.cmd === "type-prompt" && c.type === "chat") as { message: string };
    expect(instruction.message).not.toContain("memory:");
    expect(instruction.message).not.toContain(join(fx.cwd, "memory"));

    const argv = String(starts(fx)[0].argv);
    expect(argv).toContain(join(fx.cwd, "memory", "MEMORY.md"));
    // a region's index and the top-level index's own text stay out of the arguments
    expect(argv).not.toContain(join(fx.cwd, "memory", "region", "MEMORY.md"));
    expect(argv).not.toContain("REGION-LINE");
    expect(argv).not.toContain("REGION-INDEX");
  });

  test("AC-003: a mode with no index adds no memory text until the file appears", async () => {
    const fx = fixture();
    expect(existsSync(join(fx.cwd, "memory"))).toBe(false);
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === 1);
    expect(argvWithoutInstructions(starts(fx)[0])).not.toContain("--append-system-prompt");
    expect(String(starts(fx)[0].argv)).not.toContain(join(fx.cwd, "memory"));

    // once the index exists, the next pi start gets it
    mkdirSync(join(fx.cwd, "memory"), { recursive: true });
    writeFileSync(join(fx.cwd, "memory", "MEMORY.md"), "index\n");
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === 2);
    expect(String(starts(fx)[1].argv)).toContain(join(fx.cwd, "memory", "MEMORY.md"));
  });
});

describe("the session marks", () => {
  test("AC-019 / AC-026: the list sorts by created, activity and name, and keeps the old default without a query", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSessionAt(dir, "s-old", fx.cwd, "2026-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:00Z"), [{ type: "session_info", id: "n1", parentId: null, name: "zulu" }]);
    placeSessionAt(dir, "s-mid", fx.cwd, "2026-03-01T00:00:00.000Z", new Date("2026-02-01T00:00:00Z"), [{ type: "session_info", id: "n2", parentId: null, name: "alpha" }]);
    placeSessionAt(dir, "s-new", fx.cwd, "2026-06-01T00:00:00.000Z", new Date("2026-06-01T00:00:00Z"), [{ type: "session_info", id: "n3", parentId: null, name: "mike" }]);
    placeSessionAt(dir, "s-none", fx.cwd, "2026-04-01T00:00:00.000Z", new Date("2026-03-01T00:00:00Z"), []);

    expect((await listBody(fx, "?sort=created")).conversations.map((c) => c.id)).toEqual(["s-new", "s-none", "s-mid", "s-old"]);
    expect((await listBody(fx, "?sort=updated&direction=asc")).conversations.map((c) => c.id)).toEqual(["s-old", "s-mid", "s-none", "s-new"]);
    expect((await listBody(fx, "?sort=name&direction=asc")).conversations.map((c) => c.id)).toEqual(["s-mid", "s-new", "s-old", "s-none"]);
    // no query: newest activity first, the way the list has always answered
    expect((await listBody(fx)).conversations.map((c) => c.id)).toEqual(["s-new", "s-none", "s-mid", "s-old"]);
    const bad = await api(fx, "GET", "/api/conversations?sort=nope");
    expect(bad.status).toBe(400);
  });

  test("AC-020: the date grouping buckets the sorted key by the machine's days", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    placeSessionAt(dir, "d-today", fx.cwd, new Date(now.getTime()).toISOString(), new Date(now));
    placeSessionAt(dir, "d-yesterday", fx.cwd, new Date(now.getTime() - day).toISOString(), new Date(now.getTime() - day));
    placeSessionAt(dir, "d-10", fx.cwd, new Date(now.getTime() - 10 * day).toISOString(), new Date(now.getTime() - 10 * day));
    placeSessionAt(dir, "d-old", fx.cwd, new Date(now.getTime() - 70 * day).toISOString(), new Date(now.getTime() - 70 * day));
    const grouped = await listBody(fx, "?group=date");
    expect(grouped.groups?.map((g) => g.key)).toEqual(["today", "yesterday", "last30", "older"]);
    for (const group of grouped.groups ?? []) expect(group.conversations.length).toBe(1);
    const byCreated = await listBody(fx, "?group=date&sort=created&direction=asc");
    expect(byCreated.groups?.map((g) => g.key)).toEqual(["older", "last30", "yesterday", "today"]);
  });

  test("AC-021 / AC-022: pinning, archiving and the archive query", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "m-one", fx.cwd, []);
    placeSession(dir, "m-two", fx.cwd, []);
    expect((await marks(fx, "m-one", { pinned: true })).status).toBe(200);
    const pinned = await listBody(fx);
    expect(pinned.conversations.find((c) => c.id === "m-one")?.pinned).toBe(true);
    const grouped = await listBody(fx, "?group=date");
    expect(grouped.groups?.[0].key).toBe("pinned");
    expect(grouped.groups?.[0].conversations.map((c) => c.id)).toEqual(["m-one"]);
    for (const group of grouped.groups?.slice(1) ?? []) expect(group.conversations.some((c) => c.id === "m-one")).toBe(false);
    expect((await marks(fx, "m-one", { pinned: null })).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === "m-one")?.pinned).toBe(false);

    expect((await marks(fx, "m-two", { archived: true })).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === "m-two")?.archived).toBe(true);
    expect((await listBody(fx, "?archive=exclude")).conversations.some((c) => c.id === "m-two")).toBe(false);
    expect((await listBody(fx, "?archive=only")).conversations.map((c) => c.id)).toEqual(["m-two"]);
    expect((await api(fx, "GET", "/api/conversations/m-two")).status).toBe(200);

    // a conversation that has not been sent to can still be pinned (no pi is started by the mark door)
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const before = starts(fx).length;
    expect((await marks(fx, created.id, { pinned: true })).status).toBe(200);
    expect(starts(fx).length).toBe(before);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
  });

  test("AC-023 / AC-024: bookmark kinds, grouping and the space grouping", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "b-one", fx.cwd, []);
    placeSession(dir, "b-two", fx.cwd, []);
    expect((await api(fx, "POST", "/api/conversations/workspaces/chat/bookmarks", { id: "todo", label: "To do" })).status).toBe(200);
    expect((await api(fx, "POST", "/api/conversations/workspaces/chat/bookmarks", { id: "read", label: "Read" })).status).toBe(200);
    expect((await marks(fx, "b-one", { bookmarks: ["todo", "read"] })).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === "b-one")?.bookmarks).toEqual(["todo", "read"]);
    expect((await marks(fx, "b-one", { bookmarks: ["nope"] })).status).toBe(400);
    const grouped = await listBody(fx, "?group=bookmark");
    const keys = grouped.groups?.map((g) => g.key) ?? [];
    expect(keys).toContain("todo");
    expect(keys).toContain("read");
    expect(keys).toContain("none");
    expect(grouped.groups?.find((g) => g.key === "todo")?.conversations.some((c) => c.id === "b-one")).toBe(true);
    expect(grouped.groups?.find((g) => g.key === "none")?.conversations.map((c) => c.id)).toEqual(["b-two"]);

    await api(fx, "PATCH", "/api/conversations/workspaces/chat/bookmarks/todo", { label: "To-do" });
    expect((await json<{ bookmarks: { id: string; label: string }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/bookmarks"))).bookmarks.find((b) => b.id === "todo")?.label).toBe("To-do");
    expect((await api(fx, "DELETE", "/api/conversations/workspaces/chat/bookmarks/todo")).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === "b-one")?.bookmarks).toEqual(["read"]);

    placeSpaceFile(fx, "alpha", "name: Alpha");
    expect((await marks(fx, "b-one", { space: "alpha" })).status).toBe(200);
    const spaceGroups = await listBody(fx, "?group=space");
    expect(spaceGroups.groups?.find((g) => g.key === "alpha")?.conversations.map((c) => c.id)).toEqual(["b-one"]);
    expect(spaceGroups.groups?.find((g) => g.key === "none")?.conversations.map((c) => c.id)).toEqual(["b-two"]);
    expect((await listBody(fx, "?space=alpha")).conversations.map((c) => c.id)).toEqual(["b-one"]);
  });

  test("F-3: a mark naming a space whose dir is gone reads as no membership", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "gone-one", fx.cwd, []);
    placeSession(dir, "gone-two", fx.cwd, []);
    placeSpaceFile(fx, "alpha", "name: Alpha");
    expect((await marks(fx, "gone-one", { space: "alpha" })).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === "gone-one")?.space).toBe("alpha");

    rmSync(join(fx.cwd, "spaces", "alpha"), { recursive: true, force: true });
    expect((await listBody(fx)).conversations.find((c) => c.id === "gone-one")?.space).toBeUndefined();
    expect((await listBody(fx, "?space=alpha")).conversations.length).toBe(0);
    const grouped = await listBody(fx, "?group=space");
    expect(grouped.groups?.some((g) => g.key === "alpha")).toBe(false);
    expect(grouped.groups?.find((g) => g.key === "none")?.conversations.some((c) => c.id === "gone-one")).toBe(true);
  });

  test("AC-025: the list entry carries exactly the old fields plus the marks, workdir and space", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "k-one", fx.cwd, [{ type: "session_info", id: "n1", parentId: null, name: "named" }]);
    placeSpaceFile(fx, "alpha", "name: Alpha");
    await marks(fx, "k-one", { space: "alpha" });
    const summary = (await listBody(fx)).conversations.find((c) => c.id === "k-one") as unknown as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "archived", "bookmarks", "cost", "createdAt", "cwd", "id", "mode", "name", "open", "pinned", "running", "space", "tools", "updatedAt", "workdir",
    ]);
  });

  test("AC-027 / AC-028 / AC-036: marks leave pi's record alone, survive a corrupt file, and need no pi", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    const file = placeSession(dir, "z-one", fx.cwd, [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } }]);
    const before = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    await marks(fx, "z-one", { pinned: true });
    await api(fx, "POST", "/api/conversations/workspaces/chat/bookmarks", { id: "k" });
    await marks(fx, "z-one", { bookmarks: ["k"], archived: true });
    placeSpaceFile(fx, "alpha", "name: Alpha");
    await marks(fx, "z-one", { space: "alpha" });
    expect(starts(fx)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);

    // a broken marks file is no marks to a read, and a read never moves it
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const healthy = await api(fx, "GET", "/api/conversations");
    expect(healthy.status).toBe(200);
    expect((await json<ListBody>(healthy)).conversations.find((c) => c.id === "z-one")?.pinned).toBe(false);
    expect(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")).toBe("{not json");

    // a write on a broken file is refused and the file is moved aside, so the same write can be retried
    const refused = await marks(fx, "z-one", { pinned: true });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const broken = readdirSync(join(fx.cwd, ".propter")).filter((name) => name.startsWith("sessions.json.broken-"));
    expect(broken.length).toBe(1);
    expect(readFileSync(join(fx.cwd, ".propter", broken[0]), "utf8")).toBe("{not json");
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);
    expect((await marks(fx, "z-one", { pinned: true })).status).toBe(200);
    expect(() => JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8"))).not.toThrow();

    // a mark is removable from a session whose cwd dir is gone
    rmSync(fx.cwd, { recursive: true, force: true });
    mkdirSync(fx.cwd, { recursive: true });
    expect((await marks(fx, "z-one", { archived: true })).status).toBe(200);

    // deleting the conversation removes its mark
    placeSession(dir, "z-two", fx.cwd, []);
    await marks(fx, "z-two", { pinned: true });
    await api(fx, "DELETE", "/api/conversations/z-two");
    const marksFile = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, unknown> };
    expect(marksFile.sessions["z-two"]).toBeUndefined();
  });
});

describe("an open conversation in the list", () => {
  test("F-1: opening a conversation keeps the record's name and createdAt", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSessionAt(dir, "open-one", fx.cwd, "2026-02-01T00:00:00.000Z", new Date("2026-05-01T00:00:00Z"), [{ type: "session_info", id: "n1", parentId: null, name: "kept-name" }]);
    const before = (await listBody(fx)).conversations.find((c) => c.id === "open-one") as Summary;
    expect(before.name).toBe("kept-name");
    expect(before.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(before.open).toBe(false);

    expect((await api(fx, "GET", "/api/conversations/open-one")).status).toBe(200);
    await until(() => starts(fx).length === 1);
    const after = (await listBody(fx)).conversations.find((c) => c.id === "open-one") as Summary;
    expect(after.name).toBe("kept-name");
    expect(after.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(after.open).toBe(true);
    expect(after.running).toBe(false);
    await api(fx, "POST", "/api/conversations/open-one/close");
  });
});

describe("branches and spaces", () => {
  test("AC-032 / AC-033: a branch keeps its workdir cwd, and promotion moves the record to that cwd's place", async () => {
    const fx = fixture();
    const workdir = join(fx.cwd, "w", "a");
    mkdirSync(workdir, { recursive: true });
    const dir = sessionDirOf(fx, "chat", workdir);
    placeSessionAt(dir, "wp-parent", workdir, "2026-02-01T00:00:00.000Z", undefined, [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const forked = await fork(fx, "wp-parent", { at: "a1" });
    expect(forked.res.status).toBe(200);
    expect(forked.body.cwd).toBe(workdir);
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].cwd).toBe(workdir);

    const promoted = await json<{ cwd: string }>(await api(fx, "POST", `/api/conversations/${forked.body.id}/promote`, {}));
    expect(promoted.cwd).toBe(workdir);
    const kept = readdirSync(dir).filter((n) => n.endsWith(`_${forked.body.id}.jsonl`));
    expect(kept.length).toBe(1);
    const header = JSON.parse(readFileSync(join(dir, kept[0]), "utf8").split("\n")[0]) as { cwd: string };
    expect(header.cwd).toBe(workdir);
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${forked.body.id}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(starts(fx).at(-1)?.cwd).toBe(workdir);

    // a branch whose cwd is outside the target workspace is promoted to the workspace
    const outside = await fork(fx, "wp-parent", { at: "a1", cwd: fx.ideaCwd });
    const promotedOut = await json<{ cwd: string }>(await api(fx, "POST", `/api/conversations/${outside.body.id}/promote`, { mode: "chat" }));
    expect(promotedOut.cwd).toBe(fx.cwd);
  });

  test("AC-035: a space membership follows a fork and a branch, and lands in the mark on promotion", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSpaceFile(fx, "alpha", "name: Alpha", "SECRET-CONTEXT");
    placeSession(dir, "proj-parent", fx.cwd, [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    await marks(fx, "proj-parent", { space: "alpha" });

    // pi's fork re-registers the session: the new id's mark carries the same space
    process.env.FAKE_PI_FORK_ID = "proj-forked";
    const opened = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" }));
    await until(() => starts(fx).length >= 1);
    await api(fx, "POST", `/api/conversations/${opened.id}/command`, { type: "fork", entryId: "u1" });
    const marksFile = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { space?: string }> };
    expect(marksFile.sessions["proj-forked"]?.space).toBe("alpha");
    delete process.env.FAKE_PI_FORK_ID;

    // an ephemeral branch carries the context but has no mark of its own
    const branch = await fork(fx, "proj-parent", { at: "a1" });
    expect(branch.res.status).toBe(200);
    await until(() => starts(fx).some((s) => s.session === branch.body.id));
    const branchStart = starts(fx).find((s) => s.session === branch.body.id) as Record<string, unknown>;
    expect(String(branchStart.argv)).toContain("SECRET-CONTEXT");
    const afterBranch = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, unknown> };
    expect(afterBranch.sessions[branch.body.id as string]).toBeUndefined();

    await api(fx, "POST", `/api/conversations/${branch.body.id}/promote`, { mode: "chat" });
    const afterPromote = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { space?: string }> };
    expect(afterPromote.sessions[branch.body.id as string]?.space).toBe("alpha");
  });
});

// ---- the conversation side features: titles, search, settings, quota, transcription ----

async function untilAsync(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(30);
  }
}

function writeSettingsFile(state: string, value: Record<string, unknown>): void {
  mkdirSync(join(state, "pipeline"), { recursive: true });
  writeFileSync(conversationSettingsPath(), `${JSON.stringify(value, null, 2)}\n`);
}

function skillFile(dir: string, name: string, description = "desc"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

function costLines(): Record<string, unknown>[] {
  if (!existsSync(conversationCostPath())) return [];
  return readFileSync(conversationCostPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("automatic titles", () => {
  test("AC-001 / AC-002: a nameless session is titled by a separate one-shot run, never by its own pi", async () => {
    const fx = fixture();
    process.env.FAKE_PI_TITLE = "テストの題名";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const seen = await readUntil(events, (e) => e.type === "name", 10_000);
    expect(seen.some((e) => e.type === "name" && e.name === "テストの題名")).toBe(true);
    await until(() => oneshots(fx).length === 1, 8000);
    const shot = oneshots(fx)[0];
    expect(shot.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(shot.mode).toBe("json");
    for (const flag of ["noTools", "noSkills", "noExtensions", "noContext", "noSession"]) expect(shot[flag], flag).toBe(true);
    expect(String(shot.message)).toContain("one");
    // the conversation's pi received exactly one prompt and no title instruction
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one"]);
    expect(count(fx, "steer")).toBe(0);
    expect(count(fx, "follow_up")).toBe(0);
    await until(() => commands(fx).some((c) => c.cmd === "set_session_name" && c.name === "テストの題名"));
    await untilAsync(async () => {
      const body = await json<{ conversations: { id: string; name?: string }[] }>(await api(fx, "GET", "/api/conversations"));
      return body.conversations.find((c) => c.id === created.id)?.name === "テストの題名";
    });
    const titles = costLines().filter((l) => l.title === true);
    expect(titles.length).toBe(1);
    expect(titles[0].sessionId).toBe(created.id);
    await events.close();
  });

  test("AC-001: a titler that fails leaves the run completed and the session unnamed", async () => {
    const fx = fixture();
    process.env.FAKE_PI_ONESHOT_FAIL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const all = await readUntil(events, (e) => e.type === "end", 8000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("completed");
    await until(() => oneshots(fx).length === 1);
    await sleep(400);
    expect(commands(fx).some((c) => c.cmd === "set_session_name")).toBe(false);
    const body = await json<{ conversations: { id: string; name?: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(body.conversations.find((c) => c.id === created.id)?.name).toBeUndefined();
    await events.close();
  });

  test("a titler that ignores SIGTERM is stopped inside the limit, the mark comes off, and the title can be asked for again", async () => {
    const fx = fixture();
    setOneShotLimits({ timeoutMs: 400, graceMs: 200 });
    placeChatParent(fx, "retitle-hang", [userEntry("u1", null, "hang-user"), assistantEntry("a1", "u1", "hang-assistant")]);
    process.env.FAKE_PI_ONESHOT_HANG = "1";
    const started = Date.now();
    const first = await api(fx, "POST", "/api/conversations/retitle-hang/title", {});
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(first.status).not.toBe(409);
    expect(Date.now() - started).toBeLessThan(4_000);
    // the in-flight mark is off: the same conversation's title is asked for again, not refused
    delete process.env.FAKE_PI_ONESHOT_HANG;
    process.env.FAKE_PI_TITLE = "頼み直した題名";
    const second = await api(fx, "POST", "/api/conversations/retitle-hang/title", {});
    expect(second.status).toBe(200);
    expect((await json<{ name: string }>(second)).name).toBe("頼み直した題名");
  });

  test("a titler that answers and exits is read as it ended while a grandchild holds the pipes", async () => {
    const fx = fixture();
    setOneShotLimits({ timeoutMs: 3_000, graceMs: 200, drainMs: 200 });
    placeChatParent(fx, "retitle-grandchild", [userEntry("u1", null, "gc-user"), assistantEntry("a1", "u1", "gc-assistant")]);
    process.env.FAKE_PI_ONESHOT_GRANDCHILD = "1";
    process.env.FAKE_PI_TITLE = "孫がいる題名";
    const started = Date.now();
    const res = await api(fx, "POST", "/api/conversations/retitle-grandchild/title", {});
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("孫がいる題名");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(costLines().filter((l) => l.title === true).length).toBe(1);
  });

  test("AC-001: the material is cut before the queue's next turn is sent", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "250";
    process.env.FAKE_PI_ONESHOT_MS = "800";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "first-turn" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "second-turn" });
    await until(() => oneshots(fx).length === 1, 8000);
    expect(String(oneshots(fx)[0].message)).toContain("first-turn");
    expect(String(oneshots(fx)[0].message)).not.toContain("second-turn");
  });

  test("AC-001: an ephemeral branch is never auto-titled", async () => {
    const fx = fixture();
    placeChatParent(fx, "title-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "title-parent", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "hi" });
    await until(() => count(fx, "prompt") === 1);
    await sleep(500);
    expect(oneshots(fx).length).toBe(0);
  });
});

describe("protecting a name", () => {
  test("AC-003: a named session is never auto-titled", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "named-1", fx.cwd, [
      { type: "session_info", id: "n1", parentId: null, name: "利用者の題名" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } },
    ]);
    await api(fx, "POST", "/api/conversations/named-1/messages", { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await sleep(500);
    expect(oneshots(fx).length).toBe(0);
    const body = await json<{ conversations: { id: string; name?: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(body.conversations.find((c) => c.id === "named-1")?.name).toBe("利用者の題名");
  });

  test("AC-003: a name set while the title generates wins", async () => {
    const fx = fixture();
    process.env.FAKE_PI_TITLE = "生成された題名";
    process.env.FAKE_PI_ONESHOT_MS = "700";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => oneshots(fx).length === 1, 8000);
    await api(fx, "POST", `/api/conversations/${created.id}/command`, { type: "set_session_name", name: "利用者の題名" });
    await until(() => commands(fx).some((c) => c.cmd === "set_session_name" && c.name === "利用者の題名"));
    await sleep(900);
    expect(commands(fx).some((c) => c.cmd === "set_session_name" && c.name === "生成された題名")).toBe(false);
    const body = await json<{ conversations: { id: string; name?: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(body.conversations.find((c) => c.id === created.id)?.name).toBe("利用者の題名");
  });
});

describe("retitling", () => {
  test("AC-004: uses the last configured turns of the current branch, without tool results", async () => {
    const fx = fixture();
    const entries = [
      userEntry("u1", null, "turn-one-user"),
      assistantEntry("a1", "u1", "turn-one-assistant"),
      userEntry("u2", "a1", "turn-two-user"),
      assistantEntry("a2", "u2", "turn-two-assistant"),
      { type: "message", id: "t2", parentId: "a2", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "TOOL-OUTPUT" }] } },
      userEntry("u3", "a2", "turn-three-user"),
      assistantEntry("a3", "u3", "turn-three-assistant"),
      userEntry("u4", "a3", "turn-four-user"),
      assistantEntry("a4", "u4", "turn-four-assistant"),
      userEntry("u5", "a4", "turn-five-user"),
      assistantEntry("a5", "u5", "turn-five-assistant"),
    ];
    placeChatParent(fx, "retitle-1", entries);
    process.env.FAKE_PI_TITLE = "付け直した題名";
    const res = await api(fx, "POST", "/api/conversations/retitle-1/title", {});
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("付け直した題名");
    await until(() => oneshots(fx).length === 1);
    const material = String(oneshots(fx)[0].message);
    for (const needle of ["turn-three-user", "turn-four-assistant", "turn-five-assistant"]) expect(material).toContain(needle);
    expect(material).not.toContain("turn-one-user");
    expect(material).not.toContain("turn-two-user");
    expect(material).not.toContain("TOOL-OUTPUT");
  });

  test("AC-004: title_context_turns of 1 cuts to a single turn, and a concurrent call is 409", async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "roles.yaml"), [
      "defaults:",
      "  title_context_turns: 1",
      "models:",
      "  openrouter-z-ai-glm-5.3:",
      "    model: openrouter/z-ai/glm-5.3",
      "  openrouter-z-ai-glm-5.3-flash:",
      "    model: openrouter/z-ai/glm-5.3-flash",
      "roles:",
      "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash] }",
      "  ideas: { model: openrouter-z-ai-glm-5.3, thinking: low, tools: [read] }",
      "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
    ].join("\n") + "\n");
    placeChatParent(fx, "retitle-2", [
      userEntry("u1", null, "old-user"), assistantEntry("a1", "u1", "old-assistant"),
      userEntry("u2", "a1", "newest-user"), assistantEntry("a2", "u2", "newest-assistant"),
    ]);
    process.env.FAKE_PI_ONESHOT_MS = "600";
    const first = api(fx, "POST", "/api/conversations/retitle-2/title", {});
    await until(() => oneshots(fx).length === 1, 8000);
    const second = await api(fx, "POST", "/api/conversations/retitle-2/title", {});
    expect(second.status).toBe(409);
    await first;
    const material = String(oneshots(fx)[0].message);
    expect(material).toContain("newest-user");
    expect(material).not.toContain("old-user");
  });
});

describe("searching the records", () => {
  test("AC-005: finds words in a person's and the assistant's text and in a name, case-insensitively", async () => {
    const fx = fixture();
    placeSession(sessionDirOf(fx, "chat", fx.cwd), "search-a", fx.cwd, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Hello NEEDLE body" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
      { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "HIDDENWORD" }] } },
      { type: "message", id: "a2", parentId: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: "THINKWORD" }] } },
    ]);
    placeSession(sessionDirOf(fx, "ideas", fx.ideaCwd), "search-b", fx.ideaCwd, [
      { type: "session_info", id: "n1", parentId: null, name: "NAMEWORD session" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "nothing here" } },
    ]);
    const res = await api(fx, "GET", "/api/conversation-search?q=needle");
    expect(res.status).toBe(200);
    const body = await json<{ results: { sessionId: string; hits: { entryId: string | null; role: string }[] }[] }>(res);
    expect(body.results.map((r) => r.sessionId)).toEqual(["search-a"]);
    expect(body.results[0].hits[0].entryId).toBe("u1");
    expect(body.results[0].hits[0].role).toBe("user");

    const byName = await json<{ results: { sessionId: string; hits: { role: string }[] }[] }>(await api(fx, "GET", "/api/conversation-search?q=nameword"));
    expect(byName.results.map((r) => r.sessionId)).toEqual(["search-b"]);
    expect(byName.results[0].hits[0].role).toBe("session");

    const modeFiltered = await json<{ results: unknown[] }>(await api(fx, "GET", "/api/conversation-search?q=needle&mode=idea"));
    expect(modeFiltered.results).toEqual([]);
    expect((await api(fx, "GET", "/api/conversation-search?q=hiddenword")).status).toBe(200);
    const hidden = await json<{ results: unknown[] }>(await api(fx, "GET", "/api/conversation-search?q=hiddenword"));
    expect(hidden.results).toEqual([]);
    const think = await json<{ results: unknown[] }>(await api(fx, "GET", "/api/conversation-search?q=thinkword"));
    expect(think.results).toEqual([]);
    expect((await api(fx, "GET", "/api/conversation-search?q=")).status).toBe(400);
  });

  test("AC-006: searching starts no pi and never changes a record", async () => {
    const fx = fixture();
    const file = placeSession(sessionDirOf(fx, "chat", fx.cwd), "search-c", fx.cwd, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "findme" } },
    ]);
    const before = readFileSync(file, "utf8");
    const beforeMtime = statSync(file).mtimeMs;
    await api(fx, "GET", "/api/conversation-search?q=findme");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
    expect(starts(fx)).toEqual([]);
    expect(oneshots(fx)).toEqual([]);
  });
});

describe("conversation settings", () => {
  test("AC-007: lists candidates with their places and toggles them on", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      skillFile(join(home, ".agents", "skills", "user-one"), "user-one");
      skillFile(join(fx.userAgent, "skills", "user-two"), "user-two");
      skillFile(join(fx.cwd, ".agents", "skills", "ws-one"), "ws-one");
      skillFile(join(fx.ideaCwd, ".pi", "skills", "ws-two"), "ws-two");
      mkdirSync(join(fx.cwd, ".agents", "skills", "no-skill"), { recursive: true });
      mkdirSync(join(fx.root, ".git"), { recursive: true });
      skillFile(join(fx.root, ".pi", "skills", "proj-one"), "proj-one");

      const res = await api(fx, "GET", "/api/conversation-settings");
      expect(res.status).toBe(200);
      const body = await json<{ settings: { webSearch: boolean; mcp: boolean; skills: string[] }; candidates: { path: string; name: string; origin: string; enabled: boolean }[] }>(res);
      expect(body.settings.webSearch).toBe(true);
      expect(body.settings.mcp).toBe(false);
      expect(body.settings.skills).toEqual([]);
      const names = new Map(body.candidates.map((c) => [c.name, c.origin]));
      expect(names.get("user-one")).toBe("user");
      expect(names.get("user-two")).toBe("user");
      expect(names.get("ws-one")).toBe("workspace");
      expect(names.get("ws-two")).toBe("workspace");
      expect(names.has("no-skill")).toBe(false);
      expect(names.has("proj-one")).toBe(false);

      const withCwd = await json<{ candidates: { name: string; origin: string }[] }>(await api(fx, "GET", `/api/conversation-settings?cwd=${encodeURIComponent(fx.cwd)}`));
      const proj = withCwd.candidates.find((c) => c.name === "proj-one");
      expect(proj?.origin).toBe("repo");

      const patch = await api(fx, "PATCH", "/api/conversation-settings", { skills: [join(home, ".agents", "skills", "user-one")] });
      expect(patch.status).toBe(200);
      const after = await json<{ settings: { skills: string[] } }>(await api(fx, "GET", "/api/conversation-settings"));
      expect(after.settings.skills).toEqual([join(home, ".agents", "skills", "user-one")]);
      const refused = await api(fx, "PATCH", "/api/conversation-settings", { skills: [join(fx.root, "arbitrary")] });
      expect(refused.status).toBe(400);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  test("AC-004: another cwd's skill stays on while a new path outside the cwd is refused", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const chatSkill = join(fx.cwd, ".agents", "skills", "chat-one");
      const ideaSkill = join(fx.ideaCwd, ".agents", "skills", "idea-one");
      skillFile(chatSkill, "chat-one");
      skillFile(ideaSkill, "idea-one");

      // the idea's skill is turned on from the idea's own cwd, where it is a candidate
      const first = await json<{ settings: { skills: string[] } }>(await api(fx, "PATCH", "/api/conversation-settings", { skills: [ideaSkill], cwd: fx.ideaCwd }));
      expect(first.settings.skills).toEqual([ideaSkill]);

      // from the chat's cwd the idea's skill is no candidate at all, but it is already on, so it stays and the
      // new chat skill is taken in the same request; what a chat conversation is handed is only its own candidate
      const second = await json<{ settings: { skills: string[] }; effectiveSkills: string[] }>(await api(fx, "PATCH", "/api/conversation-settings", { skills: [ideaSkill, chatSkill], cwd: fx.cwd }));
      expect(second.settings.skills).toEqual([ideaSkill, chatSkill]);
      expect(second.effectiveSkills).toEqual([chatSkill]);

      // a path this change would newly turn on and that is not a candidate is still refused, and nothing moves
      const refused = await api(fx, "PATCH", "/api/conversation-settings", { skills: [ideaSkill, chatSkill, join(fx.root, "arbitrary")], cwd: fx.cwd });
      expect(refused.status).toBe(400);
      const after = await json<{ settings: { skills: string[] } }>(await api(fx, "GET", "/api/conversation-settings"));
      expect(after.settings.skills).toEqual([ideaSkill, chatSkill]);

      const shown = await json<{ candidates: { path: string; enabled: boolean }[] }>(await api(fx, "GET", `/api/conversation-settings?cwd=${encodeURIComponent(fx.cwd)}`));
      expect(shown.candidates.find((c) => c.path === chatSkill)?.enabled).toBe(true);
      expect(shown.candidates.some((c) => c.path === ideaSkill)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });
});

describe("skills and tools in the launch arguments", () => {
  test("AC-008 / AC-010: discovery is off, only enabled candidates are handed over, and the features shape --tools", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const skillDir = join(home, ".agents", "skills", "keeper");
      skillFile(skillDir, "keeper");
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      await until(() => starts(fx).length === 1);
      expect(String(starts(fx)[0].argv)).toContain("--no-skills");
      expect(String(starts(fx)[0].argv)).not.toContain("--skill ");
      expect(starts(fx)[0].tools).toBe("read,bash,web_search,fetch_content,get_search_content,source_check,propter_read");

      writeSettingsFile(fx.state, { skills: [skillDir], webSearch: false, mcp: true });
      const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
      await until(() => starts(fx).length === 2);
      const second = starts(fx)[1];
      expect(String(second.argv)).toContain(`--skill ${skillDir}`);
      expect(second.tools).toBe("read,bash,codemode,tool_search,propter_read");
      const opened = await json<{ features: { webSearch: boolean; mcp: boolean; skills: string[] } }>(await api(fx, "GET", `/api/conversations/${created.id}`));
      expect(opened.features).toEqual({ webSearch: false, mcp: true, skills: [skillDir] });

      // a skill that is gone is not handed over
      rmSync(skillDir, { recursive: true, force: true });
      await api(fx, "POST", `/api/conversations/${created.id}/close`);
      await until(() => !openConversations().some((c) => c.sessionId === created.id));
      await api(fx, "GET", `/api/conversations/${created.id}`);
      await until(() => starts(fx).length === 3);
      expect(String(starts(fx)[2].argv)).not.toContain("--skill ");
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  test("AC-005: the handoff skill is an OFF candidate by default, and turning it on hands its dir to the next pi", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const skillDir = join(home, ".agents", "skills", "propter-handoff");
      skillFile(skillDir, "propter-handoff");
      // the default enabled list is empty: the skill is a candidate, not on
      const settings = await json<{ settings: { skills: string[] }; candidates: { path: string; name: string; origin: string; enabled: boolean }[] }>(await api(fx, "GET", "/api/conversation-settings"));
      const candidate = settings.candidates.find((c) => c.name === "propter-handoff");
      expect(candidate?.origin).toBe("user");
      expect(candidate?.enabled).toBe(false);
      expect(settings.settings.skills).toEqual([]);
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      await until(() => starts(fx).length === 1);
      expect(String(starts(fx)[0].argv)).not.toContain("--skill ");
      // turning it on hands the dir over; the file itself is read, not written
      const patch = await api(fx, "PATCH", "/api/conversation-settings", { skills: [skillDir] });
      expect(patch.status).toBe(200);
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      await until(() => starts(fx).length === 2);
      expect(String(starts(fx)[1].argv)).toContain(`--skill ${skillDir}`);
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("name: propter-handoff");
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  test("AC-008 / AC-009: an enabled settings change never writes inside a skill dir or the user's pi config", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const skillDir = join(home, ".agents", "skills", "keeper");
      skillFile(skillDir, "keeper");
      writeFileSync(join(fx.userAgent, "settings.json"), "{}\n");
      const before = readdirSync(skillDir).sort();
      const beforeSkill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      await api(fx, "PATCH", "/api/conversation-settings", { skills: [skillDir] });
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      await until(() => starts(fx).length === 1);
      expect(readdirSync(skillDir).sort()).toEqual(before);
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(beforeSkill);
      expect(readFileSync(join(fx.userAgent, "settings.json"), "utf8")).toBe("{}\n");
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });

  test("AC-003: the open state names the skills its pi was handed, and holds them until the next pi", async () => {
    const fx = fixture();
    const home = join(fx.root, "home");
    mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const skillDir = join(home, ".agents", "skills", "keeper");
      skillFile(skillDir, "keeper");
      writeSettingsFile(fx.state, { skills: [skillDir], webSearch: false, mcp: false });
      const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
      await until(() => starts(fx).length === 1);
      const opened = await json<{ harness: string; features: { webSearch: boolean; mcp: boolean; skills: string[] } }>(await api(fx, "GET", `/api/conversations/${created.id}`));
      expect(opened.features).toEqual({ webSearch: false, mcp: false, skills: [skillDir] });
      expect(opened.harness).toBe("pi");

      // the running pi keeps what it was handed: the settings change does not move the open state
      writeSettingsFile(fx.state, { skills: [], webSearch: false, mcp: false });
      const still = await json<{ features: { skills: string[] } }>(await api(fx, "GET", `/api/conversations/${created.id}`));
      expect(still.features.skills).toEqual([skillDir]);

      // a branch of it is handed the same skills, and reports them too
      writeSettingsFile(fx.state, { skills: [skillDir], webSearch: false, mcp: false });
      placeChatParent(fx, "fork-skills", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "answer")]);
      const before = starts(fx).length;
      const branch = await fork(fx, "fork-skills", { at: "a1" });
      await until(() => starts(fx).length === before + 1);
      expect(String((starts(fx).at(-1) as Record<string, unknown>).argv)).toContain(`--skill ${skillDir}`);
      const branchOpen = await json<{ features: { skills: string[] } }>(await api(fx, "GET", `/api/conversations/${branch.body.id}`));
      expect(branchOpen.features.skills).toEqual([skillDir]);

      // closed and reopened, the next pi is handed what the settings say now
      await api(fx, "POST", `/api/conversations/${created.id}/close`);
      await until(() => !openConversations().some((c) => c.sessionId === created.id));
      writeSettingsFile(fx.state, { skills: [], webSearch: true, mcp: false });
      const reopened = await json<{ features: { skills: string[] } }>(await api(fx, "GET", `/api/conversations/${created.id}`));
      expect(reopened.features.skills).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });
});

describe("settings take effect on the next pi", () => {
  test("AC-011: the PATCH names the running conversations and the change waits for the next start", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const patch = await json<{ running: string[] }>(await api(fx, "PATCH", "/api/conversation-settings", { webSearch: false }));
    expect(patch.running).toContain(created.id);
    expect(starts(fx).length).toBe(1);
    const opened = await json<{ features: { webSearch: boolean } }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(opened.features.webSearch).toBe(true);
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await until(() => starts(fx).length === 2);
    expect(starts(fx)[1].tools).toBe("read,bash,propter_read");
  });
});

describe("the context use", () => {
  test("AC-012: reads pi's statistics, streams them at the end of a run, and opens anyway when they fail", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const context = await json<{ contextUsage: { tokens: number; contextWindow: number; percent: number } }>(await api(fx, "GET", `/api/conversations/${created.id}/context`));
    expect(context.contextUsage).toEqual({ tokens: 100, contextWindow: 1000, percent: 10 });
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hi" });
    const all = await readUntil(events, (e) => e.type === "context", 8000);
    expect((all.find((e) => e.type === "context") as { contextUsage: { percent: number } }).contextUsage.percent).toBe(10);
    const list = await json<{ conversations: { id: string }[] }>(await api(fx, "GET", "/api/conversations"));
    expect(JSON.stringify(list.conversations.find((c) => c.id === created.id))).not.toContain("contextUsage");
    await events.close();

    process.env.FAKE_PI_STATS_ERROR = "1";
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    const open = await api(fx, "GET", `/api/conversations/${created.id}`);
    expect(open.status).toBe(200);
    expect((await json<{ contextUsage: unknown }>(open)).contextUsage).toBeNull();
  });

  test("AC-012: pi reporting no field, or null values, is passed through", async () => {
    const fx = fixture();
    process.env.FAKE_PI_STATS_NULL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    expect((await json<{ contextUsage: unknown }>(await api(fx, "GET", `/api/conversations/${created.id}/context`))).contextUsage).toBeNull();
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    delete process.env.FAKE_PI_STATS_NULL;
    process.env.FAKE_PI_STATS_PARTIAL = "1";
    await api(fx, "GET", `/api/conversations/${created.id}`);
    const partial = await json<{ contextUsage: { tokens: null; contextWindow: number; percent: null } }>(await api(fx, "GET", `/api/conversations/${created.id}/context`));
    expect(partial.contextUsage).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });
});

describe("the quota door", () => {
  test("AC-013: returns Claude's last observation and nothing for a provider with no reading door", async () => {
    const fx = fixture();
    const configDir = join(fx.root, "claude");
    writeFileSync(join(fx.root, "roles.yaml"), [
      "defaults:",
      "  claude_config_dir: " + configDir,
      "models:",
      "  openrouter-z-ai-glm-5.3:",
      "    model: openrouter/z-ai/glm-5.3",
      "  openrouter-z-ai-glm-5.3-flash:",
      "    model: openrouter/z-ai/glm-5.3-flash",
      "roles:",
      "  chat: { model: openrouter-z-ai-glm-5.3, thinking: high, tools: [read, bash] }",
      "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
    ].join("\n") + "\n");
    const empty = await json<{ providers: unknown[] }>(await api(fx, "GET", "/api/quota"));
    expect(empty.providers).toEqual([]);

    const { claudeQuotaPath } = await import("@idd/lane");
    mkdirSync(join(fx.state, "pipeline"), { recursive: true });
    const resets = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(claudeQuotaPath(), JSON.stringify({
      accounts: {
        [configDir]: { status: "allowed", observed_at: new Date().toISOString(), windows: { five_hour: { utilization: 0.4, resets_at: resets } } },
      },
    }));
    const body = await json<{ providers: { provider: string; observed: string; windows: { name: string; utilization: number; resets?: string }[] }[] }>(await api(fx, "GET", "/api/quota"));
    expect(body.providers.length).toBe(1);
    expect(body.providers[0].provider).toBe("claude");
    expect(typeof body.providers[0].observed).toBe("string");
    expect(body.providers[0].windows[0].utilization).toBe(0.4);
    expect(body.providers[0].windows[0].resets).toBeDefined();
    expect(starts(fx)).toEqual([]);
  });
});

describe("transcription", () => {
  test("AC-015 / AC-016: sends one request to the configured provider, hides the key, and keeps no audio", async () => {
    const fx = fixture();
    const seen: { path: string; key: string; body: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        seen.push({ path: url.pathname, key: req.headers.get("x-goog-api-key") ?? "", body });
        return Response.json({ candidates: [{ content: { parts: [{ text: "こんにちは" }] } }] });
      },
    });
    const keyEnv = "MY_STT_KEY";
    process.env[keyEnv] = "secret-value";
    try {
      writeFileSync(join(fx.root, "roles.yaml"), [
        "models:",
        "  openrouter-z-ai-glm-5.3-flash:",
        "    model: openrouter/z-ai/glm-5.3-flash",
        "roles:",
        "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
        "stt:",
        "  provider: gemini",
        "  model: gemini-3.5-transcribe",
        `  base_url: http://127.0.0.1:${server.port}`,
        `  api_key_env: ${keyEnv}`,
        "  max_bytes: 8",
      ].join("\n") + "\n");

      const raw = (body: Uint8Array | string, type = "audio/webm") => fx.handler(new Request("http://127.0.0.1:30144/api/transcriptions", {
        method: "POST", headers: { "content-type": type, host: "127.0.0.1:30144" }, body,
      }));
      const tooBig = await raw(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
      expect(tooBig.status).toBe(413);
      const notAudio = await raw("hello", "text/plain");
      expect(notAudio.status).toBe(400);
      const empty = await raw(new Uint8Array());
      expect(empty.status).toBe(400);
      expect(seen.length).toBe(0);

      const ok = await raw(new Uint8Array([1, 2, 3]));
      expect(ok.status).toBe(200);
      const body = await json<{ text: string; model: string }>(ok);
      expect(body.text).toBe("こんにちは");
      expect(body.model).toBe("gemini-3.5-transcribe");
      expect(seen.length).toBe(1);
      expect(seen[0].path).toContain("gemini-3.5-transcribe");
      expect(seen[0].key).toBe("secret-value");
      expect(seen[0].body).toContain("audio");

      // the audio never lands under state
      const found = existsSync(join(fx.state, "pipeline")) ? readdirSync(join(fx.state, "pipeline")) : [];
      expect(found.some((n) => n.endsWith(".webm") || n.endsWith(".audio"))).toBe(false);
    } finally {
      delete process.env[keyEnv];
      try { server.stop(); } catch { /* already stopped */ }
    }
  });

  test("AC-015 / AC-016: a missing block is 503, a provider failure is 502, and a returned key is hidden", async () => {
    const fx = fixture();
    const onFail = (status: number, bodyText: string) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(bodyText, { status }),
      });
      return server;
    };
    try {
      // no stt block
      const noBlock = await fx.handler(new Request("http://127.0.0.1:30144/api/transcriptions", {
        method: "POST", headers: { "content-type": "audio/webm", host: "127.0.0.1:30144" }, body: new Uint8Array([1]) ,
      }));
      expect(noBlock.status).toBe(503);

      const keyEnv = "MY_STT_KEY_FAIL";
      process.env[keyEnv] = "super-secret";
      const server = onFail(500, "failed with super-secret in the message");
      writeFileSync(join(fx.root, "roles.yaml"), [
        "models:",
        "  openrouter-z-ai-glm-5.3-flash:",
        "    model: openrouter/z-ai/glm-5.3-flash",
        "roles:",
        "  titler: { model: openrouter-z-ai-glm-5.3-flash, thinking: low, tools: [read] }",
        "stt:",
        "  provider: gemini",
        "  model: gemini-3.5-transcribe",
        `  base_url: http://127.0.0.1:${server.port}`,
        `  api_key_env: ${keyEnv}`,
      ].join("\n") + "\n");
      const failed = await fx.handler(new Request("http://127.0.0.1:30144/api/transcriptions", {
        method: "POST", headers: { "content-type": "audio/webm", host: "127.0.0.1:30144" }, body: new Uint8Array([1, 2]) ,
      }));
      expect(failed.status).toBe(502);
      const failedBody = await failed.text();
      expect(failedBody).not.toContain("super-secret");
      server.stop();
      delete process.env[keyEnv];
    } finally {
      delete process.env.MY_STT_KEY;
    }
  });
});

// ---- IDD-058: the list's reading, the marks' guard, and shared / nested workspaces ----

/** a record with many message lines, for the event-loop check: the size is the point, not the content */
function placeBigSession(dir: string, id: string, cwd: string, bytes: number): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-02-01T00-00-00-000Z_${id}.jsonl`);
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-02-01T00:00:00.000Z", cwd })];
  let size = lines[0].length + 1;
  const filler = "x".repeat(900);
  let n = 0;
  while (size < bytes) {
    n += 1;
    const line = JSON.stringify({ type: "message", id: `m${n}`, parentId: null, message: { role: "assistant", content: [{ type: "text", text: filler }] } });
    lines.push(line);
    size += line.length + 1;
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** the longest time a 2 ms timer did not fire while `fn` ran: the event loop's worst stall, in ms */
async function measureMaxLag(fn: () => Promise<unknown>): Promise<number> {
  let maxLag = 0;
  let expected = performance.now() + 2;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + 2;
    timer = setTimeout(tick, 2);
  };
  timer = setTimeout(tick, 2);
  try { await fn(); } finally { if (timer) clearTimeout(timer); }
  return maxLag;
}

/** the shortest stall over up to `maxRounds` runs of `measureOnce`, stopping at the first run under `limitMs`; a synchronous read stalls every run, so it still fails */
async function bestLag(measureOnce: (round: number) => Promise<number>, limitMs: number, maxRounds: number): Promise<number> {
  let best = Infinity;
  for (let round = 0; round < maxRounds && best >= limitMs; round += 1) best = Math.min(best, await measureOnce(round));
  return best;
}

function placeLaneRecord(fx: Fixture, id: string): void {
  const dir = join(fx.state, "pipeline", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ session_id: id, slot: "planner", role: "chat" })}\n`);
}

function writeMarksFile(workspace: string, sessions: Record<string, unknown>, bookmarks: unknown[] = []): void {
  mkdirSync(join(workspace, ".propter"), { recursive: true });
  writeFileSync(join(workspace, ".propter", "sessions.json"), `${JSON.stringify({ bookmarks, sessions }, null, 2)}\n`);
}

/** the modes the nested and shared fixtures use; both name the same role so the records share one agent dir */
function writeModes(fx: Fixture, body: string): void {
  writeFileSync(join(fx.root, "modes.yaml"), `modes:\n${body}`);
}

async function closeAndForget(fx: Fixture, id: string): Promise<void> {
  await api(fx, "POST", `/api/conversations/${id}/close`);
  await until(() => !openConversations().some((c) => c.sessionId === id));
}

describe("the record cache and the asynchronous list", () => {
  test("AC-001 / INV-1361: an unchanged record is answered from the cache, not read again", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    const file = placeSession(dir, "cache-1", fx.cwd, [{ type: "session_info", id: "n1", parentId: null, name: "nome" }]);
    expect((await listBody(fx)).conversations.find((c) => c.id === "cache-1")?.name).toBe("nome");
    // the same mtime and size with different content: only a cache hit keeps the old summary
    const before = statSync(file);
    writeFileSync(file, readFileSync(file, "utf8").replace('"nome"', '"XXXX"'));
    utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
    expect((await listBody(fx)).conversations.find((c) => c.id === "cache-1")?.name).toBe("nome");
  });

  test("AC-002 / INV-1362: a changed, added or removed record shows on the next list", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    const file = placeSession(dir, "chg-1", fx.cwd, []);
    expect((await listBody(fx)).conversations.some((c) => c.id === "chg-1")).toBe(true);
    appendFileSync(file, `${JSON.stringify({ type: "session_info", id: "n1", parentId: null, name: "renamed" })}\n`);
    expect((await listBody(fx)).conversations.find((c) => c.id === "chg-1")?.name).toBe("renamed");
    rmSync(file);
    expect((await listBody(fx)).conversations.some((c) => c.id === "chg-1")).toBe(false);
    placeSession(dir, "chg-2", fx.cwd, []);
    expect((await listBody(fx)).conversations.some((c) => c.id === "chg-2")).toBe(true);
  });

  test("AC-003 / INV-1363: the list never holds the event loop for 50 ms, cold and warm", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    // a cold round is measured from records whose paths the cache has not seen, so every cold round reads the files
    // from disk; a round is measured again until one stays under 50 ms, which takes the machine's own noise out, and the 50 ms value is not changed
    const cold = await bestLag(async (round) => {
      rmSync(dir, { recursive: true, force: true });
      placeBigSession(dir, `big-${round}`, fx.cwd, 15 * 1024 * 1024);
      for (let i = 0; i < 32; i += 1) placeBigSession(dir, `small-${round}-${i}`, fx.cwd, 380 * 1024);
      return measureMaxLag(() => listBody(fx));
    }, 50, 8);
    expect(cold).toBeLessThan(50);
    const body = await listBody(fx);
    expect(body.conversations.length).toBe(33);
    // a warm round is the same records answered from the cache
    const warm = await bestLag(() => measureMaxLag(() => listBody(fx)), 50, 8);
    expect(warm).toBeLessThan(50);
  }, 120_000);

  test("AC-004 / INV-1368: search reads the workdir records the list shows, not lane or foreign ones", async () => {
    const fx = fixture();
    const workdir = join(fx.cwd, "notes", "a");
    mkdirSync(workdir, { recursive: true });
    placeSession(sessionDirOf(fx, "chat", fx.cwd), "srch-root", fx.cwd, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "common-word needle-root" } },
    ]);
    placeSession(sessionDirOf(fx, "chat", workdir), "srch-work", workdir, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "common-word needle-work" } },
    ]);
    placeSession(sessionDirOf(fx, "ideas", fx.ideaCwd), "srch-other", fx.ideaCwd, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "common-word needle-other" } },
    ]);
    placeSession(sessionDirOf(fx, "chat", fx.cwd), "srch-lane", fx.cwd, [
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "common-word needle-lane" } },
    ]);
    placeLaneRecord(fx, "srch-lane");

    const found = await json<{ results: { sessionId: string }[] }>(await api(fx, "GET", "/api/conversation-search?q=needle-work"));
    expect(found.results.map((r) => r.sessionId)).toEqual(["srch-work"]);
    const common = await json<{ results: { sessionId: string }[] }>(await api(fx, "GET", "/api/conversation-search?q=common-word"));
    const listed = (await listBody(fx)).conversations.map((c) => c.id).sort();
    expect(common.results.map((r) => r.sessionId).sort()).toEqual(listed);
    expect(common.results.map((r) => r.sessionId)).not.toContain("srch-lane");
    const filtered = await json<{ results: { sessionId: string }[] }>(await api(fx, "GET", "/api/conversation-search?q=common-word&mode=idea"));
    expect(filtered.results.map((r) => r.sessionId)).toEqual(["srch-other"]);
  });
});

describe("guarding the marks file", () => {
  test("AC-005 / INV-1364: a write on a broken marks file is refused, the create never wakes pi", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "brk-1", fx.cwd, []);
    await marks(fx, "brk-1", { pinned: true });
    placeSpaceFile(fx, "alpha", "name: Alpha");
    const before = starts(fx).length;
    const sessionsBefore = readdirSync(join(fx.cwd, "spaces")).length;

    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const marksRes = await marks(fx, "brk-1", { archived: true });
    expect(marksRes.status).toBeGreaterThanOrEqual(400);
    expect(marksRes.status).toBeLessThan(500);

    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const bookmarkRes = await api(fx, "POST", "/api/conversations/workspaces/chat/bookmarks", { id: "k" });
    expect(bookmarkRes.status).toBeGreaterThanOrEqual(400);
    expect(bookmarkRes.status).toBeLessThan(500);

    const listBefore = (await listBody(fx)).conversations.length;
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const createRes = await api(fx, "POST", "/api/conversations", { mode: "chat", space: "alpha" });
    expect(createRes.status).toBeGreaterThanOrEqual(400);
    expect(createRes.status).toBeLessThan(500);
    expect(starts(fx).length).toBe(before);
    expect((await listBody(fx)).conversations.length).toBe(listBefore);
    expect(readdirSync(join(fx.cwd, "spaces")).length).toBe(sessionsBefore);

    // a dir in the file's place is a read failure, not a broken table: refused and left where it is
    rmSync(join(fx.cwd, ".propter", "sessions.json"), { force: true });
    mkdirSync(join(fx.cwd, ".propter", "sessions.json"));
    const dirRes = await marks(fx, "brk-1", { pinned: true });
    expect(dirRes.status).toBeGreaterThanOrEqual(400);
    expect(dirRes.status).toBeLessThan(500);
    expect(statSync(join(fx.cwd, ".propter", "sessions.json")).isDirectory()).toBe(true);
  });

  test("AC-006 / INV-1369: a broken file is moved aside byte for byte and the retry succeeds", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "quo-1", fx.cwd, []);
    placeSession(dir, "quo-2", fx.cwd, []);
    await marks(fx, "quo-1", { pinned: true });
    await marks(fx, "quo-2", { archived: true });
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");

    const refused = await marks(fx, "quo-1", { archived: true });
    expect(refused.status).toBe(409);
    const broken = readdirSync(join(fx.cwd, ".propter")).filter((name) => name.startsWith("sessions.json.broken-"));
    expect(broken.length).toBe(1);
    expect(readFileSync(join(fx.cwd, ".propter", broken[0]), "utf8")).toBe("{not json");
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);
    // the quarantine kept the other session's mark, and the retry applies the new one
    const retry = await marks(fx, "quo-1", { archived: true });
    expect(retry.status).toBe(200);
    const marksFile = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { pinned?: boolean; archived?: boolean }> };
    expect(marksFile.sessions["quo-1"]?.archived).toBe(true);
    expect(marksFile.sessions["quo-2"]).toBeUndefined();

    // deleting a conversation is the engine's own write: a broken file must not stop it
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const del = await api(fx, "DELETE", "/api/conversations/quo-1");
    expect(del.status).toBe(200);
  });

  test("AC-007 / AC-008 / INV-1365: a read-only list answers and logs its reason once", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "log-1", fx.cwd, []);
    await marks(fx, "log-1", { pinned: true });
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{not json");
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await api(fx, "GET", "/api/conversations");
        expect(res.status).toBe(200);
        expect((await json<ListBody>(res)).conversations.find((c) => c.id === "log-1")?.pinned).toBe(false);
      }
      const reasons = warns.filter((line) => line.includes("[idd marks]") && line.includes("読めません"));
      expect(reasons.length).toBe(1);
      expect(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")).toBe("{not json");
      const refused = await marks(fx, "log-1", { pinned: false });
      expect(refused.status).toBe(409);
      expect(warns.some((line) => line.includes("[idd marks]") && line.includes("sessions.json.broken-"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });
});

describe("modes that share a workspace", () => {
  test("AC-009 / AC-010 / INV-1366: a later mode's conversation is listed once and opens as that mode", async () => {
    for (const linked of [false, true]) {
      const fx = fixture();
      // the real layout: every role's sessions dir links to the user's one dir
      if (linked) mkdirSync(join(fx.userAgent, "sessions"), { recursive: true });
      writeModes(fx, `  chat: { role: chat, workspace: ${fx.cwd} }\n  later: { role: ideas, workspace: ${fx.cwd} }\n`);
      await api(fx, "POST", "/api/conversations", { mode: "chat" });
      const later = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "later" }));
      await until(() => starts(fx).some((s) => s.session === later.id));
      // a pi CLI record with no spawn record: config order decides
      const dir = sessionDirOf(fx, "chat", fx.cwd);
      mkdirSync(dir, { recursive: true });
      placeSession(dir, "cli-one", fx.cwd, []);

      const rows = (await listBody(fx)).conversations;
      expect(rows.filter((c) => c.id === later.id).length).toBe(1);
      expect(rows.find((c) => c.id === later.id)?.mode).toBe("later");
      expect(rows.find((c) => c.id === "cli-one")?.mode).toBe("chat");

      await closeAndForget(fx, later.id);
      const opened = await json<{ mode: string }>(await api(fx, "GET", `/api/conversations/${later.id}`));
      expect(opened.mode).toBe("later");
      await until(() => starts(fx).at(-1)?.session === later.id);
      expect(starts(fx).at(-1)?.agentDir).toBe(agentDir(fx, "ideas"));
    }
  }, 30_000);
});

describe("nested workspaces and the place of a mark", () => {
  /** outer holds inner; both use role chat, so their records share one agent dir */
  function nested(fx: Fixture): string {
    const inner = join(fx.cwd, "inner");
    mkdirSync(inner, { recursive: true });
    writeModes(fx, `  outer: { role: chat, workspace: ${fx.cwd} }\n  inner: { role: chat, workspace: ${inner} }\n`);
    return inner;
  }

  test("AC-011 / INV-1367: an outer conversation in an inner workdir reads its outer membership", async () => {
    const fx = fixture();
    const inner = nested(fx);
    placeSpaceFile(fx, "alpha", "name: Alpha", "ALPHA-CTX");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "outer", workdir: "inner/work", space: "alpha" }));
    await until(() => starts(fx).some((s) => s.session === created.id));

    const row = (await listBody(fx)).conversations.find((c) => c.id === created.id);
    expect(row?.mode).toBe("inner");
    expect(row?.space).toBe("alpha");
    expect(row?.workdir).toBe("work");
    expect((await listBody(fx, "?space=alpha")).conversations.map((c) => c.id)).toContain(created.id);
    const grouped = await listBody(fx, "?group=space");
    expect(grouped.groups?.find((g) => g.key === "alpha")?.conversations.map((c) => c.id)).toContain(created.id);

    // pinning through the inner door keeps the mark in the outer file, not a new one inside
    expect((await marks(fx, created.id, { pinned: true })).status).toBe(200);
    const outerMarks = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { space?: string; pinned?: boolean }> };
    expect(outerMarks.sessions[created.id]?.space).toBe("alpha");
    expect(outerMarks.sessions[created.id]?.pinned).toBe(true);
    expect(existsSync(join(inner, ".propter", "sessions.json"))).toBe(false);

    // a conversation with no space yet, created in the same way, also lands its first mark outside
    const plain = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "outer", workdir: "inner/work2" }));
    await until(() => starts(fx).some((s) => s.session === plain.id));
    expect((await marks(fx, plain.id, { pinned: true })).status).toBe(200);
    const after = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { pinned?: boolean }> };
    expect(after.sessions[plain.id]?.pinned).toBe(true);
    expect(existsSync(join(inner, ".propter", "sessions.json"))).toBe(false);

    // a record with no spawn record belongs to the inner mode, so its mark goes inside
    const cliDir = sessionDirOf(fx, "chat", join(inner, "work3"));
    mkdirSync(cliDir, { recursive: true });
    placeSession(cliDir, "cli-inner", join(inner, "work3"), []);
    expect((await marks(fx, "cli-inner", { pinned: true })).status).toBe(200);
    const innerMarks = JSON.parse(readFileSync(join(inner, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { pinned?: boolean }> };
    expect(innerMarks.sessions["cli-inner"]?.pinned).toBe(true);
  }, 30_000);

  test("AC-015: a reopened nested conversation keeps its context and its marks door", async () => {
    const fx = fixture();
    nested(fx);
    placeSpaceFile(fx, "alpha", "name: Alpha", "ALPHA-CTX");
    placeSpaceFile(fx, "beta", "name: Beta", "BETA-CTX");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "outer", workdir: "inner/work", space: "alpha" }));
    await until(() => starts(fx).some((s) => s.session === created.id));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "settled") >= 1);
    await closeAndForget(fx, created.id);
    const before = starts(fx).length;
    expect((await api(fx, "GET", `/api/conversations/${created.id}`)).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(String(starts(fx).at(-1)?.argv)).toContain("ALPHA-CTX");

    // the inner door can move the membership to another space the outer workspace defines
    expect((await marks(fx, created.id, { space: "beta" })).status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === created.id)?.space).toBe("beta");

    // and it can use a bookmark kind the outer workspace defines
    expect((await api(fx, "POST", "/api/conversations/workspaces/outer/bookmarks", { id: "todo", label: "To do" })).status).toBe(200);
    expect((await marks(fx, created.id, { bookmarks: ["todo"] })).status).toBe(200);
    const grouped = await listBody(fx, "?group=bookmark");
    expect(grouped.groups?.find((g) => g.key === "todo")?.label).toBe("To do");
    expect(grouped.groups?.find((g) => g.key === "todo")?.conversations.map((c) => c.id)).toContain(created.id);
  }, 30_000);

  test("AC-016 / INV-1370: a fork and a promotion of a nested conversation keep the membership", async () => {
    const fx = fixture();
    const inner = nested(fx);
    placeSpaceFile(fx, "alpha", "name: Alpha", "ALPHA-CTX");
    // the fake fork id must be in the branch pi's environment from its start, so it is set before the create
    process.env.FAKE_PI_FORK_ID = "nested-forked";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "outer", workdir: "inner/work", space: "alpha" }));
    await until(() => starts(fx).some((s) => s.session === created.id));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "settled") >= 1);

    // pi's fork re-registers the session: the new id's mark stays in the outer file
    await api(fx, "POST", `/api/conversations/${created.id}/command`, { type: "fork", entryId: "u1" });
    await until(() => existsSync(join(fx.cwd, ".propter", "sessions.json")) && JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")).sessions["nested-forked"]);
    const forkedRow = (await listBody(fx)).conversations.find((c) => c.id === "nested-forked");
    expect(forkedRow?.space).toBe("alpha");
    expect(existsSync(join(inner, ".propter", "sessions.json"))).toBe(false);

    // cutting a branch and promoting it carries the membership too
    const branch = await fork(fx, created.id, { at: "a2" });
    expect(branch.res.status).toBe(200);
    const promoted = await api(fx, "POST", `/api/conversations/${branch.body.id}/promote`, { mode: "outer" });
    expect(promoted.status).toBe(200);
    expect((await listBody(fx)).conversations.find((c) => c.id === branch.body.id)?.space).toBe("alpha");
    expect(existsSync(join(inner, ".propter", "sessions.json"))).toBe(false);
  }, 30_000);
});

describe("marks with a shape the engine cannot use", () => {
  test("AC-012: a space id that is not an id reads as no membership and cannot be written", async () => {
    const fx = fixture();
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "bad-1", fx.cwd, [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "one"),
    ]);
    writeMarksFile(fx.cwd, { "bad-1": { space: "../x", pinned: true } });

    const row = (await listBody(fx)).conversations.find((c) => c.id === "bad-1");
    expect(row?.space).toBeUndefined();
    expect(row?.pinned).toBe(true);

    const before = starts(fx).length;
    expect((await api(fx, "GET", "/api/conversations/bad-1")).status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(argvWithoutInstructions(starts(fx).at(-1))).not.toContain("--append-system-prompt");
    expect((await api(fx, "POST", "/api/conversations/bad-1/messages", { text: "hi" })).status).toBe(200);
    expect((await marks(fx, "bad-1", { space: "../x" })).status).toBe(400);
  }, 30_000);
});

describe("a space the engine cannot read", () => {
  test("AC-013: one unreadable space is skipped, and its doors answer 404 or 4xx", async () => {
    const fx = fixture();
    placeSpaceFile(fx, "one", "name: One");
    placeSpaceFile(fx, "two", "name: Two");
    mkdirSync(join(fx.cwd, "spaces", "three", "space.md"), { recursive: true });
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const list = await json<{ spaces: { id: string }[] }>(await api(fx, "GET", "/api/conversations/workspaces/chat/spaces"));
      expect(list.spaces.map((p) => p.id).sort()).toEqual(["one", "two"]);
      expect(warns.filter((line) => line.includes("[idd spaces]") && line.includes("space.md")).length).toBe(1);
      expect((await api(fx, "GET", "/api/conversations/workspaces/chat/spaces/three")).status).toBe(404);
      expect((await api(fx, "PATCH", "/api/conversations/workspaces/chat/spaces/three", { name: "Three" })).status).toBe(404);

      const dir = sessionDirOf(fx, "chat", fx.cwd);
      placeSession(dir, "unreadable-1", fx.cwd, []);
      writeMarksFile(fx.cwd, { "unreadable-1": { space: "three" } });
      expect((await listBody(fx)).conversations.find((c) => c.id === "unreadable-1")?.space).toBeUndefined();
      expect((await marks(fx, "unreadable-1", { space: "three" })).status).toBe(400);
      expect((await api(fx, "POST", "/api/conversations", { mode: "chat", space: "three" })).status).toBe(400);
      expect(starts(fx)).toEqual([]);
    } finally {
      console.warn = original;
    }
  });
});

// A repo check runs in the engine's own process; the conversation stream of that process must keep delivering
// while it waits (DEC-2321 / DEC-2330). A test route starts the same wait the landing and the submit use.
describe("a repo check beside the conversation stream", () => {
  test("delivers events while a check waits in the engine's process", async () => {
    const fx = fixture();
    const started = join(fx.root, "check-started"), signal = join(fx.root, "check-signal");
    fx.handler = createFetchHandler([{
      method: "POST",
      pattern: "/api/idd/slow-check",
      handler: async () => {
        await runChecks(fx.root, [{ name: "slow", command: ["bash", "-c", `touch ${started}; while [ ! -f ${signal} ]; do sleep 0.1; done`], required: true }]);
        return new Response("ok");
      },
    }]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const check = api(fx, "POST", "/api/idd/slow-check");
    await until(() => existsSync(started));
    const t0 = Date.now();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    const first = await reader.next(2500);
    const elapsed = Date.now() - t0;
    expect(first).toBeTruthy();
    expect(elapsed).toBeLessThan(1000);
    writeFileSync(signal, "go");
    expect((await check).status).toBe(200);
    await reader.close();
  });
});

// The engine may run two copies' checks at the same time (one lane's check while another lane's runs). Each check
// gets a list and a place of its own, and neither may read the other's (INV-2521).
describe("two copies' checks at once", () => {
  test("AC-010 / INV-2521: both pass, each from its own place and its own changed list", async () => {
    const roots = [0, 1].map((i) => {
      const root = mkdtempSync(join(tmpdir(), `idd-two-checks-${i}-`));
      writeFileSync(join(root, `mark-${i}`), "");
      return root;
    });
    // each check waits until the other has started, so the two really overlap, then reads its own place and list
    const script = (i: number, other: number) =>
      `test -f mark-${i} && touch ready-${i}`
      + ` && for n in $(seq 1 100); do [ -f ${roots[other]}/ready-${other} ] && break; sleep 0.05; done`
      + ` && test -f ${roots[other]}/ready-${other}`
      + ` && grep -zqx "only-${i}" "$IDD_CHANGED_FILES"`
      + ` && ! grep -zqx "only-${other}" "$IDD_CHANGED_FILES"`;
    const results = await Promise.all(roots.map((root, i) => runChecks(
      root,
      [{ name: `check-${i}`, command: ["bash", "-c", script(i, (i + 1) % 2)], required: true }],
      { changed: [`only-${i}`] },
    )));
    expect(results.map((r) => r.map((c) => [c.name, c.status]))).toEqual([[['check-0', 'pass']], [['check-1', 'pass']]]);
  });
});

describe("a branch whose cwd is gone", () => {
  test("AC-014 / INV-1530: it can still be deleted and promoted without waking pi", async () => {
    const fx = fixture();
    placeChatParent(fx, "gone-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const workdir = join(fx.cwd, "sub");
    mkdirSync(workdir, { recursive: true });
    const del = (await fork(fx, "gone-parent", { at: "a1", cwd: workdir })).body.id as string;
    const promo = (await fork(fx, "gone-parent", { at: "a1", cwd: workdir })).body.id as string;
    await api(fx, "POST", `/api/conversations/${del}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === del));
    rmSync(workdir, { recursive: true, force: true });
    const before = starts(fx).length;
    // a closed branch is deleted from its records; the missing cwd is not consulted
    expect((await api(fx, "DELETE", `/api/conversations/${del}`)).status).toBe(200);
    expect(existsSync(ephemeralRecordPath(del))).toBe(false);
    expect(starts(fx).length).toBe(before);
    // a promoted branch falls back to the mode's workspace and wakes no pi
    const res = await api(fx, "POST", `/api/conversations/${promo}/promote`, {});
    expect(res.status).toBe(200);
    expect((await json<{ cwd: string }>(res)).cwd).toBe(fx.cwd);
    expect(starts(fx).length).toBe(before);
  });
});

describe("a promotion's dropped queue", () => {
  test("AC-016: a successful promotion leaves out the item pi was handed", async () => {
    const fx = fixture();
    process.env.FAKE_PI_PROMPT_MS = "600";
    placeChatParent(fx, "promo-d", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "promo-d", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "queued" });
    const res = await api(fx, "POST", `/api/conversations/${id}/promote`, {});
    expect(res.status).toBe(200);
    expect((await json<{ droppedQueue: { text: string }[] }>(res)).droppedQueue.map((q) => q.text)).toEqual(["queued"]);
  });

  test("AC-016: a refused promotion carries the items it dropped", async () => {
    const fx = fixture();
    process.env.FAKE_PI_IGNORE_STDIN_END = "1";
    process.env.FAKE_PI_MS = "4000";
    process.env.IDD_PROMOTE_EXIT_TIMEOUT_MS = "300";
    placeChatParent(fx, "promo-e", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    const { body } = await fork(fx, "promo-e", { at: "a1" });
    const id = body.id as string;
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${id}/messages`, { text: "queued" });
    const res = await api(fx, "POST", `/api/conversations/${id}/promote`, {});
    expect(res.status).toBe(409);
    expect((await json<{ droppedQueue: { text: string }[] }>(res)).droppedQueue.map((q) => q.text)).toEqual(["queued"]);
    expect(existsSync(ephemeralRecordPath(id))).toBe(true);
  });
});

// ---- the conversation state machine, driven without a pi process ----

type MachineReply = { resolve: () => void; reject: (err: unknown) => void };
const noop = (): void => {};

function machineIn(phase: ConversationPhase): ConversationMachine {
  const base: ConversationMachine = { state: { phase: "closed" }, deferred: {}, queue: [], itemSeq: 0, generation: 1, wantType: null, history: null, instruction: null, paused: false };
  switch (phase) {
    case "closed": return base;
    case "opening": return { ...base, state: { phase: "opening", asked: false, waiters: [] } };
    case "idle": return { ...base, state: { phase: "idle", switching: null } };
    case "sending": return { ...base, state: { phase: "sending", item: { id: "q1", text: "one" }, held: [], awaiting: "prompt", deferredBefore: {}, pendingRunEnd: null } };
    case "running": return { ...base, state: { phase: "running", switching: null } };
    case "stopping": return { ...base, state: { phase: "stopping", item: null, held: [], awaiting: null, abortSent: true, deferredBefore: {}, pendingRunEnd: null } };
    case "delivering": return { ...base, state: { phase: "delivering", instruction: { type: "idea", kind: "full" }, waiters: [] } };
    case "closing": return { ...base, state: { phase: "closing", graceMs: 100, forced: false, pendingOpen: false, openWaiters: [], closeWaiters: [] } };
  }
}

/** every phase together with the values that ride inside it; the completeness test walks this list */
function machineVariants(): { label: string; machine: ConversationMachine }[] {
  const base: ConversationMachine = { state: { phase: "closed" }, deferred: {}, queue: [], itemSeq: 0, generation: 1, wantType: null, history: null, instruction: null, paused: false };
  const switching = (asked: boolean) => ({ want: { model: "m" }, awaiting: "model" as const, waiters: [], asked });
  const sending = (awaiting: "model" | "effort" | "prompt", pendingRunEnd: { stopReason: string | null } | null = null): ConversationMachine => ({
    ...base, state: { phase: "sending", item: { id: "q1", text: "one" }, held: [], awaiting, deferredBefore: {}, pendingRunEnd },
  });
  const typed = (): ConversationMachine => ({ ...base, wantType: "idea", history: { lastType: "chat", full: ["chat"] } });
  return [
    { label: "closed", machine: base },
    { label: "opening", machine: { ...base, state: { phase: "opening", asked: false, waiters: [] } } },
    { label: "idle", machine: { ...base, state: { phase: "idle", switching: null } } },
    { label: "idle + instruction", machine: { ...typed(), instruction: { type: "idea", kind: "full" } } },
    { label: "idle + unknown history", machine: { ...base, wantType: "idea" } },
    { label: "idle + switching", machine: { ...base, state: { phase: "idle", switching: switching(false) } } },
    { label: "idle + switching + asked", machine: { ...base, state: { phase: "idle", switching: switching(true) } } },
    { label: "sending + model", machine: sending("model") },
    { label: "sending + effort", machine: sending("effort") },
    { label: "sending + prompt", machine: sending("prompt") },
    { label: "sending + prompt + run end", machine: sending("prompt", { stopReason: "stop" }) },
    { label: "running", machine: { ...base, state: { phase: "running", switching: null } } },
    { label: "running + switching", machine: { ...base, state: { phase: "running", switching: switching(false) } } },
    { label: "stopping + abort sent", machine: { ...base, state: { phase: "stopping", item: null, held: [], awaiting: null, abortSent: true, deferredBefore: {}, pendingRunEnd: null } } },
    { label: "stopping + model", machine: { ...base, state: { phase: "stopping", item: { id: "q1", text: "one" }, held: [], awaiting: "model", abortSent: false, deferredBefore: {}, pendingRunEnd: null } } },
    { label: "stopping + prompt", machine: { ...base, state: { phase: "stopping", item: { id: "q1", text: "one" }, held: [], awaiting: "prompt", abortSent: false, deferredBefore: {}, pendingRunEnd: null } } },
    { label: "delivering", machine: { ...typed(), state: { phase: "delivering", instruction: { type: "idea", kind: "full" }, waiters: [] } } },
    { label: "closing", machine: { ...base, state: { phase: "closing", graceMs: 100, forced: false, pendingOpen: false, openWaiters: [], closeWaiters: [] } } },
  ];
}

const openEv = (): ConversationMailEvent => ({ type: "open", reply: { resolve: noop, reject: noop } });
const sendEv = (text: string, model?: string): ConversationMailEvent => ({ type: "send", text, ...(model ? { model } : {}), result: {} });
const steerEv = (text: string, reply: MachineReply = { resolve: noop, reject: noop }): ConversationMailEvent => ({ type: "steer", text, reply });
const stopEv = (): ConversationMailEvent => ({ type: "stop", reply: { resolve: noop, reject: noop } });
const modelEv = (model: string | null, effort: string | null = null): ConversationMailEvent => ({ type: "model", model, effort, reply: { resolve: noop, reject: noop } });
const closeEv = (graceMs = 100): ConversationMailEvent => ({ type: "close", graceMs, reply: { resolve: noop } });
const spawnedEv = (generation = 1): ConversationMailEvent => ({ type: "spawned", generation });
const promptSettledEv = (generation: number, itemId: string, disposition: "started" | "queued" | "handled" | "failed"): ConversationMailEvent => ({ type: "promptSettled", generation, itemId, disposition });
const modelSettledEv = (generation: number, step: "model" | "effort", ok: boolean): ConversationMailEvent => ({ type: "modelSettled", generation, step, ok });
const runStartedEv = (generation = 1): ConversationMailEvent => ({ type: "runStarted", generation });
const runEndedEv = (generation: number, stopReason: string | null): ConversationMailEvent => ({ type: "runEnded", generation, stopReason });
const exitedEv = (generation = 1): ConversationMailEvent => ({ type: "exited", generation });
const typeRequestEv = (wantType: string, reply: MachineReply = { resolve: noop, reject: noop }): ConversationMailEvent => ({ type: "typeRequest", wantType, reply });
const historyReadEv = (lastType: string | null, full: string[], generation = 1): ConversationMailEvent => ({ type: "historyRead", generation, lastType, full });
const compactionEndedEv = (generation = 1): ConversationMailEvent => ({ type: "compactionEnded", generation });

function sampleEvent(type: ConversationMailEvent["type"], onReject: () => void = noop): ConversationMailEvent {
  const reply = (): MachineReply => ({ resolve: noop, reject: onReject });
  switch (type) {
    case "open": return { type: "open", reply: reply() };
    case "send": return { type: "send", text: "one", result: {} };
    case "steer": return { type: "steer", text: "one", reply: reply() };
    case "stop": return { type: "stop", reply: reply() };
    case "model": return { type: "model", model: "m", effort: null, reply: reply() };
    case "edit": return { type: "edit", id: "q1", patch: {}, result: {} };
    case "cancel": return { type: "cancel", id: "q1", result: {} };
    case "close": return { type: "close", graceMs: 100, reply: { resolve: noop } };
    case "spawned": return { type: "spawned", generation: 1 };
    case "spawnFailed": return { type: "spawnFailed", generation: 1 };
    case "promptSettled": return { type: "promptSettled", generation: 1, itemId: "q1", disposition: "started" };
    case "modelSettled": return { type: "modelSettled", generation: 1, step: "model", ok: true };
    case "runStarted": return { type: "runStarted", generation: 1 };
    case "runEnded": return { type: "runEnded", generation: 1, stopReason: "stop" };
    case "exited": return { type: "exited", generation: 1 };
    case "hardKill": return { type: "hardKill", generation: 1 };
    case "typeRequest": return { type: "typeRequest", wantType: "idea", reply: reply() };
    case "historyRead": return { type: "historyRead", generation: 1, lastType: "chat", full: ["chat"] };
    case "compactionEnded": return { type: "compactionEnded", generation: 1 };
  }
}

interface PiStep { kind: string; text?: string; model?: string }
interface DriveResult { machine: ConversationMachine; pi: PiStep[]; emitted: { type: string; fields: Record<string, unknown> }[] }

/** feed the events through the transition function and record the instructions it asks for */
function drive(events: ConversationMailEvent[], initial: ConversationMachine = emptyConversationMachine()): DriveResult {
  let machine = initial;
  const pi: PiStep[] = [];
  const emitted: { type: string; fields: Record<string, unknown> }[] = [];
  let outstanding = 0;
  for (const event of events) {
    if (event.type === "promptSettled") outstanding = Math.max(0, outstanding - 1);
    const { machine: next, directives } = reduceConversation(machine, event);
    machine = next;
    for (const directive of directives) {
      if (directive.kind === "emit") { emitted.push({ type: directive.eventType, fields: directive.fields }); continue; }
      if (directive.kind === "prompt") {
        outstanding += 1;
        pi.push({ kind: "prompt", text: directive.item.text, ...(directive.item.model ? { model: directive.item.model } : {}) });
        continue;
      }
      if (directive.kind === "typePrompt") {
        outstanding += 1;
        pi.push({ kind: "typePrompt", text: directive.instruction.type, ...(directive.instruction.kind ? { model: directive.instruction.kind } : {}) });
        continue;
      }
      if (directive.kind === "steer") { pi.push({ kind: "steer", text: directive.text }); continue; }
      pi.push({ kind: directive.kind });
    }
    // one unsettled prompt at most, whatever the order of the events (INV-1522)
    expect(outstanding).toBeLessThanOrEqual(1);
  }
  return { machine, pi, emitted };
}

const kinds = (r: DriveResult): string[] => r.pi.map((step) => step.kind);
const prompts = (r: DriveResult): { text?: string; model?: string }[] => r.pi.filter((step) => step.kind === "prompt").map(({ text, model }) => ({ text, ...(model ? { model } : {}) }));
const queueTexts = (machine: ConversationMachine): string[] => machine.queue.map((item) => item.text);

/** the treatment of every state value and event pair, one row per state value; an unlisted pair is a bug */
const TRANSITION_TABLE = [
  { label: "closed", moves: ["open", "send", "steer", "model", "close", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "opening", moves: ["open", "send", "steer", "model", "close", "spawned", "spawnFailed", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "idle", moves: ["send", "steer", "model", "close", "runStarted", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "idle + instruction", moves: ["open", "send", "steer", "model", "close", "compactionEnded"], refuses: ["edit", "cancel"] },
  { label: "idle + unknown history", moves: ["open", "send", "steer", "model", "close", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "idle + switching", moves: ["send", "steer", "stop", "model", "close", "modelSettled", "runStarted", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "idle + switching + asked", moves: ["send", "steer", "stop", "model", "close", "modelSettled", "runStarted", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "sending + model", moves: ["send", "steer", "stop", "model", "close", "promptSettled", "modelSettled", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "sending + effort", moves: ["send", "steer", "stop", "model", "close", "promptSettled", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "sending + prompt", moves: ["send", "steer", "stop", "model", "close", "promptSettled", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "sending + prompt + run end", moves: ["send", "steer", "stop", "model", "close", "promptSettled", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "running", moves: ["send", "steer", "stop", "model", "close", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "running + switching", moves: ["send", "steer", "stop", "model", "close", "modelSettled", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "stopping + abort sent", moves: ["send", "steer", "model", "close", "promptSettled", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "stopping + model", moves: ["send", "steer", "model", "close", "promptSettled", "modelSettled", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "stopping + prompt", moves: ["send", "steer", "model", "close", "promptSettled", "runEnded", "exited", "typeRequest", "historyRead"], refuses: ["edit", "cancel"] },
  { label: "delivering", moves: ["send", "steer", "model", "close", "promptSettled", "exited", "typeRequest", "compactionEnded"], refuses: ["edit", "cancel"] },
  { label: "closing", moves: ["open", "close", "exited", "hardKill", "historyRead"], refuses: ["send", "steer", "stop", "model", "edit", "cancel", "typeRequest"] },
] as const;

function machineSnapshot(machine: ConversationMachine): string {
  return JSON.stringify({ state: machine.state, deferred: machine.deferred, queue: machine.queue, itemSeq: machine.itemSeq, generation: machine.generation, wantType: machine.wantType, history: machine.history, instruction: machine.instruction, paused: machine.paused });
}

describe("the conversation state machine", () => {
  test("AC-016: every state value and event pair has a row in the transition table", () => {
    const rows = new Map(TRANSITION_TABLE.map((row) => [row.label, row]));
    const variants = machineVariants();
    // a state value added without a row stops here
    expect(variants.map((v) => v.label).sort()).toEqual(TRANSITION_TABLE.map((r) => r.label).sort());
    for (const { label, machine } of variants) {
      const row = rows.get(label);
      expect(row, label).toBeDefined();
      if (!row) continue;
      const moves = new Set<string>(row.moves);
      const refuses = new Set<string>(row.refuses);
      for (const type of CONVERSATION_EVENT_TYPES) {
        let rejected = false;
        const event = sampleEvent(type, () => { rejected = true; });
        const before = machineSnapshot(machine);
        const { machine: after, directives } = reduceConversation(machine, event);
        const afterSnap = machineSnapshot(after);
        const resultError = "result" in event && event.result !== undefined && "error" in event.result && event.result.error !== undefined;
        const refused = rejected || resultError;
        if (moves.has(type)) {
          expect(before === afterSnap && directives.length === 0 && !refused, `${label} + ${type} must move`).toBe(false);
        } else if (refuses.has(type)) {
          expect(refused, `${label} + ${type} must refuse`).toBe(true);
        } else {
          expect(before, `${label} + ${type} must not change the state`).toBe(afterSnap);
          expect(directives.length, `${label} + ${type} must not emit`).toBe(0);
        }
      }
    }
    // an event added without a row stops here
    const named = new Set<string>([...TRANSITION_TABLE.flatMap((r) => [...r.moves, ...r.refuses])]);
    expect([...named].sort()).toEqual([...CONVERSATION_EVENT_TYPES].sort());
  });

  test("the model's eight scenarios run through the transition function", () => {
    // 1. a plain exchange with a queue; the second item's model is switched before its prompt
    const queue = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b", "m2"), runEndedEv(1, "stop"), modelSettledEv(1, "model", true), promptSettledEv(1, "q2", "started"), runEndedEv(1, "stop")]);
    expect(kinds(queue)).toEqual(["spawn", "prompt", "setModel", "prompt"]);
    expect(prompts(queue)).toEqual([{ text: "a" }, { text: "b", model: "m2" }]);
    expect(queue.machine.state.phase).toBe("idle");
    expect(queueTexts(queue.machine)).toEqual([]);

    // 2. a stop keeps the queue and does not run it; the next send starts from the head
    const stopped = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b"), stopEv(), runEndedEv(1, "error")]);
    expect(kinds(stopped)).toEqual(["spawn", "prompt", "abort"]);
    expect(stopped.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["stopped"]);
    expect(queueTexts(stopped.machine)).toEqual(["b"]);
    const resumed = drive([sendEv("c")], stopped.machine);
    expect(prompts(resumed).map((p) => p.text)).toEqual(["b"]);

    // 2b. a failure without a stop also holds the queue
    const failed = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b"), runEndedEv(1, "error")]);
    expect(failed.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["failed"]);
    expect(queueTexts(failed.machine)).toEqual(["b"]);

    // 3. an interrupt during a run goes straight to pi's steer and waits for nothing
    const steered = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b"), steerEv("wait!")]);
    expect(kinds(steered)).toEqual(["spawn", "prompt", "steer"]);
    expect(queueTexts(steered.machine)).toEqual(["b"]);

    // 4. an item is editable before it is handed over and not after
    const edited = drive([openEv(), spawnedEv(1), sendEv("a"), sendEv("b")]);
    const editFirst = reduceConversation(edited.machine, { type: "edit", id: "q1", patch: { text: "A" }, result: {} });
    expect((editFirst.machine.queue.find((i) => i.id === "q2")?.text)).toBe("b");
    const cancelFirst = reduceConversation(editFirst.machine, { type: "cancel", id: "q1", result: {} });
    expect(cancelFirst.machine.state.phase).toBe("sending");
    expect(queueTexts(cancelFirst.machine)).toEqual(["b"]);

    // 5. an open during a close waits for the exit and starts one new pi
    const closing = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), closeEv(), openEv(), openEv()]);
    expect(kinds(closing)).toEqual(["spawn", "prompt", "kill"]);
    expect(closing.machine.state.phase).toBe("closing");
    const reopened = drive([exitedEv(1)], closing.machine);
    expect(kinds(reopened)).toEqual(["spawn"]);
    expect(reopened.machine.state.phase).toBe("opening");

    // 6. a run that ends while a stop is waiting counts as stopped whatever it reported
    const race = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), stopEv(), runEndedEv(1, "stop")]);
    expect(race.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["stopped"]);
    expect(race.machine.state.phase).toBe("idle");

    // 7. a pi that dies mid-run leaves no running state behind
    const crash = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), exitedEv(1)]);
    expect(crash.machine.state.phase).toBe("closed");
    expect(crash.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["failed"]);
  });

  test("AC-010 / INV-1762: a run end remembered in Sending is carried into the stop", () => {
    const r = drive([
      openEv(), spawnedEv(1), sendEv("a"), runEndedEv(1, "stop"), steerEv("held"), stopEv(), promptSettledEv(1, "q1", "started"),
    ]);
    expect(kinds(r)).toEqual(["spawn", "prompt"]);
    expect(r.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["stopped"]);
    expect(r.machine.state.phase).toBe("idle");
    expect(prompts(r).map((p) => p.text)).toEqual(["a"]);
    expect(queueTexts(r.machine)).toEqual(["held"]);
  });

  test("AC-011 / INV-1761: a stop before the prompt is written never hands the item to pi", () => {
    const r = drive([openEv(), spawnedEv(1), sendEv("elem", "m"), stopEv(), modelSettledEv(1, "model", true)]);
    expect(kinds(r)).toEqual(["spawn", "setModel"]);
    expect(queueTexts(r.machine)).toEqual(["elem"]);
    expect(r.machine.state.phase).toBe("idle");
    const editEvent: ConversationMailEvent = { type: "edit", id: "q1", patch: { text: "E" }, result: {} };
    const edited = reduceConversation(r.machine, editEvent);
    expect((editEvent as { result: { item?: { text?: string } } }).result.item?.text).toBe("E");
    const again = drive([sendEv("later"), modelSettledEv(1, "model", true)], edited.machine);
    expect(prompts(again).map((p) => p.text)).toEqual(["E"]);
  });

  test("AC-012 / INV-1763: a stopped or failed queue does not run without a person", () => {
    const failed = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b"), runEndedEv(1, "error")]);
    expect(queueTexts(failed.machine)).toEqual(["b"]);
    const natural = drive([runStartedEv(1), runEndedEv(1, "stop")], failed.machine);
    expect(prompts(natural).map((p) => p.text)).toEqual([]);
    const during = drive([runStartedEv(1), sendEv("c"), runEndedEv(1, "stop")], failed.machine);
    expect(prompts(during).map((p) => p.text)).toEqual(["b"]);
    const stopped = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b"), stopEv(), runEndedEv(1, "error")]);
    expect(queueTexts(stopped.machine)).toEqual(["b"]);
    const reopened = drive([closeEv(), openEv(), exitedEv(1), spawnedEv(2)], stopped.machine);
    expect(prompts(reopened).map((p) => p.text)).toEqual([]);
  });

  test("AC-013 / INV-1764: a promotion's dropped items include the one waiting for its switch", () => {
    const r = drive([openEv(), spawnedEv(1), sendEv("first", "m"), sendEv("second")]);
    expect(droppedQueue(r.machine).map((i) => i.text)).toEqual(["first", "second"]);
    const settled = reduceConversation(r.machine, modelSettledEv(1, "model", true)).machine;
    expect(droppedQueue(settled).map((i) => i.text)).toEqual(["second"]);
  });

  test("AC-014 / INV-1765: a handled settle with an empty queue still emits the queue", () => {
    const r = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "handled")]);
    const events = r.emitted.filter((e) => e.type === "queue");
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.fields.queue).toEqual([]);
  });

  test("AC-012: an interrupt and a settle together keep the queue moving and never double the prompt", () => {
    const together = drive([
      openEv(), spawnedEv(1), sendEv("a"), sendEv("b"), steerEv("wait"),
      promptSettledEv(1, "q1", "started"), runEndedEv(1, "stop"),
    ]);
    expect(prompts(together).map((p) => p.text)).toEqual(["a", "b"]);
    expect(together.pi.filter((s) => s.kind === "steer").map((s) => s.text)).toEqual(["wait"]);
    // the run ended and the queue moved on to the item behind it
    expect(together.machine.state.phase).toBe("sending");

    // the process dies before the prompt settles: the item returns to the head and the held interrupt joins the tail
    let answered = false;
    const crashed = drive([
      openEv(), spawnedEv(1), sendEv("a"), steerEv("wait", { resolve: () => { answered = true; }, reject: noop }),
      stopEv(), exitedEv(1),
    ]);
    expect(answered).toBe(true);
    expect(crashed.machine.state.phase).toBe("closed");
    expect(queueTexts(crashed.machine)).toEqual(["a", "wait"]);
  });

  test("AC-009: a stop during a send defers the abort until the prompt settles", () => {
    const waiting = drive([openEv(), spawnedEv(1), sendEv("a"), stopEv()]);
    expect(waiting.machine.state.phase).toBe("stopping");
    expect(kinds(waiting)).not.toContain("abort");
    const aborting = drive([promptSettledEv(1, "q1", "started")], waiting.machine);
    expect(kinds(aborting)).toContain("abort");
    expect(aborting.machine.state.phase).toBe("stopping");
  });

  test("AC-002: an open during a close starts no pi until the old process is gone", () => {
    const closing = drive([openEv(), spawnedEv(1), closeEv(), openEv(), openEv()]);
    expect(kinds(closing).filter((kind) => kind === "spawn")).toHaveLength(1);
    const reopened = drive([exitedEv(1)], closing.machine);
    expect(kinds(reopened).filter((kind) => kind === "spawn")).toHaveLength(1);
    expect(reopened.machine.state.phase).toBe("opening");
  });

  test("AC-022: a model change is applied in Idle, held elsewhere, and refused while closing", () => {
    const idle = drive([modelEv("m")], machineIn("idle"));
    expect(kinds(idle)).toContain("setModel");
    for (const phase of ["sending", "running", "stopping", "opening", "closed"] as const) {
      const held = drive([modelEv("m")], machineIn(phase));
      expect(kinds(held), phase).not.toContain("setModel");
      expect(held.machine.deferred.model, phase).toBe("m");
    }
    let refused: unknown;
    const rejected = (err: unknown): void => { refused = err; };
    drive([{ type: "model", model: "m", effort: null, reply: { resolve: noop, reject: rejected } }], machineIn("closing"));
    expect(refused).toBeInstanceOf(ConversationRefused);
  });

  test("F-1: an Idle model switch parks the items that arrive while its answer is out", () => {
    let steered = false;
    const parked = drive([
      modelEv("m"),
      sendEv("a"),
      steerEv("b", { resolve: () => { steered = true; }, reject: noop }),
    ], machineIn("idle"));
    // the switch owns pi: nothing is prompted or steered, and the switch's answer is still owed
    expect(kinds(parked)).toEqual(["setModel"]);
    expect(queueTexts(parked.machine)).toEqual(["a", "b"]);
    expect(steered).toBe(true);
    const settled = drive([modelSettledEv(1, "model", true)], parked.machine);
    expect(prompts(settled).map((p) => p.text)).toEqual(["a"]);
    expect(queueTexts(settled.machine)).toEqual(["b"]);
  });

  test("F-2: an interrupt during a stop is answered and queued when the run ends", () => {
    let answered = false;
    const stopping = drive([
      openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"),
      sendEv("b"), stopEv(),
      steerEv("wait", { resolve: () => { answered = true; }, reject: noop }),
    ]);
    expect(stopping.machine.state.phase).toBe("stopping");
    // held until the run it was stopped for is over; nothing is dropped unanswered
    expect(answered).toBe(false);
    const ended = drive([runEndedEv(1, "stop")], stopping.machine);
    expect(answered).toBe(true);
    expect(ended.machine.state.phase).toBe("idle");
    expect(queueTexts(ended.machine)).toEqual(["b", "wait"]);
    expect(ended.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["stopped"]);
    // a stopped queue stays put
    expect(prompts(ended)).toEqual([]);
  });

  test("AC-023: a run pi started itself is Running, and a queued prompt is Running too", () => {
    const injected = drive([runStartedEv(1), sendEv("later")], machineIn("idle"));
    expect(injected.machine.state.phase).toBe("running");
    expect(queueTexts(injected.machine)).toEqual(["later"]);
    expect(kinds(injected)).toEqual([]);

    const queued = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "queued")]);
    expect(queued.machine.state.phase).toBe("running");
    expect(prompts(queued).map((p) => p.text)).toEqual(["a"]);
  });

  test("F-5: a run end that shares the prompt's answer chunk ends the run instead of sticking in Running", () => {
    // one chunk: pi's answer for the prompt and the run's report land together; the mailbox sees the
    // report first because the answer's continuation runs after the chunk's records are read
    const sameChunk = drive([
      openEv(), spawnedEv(1), sendEv("a"), sendEv("b"),
      runEndedEv(1, "stop"), promptSettledEv(1, "q1", "started"),
    ]);
    expect(sameChunk.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["completed"]);
    // the natural end moves the queue on to the item behind the one that just ended
    expect(prompts(sameChunk).map((p) => p.text)).toEqual(["a", "b"]);
    expect(sameChunk.machine.state.phase).toBe("sending");

    // a failure in the same chunk holds the queue, like any other failed run
    const failed = drive([
      openEv(), spawnedEv(1), sendEv("a"), sendEv("b"),
      runEndedEv(1, "error"), promptSettledEv(1, "q1", "started"),
    ]);
    expect(failed.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["failed"]);
    expect(queueTexts(failed.machine)).toEqual(["b"]);
  });

  test("F-6: a stop's handed item is not sent twice when the run ends before the prompt's answer", () => {
    const stopping = drive([openEv(), spawnedEv(1), sendEv("a"), stopEv()]);
    expect(stopping.machine.state.phase).toBe("stopping");
    // the run ends while pi has not answered for the prompt yet: the item was handed over, so it is spent
    const ended = drive([runEndedEv(1, "stop")], stopping.machine);
    expect(ended.emitted.filter((e) => e.type === "end").map((e) => e.fields.reason)).toEqual(["stopped"]);
    expect(queueTexts(ended.machine)).toEqual([]);
    // a late answer for the prompt does not send it again either
    const late = drive([promptSettledEv(1, "q1", "started")], ended.machine);
    expect(prompts(late)).toEqual([]);
    expect(late.machine.state.phase).toBe("idle");
  });

  test("F-7: a failed Idle switch still starts the item that waited for it", () => {
    const parked = drive([modelEv("m"), sendEv("a")], machineIn("idle"));
    expect(kinds(parked)).toEqual(["setModel"]);
    expect(queueTexts(parked.machine)).toEqual(["a"]);
    const failed = drive([modelSettledEv(1, "model", false)], parked.machine);
    expect(failed.emitted.some((e) => e.type === "error")).toBe(true);
    // the switch is over (failed), so the item that waited behind it must move
    expect(prompts(failed).map((p) => p.text)).toEqual(["a"]);
    expect(failed.machine.state.phase).toBe("sending");
  });

  test("F-8: a run that starts during an Idle switch keeps the switch's door owed", () => {
    let answered = false;
    const opened = drive([{ type: "model", model: "m", effort: null, reply: { resolve: () => { answered = true; }, reject: noop } }], machineIn("idle"));
    const injected = drive([runStartedEv(1)], opened.machine);
    expect(injected.machine.state.phase).toBe("running");
    const settled = drive([modelSettledEv(1, "model", true)], injected.machine);
    expect(answered).toBe(true);
    expect(settled.machine.state.phase).toBe("running");
  });

  test("F-9: a stop while a run and a switch are both going answers the model door", () => {
    let refused: unknown;
    const opened = drive([{ type: "model", model: "m", effort: null, reply: { resolve: noop, reject: (err) => { refused = err; } } }], machineIn("idle"));
    const running = drive([runStartedEv(1), stopEv()], opened.machine);
    expect(running.machine.state.phase).toBe("stopping");
    expect(refused).toBeInstanceOf(ConversationRefused);
  });
});

describe("a run end that shares the prompt's chunk", () => {
  test("F-5: ends the run and moves the queue on instead of sticking in Running", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SETTLE_WITH_RESPONSE = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    const all = await readUntil(events, (e) => e.type === "end", 8000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("completed");
    // the natural end moved the queue: the item behind the one that ended went to pi
    await until(() => count(fx, "prompt") === 2, 8000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["one", "two"]);
    await events.close();
  });
});

describe("a stop whose prompt answer is still out", () => {
  test("F-6: does not put the handed item back when the run ends first", async () => {
    const fx = fixture();
    process.env.FAKE_PI_PROMPT_MS = "300";
    process.env.FAKE_PI_SETTLE_WITH_RESPONSE = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => count(fx, "prompt") === 1);
    await api(fx, "POST", `/api/conversations/${created.id}/stop`);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "stopping", 5000);
    const all = await readUntil(events, (e) => e.type === "end", 5000);
    expect((all.find((e) => e.type === "end") as { reason: string }).reason).toBe("stopped");
    const state = await json<{ queue: { text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    // the item was handed to pi before the stop: it is spent and does not wait for another send
    expect(state.queue.map((q) => q.text)).toEqual([]);
    expect(count(fx, "prompt")).toBe(1);
    await events.close();
  });
});

describe("a failed model switch", () => {
  test("F-7: still starts the item that waited behind it", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "300";
    process.env.FAKE_PI_DENY_MODEL = "openrouter/nope/thing";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "warm" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "idle", 5000);
    const changed = api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/nope/thing" });
    await until(() => count(fx, "set_model") === 1);
    const sent = api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    const [changedRes, sentRes] = await Promise.all([changed, sent]);
    expect(changedRes.status).toBe(400);
    expect(sentRes.status).toBe(200);
    await until(() => count(fx, "prompt") === 2, 5000);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["warm", "one"]);
  });
});

describe("a run that starts during an Idle model switch", () => {
  test("F-8: still answers the model door", async () => {
    const fx = fixture();
    process.env.FAKE_PI_SET_MODEL_MS = "300";
    process.env.FAKE_PI_RUN_ON_SET_MODEL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "warm" });
    await until(() => count(fx, "prompt") === 1);
    await until(() => openConversations().find((c) => c.sessionId === created.id)?.phase === "idle", 5000);
    const res = await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.4" });
    expect(res.status).toBe(200);
    expect(await json<{ model?: string }>(res)).toMatchObject({ model: "openrouter/z-ai/glm-5.4" });
  });
});

// ---- the conversation type instruction ----

const typedBase = (wantType: string | null, history: { lastType: string | null; full: string[] } | null = null): ConversationMachine => ({
  ...emptyConversationMachine(), wantType, history,
});
const typedIdle = (wantType: string | null, history: { lastType: string | null; full: string[] } | null = null): ConversationMachine => ({
  ...emptyConversationMachine(), generation: 1, state: { phase: "idle", switching: null }, wantType, history,
});

describe("the type instruction in the state machine", () => {
  test("AC-018: the type events and the delivery phase are in the walked lists", () => {
    for (const type of ["typeRequest", "historyRead", "compactionEnded"]) expect(CONVERSATION_EVENT_TYPES).toContain(type);
    expect(CONVERSATION_PHASES).toContain("delivering");
  });

  test("AC-012 / INV-1601 / INV-1603: a spawn delivers the owed instruction and starts no run", () => {
    const spawned = drive([openEv(), historyReadEv("chat", ["chat"]), spawnedEv(1)], typedBase("idea"));
    expect(spawned.pi).toEqual([{ kind: "spawn" }, { kind: "typePrompt", text: "idea", model: "full" }]);
    expect(spawned.machine.state.phase).toBe("delivering");
    const settled = drive([promptSettledEv(1, "type:idea", "handled")], spawned.machine);
    expect(settled.machine.state.phase).toBe("idle");
    expect(settled.machine.instruction).toBeNull();
    expect(settled.pi).toEqual([]);
  });

  test("AC-010 / AC-011 / INV-1604: the full text lands once and a return is a short message", () => {
    const spawned = drive([openEv(), historyReadEv(null, []), spawnedEv(1)], typedBase("chat"));
    expect(spawned.pi).toEqual([{ kind: "spawn" }, { kind: "typePrompt", text: "chat", model: "full" }]);
    const opened = drive([promptSettledEv(1, "type:chat", "handled")], spawned.machine);
    const idea = drive([typeRequestEv("idea")], opened.machine);
    expect(idea.pi).toEqual([{ kind: "typePrompt", text: "idea", model: "full" }]);
    const ideaDone = drive([promptSettledEv(1, "type:idea", "handled")], idea.machine);
    const backToChat = drive([typeRequestEv("chat")], ideaDone.machine);
    expect(backToChat.pi).toEqual([{ kind: "typePrompt", text: "chat", model: "short" }]);
    const chatDone = drive([promptSettledEv(1, "type:chat", "handled")], backToChat.machine);
    const ideaAgain = drive([typeRequestEv("idea")], chatDone.machine);
    expect(ideaAgain.pi).toEqual([{ kind: "typePrompt", text: "idea", model: "short" }]);
    const ideaAgainDone = drive([promptSettledEv(1, "type:idea", "handled")], ideaAgain.machine);
    const same = drive([typeRequestEv("idea")], ideaAgainDone.machine);
    expect(same.pi).toEqual([]);
  });

  test("AC-014 / INV-1603: a stop's leftover queue holds the instruction until a send", () => {
    const running = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), sendEv("b")], typedBase("chat", { lastType: "chat", full: ["chat"] }));
    const requested = drive([typeRequestEv("idea")], running.machine);
    expect(requested.pi).toEqual([]);
    expect(requested.machine.instruction).toEqual({ type: "idea", kind: "full" });
    const stopped = drive([stopEv(), runEndedEv(1, "error")], requested.machine);
    expect(stopped.machine.state.phase).toBe("idle");
    expect(kinds(stopped)).toEqual(["abort"]);
    expect(queueTexts(stopped.machine)).toEqual(["b"]);
    const sent = drive([sendEv("c")], stopped.machine);
    expect(sent.pi[0]).toEqual({ kind: "typePrompt", text: "idea", model: "full" });
    const settled = drive([promptSettledEv(1, "type:idea", "handled")], sent.machine);
    expect(prompts(settled).map((p) => p.text)).toEqual(["b"]);
  });

  test("AC-013 / INV-1601: an interrupt with an instruction owed is queued, not steered", () => {
    const running = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started"), typeRequestEv("idea")], typedBase("chat", { lastType: "chat", full: ["chat"] }));
    const steered = drive([steerEv("interrupt")], running.machine);
    expect(steered.pi).toEqual([]);
    expect(queueTexts(steered.machine)).toEqual(["interrupt"]);
    const ended = drive([runEndedEv(1, "stop")], steered.machine);
    expect(ended.pi[0]).toEqual({ kind: "typePrompt", text: "idea", model: "full" });
    const done = drive([promptSettledEv(1, "type:idea", "handled")], ended.machine);
    expect(prompts(done).map((p) => p.text)).toEqual(["interrupt"]);
  });

  test("AC-024 / INV-1609: the instruction does not spend a deferred model", () => {
    const running = drive([openEv(), spawnedEv(1), sendEv("a"), promptSettledEv(1, "q1", "started")], typedBase("chat", { lastType: "chat", full: ["chat"] }));
    const changed = drive([modelEv("m2")], running.machine);
    const requested = drive([typeRequestEv("idea")], changed.machine);
    const sent = drive([sendEv("b")], requested.machine);
    const ended = drive([runEndedEv(1, "stop")], sent.machine);
    expect(ended.pi.map((s) => s.kind)).toEqual(["typePrompt"]);
    const settled = drive([promptSettledEv(1, "type:idea", "handled")], ended.machine);
    expect(settled.pi.map((s) => s.kind)).toEqual(["setModel"]);
    const modeled = drive([modelSettledEv(1, "model", true)], settled.machine);
    expect(prompts(modeled)).toEqual([{ text: "b" }]);
  });

  test("AC-024: editing and cancelling during a delivery never touch the instruction", () => {
    const delivering = drive([typeRequestEv("idea"), sendEv("x")], typedIdle("chat", { lastType: "chat", full: ["chat"] }));
    expect(delivering.machine.state.phase).toBe("delivering");
    const cancelled = reduceConversation(delivering.machine, { type: "cancel", id: "q1", result: {} });
    expect(cancelled.machine.state.phase).toBe("delivering");
    expect(cancelled.machine.instruction).toBeNull();
    expect(queueTexts(cancelled.machine)).toEqual([]);
  });

  test("AC-015 / INV-1606: a compaction that dropped the instruction makes it owed again", () => {
    const open = drive([openEv(), spawnedEv(1)], typedBase("idea", { lastType: "idea", full: ["idea"] }));
    expect(open.pi).toEqual([{ kind: "spawn" }]);
    const dropped = drive([compactionEndedEv(1), historyReadEv("chat", ["chat"])], open.machine);
    expect(dropped.pi).toEqual([{ kind: "typePrompt", text: "idea", model: "full" }]);
    const kept = drive([compactionEndedEv(1), historyReadEv("idea", ["idea"])], open.machine);
    expect(kept.pi).toEqual([]);
  });

  test("AC-004 / AC-014: a refused instruction stays owed and keeps the queue at its head", () => {
    const delivering = drive([typeRequestEv("idea"), sendEv("x")], typedIdle("chat", { lastType: "chat", full: ["chat"] }));
    let refused: unknown;
    const failed = drive([promptSettledEv(1, "type:idea", "failed")], delivering.machine);
    expect(failed.machine.state.phase).toBe("idle");
    expect(failed.machine.instruction).toEqual({ type: "idea", kind: "full" });
    expect(queueTexts(failed.machine)).toEqual(["x"]);
    expect(failed.emitted.some((e) => e.type === "error")).toBe(true);
    // a later send retries the instruction first and then the item behind it
    const retried = drive([sendEv("y")], failed.machine);
    expect(retried.pi[0]).toEqual({ kind: "typePrompt", text: "idea", model: "full" });
    void refused;
  });
});

// ---- the conversation type doors ----

/** give the fixture's chat mode the chat / idea / notes types, with idea's files under the ideas dir */
function typedModes(fx: Fixture, opts: { ideaOperations?: boolean } = {}): void {
  mkdirSync(fx.ideaCwd, { recursive: true });
  mkdirSync(join(fx.cwd, "notes"), { recursive: true });
  if (opts.ideaOperations !== false) writeFileSync(join(fx.ideaCwd, "AGENTS.md"), "アイデアの運用本文です。\n");
  writeFileSync(join(fx.ideaCwd, "_template.md"), "---\nstatus: 探索中\ntitle: t\n---\n\n本文\n");
  writeFileSync(join(fx.cwd, "notes", "AGENTS.md"), "ノートの運用です。\n");
  writeFileSync(join(fx.root, "modes.yaml"), [
    "modes:",
    "  chat:",
    "    role: chat",
    `    workspace: ${fx.cwd}`,
    "    types:",
    "      chat: { label: チャット }",
    `      idea: { label: アイデア, dir: ${fx.ideaCwd}, template: _template.md }`,
    "      notes: { label: ノート, dir: notes }",
    "      missing: { label: 欠け, dir: nowhere }",
    "  idea:",
    "    role: ideas",
    `    workspace: ${fx.ideaCwd}`,
  ].join("\n") + "\n");
}

async function waitIdle(fx: Fixture, id: string): Promise<void> {
  await until(() => openConversations().find((c) => c.sessionId === id)?.phase === "idle", 8000);
}

function sessionEntries(fx: Fixture, id: string): Record<string, unknown>[] {
  const file = sessionFileOf(fx, id);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("conversation types", () => {
  test("AC-002 / INV-1607: a mode without types behaves as before and the type door refuses", async () => {
    const fx = fixture();
    const created = await json<{ id: string; type?: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    expect(created.type).toBeUndefined();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await until(() => count(fx, "prompt") === 1);
    expect(commands(fx).filter((c) => c.cmd === "prompt").map((c) => c.message)).toEqual(["hello"]);
    expect(count(fx, "type-prompt")).toBe(0);
    const row = (await listBody(fx)).conversations.find((c) => c.id === created.id);
    expect(row?.type).toBeUndefined();
    expect(row?.document).toBeUndefined();
    const open = await json<{ type?: string; document?: unknown }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(open.type).toBeUndefined();
    expect(open.document).toBeUndefined();
    expect((await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" })).status).toBe(409);
  });

  test("AC-004 / INV-1605: a type whose dir or operations file is gone is refused without a mark", async () => {
    const fx = fixture();
    typedModes(fx, { ideaOperations: false });
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    const before = count(fx, "type-prompt");
    expect((await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" })).status).toBe(409);
    expect((await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "missing" })).status).toBe(409);
    expect(count(fx, "type-prompt")).toBe(before);
    const marksFile = join(fx.cwd, ".propter", "sessions.json");
    if (existsSync(marksFile)) expect((JSON.parse(readFileSync(marksFile, "utf8")) as { sessions: Record<string, { type?: string }> }).sessions[created.id]?.type).toBeUndefined();
    expect(existsSync(join(fx.cwd, "nowhere"))).toBe(false);
    // a create with a missing operations file is refused before pi starts
    const startsBeforeCreate = starts(fx).length;
    expect((await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" })).status).toBe(409);
    expect(starts(fx).length).toBe(startsBeforeCreate);
  });

  test("AC-005 / AC-006 / INV-1605: a full instruction carries the body and the paths, and is read fresh", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string; type: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    expect(created.type).toBe("chat");
    await waitIdle(fx, created.id);
    const chat = commands(fx).find((c) => c.cmd === "type-prompt" && c.type === "chat") as { kind: string; message: string };
    expect(chat.kind).toBe("full");
    expect(chat.message).toContain("<propter-system-message>");
    expect(chat.message).toContain(fx.cwd);
    expect(chat.message).not.toContain("memory:");
    expect(chat.message).not.toContain(join(fx.cwd, "memory"));
    expect(chat.message).not.toContain("アイデアの運用本文");
    expect(chat.message).not.toContain("テンプレ:");
    const res = await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    expect(res.status).toBe(200);
    await until(() => commands(fx).some((c) => c.cmd === "type-prompt" && c.type === "idea"));
    const idea = commands(fx).find((c) => c.cmd === "type-prompt" && c.type === "idea") as { kind: string; message: string };
    expect(idea.kind).toBe("full");
    expect(idea.message).toContain(fx.ideaCwd);
    expect(idea.message).toContain(join(fx.ideaCwd, "_template.md"));
    expect(idea.message).not.toContain("memory:");
    expect(idea.message).not.toContain(join(fx.cwd, "memory"));
    expect(idea.message).toContain("アイデアの運用本文です。");
    // the operations body is read at delivery time, never held: a change reaches the next switch
    writeFileSync(join(fx.ideaCwd, "AGENTS.md"), "新しい運用の本文です。\n");
    const other = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" }));
    await waitIdle(fx, other.id);
    const fresh = commands(fx).filter((c) => c.cmd === "type-prompt" && c.type === "idea").at(-1) as { message: string };
    expect(fresh.message).toContain("新しい運用の本文です。");
    expect(fresh.message).not.toContain("アイデアの運用本文です。");
  });

  test("AC-007: a create adds the type's instruction before the first message and refuses bad input before pi", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" }));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "hello"));
    const cmds = commands(fx);
    const ideaAt = cmds.findIndex((c) => c.cmd === "type-prompt" && c.type === "idea");
    const helloAt = cmds.findIndex((c) => c.cmd === "prompt" && c.message === "hello");
    expect(ideaAt).toBeGreaterThanOrEqual(0);
    expect(ideaAt).toBeLessThan(helloAt);
    // omitted type uses the default
    const dflt = await json<{ type: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    expect(dflt.type).toBe("chat");
    // an unknown type is 400 and starts no pi
    const before = starts(fx).length;
    expect((await api(fx, "POST", "/api/conversations", { mode: "chat", type: "nope" })).status).toBe(400);
    expect((await api(fx, "POST", "/api/conversations", { mode: "idea", type: "chat" })).status).toBe(400);
    expect(starts(fx).length).toBe(before);
    // a broken marks file refuses the create before pi starts
    mkdirSync(join(fx.cwd, ".propter"), { recursive: true });
    writeFileSync(join(fx.cwd, ".propter", "sessions.json"), "{ broken");
    const starts2 = starts(fx).length;
    expect((await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" })).status).toBe(409);
    expect(starts(fx).length).toBe(starts2);
  });

  test("AC-008 / AC-009 / INV-1602 / INV-1603: an idle switch adds one hidden message and changes no launch", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    const argv = String(starts(fx)[0].argv);
    const beforeMessages = sessionEntries(fx, created.id).filter((e) => e.type === "custom_message").length;
    const beforePrompts = count(fx, "type-prompt");
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const res = await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    expect(res.status).toBe(200);
    expect((await json<{ delivered: boolean }>(res)).delivered).toBe(true);
    await until(() => sessionEntries(fx, created.id).filter((e) => e.type === "custom_message").length === beforeMessages + 1);
    expect(count(fx, "type-prompt")).toBe(beforePrompts + 1);
    const added = sessionEntries(fx, created.id).filter((e) => e.type === "custom_message").at(-1) as { customType?: string; display?: boolean; details?: unknown };
    expect(added.customType).toBe("idd.conversation-type");
    expect(added.display).toBe(false);
    expect(added.details).toMatchObject({ type: "idea", kind: "full" });
    expect(starts(fx).length).toBe(1);
    expect(String(starts(fx)[0].argv)).toBe(argv);
    expect(starts(fx)[0].cwd).toBe(fx.cwd);
    const seen: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i += 1) { const event = await reader.tryNext(200); if (event) seen.push(event); }
    expect(seen.some((e) => e.type === "run_start" || e.type === "end")).toBe(false);
    expect(openConversations().find((c) => c.sessionId === created.id)?.isStreaming).toBe(false);
    await reader.close();
  });

  test("AC-010 / INV-1604: switching to the current type adds nothing", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    const file = sessionFileOf(fx, created.id) as string;
    const before = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    const beforePrompts = count(fx, "type-prompt");
    const res = await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "chat" });
    expect(res.status).toBe(200);
    expect((await json<{ delivered: boolean }>(res)).delivered).toBe(true);
    await sleep(120);
    expect(count(fx, "type-prompt")).toBe(beforePrompts);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean).length).toBe(before);
  });

  test("AC-011 / INV-1604: returning to a type is a short message and the operations body is not repeated", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    await until(() => commands(fx).some((c) => c.cmd === "type-prompt" && c.type === "idea" && c.kind === "full"));
    await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "chat" });
    await until(() => commands(fx).some((c) => c.cmd === "type-prompt" && c.type === "chat" && c.kind === "short"));
    await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    await until(() => commands(fx).some((c) => c.cmd === "type-prompt" && c.type === "idea" && c.kind === "short"));
    const ideas = commands(fx).filter((c) => c.cmd === "type-prompt" && c.type === "idea");
    expect(ideas.filter((c) => c.kind === "full").length).toBe(1);
    expect(ideas.filter((c) => c.kind === "short").length).toBe(1);
    const back = commands(fx).find((c) => c.cmd === "type-prompt" && c.type === "chat" && c.kind === "short") as { message: string };
    expect(back.message).not.toContain("アイデアの運用本文");
    expect(back.message).toContain("通常の対話");
  });

  test("AC-012 / INV-1601: a switch during a run reaches pi before the next message", async () => {
    const fx = fixture();
    typedModes(fx);
    process.env.FAKE_PI_MS = "250";
    process.env.FAKE_PI_TYPE_MS = "150";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "one"));
    const res = await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    expect((await json<{ delivered: boolean }>(res)).delivered).toBe(false);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "two"), 8000);
    const cmds = commands(fx);
    const ideaAt = cmds.findIndex((c) => c.cmd === "type-prompt" && c.type === "idea");
    const twoAt = cmds.findIndex((c) => c.cmd === "prompt" && c.message === "two");
    expect(ideaAt).toBeGreaterThanOrEqual(0);
    expect(ideaAt).toBeLessThan(twoAt);
    expect(count(fx, "prompt-overlap")).toBe(0);
  });

  test("AC-013 / INV-1601: an interrupt while the instruction is owed is queued and steering it is refused", async () => {
    const fx = fixture();
    typedModes(fx);
    process.env.FAKE_PI_MS = "900";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "one"));
    await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "interrupt" });
    expect(count(fx, "steer")).toBe(0);
    const state = await json<{ queue: { id: string; text: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    const item = state.queue.find((q) => q.text === "interrupt") as { id: string };
    expect(item).toBeTruthy();
    expect((await api(fx, "POST", `/api/conversations/${created.id}/queue/${item.id}/steer`)).status).toBe(409);
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "interrupt"), 8000);
    const cmds = commands(fx);
    const ideaAt = cmds.findIndex((c) => c.cmd === "type-prompt" && c.type === "idea");
    const interruptAt = cmds.findIndex((c) => c.cmd === "prompt" && c.message === "interrupt");
    expect(ideaAt).toBeGreaterThanOrEqual(0);
    expect(ideaAt).toBeLessThan(interruptAt);
  });

  test("AC-014: a refused instruction keeps the message queued, rejects the door and is retried", async () => {
    const fx = fixture();
    typedModes(fx);
    process.env.FAKE_PI_TYPE_FAIL = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => count(fx, "type-prompt") >= 1 && openConversations().find((c) => c.sessionId === created.id)?.phase === "idle", 8000);
    expect(openConversations().find((c) => c.sessionId === created.id)?.hasUndeliveredInstruction()).toBe(true);
    // an instruction that cannot land rejects the door that asked for it in the same turn
    expect((await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" })).status).toBe(503);
    // a message behind the owed instruction is not handed over, and the instruction is retried
    const before = count(fx, "type-prompt");
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "hello" });
    await until(() => count(fx, "type-prompt") >= before + 1, 8000);
    expect(count(fx, "prompt")).toBe(0);
    expect(openConversations().find((c) => c.sessionId === created.id)?.queueItems.map((q) => q.text)).toEqual(["hello"]);
    expect(openConversations().find((c) => c.sessionId === created.id)?.hasUndeliveredInstruction()).toBe(true);
  });

  test("AC-024 / INV-1608 / INV-1609: the instruction is never in the queue and does not spend a deferred model", async () => {
    const fx = fixture();
    typedModes(fx);
    process.env.FAKE_PI_MS = "350";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await waitIdle(fx, created.id);
    const reader = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "one" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "one"));
    await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/z-ai/glm-5.4" });
    await api(fx, "POST", `/api/conversations/${created.id}/type`, { type: "idea" });
    const seen: Record<string, unknown>[] = [];
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) { const event = await reader.tryNext(120); if (!event) continue; seen.push(event); if (event.type === "queue") { const queue = (event.queue ?? []) as { text: string }[]; expect(queue.every((q) => !q.text.includes("<propter-system-message>"))).toBe(true); } }
    await reader.close();
    await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "two" });
    await until(() => commands(fx).some((c) => c.cmd === "prompt" && c.message === "two"), 8000);
    const cmds = commands(fx);
    const ideaAt = cmds.findIndex((c) => c.cmd === "type-prompt" && c.type === "idea");
    const modelAt = cmds.findIndex((c) => c.cmd === "set_model" && c.modelId === "z-ai/glm-5.4");
    const twoAt = cmds.findIndex((c) => c.cmd === "prompt" && c.message === "two");
    expect(ideaAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(ideaAt).toBeLessThan(modelAt);
    expect(modelAt).toBeLessThan(twoAt);
  });

  test("AC-016: the list and open doors report the current type and the mark rule", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" }));
    await waitIdle(fx, created.id);
    const startsBefore = starts(fx).length;
    expect((await listBody(fx)).conversations.find((c) => c.id === created.id)?.type).toBe("idea");
    expect(starts(fx).length).toBe(startsBefore);
    const mark = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { type?: string }> };
    expect(mark.sessions[created.id]?.type).toBe("idea");
    placeSession(sessionDirOf(fx, "chat", fx.cwd), "plain-1", fx.cwd, [userEntry("u1", null, "x")]);
    expect((await listBody(fx)).conversations.find((c) => c.id === "plain-1")?.type).toBe("chat");
    writeMarksFile(fx.cwd, { "plain-1": { type: "gone" } });
    expect((await listBody(fx)).conversations.find((c) => c.id === "plain-1")?.type).toBe("chat");
  });

  test("AC-017: the doors derive the type's document, its status and its branch", async () => {
    const fx = fixture();
    typedModes(fx);
    const doc = join(fx.ideaCwd, "idea-1.md");
    writeFileSync(doc, "---\nstatus: 探索中\n---\n\nbody\n");
    const gone = join(fx.ideaCwd, "idea-gone.md");
    const dir = sessionDirOf(fx, "chat", fx.cwd);
    placeSession(dir, "doc-rel", fx.cwd, [
      userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one"),
      toolCallEntry("w1", "a1", "c1", "write", "notes/n.md"), toolResultEntry("r1", "w1", "c1"),
      toolCallEntry("w2", "r1", "c2", "edit", join(fx.ideaCwd, "_template.md")), toolResultEntry("r2", "w2", "c2"),
      toolCallEntry("w3", "r2", "c3", "write", join(fx.ideaCwd, "AGENTS.md")), toolResultEntry("r3", "w3", "c3"),
    ]);
    writeFileSync(join(fx.cwd, "notes", "n.md"), "---\nstatus: メモ\n---\n");
    // the last successful, non-template/operations write under the type's dir wins; off-branch and failed ones do not
    placeSession(dir, "doc-idea", fx.cwd, [
      userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one"),
      toolCallEntry("w1", "a1", "c1", "write", doc), toolResultEntry("r1", "w1", "c1"),
      toolCallEntry("w2", "a1", "c2", "write", gone), toolResultEntry("r2", "w2", "c2", true),
      toolCallEntry("w3", "u1", "c3", "write", join(fx.ideaCwd, "side.md")),
      assistantEntry("a2", "r1", "two"),
    ]);
    writeMarksFile(fx.cwd, { "doc-idea": { type: "idea" }, "doc-rel": { type: "notes" } });
    const rows = (await listBody(fx)).conversations;
    expect(rows.find((c) => c.id === "doc-idea")?.document).toEqual({ path: doc, status: "探索中" });
    expect(rows.find((c) => c.id === "doc-rel")?.document).toEqual({ path: join(fx.cwd, "notes", "n.md"), status: "メモ" });
    const open = await json<{ type: string; document: { path: string; status: string | null } }>(await api(fx, "GET", "/api/conversations/doc-idea"));
    expect(open.type).toBe("idea");
    expect(open.document).toEqual({ path: doc, status: "探索中" });
    // a document that is gone still reports its path with a null status
    const doc2 = join(fx.ideaCwd, "idea-2.md");
    placeSession(dir, "doc-missing", fx.cwd, [
      userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one"),
      toolCallEntry("w1", "a1", "c1", "write", doc2), toolResultEntry("r1", "w1", "c1"),
    ]);
    writeMarksFile(fx.cwd, { "doc-missing": { type: "idea" } });
    const missing = (await listBody(fx)).conversations.find((c) => c.id === "doc-missing");
    expect(missing?.document).toEqual({ path: doc2, status: null });
    // a type without a dir, or a branch with no write, has no document
    placeSession(dir, "doc-chat", fx.cwd, [
      userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one"),
      toolCallEntry("w1", "a1", "c1", "write", join(fx.ideaCwd, "x.md")), toolResultEntry("r1", "w1", "c1"),
    ]);
    writeMarksFile(fx.cwd, { "doc-chat": { type: "chat" } });
    expect((await listBody(fx)).conversations.find((c) => c.id === "doc-chat")?.document).toBeUndefined();
  });

  test("AC-022 / INV-1604: a fork and a promotion carry the type and a branch refuses switches", async () => {
    const fx = fixture();
    typedModes(fx);
    placeChatParent(fx, "branch-parent", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "one")]);
    writeMarksFile(fx.cwd, { "branch-parent": { type: "idea" } });
    const { body } = await fork(fx, "branch-parent", { at: "a1" });
    const branchId = body.id as string;
    expect((await json<{ type?: string }>(await api(fx, "GET", `/api/conversations/${branchId}`))).type).toBe("idea");
    expect((await api(fx, "POST", `/api/conversations/${branchId}/type`, { type: "chat" })).status).toBe(409);
    const promoted = await api(fx, "POST", `/api/conversations/${branchId}/promote`, { mode: "chat" });
    expect(promoted.status).toBe(200);
    await until(() => existsSync(join(fx.cwd, ".propter", "sessions.json")) && (JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { type?: string }> }).sessions[branchId]?.type === "idea");
  });

  test("AC-025 / INV-1610: a type mark survives other marks and reads back", async () => {
    const fx = fixture();
    typedModes(fx);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat", type: "idea" }));
    await waitIdle(fx, created.id);
    expect((await marks(fx, created.id, { pinned: true })).status).toBe(200);
    expect((await marks(fx, created.id, { pinned: null })).status).toBe(200);
    const mark = JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { type?: string; pinned?: boolean }> };
    expect(mark.sessions[created.id]?.type).toBe("idea");
    expect(mark.sessions[created.id]?.pinned).toBeUndefined();
    expect((await listBody(fx)).conversations.find((c) => c.id === created.id)?.type).toBe("idea");
  });
});

// ---- the composer's row: the model candidates, the applied effort, the notices and the image limits (IDD-118) ----

/** write a roles file with the models a test needs; every role carries a model so the file parses */
function writeRoles(fx: Fixture, body: string): void {
  writeFileSync(join(fx.root, "roles.yaml"), body);
}

/** the last Claude window observation the engine reads, written into this fixture's own state */
function writeQuota(fx: Fixture, windows: Record<string, { utilization: number }>, status = "allowed"): void {
  mkdirSync(join(fx.state, "pipeline"), { recursive: true });
  const account = resolve(readRoles().defaults.claudeConfigDir);
  writeFileSync(claudeQuotaPath(), JSON.stringify({ accounts: { [account]: { status, observed_at: new Date().toISOString(), windows } } }));
}

const ROLES_CONFIG_A = [
  "defaults: { title_context_turns: 3 }",
  "models:",
  "  openrouter-config-a:",
  "    model: openrouter/config-a",
  "  openrouter-config-b:",
  "    model: openrouter/config-b",
  "  openrouter-config-c:",
  "    model: openrouter/config-c",
  "roles:",
  "  chat: { model: openrouter-config-a, thinking: low, tools: [read] }",
  "  ideas: { model: openrouter-config-b, thinking: low, tools: [read] }",
  "  titler: { model: openrouter-config-c, thinking: low, tools: [read] }",
].join("\n") + "\n";

describe("the model candidates door", () => {
  test("AC-001 / AC-002 / INV-118-1: candidates are the config names pi accepts, plus the current model", async () => {
    const fx = fixture();
    writeRoles(fx, ROLES_CONFIG_A);
    process.env.FAKE_PI_MODELS = JSON.stringify([
      { provider: "openrouter", id: "config-b", name: "Config B", contextWindow: 1000, input: ["text", "image"], reasoning: true },
      { provider: "openrouter", id: "config-c", name: "Config C", contextWindow: 2000, input: ["text"], reasoning: false },
      { provider: "openrouter", id: "pi-only-d", name: "Pi D", contextWindow: 3000, input: ["text"], reasoning: false },
      { provider: "openrouter", id: "current-e", name: "Current E", contextWindow: 4000, input: ["text"], reasoning: true },
    ]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    // switch to E, which the config does not name but pi holds; the picker must still offer it
    const switched = await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/current-e" });
    expect(switched.status).toBe(200);
    const res = await api(fx, "GET", `/api/conversations/${created.id}/models`);
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; models: { id: string }[]; current: { model: string } }>(res);
    expect(body.ok).toBe(true);
    // config-a (config only) and pi-only-d (pi only) are both out; current-e rides along
    expect(body.models.map((m) => m.id).sort()).toEqual(["openrouter/config-b", "openrouter/config-c", "openrouter/current-e"]);
    expect(body.current.model).toBe("openrouter/current-e");
  });

  test("AC-003: a candidate carries only the capabilities pi's definition names", async () => {
    const fx = fixture();
    writeRoles(fx, ROLES_CONFIG_A);
    process.env.FAKE_PI_MODELS = JSON.stringify([
      { provider: "openrouter", id: "config-b", name: "Config B", contextWindow: 1000, input: ["text", "image"], reasoning: true },
      { provider: "openrouter", id: "config-c", name: "Config C", contextWindow: 2000, input: ["text"], reasoning: false },
    ]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const body = await json<{ models: { id: string; capabilities: string[] }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    expect(body.models.find((m) => m.id === "openrouter/config-b")?.capabilities).toEqual(["image", "reasoning"]);
    expect(body.models.find((m) => m.id === "openrouter/config-c")?.capabilities).toEqual([]);
  });

  test("AC-002: a model only the user's models.json defines is a candidate when pi accepts it", async () => {
    const fx = fixture();
    writeRoles(fx, [
      "defaults: { title_context_turns: 3 }",
      "models:",
      "  openrouter-config-a:",
      "    model: openrouter/config-a",
      "  openrouter-config-b:",
      "    model: openrouter/config-b",
      "  openrouter-config-c:",
      "    model: openrouter/config-c",
      "  openrouter-config-x:",
      "    model: openrouter/config-x",
      "roles:",
      "  chat: { model: openrouter-config-a, thinking: low, tools: [read] }",
      "  ideas: { model: openrouter-config-b, thinking: low, tools: [read] }",
      "  titler: { model: openrouter-config-c, thinking: low, tools: [read] }",
      "  spare: { model: openrouter-config-x, thinking: low, tools: [read] }",
    ].join("\n") + "\n");
    writeFileSync(join(fx.userAgent, "models.json"), JSON.stringify({ providers: { openrouter: { models: [{ id: "user-m" }] } } }));
    process.env.FAKE_PI_MODELS = JSON.stringify([
      { provider: "openrouter", id: "config-b", name: "Config B" },
      { provider: "openrouter", id: "user-m", name: "User M" },
      { provider: "openrouter", id: "pi-only-d", name: "Pi D" },
    ]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const body = await json<{ models: { id: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("openrouter/user-m");
    // config-x is named by the config but not by pi; pi-only-d is the other way around; neither is offered
    expect(ids).not.toContain("openrouter/config-x");
    expect(ids).not.toContain("openrouter/pi-only-d");
  });
});

describe("the applied effort and the accepted levels", () => {
  test("AC-004: the door and the event report the level pi clamped to, and a model switch re-clamps", async () => {
    const fx = fixture();
    writeRoles(fx, ROLES_CONFIG_A);
    process.env.FAKE_PI_LEVELS = JSON.stringify({ "openrouter/config-a": ["off", "low", "medium", "high"], "openrouter/next-e": ["off", "low", "medium"] });
    process.env.FAKE_PI_MODELS = JSON.stringify([
      { provider: "openrouter", id: "config-a", name: "A" },
      { provider: "openrouter", id: "next-e", name: "E" },
    ]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    // the model accepts up to high, so a requested max is clamped and the answer is high, never max
    const first = await json<{ ok: boolean; effort?: string }>(await api(fx, "POST", `/api/conversations/${created.id}/model`, { effort: "max" }));
    expect(first.effort).toBe("high");
    const switched = await json<{ model?: string; effort?: string }>(await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/next-e" }));
    expect(switched.effort).toBe("medium");
    const seen = await readUntil(events, (e) => e.type === "model" && e.effort === "medium", 5000);
    expect(seen.some((e) => e.type === "model" && e.effort === "high")).toBe(true);
    const state = await json<{ effort?: string }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.effort).toBe("medium");
    await events.close();
  });

  test("AC-005: the door, the answer and the event carry the levels pi reports for the model", async () => {
    const fx = fixture();
    writeRoles(fx, ROLES_CONFIG_A);
    process.env.FAKE_PI_LEVELS = JSON.stringify({ "openrouter/config-a": ["low", "medium"], "openrouter/next-e": ["low", "high", "max"] });
    process.env.FAKE_PI_MODELS = JSON.stringify([
      { provider: "openrouter", id: "config-a", name: "A" },
      { provider: "openrouter", id: "next-e", name: "E" },
    ]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const events = new SseReader(await api(fx, "GET", `/api/conversations/${created.id}/events`));
    const list = await json<{ models: { id: string }[]; current: { efforts?: string[] } }>(await api(fx, "GET", `/api/conversations/${created.id}/models`));
    expect(list.current.efforts).toEqual(["low", "medium"]);
    const opened = await json<{ efforts?: string[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(opened.efforts).toEqual(["low", "medium"]);
    const switched = await json<{ ok: boolean; model?: string; efforts?: string[] }>(await api(fx, "POST", `/api/conversations/${created.id}/model`, { model: "openrouter/next-e" }));
    expect(switched.efforts).toEqual(["low", "high", "max"]);
    const seen = await readUntil(events, (e) => e.type === "context", 5000);
    const modelEvent = seen.find((e) => e.type === "model" && e.model === "openrouter/next-e") as { efforts?: string[] } | undefined;
    expect(modelEvent?.efforts).toEqual(["low", "high", "max"]);
    await events.close();
  });
});

describe("the composer notices", () => {
  test("AC-006: pi's percentage past the threshold earns a context notice, below it earns none", async () => {
    const fx = fixture();
    process.env.FAKE_PI_STATS_PERCENT = "95";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const state = await json<{ notices: { kind: string; percent?: number }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.notices).toContainEqual({ kind: "context", percent: 95 });

    const fx2 = fixture();
    process.env.FAKE_PI_STATS_PERCENT = "50";
    const other = await json<{ id: string }>(await api(fx2, "POST", "/api/conversations", { mode: "chat" }));
    const state2 = await json<{ notices: unknown[] }>(await api(fx2, "GET", `/api/conversations/${other.id}`));
    expect(state2.notices).toEqual([]);
  });

  test("AC-006: a Claude model gets the window notice at the stop line, an openrouter model does not", async () => {
    const fx = fixture();
    writeRoles(fx, [
      "defaults: { title_context_turns: 3 }",
      "models:",
      "  anthropic-claude-sonnet-4-6:",
      "    model: anthropic/claude-sonnet-4-6",
      "roles:",
      "  chat: { model: anthropic-claude-sonnet-4-6, thinking: high, tools: [read] }",
      "  ideas: { model: anthropic-claude-sonnet-4-6, thinking: low, tools: [read] }",
      "  titler: { model: anthropic-claude-sonnet-4-6, thinking: low, tools: [read] }",
    ].join("\n") + "\n");
    writeQuota(fx, { five_hour: { utilization: 0.95 }, seven_day: { utilization: 0.95 } });
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const state = await json<{ notices: { kind: string; window?: string }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.notices.some((n) => n.kind === "quota" && n.window === "five_hour")).toBe(true);

    const fx2 = fixture();
    writeQuota(fx2, { five_hour: { utilization: 0.95 } });
    const other = await json<{ id: string }>(await api(fx2, "POST", "/api/conversations", { mode: "chat" }));
    const state2 = await json<{ notices: { kind: string }[] }>(await api(fx2, "GET", `/api/conversations/${other.id}`));
    expect(state2.notices.filter((n) => n.kind === "quota")).toEqual([]);
  });

  test("AC-006: an open door survives stats it cannot read and answers with no notices", async () => {
    const fx = fixture();
    process.env.FAKE_PI_STATS_ERROR = "1";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const res = await api(fx, "GET", `/api/conversations/${created.id}`);
    expect(res.status).toBe(200);
    const state = await json<{ notices: unknown[]; contextUsage: unknown }>(res);
    expect(state.contextUsage).toBe(null);
    expect(state.notices).toEqual([]);
  });
});

describe("the image limits on the doors", () => {
  const tiny = (n: number) => Array.from({ length: n }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" }));
  const small = { type: "image", data: "AAAA", mimeType: "image/png" };

  test("AC-007 / INV-118-5: more than ten images and an oversize image are refused before pi", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const tooMany = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: tiny(11) });
    expect(tooMany.status).toBe(400);
    const big = { type: "image", data: "A".repeat(14 * 1024 * 1024), mimeType: "image/png" };
    const tooBig = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [big] });
    expect(tooBig.status).toBe(400);
    await sleep(150);
    expect(count(fx, "prompt")).toBe(0);
  });

  test("AC-007 / INV-118-5: a broken item refuses the whole request, so the text never reaches pi alone", async () => {
    const fx = fixture();
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const badData = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [{ type: "image", data: 7, mimeType: "image/png" }] });
    expect(badData.status).toBe(400);
    const badType = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [{ type: "image", data: "AAAA", mimeType: "text/plain" }] });
    expect(badType.status).toBe(400);
    const badSteer = await api(fx, "POST", `/api/conversations/${created.id}/steer`, { text: "look", images: [{ type: "image", data: "AAAA", mimeType: "text/plain" }] });
    expect(badSteer.status).toBe(400);
    await sleep(150);
    expect(count(fx, "prompt")).toBe(0);
    expect(count(fx, "steer")).toBe(0);
    const state = await json<{ queue: unknown[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue).toEqual([]);
  });

  test("AC-007: the new screen's shape passes, and null on an edit takes the images off a queued item", async () => {
    const fx = fixture();
    process.env.FAKE_PI_MS = "2000";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    const shaped = await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "look", images: [{ data: "BBBB", mimeType: "image/png" }] });
    expect(shaped.status).toBe(200);
    await until(() => count(fx, "prompt") === 1);
    expect(commands(fx).find((c) => c.cmd === "prompt")?.images).toEqual([{ type: "image", data: "BBBB", mimeType: "image/png" }]);

    const queued = await json<{ item: { id: string } }>(await api(fx, "POST", `/api/conversations/${created.id}/messages`, { text: "second", images: [small] }));
    const rejected = await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${queued.item.id}`, { images: [{ type: "image", data: "AAAA", mimeType: "text/plain" }] });
    expect(rejected.status).toBe(400);
    const patched = await api(fx, "PATCH", `/api/conversations/${created.id}/queue/${queued.item.id}`, { images: null });
    expect(patched.status).toBe(200);
    const state = await json<{ queue: { id: string; images?: unknown }[] }>(await api(fx, "GET", `/api/conversations/${created.id}`));
    expect(state.queue.find((q) => q.id === queued.item.id)?.images).toBeUndefined();
  });
});

// ---- the user's instructions ----

const ALL_RANGES = { repos: "all", scenes: "all", places: "all" };

/** put an instruction file where the conversation reads it: a dir of the test's own, never the user's real one */
function placeInstructions(fx: Fixture, list: { id: string; text: string; reason: string; scope: unknown }[]): string {
  const dir = join(fx.root, "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instructions.json"), JSON.stringify({
    version: 1, next: list.length + 1,
    instructions: list.map((i) => ({ ...i, created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" })),
  }));
  process.env.IDD_INSTRUCTIONS_DIR = dir;
  return dir;
}

const CHAT_RULE = { id: "INS-1", text: "会話では結論から答える。", reason: "前置きが長いと読まれないから", scope: { repos: "all", scenes: ["chat"], places: ["conversation"] } };
const REVIEW_RULE = { id: "INS-2", text: "レビューは blocker だけを挙げる。", reason: "嘘の指摘で巡が増えるから", scope: { repos: "all", scenes: ["review"], places: "all" } };

async function reopen(fx: Fixture, id: string, startsBefore: number): Promise<void> {
  await api(fx, "POST", `/api/conversations/${id}/close`);
  await until(() => !openConversations().some((c) => c.sessionId === id));
  await api(fx, "GET", `/api/conversations/${id}`);
  await until(() => starts(fx).length === startsBefore + 1);
}

describe("the user's instructions in a conversation", () => {
  test("a conversation starts with the instructions that apply to it, and the way to put a proposal down", async () => {
    const fx = fixture();
    placeInstructions(fx, [CHAT_RULE, REVIEW_RULE]);
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === 1);
    const argv = String(starts(fx)[0].argv);
    expect(argv).toContain("会話では結論から答える。（理由: 前置きが長いと読まれないから）");
    expect(argv).not.toContain("レビューは blocker だけを挙げる。");
    expect(argv).toContain("instruction propose add");
    // the instruction rides in the system prompt and no file is handed over for the agent to open
    expect(argv).not.toContain("instructions.json");
  });

  test("the session's identity is its own id and never a lane's, even when the engine was started from a lane", async () => {
    const fx = fixture();
    process.env.IDD_ID = "IDD-77";
    process.env.IDD_RUN_LANE = "IDD-77";
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    expect(starts(fx)[0].iddId).toBeUndefined();
    expect(starts(fx)[0].runLane).toBeUndefined();
    expect(starts(fx)[0].iddSession).toBe(created.id);
  });

  test("the ledger gets a line per start that really happened, and none for a pi that failed to start", async () => {
    const fx = fixture();
    placeInstructions(fx, [CHAT_RULE]);
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    await until(() => readLedger({ session: created.id }).length === 1);
    const first = readLedger({ session: created.id })[0];
    expect(first).toMatchObject({ instruction: "INS-1", text: CHAT_RULE.text, reason: CHAT_RULE.reason, via: "scope" });
    expect(first.to).toMatchObject({ kind: "conversation", session: created.id, scene: "chat" });
    // a reopen delivers again: the ledger gains a line and the first one is as it was
    await reopen(fx, created.id, 1);
    await until(() => readLedger({ session: created.id }).length === 2);
    expect(readLedger({ session: created.id })[0]).toEqual(first);
    // a start that fails leaves nothing behind
    await api(fx, "POST", `/api/conversations/${created.id}/close`);
    await until(() => !openConversations().some((c) => c.sessionId === created.id));
    process.env.FAKE_PI_FAIL_START = "1";
    await api(fx, "GET", `/api/conversations/${created.id}`);
    await sleep(800);
    expect(readLedger({ session: created.id }).length).toBe(2);
  });

  test("an ephemeral branch receives no instruction and no guidance", async () => {
    const fx = fixture();
    placeInstructions(fx, [CHAT_RULE]);
    placeChatParent(fx, "fork-i", [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "answer")]);
    const before = starts(fx).length;
    const { res, body } = await fork(fx, "fork-i", { at: "a1" });
    expect(res.status).toBe(200);
    await until(() => starts(fx).length === before + 1);
    expect(starts(fx).at(-1)?.session).toBe(body.id);
    expect(argvWithoutInstructions(starts(fx).at(-1))).not.toContain("会話では結論から答える。");
    expect(String(starts(fx).at(-1)?.argv)).not.toContain("instruction propose");
    expect(readLedger({ session: body.id as string })).toEqual([]);
  });
});

describe("the doors of the user's instructions", () => {
  const token = "INSTRUCTION-TOKEN-1";
  const auth = { authorization: `Bearer ${token}` };
  const propose = (fx: Fixture, body: Record<string, unknown>, headers: Record<string, string> = auth) => api(fx, "POST", "/api/idd/instruction", body, headers);
  /** the credential the engine put in that conversation's own pi, which a lane never has */
  const ownCredential = (fx: Fixture, at = 0) => ({ ...auth, "x-idd-session-token": String(starts(fx)[at].iddSessionToken) });
  const openProposals = async (fx: Fixture): Promise<number> => (await json<{ proposals: unknown[] }>(await api(fx, "GET", "/api/idd/instruction?op=proposals"))).proposals.length;
  /** one passkey registered in this engine's state, and the signature the page would make for a proposal's approval */
  const keys = new WeakMap<Fixture, ReturnType<typeof softwareAuthenticator>>();
  async function signedApproval(fx: Fixture, proposal: string, rejection?: { reason: string }): Promise<Record<string, unknown>> {
    let key = keys.get(fx);
    if (!key) {
      key = softwareAuthenticator();
      keys.set(fx, key);
      const { nonce: regNonce, options } = createRegistrationOptions();
      const done = await finishRegistration({ nonce: regNonce, response: key.registration({ challenge: String(options.challenge), origin: "http://localhost:30142", rpId: "localhost" }), name: "test", localScreen: true });
      expect(done.ok).toBe(true);
    }
    const asked = await json<{ nonce: string; challenge: string }>(await api(fx, "POST", "/api/idd/passkey/challenge", { action: rejection ? "instruction_reject" : "instruction_approve", payload: { proposal, ...(rejection ? { reason: rejection.reason } : {}) } }));
    return { proposal, ...(rejection ? { reason: rejection.reason } : {}), nonce: asked.nonce, assertion: key.assertion({ challenge: asked.challenge, origin: "http://localhost:30142", rpId: "localhost" }) };
  }
  const ADD = { kind: "add", text: "PR 本文は短く書く。", reason: "長い本文は読まれないから", scope: ALL_RANGES };

  test("a conversation's agent files a proposal; it changes nothing until the user answers its card", async () => {
    const fx = fixture();
    process.env.IDD_AGENT_TOKEN = token;
    process.env.IDD_INSTRUCTIONS_DIR = join(fx.root, "instructions");
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);

    // no token: refused. a lane: refused. a session that is not a conversation: refused
    const own = ownCredential(fx);
    expect((await propose(fx, { action: "propose", session: created.id, payload: ADD }, {})).status).toBe(401);
    expect((await propose(fx, { action: "propose", idd_id: "IDD-5", session: created.id, payload: ADD }, own)).status).toBe(403);
    expect((await propose(fx, { action: "propose", session: "not-a-conversation", payload: ADD }, own)).status).toBe(403);
    expect((await propose(fx, { action: "approve", session: created.id, payload: { proposal: "INP-1" } }, own)).status).toBe(400);
    // a lane that leaves its id out and names the conversation holds the agent token and no credential of that conversation:
    // none, a made-up one and another conversation's own are all refused
    expect((await propose(fx, { action: "propose", session: created.id, payload: ADD })).status).toBe(403);
    expect((await propose(fx, { action: "propose", session: created.id, payload: ADD }, { ...auth, "x-idd-session-token": "made-up" })).status).toBe(403);
    const other = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 2);
    const theirs = ownCredential(fx, 1);
    expect(theirs["x-idd-session-token"]).not.toBe(own["x-idd-session-token"]);
    expect((await propose(fx, { action: "propose", session: created.id, payload: ADD }, theirs)).status).toBe(403);
    expect((await propose(fx, { action: "propose", session: other.id, payload: ADD }, own)).status).toBe(403);
    expect(await openProposals(fx)).toBe(0);

    const filed = await propose(fx, { action: "propose", session: created.id, payload: ADD }, own);
    expect(filed.status).toBe(200);
    const body = await json<{ id: string; effect: string }>(filed);
    expect(body.effect).toBe("pending");
    // nothing is in force: the read door lists none, and the next start carries no such instruction
    const listed = await json<{ instructions: unknown[] }>(await api(fx, "GET", "/api/idd/instruction?op=list"));
    expect(listed.instructions).toEqual([]);
    const proposals = await json<{ proposals: { id: string; session: string }[] }>(await api(fx, "GET", "/api/idd/instruction?op=proposals"));
    expect(proposals.proposals.map((p) => [p.id, p.session])).toEqual([[body.id, created.id]]);
    await reopen(fx, created.id, 2);
    expect(String(starts(fx).at(-1)?.argv)).not.toContain("PR 本文は短く書く。");
    // the reopened pi carries a credential too (the engine keeps one per session while it runs)
    expect(String(starts(fx).at(-1)?.iddSessionToken)).toBe(String(starts(fx)[0].iddSessionToken));

    // a proposal that breaks the one-sentence, one-line shape is refused at the door
    expect((await propose(fx, { action: "propose", session: created.id, payload: { ...ADD, text: "一つ目。二つ目。" } }, own)).status).toBe(400);
    expect((await propose(fx, { action: "propose", session: created.id, payload: { ...ADD, reason: "一行目\n二行目" } }, own)).status).toBe(400);
  });

  test("the card shows the proposal, and the user's approval is what puts it in force from the next start", async () => {
    const fx = fixture();
    process.env.IDD_AGENT_TOKEN = token;
    const dir = join(fx.root, "instructions");
    process.env.IDD_INSTRUCTIONS_DIR = dir;
    const created = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    const chatAdd = { ...ADD, text: "会話では結論から答える。", scope: { repos: "all", scenes: ["chat"], places: ["conversation"] } };
    const filed = await json<{ id: string }>(await propose(fx, { action: "propose", session: created.id, payload: chatAdd }, ownCredential(fx)));

    // the card is on the Inbox, with no lane and no repo behind it
    const state = await json<{ items: { kind: string; proposalId?: string; proposalKind?: string; repo?: string; handle?: string; after?: { value: string }[] }[] }>(await api(fx, "GET", "/api/idd/state"));
    const card = state.items.find((i) => i.kind === "proposal" && i.proposalId === filed.id);
    expect(card?.proposalKind).toBe("instruction_add");
    expect(card?.repo).toBe("instruction");
    expect(card?.after?.some((r) => r.value === chatAdd.text)).toBe(true);

    // the agent that filed it can reach this door: a rejection with no signature, or a reason alone, leaves the proposal open
    expect((await api(fx, "POST", "/api/idd/decide", { action: "instruction_reject", payload: { proposal: filed.id } })).status).toBe(400);
    expect((await api(fx, "POST", "/api/idd/decide", { action: "instruction_reject", payload: { proposal: filed.id, reason: "要らない" } })).status).toBe(403);
    expect(await openProposals(fx)).toBe(1);
    expect(existsSync(join(dir, "instructions.json"))).toBe(false);

    // the agent that filed it can reach this door, and an approval with no signature changes nothing
    expect((await api(fx, "POST", "/api/idd/decide", { action: "instruction_approve", payload: { proposal: filed.id } })).status).toBe(403);
    expect(existsSync(join(dir, "instructions.json"))).toBe(false);

    const approved = await api(fx, "POST", "/api/idd/decide", { action: "instruction_approve", payload: await signedApproval(fx, filed.id) });
    expect(approved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "instructions.json"), "utf8")).instructions.map((i: { text: string }) => i.text)).toEqual([chatAdd.text]);
    expect(readFileSync(join(dir, "instructions.md"), "utf8")).toContain(chatAdd.text);
    // the pi that is running is untouched; the next start carries the text
    const before = starts(fx).length;
    expect(String(starts(fx)[0].argv)).not.toContain(chatAdd.text);
    await reopen(fx, created.id, before);
    expect(String(starts(fx).at(-1)?.argv)).toContain("会話では結論から答える。（理由: 長い本文は読まれないから）");
    // the card is gone with the answer
    const after = await json<{ items: { proposalId?: string }[] }>(await api(fx, "GET", "/api/idd/state"));
    expect(after.items.some((i) => i.proposalId === filed.id)).toBe(false);
  });

  const CHAT_RULE_TEXT = "会話では結論から答える。";
  const marksOf = (fx: Fixture, id: string) => (JSON.parse(readFileSync(join(fx.cwd, ".propter", "sessions.json"), "utf8")) as { sessions: Record<string, { instructionAdd?: string[]; instructionExclude?: string[] }> }).sessions[id];
  const approveProposal = (fx: Fixture, proposal: string) => signedApproval(fx, proposal).then((payload) => api(fx, "POST", "/api/idd/decide", { action: "instruction_approve", payload }));

  test("a session's own additions and exclusions are the user's signed answer, reach only that session's next start, and outlast a close and reopen", async () => {
    const fx = fixture();
    process.env.IDD_AGENT_TOKEN = token;
    placeInstructions(fx, [CHAT_RULE, REVIEW_RULE]);
    const a = await json<{ id: string }>(await api(fx, "POST", "/api/conversations", { mode: "chat" }));
    await until(() => starts(fx).length === 1);
    const before = starts(fx).length;
    // the marks door is open to every agent, so it does not take the two lists at all
    expect((await marks(fx, a.id, { instructionAdd: ["INS-2"], instructionExclude: ["INS-1"] })).status).toBe(403);
    expect((await marks(fx, a.id, { instructionAdd: null })).status).toBe(403);
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);

    // a proposal for a conversation that does not exist, or an instruction that does not, is refused
    expect((await propose(fx, { action: "propose", payload: { kind: "session", op: "add", target: "INS-2", for_session: "no-such" } })).status).toBe(404);
    expect((await propose(fx, { action: "propose", payload: { kind: "session", op: "add", target: "INS-99", for_session: a.id } })).status).toBe(400);
    expect((await propose(fx, { action: "propose", payload: { kind: "session", op: "swap", target: "INS-2", for_session: a.id } })).status).toBe(400);
    expect((await propose(fx, { action: "propose", idd_id: "IDD-5", payload: { kind: "session", op: "add", target: "INS-2", for_session: a.id } })).status).toBe(403);
    expect(await openProposals(fx)).toBe(0);

    const add = await json<{ id: string }>(await propose(fx, { action: "propose", payload: { kind: "session", op: "add", target: "INS-2", for_session: a.id } }));
    const exclude = await json<{ id: string }>(await propose(fx, { action: "propose", payload: { kind: "session", op: "exclude", target: "INS-1", for_session: a.id } }));
    // filing changes nothing, and the card says whose list it is
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);
    const state = await json<{ items: { proposalId?: string; proposalKind?: string; after?: { label: string; value: string }[] }[] }>(await api(fx, "GET", "/api/idd/state"));
    const card = state.items.find((i) => i.proposalId === add.id);
    expect(card?.proposalKind).toBe("instruction_session");
    expect(card?.after?.some((r) => r.value === a.id)).toBe(true);

    // an answer with no signature changes nothing; a signed one puts the exception in that session's marks
    expect((await api(fx, "POST", "/api/idd/decide", { action: "instruction_approve", payload: { proposal: add.id } })).status).toBe(403);
    expect(existsSync(join(fx.cwd, ".propter", "sessions.json"))).toBe(false);
    expect((await approveProposal(fx, add.id)).status).toBe(200);
    expect((await approveProposal(fx, exclude.id)).status).toBe(200);
    expect(await openProposals(fx)).toBe(0);
    // a running pi is never changed: nothing new started
    expect(starts(fx).length).toBe(before);
    await reopen(fx, a.id, before);
    const afterReopen = String(starts(fx).at(-1)?.argv);
    expect(afterReopen).toContain("レビューは blocker だけを挙げる。");
    expect(afterReopen).not.toContain(CHAT_RULE_TEXT);
    // another conversation is as it was, and the instruction file did not change
    await api(fx, "POST", "/api/conversations", { mode: "chat" });
    await until(() => starts(fx).length === before + 2);
    const other = String(starts(fx).at(-1)?.argv);
    expect(other).toContain(CHAT_RULE_TEXT);
    expect(other).not.toContain("レビューは blocker だけを挙げる。");
    // the marks file keeps the exceptions: a restart of the engine reads them again
    expect(marksOf(fx, a.id)).toMatchObject({ instructionAdd: ["INS-2"], instructionExclude: ["INS-1"] });
    await reopen(fx, a.id, starts(fx).length);
    expect(String(starts(fx).at(-1)?.argv)).toContain("レビューは blocker だけを挙げる。");
    // leaving INS-2 out takes it out of the additions, and clearing both removes the fields
    const moved = await json<{ id: string }>(await propose(fx, { action: "propose", payload: { kind: "session", op: "exclude", target: "INS-2", for_session: a.id } }));
    expect((await approveProposal(fx, moved.id)).status).toBe(200);
    expect(marksOf(fx, a.id)?.instructionAdd).toBeUndefined();
    expect(marksOf(fx, a.id)?.instructionExclude).toEqual(["INS-1", "INS-2"]);
    for (const target of ["INS-1", "INS-2"]) {
      const cleared = await json<{ id: string }>(await propose(fx, { action: "propose", payload: { kind: "session", op: "clear", target, for_session: a.id } }));
      expect((await approveProposal(fx, cleared.id)).status).toBe(200);
    }
    expect(marksOf(fx, a.id)).toBeUndefined();
  });

  test("the doors an agent can call have no approval: only the decision door answers a proposal", () => {
    const writes = routes.filter((r) => r.pattern.startsWith("/api/idd/instruction") && r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.pattern}`)).toEqual(["POST /api/idd/instruction"]);
  });
});
