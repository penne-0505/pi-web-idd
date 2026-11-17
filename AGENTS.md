# AGENTS.md

pi-web v0.8.9（agegr, MIT）の派生で、いまは propter（拡張 IDD）の engine・CLI・画面を持つ monorepo である。上流の root の Next の画面は消えた。画面は `packages/idd-gui` だけで、engine が `/gui/` で配る。

## Quick Start

```bash
bin/idd-engine         # engine（API と画面）を 30144 で起こす。常駐は idd-engine.service
npm run build:gui      # 画面の bundle を packages/idd-gui/dist/ に作る（bun）
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
Test: `npm test`・`npm run test:core`・`npm run test:lane`

画面は engine と同じ port の `http://127.0.0.1:30144/gui/` で開く。engine は `dist/` を要求のたびに disk から読むので、bundle を作り直しても再起動は要らない。

---

## Architecture

```
Browser ── GET /gui/…  ───────▶ IDD engine (Bun, one process, port 30144)
        ── /api/idd/…  ───────▶   state・tick・supervisor・HTTP API
        ── /api/conversations ─▶   conversations: one `pi --mode rpc` child per session
```

- engine（`packages/idd-engine`）が API と画面の bundle を同じ port・同じ origin で配る。別の画面の server は無い。
- 画面（`packages/idd-gui`）は engine の API だけを読む。state の file を自分で読まず、agent も自分の process では動かさない。
- 画面の bundle は `build.json` に build の commit を持つ。engine は自分と同じ commit の bundle だけを配り、別の commit の bundle は理由つきの 503 で断る（作り直しは `idd gui-build`。engine が入れ替わった後に自分で頼む）。
- CLI（`bin/idd`）が返す受信箱の URL は engine の `/gui/?view=inbox&card=<id>` で、画面はその card を前に出す。URL の宛先は `inboxBaseUrl()`（`packages/idd-core/src/agent/token.ts`）だけが決める。

## Layout

```
packages/idd-core     engine の中身（記録・遷移・検査・install）
packages/idd-engine   HTTP の口・会話・build の監視
packages/idd-lane     lane の実行（runner・brief・検査）
packages/idd-cli      CLI（idd）
packages/idd-gui      画面（Bun で bundle する React）
lib/                  engine・CLI・画面が読む共有 module（`lib/idd-ui/` の型と card の文面、request-security など）
```

---

## Key Design Decisions & Traps

### Conversations live in the engine (`packages/idd-engine/src/server/conversations.ts`)
- One engine process owns every mode conversation's `pi --mode rpc` child; no other process runs an agent (INV-1042).
- An engine conversation is keyed by session id; the engine prepares the role's agent dir in a child so a slow catalog fetch does not freeze its event loop.

### Fork re-registers the engine conversation
pi 1.0.0's `fork` switches the *same process* to a new session id. The engine reads the id back from `get_state` and re-registers the conversation under it, so one session record never has two pi writers (INV-1044).

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — it has zero effect on chat content. It is safe to rewrite the whole file (pi does this itself during migrations).

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```
