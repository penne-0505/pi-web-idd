
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { stateDir } from "../paths.ts";

/** the port the engine listens on when nothing says otherwise; the CLI, the engine and the GUI's client share this value */
export const DEFAULT_ENGINE_PORT = "30144";

export function agentToken(): string {
  const fromEnv = process.env.IDD_AGENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent-token");
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored) return stored;
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function agentBaseUrl(): string {
  const explicit = process.env.IDD_AGENT_BASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.IDD_ENGINE_PORT?.trim() || DEFAULT_ENGINE_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * The inbox the CLI points at: the screen a person opens, which the engine serves under `/gui` on its own port.
 * This is the one place the default is derived (from the engine's port), so the wrappers and the units carry no
 * copy of it. `IDD_INBOX_BASE_URL` names the origin a person reaches the engine at when it is not the local port
 * (a tailnet name); the screen's path is added to it either way.
 */
export function inboxBaseUrl(): string {
  const explicit = process.env.IDD_INBOX_BASE_URL?.trim().replace(/\/+$/, "");
  const port = process.env.IDD_ENGINE_PORT?.trim() || DEFAULT_ENGINE_PORT;
  return `${explicit || `http://127.0.0.1:${port}`}/gui`;
}

/**
 * The inbox URL a CLI answer points at: it opens the inbox and brings one card to the front. The card is named by
 * its id (a lane's `IDD-n`, or a draft's `OUT-…`); the screen reads `?card=` as that id. Without a card it opens the
 * inbox alone. One place builds it, so every command returns the same shape.
 */
export function inboxCardUrl(cardId?: string | null): string {
  const id = cardId?.trim();
  const base = `${inboxBaseUrl()}/?view=inbox`;
  return id ? `${base}&card=${encodeURIComponent(id)}` : base;
}

export function checkAgentToken(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = agentToken();
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

/**
 * The credential a lane's `idd hold` presents: derived from the shared token and the lane's id, so the engine can
 * tell which lane is asking without keeping a table. The shared token alone names no one, and the hold door writes
 * a lane's records; a request that carries another lane's id must not pass.
 */
export function laneHoldToken(lane: string, secret: string): string {
  return createHmac("sha256", secret).update(`hold:${lane}`).digest("base64url");
}

export function checkLaneHoldToken(lane: string, presented: string | null | undefined): boolean {
  if (!lane || !presented) return false;
  const expected = Buffer.from(laneHoldToken(lane, agentToken()));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
