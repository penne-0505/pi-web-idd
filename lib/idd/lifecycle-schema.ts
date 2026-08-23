/**
 * IDD lifecycle event schema + emit / fold helpers.
 *
 * Contract inherited from the Meltly side (see DEC-005 in
 * _docs/intent/Workspace/pi-web-idd-workspace/decision.md). The event vocabulary
 * mirrors sync-tools/lib/lifecycle.py exactly — event names, attr sets, enum
 * values, and the field order of the emitted JSON line all match. Any change
 * here is a breaking change to the shared ledger contract.
 *
 * Pure module: no fs / process / node built-ins. Safe to import from React
 * client code (for typed button POST bodies) and from server API routes.
 * File I/O lives in a separate module (see lib/idd/ledger-io.ts when added).
 */

// ---------- Schema (SSOT) ----------

export const LIFECYCLE_SCHEMA = {
  lane_open: {
    required: ["linear_issue_id", "worktree_branch", "worker"],
    optional: [],
    enums: {},
  },
  s1_ready: {
    required: ["linear_issue_id", "clarity_verdict"],
    optional: ["clarity_reasoning"],
    enums: { clarity_verdict: ["clear", "borderline"] },
  },
  s1_go: {
    required: ["linear_issue_id", "user_decision"],
    optional: [],
    enums: { user_decision: ["go", "forced_go"] },
  },
  s1_defer: {
    required: ["linear_issue_id"],
    optional: ["defer_reason"],
    enums: {},
  },
  s2_start: {
    required: ["linear_issue_id", "worker"],
    optional: [],
    enums: {},
  },
  s2_blocked: {
    required: ["linear_issue_id", "blocker_narrative"],
    optional: [],
    enums: {},
  },
  s2_result: {
    required: ["linear_issue_id", "result"],
    optional: ["narrative"],
    enums: { result: ["success", "failure"] },
  },
  s3_ready: {
    required: ["linear_issue_id", "narrative"],
    optional: ["touched_paths", "ac_coverage"],
    enums: {},
  },
  s3_ok: {
    required: ["linear_issue_id"],
    optional: [],
    enums: {},
  },
  s3_reject: {
    required: ["linear_issue_id", "reason"],
    optional: [],
    enums: {},
  },
  s4_submitted: {
    required: ["linear_issue_id", "pr_number", "pr_url"],
    optional: [],
    enums: {},
  },
  s4_merged: {
    required: ["linear_issue_id"],
    optional: ["merged_at"],
    enums: {},
  },
  lane_close: {
    required: ["linear_issue_id", "close_reason"],
    optional: [],
    enums: { close_reason: ["merged", "defer", "delete"] },
  },
} as const satisfies Record<
  string,
  { required: readonly string[]; optional: readonly string[]; enums: Record<string, readonly string[]> }
>;

export type LifecycleEventName = keyof typeof LIFECYCLE_SCHEMA;
export type LifecycleEventType = `lifecycle_${LifecycleEventName}`;

export const ALL_LIFECYCLE_EVENT_NAMES = Object.keys(LIFECYCLE_SCHEMA) as LifecycleEventName[];

// ---------- Emit ----------

export interface EmitOptions {
  /** Event stem without the `lifecycle_` prefix. */
  event: LifecycleEventName;
  /** ISO 8601 timestamp with tz offset, e.g. "2026-08-23T09:32:05+09:00". */
  ts: string;
  /** Repo alias (flutter / server / web / …). */
  repo: string;
  /** Attrs seed. Overrides `attrsJson` on key collision (matches Python behavior). */
  attrs?: Record<string, unknown>;
  /** Optional JSON-string overlay applied *before* `attrs` (attrs then overlay wins). */
  attrsJson?: string;
}

export type EmitResult =
  | { ok: true; line: string; parsed: LifecycleEventRecord }
  | { ok: false; error: string };

/** A parsed ledger line. Field order matches the emitted JSON. */
export interface LifecycleEventRecord {
  ts: string;
  repo: string;
  type: LifecycleEventType;
  linear_issue_id: string;
  [key: string]: unknown;
}

/**
 * Validate a lifecycle event and produce the JSON line the caller must append
 * to `state/ledger-<repo>.jsonl`.
 *
 * The caller is responsible for the ledger flock and file append; this
 * function is pure. Field order in the emitted JSON mirrors Python:
 *   ts, repo, type, then schema-declared attrs in declared order.
 */
export function emitLifecycleLine(opts: EmitOptions): EmitResult {
  if (!(opts.event in LIFECYCLE_SCHEMA)) {
    return {
      ok: false,
      error: `unknown lifecycle event: ${opts.event}. valid: ${ALL_LIFECYCLE_EVENT_NAMES.slice().sort().join(", ")}`,
    };
  }
  const schema = LIFECYCLE_SCHEMA[opts.event];

  // 1. Seed from attrsJson (if provided).
  const seeded: Record<string, unknown> = {};
  if (opts.attrsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.attrsJson);
    } catch (exc) {
      return { ok: false, error: `attrsJson is not valid JSON: ${(exc as Error).message}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "attrsJson must be a JSON object" };
    }
    Object.assign(seeded, parsed as Record<string, unknown>);
  }

  // 2. Overlay explicit attrs (win on collision).
  if (opts.attrs) Object.assign(seeded, opts.attrs);

  // 3. Silently drop unknown keys (per contract — extra fields ignored).
  const known = new Set<string>([...schema.required, ...schema.optional]);
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seeded)) {
    if (known.has(k)) attrs[k] = v;
  }

  // 4. Required-attr check.
  const missing = schema.required.filter((k) => !(k in attrs));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `lifecycle_${opts.event}: missing required attr(s): ${missing.join(", ")}`,
    };
  }

  // 5. Enum check.
  for (const [k, allowed] of Object.entries(schema.enums) as [string, readonly string[]][]) {
    if (k in attrs) {
      const v = attrs[k];
      if (typeof v !== "string" || !allowed.includes(v)) {
        return {
          ok: false,
          error: `lifecycle_${opts.event}: attr ${k}=${JSON.stringify(v)} not in [${allowed.join(", ")}]`,
        };
      }
    }
  }

  // 6. Build the record in declared field order.
  const out: LifecycleEventRecord = {
    ts: opts.ts,
    repo: opts.repo,
    type: `lifecycle_${opts.event}`,
    linear_issue_id: attrs.linear_issue_id as string,
  };
  for (const k of [...schema.required, ...schema.optional]) {
    if (k === "linear_issue_id") continue; // already placed above
    if (k in attrs) out[k] = attrs[k];
  }

  // JSON separators must match Python: no spaces, ensure_ascii=False equivalent.
  // TS JSON.stringify already emits UTF-8 without spaces by default.
  return { ok: true, line: JSON.stringify(out), parsed: out };
}

// ---------- Fold ----------

/** Stage template + attr keys whose values fill the template. */
const STAGE_MAP: Record<LifecycleEventType, [string, readonly string[]]> = {
  lifecycle_lane_open:    ["lane-open",       []],
  lifecycle_s1_ready:     ["s1-ready-{}",     ["clarity_verdict"]],
  lifecycle_s1_go:        ["s1-go",           []],
  lifecycle_s1_defer:     ["s1-defer",        []],
  lifecycle_s2_start:     ["s2-implementing", []],
  lifecycle_s2_blocked:   ["s2-blocked",      []],
  lifecycle_s2_result:    ["s2-{}",           ["result"]],
  lifecycle_s3_ready:     ["s3-ready",        []],
  lifecycle_s3_ok:        ["s3-ok",           []],
  lifecycle_s3_reject:    ["s3-rejected",     []],
  lifecycle_s4_submitted: ["s4-submitted",    []],
  lifecycle_s4_merged:    ["s4-merged",       []],
  lifecycle_lane_close:   ["lane-close",      []],
};

/** Derive a human-facing stage label from one lifecycle event. */
export function deriveStage(event: Pick<LifecycleEventRecord, "type"> & Record<string, unknown>): string {
  const entry = STAGE_MAP[event.type];
  if (!entry) return "unknown";
  const [tmpl, keys] = entry;
  if (keys.length === 0) return tmpl;
  let i = 0;
  return tmpl.replace(/\{\}/g, () => {
    const k = keys[i++];
    const v = event[k];
    return v == null ? "" : String(v);
  });
}

export interface LaneState {
  linearIssueId: string;
  stage: string;
  worker?: string;
  worktree?: string;
  since: string; // ISO ts of the most recent event
  lastEvent: LifecycleEventRecord;
}

/** Type guard for a well-formed lifecycle event record. */
export function isLifecycleEvent(value: unknown): value is LifecycleEventRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === "string" &&
    v.type.startsWith("lifecycle_") &&
    typeof v.ts === "string" &&
    typeof v.repo === "string" &&
    typeof v.linear_issue_id === "string" &&
    v.linear_issue_id.length > 0
  );
}

/**
 * Fold a sequence of lifecycle events into per-lane state. Non-lifecycle events
 * are skipped silently. Retired lanes (last event = `lifecycle_lane_close`) are
 * omitted from the output — matches Python `cmd_status`. Use `foldLifecycleLedgerFull`
 * if the caller needs retired lanes too.
 */
export function foldLifecycleLedger(events: readonly unknown[]): Map<string, LaneState> {
  const full = foldLifecycleLedgerFull(events);
  const active = new Map<string, LaneState>();
  for (const [iid, state] of full) {
    if (state.lastEvent.type !== "lifecycle_lane_close") active.set(iid, state);
  }
  return active;
}

/**
 * Fold that keeps retired lanes too. Useful for a history tab or archived view.
 */
export function foldLifecycleLedgerFull(events: readonly unknown[]): Map<string, LaneState> {
  interface Accum {
    lastEvent: LifecycleEventRecord;
    worker?: string;
    worktree?: string;
  }
  const acc = new Map<string, Accum>();

  for (const raw of events) {
    if (!isLifecycleEvent(raw)) continue;
    const state = acc.get(raw.linear_issue_id) ?? ({ lastEvent: raw } as Accum);
    state.lastEvent = raw;
    if (raw.type === "lifecycle_lane_open") {
      const wt = raw.worktree_branch;
      const wk = raw.worker;
      if (typeof wt === "string") state.worktree = wt;
      if (typeof wk === "string" && wk) state.worker = wk;
    } else if (raw.type === "lifecycle_s2_start") {
      const wk = raw.worker;
      if (typeof wk === "string" && wk) state.worker = wk;
    }
    acc.set(raw.linear_issue_id, state);
  }

  const out = new Map<string, LaneState>();
  for (const [iid, state] of acc) {
    out.set(iid, {
      linearIssueId: iid,
      stage: deriveStage(state.lastEvent),
      worker: state.worker,
      worktree: state.worktree,
      since: state.lastEvent.ts,
      lastEvent: state.lastEvent,
    });
  }
  return out;
}
