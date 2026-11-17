import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The lock that lets one supervisor at a time feed a conversation lane. It is a file whose whole content
 * (owner pid, the owner's start time, a nonce) is written aside and linked into place, so it never exists
 * half written. Whether the owner lives is told by its pid and its start time (a pid reused by another
 * process does not count), never by how old the file looks: a supervisor back from a suspend is still the
 * owner. A lock left by a dead owner is taken down only under a second lock, and only if it is still the
 * lock that was found dead, so two supervisors cleaning it up at once cannot take down each other's.
 */

export const CONVERSATION_LOCK = "conversation.lock";
const BREAK_LOCK = "conversation.lock.break";

export interface LockOwner {
  pid: number;
  /** the owner's start time (/proc/<pid>/stat field 22); null where /proc cannot be read */
  start: string | null;
  nonce: string;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** a process's start time in clock ticks since boot, which tells a pid reused by another process apart */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // the command name (field 2) is in parentheses and may hold spaces; the fields after it start at field 3
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

export function ownerAlive(owner: LockOwner | null): boolean {
  if (!owner || !pidAlive(owner.pid)) return false;
  if (owner.start === null) return true;
  const now = processStartTime(owner.pid);
  return now === null || now === owner.start;
}

export function readLockOwner(dir: string, name = CONVERSATION_LOCK): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<LockOwner>;
    return typeof o.pid === "number" && typeof o.nonce === "string" ? { pid: o.pid, start: typeof o.start === "string" ? o.start : null, nonce: o.nonce } : null;
  } catch {
    return null;
  }
}

/** the owner of the lock when it is alive, else null */
export function liveLockOwner(dir: string): LockOwner | null {
  const owner = readLockOwner(dir);
  return ownerAlive(owner) ? owner : null;
}

let me: LockOwner | null = null;

function self(): LockOwner {
  me ??= { pid: process.pid, start: processStartTime(process.pid), nonce: randomUUID() };
  return me;
}

/** create `name` holding our owner record, atomically; false when it already exists */
function linkOwner(dir: string, name: string): boolean {
  const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(self()));
  try {
    linkSync(tmp, join(dir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

function unlinkIfOwner(dir: string, name: string, nonce: string): void {
  if (readLockOwner(dir, name)?.nonce !== nonce) return;
  try { unlinkSync(join(dir, name)); } catch { /* gone */ }
}

/** take down the lock found dead, if it is still that one; under the break lock, so one cleaner at a time */
function breakDeadLock(dir: string, dead: LockOwner): void {
  if (!linkOwner(dir, BREAK_LOCK)) {
    // a cleaner that died inside the few lines below leaves the break lock; the next contender clears it
    const breaker = readLockOwner(dir, BREAK_LOCK);
    if (breaker && ownerAlive(breaker)) return;
    if (breaker) unlinkIfOwner(dir, BREAK_LOCK, breaker.nonce);
    if (!linkOwner(dir, BREAK_LOCK)) return;
  }
  try {
    // nobody but the owner (dead) and a cleaner (us, alone) removes the lock, so it cannot change under us
    const cur = readLockOwner(dir);
    if (cur?.nonce === dead.nonce && !ownerAlive(cur)) unlinkSync(join(dir, CONVERSATION_LOCK));
  } finally {
    unlinkIfOwner(dir, BREAK_LOCK, self().nonce);
  }
}

export function acquireLock(dir: string): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (linkOwner(dir, CONVERSATION_LOCK)) return true;
    const owner = readLockOwner(dir);
    if (ownerAlive(owner)) return false;
    // unreadable: another process is taking it down right now; look again
    if (owner) breakDeadLock(dir, owner);
  }
  return false;
}

/** the lock is still ours (checked before every reply, so a supervisor that lost it stops feeding) */
export function holdsLock(dir: string): boolean {
  return readLockOwner(dir)?.nonce === self().nonce;
}

export function releaseLock(dir: string): void {
  unlinkIfOwner(dir, CONVERSATION_LOCK, self().nonce);
}

/** set by `idd lane stop` on a conversation lane: a person stopped it, so the watch does not start it again */
export const STOPPED_BY_USER = "stopped-by-user.json";

export function markStoppedByUser(dir: string, at = new Date()): void {
  writeFileSync(join(dir, STOPPED_BY_USER), `${JSON.stringify({ at: at.toISOString() })}\n`);
}

export function stoppedByUserAt(dir: string): number {
  try {
    return Date.parse((JSON.parse(readFileSync(join(dir, STOPPED_BY_USER), "utf8")) as { at?: string }).at ?? "") || 0;
  } catch {
    return 0;
  }
}
