// intent: DEC-700 — 段階を繋ぐのは orchestrator の仕事。1 回の tick で S0 から順に一巡させる

import { runIntake } from "../intake/run.ts";
import { runPrep } from "./prep.ts";
import { runExec } from "./exec.ts";
import { runCheck } from "./review.ts";
import { runClose } from "./close.ts";
import { deliverPending } from "../agent/outbox.ts";

export interface TickResult {
  intake: { added: string[]; duplicates: number; failures: number };
  prep: { started: string[]; skipped: number };
  exec: { started: string[]; skipped: number };
  check: { clean: string[]; conflict: string[] };
  close: { merged: string[] };
  deliver: { delivered: number; skipped: number };
}

export async function runTick(opts: { intake?: boolean } = {}): Promise<TickResult> {
  const intake = opts.intake === false
    ? { added: [], duplicates: [], failures: [] }
    : await runIntake();

  // intent: DEC-700 — 判断が要る段階の手前で止まる。GO / 承認 / 提出は人間の押下でしか進まない
  const close = await runClose();
  const check = await runCheck();
  const exec = await runExec();
  const prep = await runPrep();
  const deliver = await deliverPending();

  return {
    intake: { added: intake.added, duplicates: intake.duplicates.length, failures: intake.failures.length },
    prep: { started: prep.started.map((s) => s.iddId), skipped: prep.skipped.length },
    exec: { started: exec.started.map((s) => s.iddId), skipped: exec.skipped.length },
    check: {
      clean: check.filter((c) => c.outcome === "clean").map((c) => c.iddId),
      conflict: check.filter((c) => c.outcome === "conflict").map((c) => c.iddId),
    },
    close: { merged: close.filter((c) => c.outcome === "merged").map((c) => c.iddId) },
    deliver: { delivered: deliver.delivered.length, skipped: deliver.skipped.length },
  };
}
