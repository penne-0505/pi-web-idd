// intent: DEC-002 — IDD button endpoint、pi-web 既存に触れず additive
// intent: DEC-006 — button push は per-action 承認、UI 側 batch 化しない。ledger 書き込みは authoritative の msync CLI 経由 (TS 側で flock を reimplement しない)

import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  ALL_LIFECYCLE_EVENT_NAMES,
  emitLifecycleLine,
  type LifecycleEventName,
} from "@/lib/idd/lifecycle-schema";

export const dynamic = "force-dynamic";

interface LifecyclePostBody {
  event?: unknown;
  repo?: unknown;
  attrs?: unknown;
  attrsJson?: unknown;
}

// intent: DEC-005 — event / repo は validated string、attrs は object、attrsJson は string。それ以外は 400
function validateBody(raw: unknown): { ok: true; event: LifecycleEventName; repo: string; attrs: Record<string, unknown>; attrsJson: string | undefined } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const body = raw as LifecyclePostBody;
  if (typeof body.event !== "string" || !ALL_LIFECYCLE_EVENT_NAMES.includes(body.event as LifecycleEventName)) {
    return { ok: false, error: `event must be one of: ${ALL_LIFECYCLE_EVENT_NAMES.slice().sort().join(", ")}` };
  }
  if (typeof body.repo !== "string" || body.repo.length === 0) {
    return { ok: false, error: "repo must be a non-empty string" };
  }
  const attrs = body.attrs;
  if (attrs !== undefined && (attrs === null || typeof attrs !== "object" || Array.isArray(attrs))) {
    return { ok: false, error: "attrs must be a JSON object if provided" };
  }
  if (body.attrsJson !== undefined && typeof body.attrsJson !== "string") {
    return { ok: false, error: "attrsJson must be a string if provided" };
  }
  return {
    ok: true,
    event: body.event as LifecycleEventName,
    repo: body.repo,
    attrs: (attrs as Record<string, unknown> | undefined) ?? {},
    attrsJson: body.attrsJson as string | undefined,
  };
}

function resolveMsyncBin(): { ok: true; bin: string } | { ok: false; error: string } {
  const root = process.env.MSYNC_ROOT?.trim();
  if (!root) return { ok: false, error: "MSYNC_ROOT env var is unset" };
  return { ok: true, bin: join(root, "bin", "msync") };
}

interface MsyncResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runMsyncLifecycle(bin: string, event: string, repo: string, attrsJson: string): Promise<MsyncResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["lifecycle", event, repo, "--attrs-json", attrsJson], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (exc) {
    return NextResponse.json(
      { ok: false, error: `body is not valid JSON: ${(exc as Error).message}` },
      { status: 400 },
    );
  }

  const parsed = validateBody(raw);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  // intent: DEC-005 — local validation で早期 reject し、msync spawn を無駄に叩かない。ts は dummy でよい (実 write 時に msync 側が発行)
  const localCheck = emitLifecycleLine({
    event: parsed.event,
    ts: "1970-01-01T00:00:00+00:00",
    repo: parsed.repo,
    attrs: parsed.attrs,
    attrsJson: parsed.attrsJson,
  });
  if (!localCheck.ok) {
    return NextResponse.json({ ok: false, error: localCheck.error }, { status: 400 });
  }

  const bin = resolveMsyncBin();
  if (!bin.ok) {
    return NextResponse.json({ ok: false, error: bin.error }, { status: 503 });
  }

  // intent: DEC-006 — attrs と attrsJson を JSON にまとめ msync に投げる。実 ledger append と flock は msync 側の SSOT に委譲
  const merged: Record<string, unknown> = {};
  if (parsed.attrsJson) {
    try {
      const overlay = JSON.parse(parsed.attrsJson);
      if (overlay !== null && typeof overlay === "object" && !Array.isArray(overlay)) {
        Object.assign(merged, overlay);
      }
    } catch {}
  }
  Object.assign(merged, parsed.attrs);

  const result = await runMsyncLifecycle(bin.bin, parsed.event, parsed.repo, JSON.stringify(merged));
  if (result.code !== 0) {
    return NextResponse.json(
      { ok: false, error: `msync lifecycle failed (exit ${result.code})`, stderr: result.stderr },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, event: parsed.event, repo: parsed.repo });
}
