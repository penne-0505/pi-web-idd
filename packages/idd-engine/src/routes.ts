import * as agentProgress from "./routes/agent-progress.ts";
import * as agentQuestions from "./routes/agent-questions.ts";
import * as agentGranularity from "./routes/agent-granularity.ts";
import * as agentReady from "./routes/agent-ready.ts";
import * as agentResult from "./routes/agent-result.ts";
import * as agentHold from "./routes/agent-hold.ts";
import * as check from "./routes/check.ts";
import * as close from "./routes/close.ts";
import * as consult from "./routes/consult.ts";
import * as conversationSearch from "./routes/conversation-search.ts";
import * as conversationSettings from "./routes/conversation-settings.ts";
import * as conversations from "./routes/conversations.ts";
import * as decide from "./routes/decide.ts";
import * as deliver from "./routes/deliver.ts";
import * as exec from "./routes/exec.ts";
import * as forecast from "./routes/forecast.ts";
import * as gui from "./routes/gui.ts";
import * as idea from "./routes/idea.ts";
import * as intake from "./routes/intake.ts";
import * as intakeIgnore from "./routes/intake-ignore.ts";
import * as intent from "./routes/intent.ts";
import * as instruction from "./routes/instruction.ts";
import * as lane from "./routes/lane.ts";
import * as liveSessions from "./routes/live-sessions.ts";
import * as metrics from "./routes/metrics.ts";
import * as modePlan from "./routes/mode-plan.ts";
import * as modeRecord from "./routes/mode-record.ts";
import * as modes from "./routes/modes.ts";
import * as overlay from "./routes/overlay.ts";
import * as order from "./routes/order.ts";
import * as passkeyChallenge from "./routes/passkey-challenge.ts";
import * as passkeyPending from "./routes/passkey-pending.ts";
import * as passkeyPin from "./routes/passkey-pin.ts";
import * as passkeyRegister from "./routes/passkey-register.ts";
import * as prep from "./routes/prep.ts";
import * as quota from "./routes/quota.ts";
import * as reload from "./routes/reload.ts";
import * as resume from "./routes/resume.ts";
import * as sessionInfo from "./routes/session-info.ts";
import * as snooze from "./routes/snooze.ts";
import * as state from "./routes/state.ts";
import * as stateEvents from "./routes/state-events.ts";
import * as storage from "./routes/storage.ts";
import * as tick from "./routes/tick.ts";
import * as transcriptions from "./routes/transcriptions.ts";
import * as work from "./routes/work.ts";
import * as workspaces from "./routes/workspaces.ts";

/** engine が答える口。パスと method は移す前の Next の route と同じ（モードの開始だけは GUI の route に分かれる）。 */
export type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

export interface Route {
  method: string;
  /** `:name` は 1 つの segment に当たる */
  pattern: string;
  handler: RouteHandler;
}

export const routes: readonly Route[] = [
  { method: "GET", pattern: "/api/idd/state", handler: state.GET },
  // the state and Work pictures as they move: one numbered stream a screen keeps open instead of reading on an interval
  { method: "GET", pattern: "/api/idd/events", handler: stateEvents.EVENTS },
  { method: "GET", pattern: "/api/idd/forecast", handler: forecast.GET },
  // 期間の指標（Issue #189）: 台帳・取り込みの検査の記録・git・予算の読み手から読むだけの口
  { method: "GET", pattern: "/api/idd/metrics", handler: metrics.GET },
  { method: "GET", pattern: "/api/idd/work", handler: work.GET },
  { method: "GET", pattern: "/api/idd/work/lanes/:id/decisions", handler: work.DECISIONS },
  { method: "GET", pattern: "/api/idd/work/lanes/:id/record", handler: work.RECORD },
  { method: "GET", pattern: "/api/idd/work/findings", handler: work.FINDINGS },
  { method: "GET", pattern: "/api/idd/work/consumption", handler: work.CONSUMPTION },
  { method: "GET", pattern: "/api/idd/storage", handler: storage.GET },
  // the built screen, on the API's own port and origin; `/gui` and `/gui/:file` are the only two names
  { method: "GET", pattern: "/gui", handler: gui.GET },
  { method: "GET", pattern: "/gui/:file", handler: gui.GET },
  { method: "POST", pattern: "/api/idd/tick", handler: tick.POST },
  { method: "POST", pattern: "/api/idd/decide", handler: decide.POST },
  // v2 の意図の記録: 書く口は agent の token を求め、読む口は求めない
  { method: "POST", pattern: "/api/idd/intent", handler: intent.POST },
  { method: "GET", pattern: "/api/idd/intent", handler: intent.GET },
  // the user's instructions: a conversation's agent proposes (the write door files a proposal and nothing more), anyone reads
  { method: "POST", pattern: "/api/idd/instruction", handler: instruction.POST },
  { method: "GET", pattern: "/api/idd/instruction", handler: instruction.GET },
  { method: "POST", pattern: "/api/idd/consult", handler: consult.POST },
  { method: "GET", pattern: "/api/idd/check", handler: check.GET },
  { method: "POST", pattern: "/api/idd/check", handler: check.POST },
  { method: "GET", pattern: "/api/idd/close", handler: close.GET },
  { method: "POST", pattern: "/api/idd/close", handler: close.POST },
  { method: "GET", pattern: "/api/idd/deliver", handler: deliver.GET },
  { method: "POST", pattern: "/api/idd/deliver", handler: deliver.POST },
  { method: "GET", pattern: "/api/idd/exec", handler: exec.GET },
  { method: "POST", pattern: "/api/idd/exec", handler: exec.POST },
  { method: "POST", pattern: "/api/idd/intake", handler: intake.POST },
  { method: "GET", pattern: "/api/idd/intake/ignore", handler: intakeIgnore.GET },
  { method: "POST", pattern: "/api/idd/intake/ignore", handler: intakeIgnore.POST },
  // the start order and the urgent marks: the Work screen's reader and the person's move / urgent doors
  { method: "GET", pattern: "/api/idd/order", handler: order.GET },
  { method: "POST", pattern: "/api/idd/order", handler: order.POST },
  { method: "GET", pattern: "/api/idd/lane/:id", handler: lane.GET },
  { method: "GET", pattern: "/api/idd/modes", handler: modes.GET },
  { method: "POST", pattern: "/api/idd/modes/:name/plan", handler: modePlan.POST },
  { method: "POST", pattern: "/api/idd/modes/:name/record", handler: modeRecord.POST },
  { method: "POST", pattern: "/api/idd/overlay", handler: overlay.POST },
  { method: "POST", pattern: "/api/idd/passkey/challenge", handler: passkeyChallenge.POST },
  { method: "GET", pattern: "/api/idd/passkey/pending", handler: passkeyPending.GET },
  { method: "POST", pattern: "/api/idd/passkey/pending/approve", handler: passkeyPending.POST },
  { method: "GET", pattern: "/api/idd/passkey/pin", handler: passkeyPin.GET },
  { method: "POST", pattern: "/api/idd/passkey/pin", handler: passkeyPin.POST },
  { method: "GET", pattern: "/api/idd/passkey/register", handler: passkeyRegister.GET },
  { method: "POST", pattern: "/api/idd/passkey/register", handler: passkeyRegister.POST },
  { method: "GET", pattern: "/api/idd/prep", handler: prep.GET },
  { method: "POST", pattern: "/api/idd/prep", handler: prep.POST },
  { method: "POST", pattern: "/api/idd/resume", handler: resume.POST },
  { method: "POST", pattern: "/api/idd/reload", handler: reload.POST },
  { method: "POST", pattern: "/api/idd/snooze", handler: snooze.POST },
  { method: "POST", pattern: "/api/idd/agent/progress", handler: agentProgress.POST },
  { method: "POST", pattern: "/api/idd/agent/questions", handler: agentQuestions.POST },
  { method: "POST", pattern: "/api/idd/agent/granularity", handler: agentGranularity.POST },
  { method: "POST", pattern: "/api/idd/agent/ready", handler: agentReady.POST },
  { method: "POST", pattern: "/api/idd/agent/result", handler: agentResult.POST },
  { method: "POST", pattern: "/api/idd/agent/hold", handler: agentHold.POST },
  { method: "GET", pattern: "/api/idd/session/:id", handler: sessionInfo.GET },
  { method: "GET", pattern: "/api/idd/live-sessions", handler: liveSessions.GET },
  // the conversation API: its own namespace, apart from the lane's `/api/idd/`. The fixed `workspaces`
  // segment comes before `/api/conversations/:id`, so that door is never read as a session id.
  { method: "POST", pattern: "/api/conversations", handler: conversations.CREATE },
  { method: "GET", pattern: "/api/conversations", handler: conversations.LIST },
  { method: "GET", pattern: "/api/conversations/workspaces", handler: workspaces.LIST },
  { method: "GET", pattern: "/api/conversations/workspaces/:mode", handler: workspaces.GET },
  { method: "GET", pattern: "/api/conversations/workspaces/:mode/spaces", handler: workspaces.SPACES },
  { method: "POST", pattern: "/api/conversations/workspaces/:mode/spaces", handler: workspaces.SPACE_CREATE },
  { method: "GET", pattern: "/api/conversations/workspaces/:mode/spaces/:id", handler: workspaces.SPACE_GET },
  { method: "PATCH", pattern: "/api/conversations/workspaces/:mode/spaces/:id", handler: workspaces.SPACE_PATCH },
  { method: "GET", pattern: "/api/conversations/workspaces/:mode/bookmarks", handler: workspaces.BOOKMARKS },
  { method: "POST", pattern: "/api/conversations/workspaces/:mode/bookmarks", handler: workspaces.BOOKMARK_CREATE },
  { method: "PATCH", pattern: "/api/conversations/workspaces/:mode/bookmarks/:id", handler: workspaces.BOOKMARK_PATCH },
  { method: "DELETE", pattern: "/api/conversations/workspaces/:mode/bookmarks/:id", handler: workspaces.BOOKMARK_DELETE },
  { method: "GET", pattern: "/api/conversations/:id", handler: conversations.OPEN },
  { method: "DELETE", pattern: "/api/conversations/:id", handler: conversations.REMOVE },
  { method: "PATCH", pattern: "/api/conversations/:id/marks", handler: conversations.MARKS },
  { method: "GET", pattern: "/api/conversations/:id/events", handler: conversations.EVENTS },
  { method: "POST", pattern: "/api/conversations/:id/messages", handler: conversations.SEND },
  { method: "POST", pattern: "/api/conversations/:id/steer", handler: conversations.STEER },
  { method: "POST", pattern: "/api/conversations/:id/stop", handler: conversations.STOP },
  { method: "POST", pattern: "/api/conversations/:id/model", handler: conversations.MODEL },
  { method: "POST", pattern: "/api/conversations/:id/type", handler: conversations.TYPE },
  { method: "POST", pattern: "/api/conversations/:id/command", handler: conversations.COMMAND },
  { method: "POST", pattern: "/api/conversations/:id/ephemeral", handler: conversations.FORK },
  { method: "POST", pattern: "/api/conversations/:id/promote", handler: conversations.PROMOTE },
  { method: "GET", pattern: "/api/conversations/:id/context", handler: conversations.CONTEXT },
  { method: "GET", pattern: "/api/conversations/:id/models", handler: conversations.MODELS },
  // the idea document: its status, the gate approvals, and the one signature that runs the exits
  { method: "GET", pattern: "/api/conversations/:id/idea", handler: idea.GET },
  { method: "POST", pattern: "/api/conversations/:id/idea/gates", handler: idea.GATES },
  { method: "POST", pattern: "/api/conversations/:id/idea/exits/challenge", handler: idea.CHALLENGE },
  { method: "POST", pattern: "/api/conversations/:id/idea/exits/run", handler: idea.RUN },
  { method: "POST", pattern: "/api/conversations/:id/title", handler: conversations.TITLE },
  { method: "POST", pattern: "/api/conversations/:id/close", handler: conversations.CLOSE },
  { method: "PATCH", pattern: "/api/conversations/:id/queue/:itemId", handler: conversations.EDIT_QUEUE },
  { method: "DELETE", pattern: "/api/conversations/:id/queue/:itemId", handler: conversations.DELETE_QUEUE },
  { method: "POST", pattern: "/api/conversations/:id/queue/:itemId/steer", handler: conversations.STEER_QUEUE },
  // the conversation side features: search, settings, quota and transcription
  { method: "GET", pattern: "/api/conversation-search", handler: conversationSearch.GET },
  { method: "GET", pattern: "/api/conversation-settings", handler: conversationSettings.GET },
  { method: "PATCH", pattern: "/api/conversation-settings", handler: conversationSettings.PATCH },
  { method: "GET", pattern: "/api/quota", handler: quota.GET },
  { method: "POST", pattern: "/api/transcriptions", handler: transcriptions.POST },
];

/** 要求のパスを pattern に当て、`:name` の値を返す（当たらなければ null） */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const value = pathParts[i];
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(value);
    else if (p !== value) return null;
  }
  return params;
}
